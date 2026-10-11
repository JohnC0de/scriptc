#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct Node Node;
struct Node {
  size_t rc;
  Node *next;
  Node *other;
  Node *untraced;
};

static size_t freed;
static size_t traced; /* trace calls: the collector's walk, one per object visit */

static size_t configured_nursery_threshold(void) {
  const char *env = getenv("SCR_CYCLE_THRESHOLD");
  long value = env ? strtol(env, NULL, 10) : 0;
  return value > 0 ? (size_t)value : 256;
}

/* How many times its size after the last full pass the heap may grow before
 * the next once passes stop finding garbage: SCR_CYCLE_GROWTH_CAP rounded
 * down to a power of two from 1 to 16, and 16 when unset. */
static size_t configured_growth_cap(void) {
  const char *env = getenv("SCR_CYCLE_GROWTH_CAP");
  long value = env ? strtol(env, NULL, 10) : 0;
  if (value <= 0) return 16;
  size_t cap = 1;
  while (cap < 16 && (long)(cap * 2) <= value) cap *= 2;
  return cap;
}

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "cycle test failed: %s\n", message);
  exit(EXIT_FAILURE);
}

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  exit(EXIT_FAILURE);
}

static void node_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  traced++;
  visit(((Node *)obj)->next, ctx);
  visit(((Node *)obj)->other, ctx);
}

static void node_free(void *obj) {
  Node *untraced = ((Node *)obj)->untraced;
  if (untraced) {
    untraced->rc--;
    scr_cyc_on_release(untraced);
  }
  freed++;
  scr_cyc_free(obj);
}

static Node *make_ring(size_t count) {
  Node **nodes = calloc(count, sizeof(*nodes));
  if (!nodes) scr_trap("cycle test: out of memory\n");
  for (size_t i = 0; i < count; i++) {
    static const ScrCycType cyc_type = { &node_trace, &node_free, 0 };
    nodes[i] = scr_cyc_alloc(sizeof(*nodes[i]), &cyc_type);
    nodes[i]->rc = 1; /* the ring edge that will point at this node */
  }
  for (size_t i = 0; i < count; i++)
    nodes[i]->next = nodes[(i + 1) % count];

  Node *root = nodes[0];
  root->rc++; /* external owner */
  free(nodes);
  return root;
}

static void release_live(Node *node) {
  node->rc--;
  scr_cyc_on_release(node);
}

static void check_sparse_mature_backlog(size_t roots) {
  enum { NODES_PER_RING = 32 };
  size_t scheduled_passes = configured_nursery_threshold();
  Node *ring_roots[2];
  size_t before = freed;

  for (size_t i = 0; i < roots; i++) {
    ring_roots[i] = make_ring(NODES_PER_RING);
    ring_roots[i]->rc++; /* temporary release makes it a candidate */
    release_live(ring_roots[i]);
  }

  /* Promote and drain every candidate while the rings are externally live.
   * This also resets scheduled age, independent of release-triggered passes. */
  scr_collect_cycles();
  check(freed == before, "setup full pass freed a live ring");

  for (size_t i = 0; i < roots; i++) release_live(ring_roots[i]);
  for (size_t i = 1; i < scheduled_passes; i++)
    scr_cyc_collect_scheduled();
  check(freed == before, "mature rings collected before configured boundary");

  scr_cyc_collect_scheduled();

  check(freed - before == roots * NODES_PER_RING,
        "configured boundary did not collect the mature rings exactly");
}

static void check_age_reset_when_last_mature_root_dies(void) {
  size_t partial_age = configured_nursery_threshold() / 2;
  size_t scheduled_passes = configured_nursery_threshold();
  size_t before = freed;
  Node *ring;
  Node *leaf;

  ring = make_ring(32);
  ring->rc++;
  release_live(ring);
  static const ScrCycType cyc_type = { &node_trace, &node_free, 0 };
  leaf = scr_cyc_alloc(sizeof(*leaf), &cyc_type);
  leaf->rc = 1;
  leaf->rc++; /* temporary release makes it a nursery candidate */
  release_live(leaf);

  /* Both objects are now mature, live, unbuffered, and scheduled age is zero. */
  scr_collect_cycles();
  check(freed == before, "setup full pass freed a live age-reset object");

  leaf->rc++;
  release_live(leaf); /* buffer the mature leaf while it remains externally live */
  for (size_t i = 0; i < partial_age; i++) scr_cyc_collect_scheduled();

  leaf->rc--;
  scr_cyc_on_dead(leaf); /* removing the last mature root resets its age */
  node_free(leaf);
  check(freed == before + 1, "directly dead mature root was not freed");

  /* The waiting ring starts a fresh age after the last prior root disappeared. */
  release_live(ring);
  for (size_t i = 1; i < scheduled_passes; i++)
    scr_cyc_collect_scheduled();
  check(freed == before + 1,
        "age reset ring collected before configured boundary");
  scr_cyc_collect_scheduled();
  check(freed == before + 33,
        "age reset ring was not collected at configured boundary");
}

static void check_dead_backlog_rearms_release_trigger(void) {
  enum { BACKLOG = 32 };
  size_t threshold = configured_nursery_threshold();
  Node *leaves[BACKLOG];

  for (size_t i = 0; i < BACKLOG; i++) {
    static const ScrCycType cyc_type = { &node_trace, &node_free, 0 };
    leaves[i] = scr_cyc_alloc(sizeof(*leaves[i]), &cyc_type);
    leaves[i]->rc = 2; /* external owner plus a temporary reference */
    release_live(leaves[i]);
  }
  scr_collect_cycles(); /* promote the live leaves and drain their roots */

  for (size_t i = 0; i < BACKLOG; i++) {
    leaves[i]->rc++;
    release_live(leaves[i]); /* build a mature candidate backlog */
  }
  if (threshold > 1)
    scr_cyc_collect_scheduled(); /* re-arm over the entire backlog */

  for (size_t i = 0; i < BACKLOG; i++) {
    leaves[i]->rc--;
    scr_cyc_on_dead(leaves[i]);
    node_free(leaves[i]);
  }

  size_t before = freed;
  for (size_t i = 0; i < threshold; i++)
    release_live(make_ring(1));
  check(freed - before == threshold,
        "directly dead backlog delayed the next release-triggered pass");
}

static Node *make_leaf(void) {
  static const ScrCycType cyc_type = { &node_trace, &node_free, 0 };
  Node *leaf = scr_cyc_alloc(sizeof(*leaf), &cyc_type);
  leaf->rc = 1;
  return leaf;
}

/* A temporary reference taken and dropped, as when a program reads it. */
static void read_live(Node *node) {
  node->rc++;
  release_live(node);
}

/* A promoted ring whose last outside owner has just been dropped. */
static void make_dead_mature_ring(size_t count) {
  Node *ring = make_ring(count);
  ring->rc++;
  release_live(ring);
  scr_collect_cycles();
  release_live(ring); /* only the ring edge remains */
}

/* Dead mature rings reclaimed by one scheduled full pass that frees more
 * than it walks live, which restores the backlog trigger's base fraction. */
static void collect_dead_mature_rings(void) {
  enum { RING = 32, RINGS = 64 };
  Node *rings[RINGS];
  size_t before = freed;
  for (size_t i = 0; i < RINGS; i++) {
    rings[i] = make_ring(RING);
    rings[i]->rc++;
    release_live(rings[i]);
  }
  scr_collect_cycles();
  for (size_t i = 0; i < RINGS; i++) release_live(rings[i]);
  for (size_t i = 0; i < configured_nursery_threshold(); i++)
    scr_cyc_collect_scheduled();
  check(freed == before + RINGS * RING, "scheduled pass missed dead mature rings");
}

static void check_unproductive_backlog_backs_off(void) {
  enum { LIVE = 8192, RING = 32 };
  static Node *leaves[LIVE];
  for (size_t i = 0; i < LIVE; i++) {
    leaves[i] = make_leaf();
    read_live(leaves[i]);
  }
  scr_collect_cycles(); /* promote; the explicit sweep never adapts the threshold */
  collect_dead_mature_rings();

  /* Reading a quarter of the live heap reaches the backlog trigger, whose
   * pass finds the dead ring among live candidates but little else. */
  size_t before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3000; i++) read_live(leaves[i]);
  check(freed == before + RING, "backlog trigger missed a dead mature ring");

  /* That unproductive pass doubled the threshold: the same reads wait. */
  before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3500; i++) read_live(leaves[i]);
  check(freed == before, "unproductive backlog pass did not back off");
  for (size_t i = 3500; i < 5000; i++) read_live(leaves[i]);
  check(freed == before + RING, "backed-off backlog trigger never collected");

  /* A productive scheduled pass restores the original fraction. */
  collect_dead_mature_rings();
  before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3000; i++) read_live(leaves[i]);
  check(freed == before + RING, "productive pass did not restore the backlog trigger");

  for (size_t i = 0; i < LIVE; i++) {
    leaves[i]->rc--;
    scr_cyc_on_dead(leaves[i]);
    node_free(leaves[i]);
  }
}

/* Survive two passes: nursery to mature, then mature to old. */
static void age_to_old(Node *node) {
  for (int i = 0; i < 2; i++) {
    read_live(node);
    scr_collect_cycles();
  }
  check(scr_cyc_hdr(node)->gen == SCR_CYC_OLD, "survivor did not reach the old generation");
}

/* Fresh live leaves, each released once so the release path keeps running
 * its passes, until `target` objects have been freed or `limit` leaves have
 * been made. Returns how many it made. */
static size_t grow_until(Node **keep, size_t limit, size_t target) {
  size_t n = 0;
  while (freed < target && n < limit) {
    keep[n] = make_leaf();
    read_live(keep[n]);
    n++;
  }
  return n;
}

static void drop_leaves(Node **keep, size_t n) {
  for (size_t i = 0; i < n; i++) {
    keep[i]->rc--;
    scr_cyc_on_dead(keep[i]);
    node_free(keep[i]);
  }
}

/* A dead cycle that has aged into the old generation is reachable only by a
 * full pass, which must reclaim it before the heap has grown a quarter past
 * its size after the last full pass while no pass has yet asked for a wider
 * fraction. Runs first, so the live heap is below the growth floor and that
 * bound is known. */
static void check_old_garbage_reclaimed_while_growing(void) {
  enum { RING = 64, FLOOR = 4096, LIMIT = 4 * FLOOR };
  static Node *keep[LIMIT];
  size_t before = freed;
  Node *ring = make_ring(RING);
  age_to_old(ring);
  release_live(ring); /* last outside owner gone: a dead old cycle */
  size_t grown = grow_until(keep, LIMIT, before + RING);
  check(freed == before + RING, "dead old cycle was never reclaimed while the heap grew");
  check(grown <= FLOOR + FLOOR / 4, "dead old cycle outlived the growth bound");
  drop_leaves(keep, grown);
  scr_collect_cycles();
}

/* Dead rings that survived at least one pass, each holding a traced edge
 * into an old ring: whichever level reclaims them must pay those edges off,
 * and must do so without an explicit sweep. */
static void check_older_rings_into_old(void) {
  enum { OLD_RING = 2048, RING = 8, RINGS = 1024, LIMIT = 4 * (OLD_RING + RING * RINGS) };
  static Node *keep[LIMIT];
  Node *old = make_ring(OLD_RING);
  age_to_old(old);
  size_t before = freed;
  Node *rings[RINGS];
  for (size_t i = 0; i < RINGS; i++) {
    rings[i] = make_ring(RING);
    rings[i]->other = old;
    old->rc++;
    read_live(rings[i]);
  }
  scr_cyc_collect_scheduled(); /* every ring survives at least one pass */
  for (size_t i = 0; i < RINGS; i++) {
    check(scr_cyc_hdr(rings[i])->gen != SCR_CYC_NURSERY, "ring was not promoted");
    release_live(rings[i]);
  }
  size_t grown = grow_until(keep, LIMIT, before + RINGS * RING);
  check(freed == before + RINGS * RING, "dead older rings were never reclaimed");
  check(old->rc == 2, "edges into the old generation were not paid off");
  drop_leaves(keep, grown);
  release_live(old);
  scr_collect_cycles();
}

/* A dead cycle spanning the mature and old generations is spared by mature
 * passes; promotion and re-buffering must still hand it to a full pass. */
static void check_cycle_spanning_mature_and_old(void) {
  enum { LIMIT = 4 * 4096 };
  static Node *keep[LIMIT];
  Node *old = make_ring(4);
  age_to_old(old);
  Node *young = make_ring(4);
  young->other = old;
  old->rc++;
  old->other = young;
  young->rc++;
  read_live(young);
  scr_cyc_collect_scheduled(); /* young survives a pass and is promoted */
  size_t before = freed;
  release_live(old);
  release_live(young); /* only the cycle's own edges remain */
  size_t grown = grow_until(keep, LIMIT, before + 8);
  check(freed == before + 8, "cycle spanning generations was never reclaimed");
  drop_leaves(keep, grown);
  scr_collect_cycles();
}

/* Grow a chain by `count` nodes, each new head owning the previous one and
 * released once, as reading the newest entry of a retained list would. Every
 * buffered head reaches the whole chain, so each full pass walks all of it. */
static Node *grow_chain(Node *head, size_t count) {
  for (size_t i = 0; i < count; i++) {
    Node *node = make_leaf();
    node->next = head; /* takes over the caller's reference */
    head = node;
    read_live(head);
  }
  return head;
}

/* Full passes over a growing retained structure that find nothing widen the
 * growth fraction, so the structure is not re-walked at every quarter of its
 * growth. How far the fraction may widen, and how a productive pass narrows
 * it, are pinned on a heap at the growth floor by
 * check_growth_cap_bounds_floating_garbage: on a structure this size the
 * default cap lets a dead cycle wait through millions of allocations. Leaves
 * the fraction widened, so it runs after the tests that assume the base
 * schedule. */
static void check_growth_schedule_follows_yield(void) {
  enum { START = 4096, GROW = 64 * START };
  size_t before = freed;
  Node *head = grow_chain(make_leaf(), START);
  scr_collect_cycles(); /* a baseline the bounds below are measured from */
  size_t walked_before = traced;
  head = grow_chain(head, GROW);
  check(freed == before, "growing a live chain freed part of it");
  /* Counting every level, walking the chain at every quarter or half of its
   * growth costs eight to ten times its final length; the widened schedule
   * keeps it near five. */
  check(traced - walked_before <= 7 * (size_t)GROW,
        "a growing retained structure was re-walked at every fraction of growth");

  /* Close the chain into one dead cycle: the collector reclaims it whole. */
  Node *tail = head;
  while (tail->next) tail = tail->next;
  tail->other = head;
  head->rc++;
  size_t length = scr_cyc_live; /* nothing else is live between the tests */
  before = freed;
  release_live(head);
  scr_collect_cycles();
  check(freed == before + length, "the closed chain was not reclaimed whole");
}

/* Grow one dead cycle until a full pass reclaims it, and return the live
 * heap at the release that ran that pass. The cycle's only old member is
 * also its only candidate; the young nodes appended to it are never
 * buffered, so only a full pass walks or frees them, and that pass reclaims
 * one old object against all of the growth, plus a dead old ring of
 * `old_garbage` objects when that is nonzero. Dead one-node rings keep the
 * release path running restricted passes meanwhile. The explicit sweeps in
 * age_to_old leave a live heap below the growth floor, so the full pass is
 * due once the heap grows past the floor by the old level's fraction. */
static size_t grow_dead_cycle_until_full_pass(size_t old_garbage) {
  enum { FLOOR = 4096 };
  size_t limit = FLOOR * 18 + 4 * configured_nursery_threshold();
  Node *garbage = NULL;
  if (old_garbage) {
    garbage = make_ring(old_garbage);
    age_to_old(garbage);
  }
  Node *old = make_leaf();
  age_to_old(old);
  check(scr_cyc_live < FLOOR, "live heap did not start below the growth floor");
  if (garbage) release_live(garbage); /* last outside owner gone */
  Node *first = make_leaf(); /* owned by old->other */
  first->next = old;
  old->rc++;
  old->other = first;
  release_live(old); /* external owner gone: a dead cycle with one old root */
  size_t old_before = scr_cyc_old_freed;
  for (size_t appended = 1; appended < limit; appended++) {
    Node *node = make_leaf(); /* takes over old's reference to the newest */
    node->next = old->other;
    old->other = node;
    Node *ring = make_ring(1);
    size_t live = scr_cyc_live;
    release_live(ring);
    if (scr_cyc_old_freed != old_before) {
      check(scr_cyc_old_freed == old_before + old_garbage + 1
              && scr_cyc_live < FLOOR / 2,
            "the full pass did not reclaim the dead old garbage whole");
      return live;
    }
  }
  check(false, "a dead cycle through the old generation outlived the growth cap");
  return 0;
}

/* Passes that keep finding nothing widen the old level's fraction up to the
 * configured cap and no further, two doublings per pass once two passes in a
 * row have asked: at the cap a dead cycle goes exactly when the heap has
 * grown the cap past the floor, not one doubling earlier (a narrower cap)
 * and not later (a wider or missing one). A pass that finds old garbage
 * narrows the fraction at once, and a single pass that finds nothing after
 * it does not widen it again. From where the ring below narrows it (two
 * doublings under any cap of 4 or more, the base fraction under 1 and 2),
 * the second pass in a row that finds nothing reaches the cap; widening a
 * doubling per pass would not. Runs last: it leaves the fraction narrowed
 * but not at the base. */
static void check_growth_cap_bounds_floating_garbage(void) {
  enum { FLOOR = 4096 };
  size_t cap = configured_growth_cap();
  /* Passes wait for the release trigger, and dead rings float until the
   * next restricted pass, so allow two nursery's worth. */
  size_t slack = 2 * configured_nursery_threshold() + 2;
  size_t narrowed = FLOOR + FLOOR * cap / 2 + slack;
  size_t due = FLOOR + FLOOR * cap;
  /* The previous test left the fraction at the cap. Old garbage narrows it
   * (see below); the pass after that is the first to find nothing and must
   * not widen it; the second in a row widens it to the cap. */
  grow_dead_cycle_until_full_pass(FLOOR / 2 - 64);
  size_t live = grow_dead_cycle_until_full_pass(0);
  check(live <= narrowed, "a pass that found old garbage did not narrow the growth fraction");
  live = grow_dead_cycle_until_full_pass(0);
  check(live <= narrowed, "a single pass that found nothing widened the growth fraction");
  live = grow_dead_cycle_until_full_pass(0);
  check(live > due, "two passes in a row that found nothing did not widen to the cap");
  check(live <= due + slack, "the growth fraction widened past the cap");
  live = grow_dead_cycle_until_full_pass(0);
  check(live > due && live <= due + slack, "the growth fraction left the cap");

  /* At any cap, old garbage of an eighth of the floor or more is a yield
   * that asks for at least one doubling less (this ring asks for two below
   * a cap of 2 or more), and narrowing does not wait for a second pass. */
  live = grow_dead_cycle_until_full_pass(FLOOR / 2 - 64);
  check(live > due && live <= due + slack, "a capped pass came early or late");
  live = grow_dead_cycle_until_full_pass(0);
  check(live <= narrowed, "a pass that found old garbage did not narrow the growth fraction");
}

static void check_deep_ring(void) {
  enum { DEPTH = 100000 };
  size_t before = freed;
  Node *root = make_ring(DEPTH);
  root->rc++;
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "deep live ring was reclaimed");
  Node *node = root;
  for (size_t i = 0; i < DEPTH; i++) {
    check(node->rc == (i == 0 ? 2u : 1u), "deep ring count not restored");
    node = node->next;
  }
  release_live(root);
  scr_collect_cycles();
  check(freed == before + DEPTH, "deep dead ring not reclaimed exactly");
}

static void check_shared_edges_and_outside_owner(void) {
  size_t before = freed;
  Node *root = make_ring(3);
  Node *shared = root->next;
  root->other = shared;
  shared->rc++; /* duplicate edge */
  shared->rc++; /* independent external owner */
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "shared subgraph lost its outside owner");
  check(root->rc == 1 && shared->rc == 3 && shared->next->rc == 1,
        "duplicate edges were not restored once each");
  /* Several candidates overlap the same graph. */
  root->rc++;
  release_live(root);
  release_live(shared);
  scr_collect_cycles();
  check(freed == before + 3, "overlapping candidates were not reclaimed once");
}

static void check_repeated_buffered_release(void) {
  size_t before = freed;
  Node *root = make_ring(3);
  root->rc++;
  release_live(root);
  scr_collect_cycles();
  for (size_t i = 0; i < 1000; i++) {
    root->rc++;
    release_live(root);
  }
  check(freed == before && root->rc == 2,
        "repeated buffered releases changed live references");
  release_live(root);
  for (size_t i = 0; i < configured_nursery_threshold(); i++)
    scr_cyc_collect_scheduled();
  check(freed == before + 3, "buffered live-to-dead transition lost its root");
}

static void check_disconnected_survivors(void) {
  size_t before = freed;
  Node *first = make_ring(2);
  Node *second = make_ring(3);
  Node *dead = make_ring(4);
  scr_collect_cycles(); /* arm the trigger before buffering separate graphs */
  first->rc++;
  release_live(first);
  second->rc++;
  release_live(second);
  release_live(dead);
  scr_collect_cycles();
  check(freed == before + 4, "mixed live/dead components were misclassified");
  check(first->rc == 2 && first->next->rc == 1 &&
        second->rc == 2 && second->next->rc == 1,
        "a later outside root replayed earlier restored edges");
  release_live(first);
  release_live(second);
  scr_collect_cycles();
  check(freed == before + 9, "disconnected survivors were not later reclaimed");
}

static void check_cross_generation_edges(void) {
  size_t before = freed;
  Node *older = make_ring(2);
  older->rc++;
  release_live(older);
  scr_collect_cycles();
  Node *younger = make_ring(2);
  younger->other = older; /* transfer the older external owner */
  release_live(younger);
  scr_cyc_collect_scheduled();
  check(freed >= before + 2, "nursery cycle was not reclaimed");
  scr_collect_cycles();
  check(freed == before + 4, "cross-generation edge was not paid off");

  before = freed;
  older = make_ring(2);
  older->rc++;
  release_live(older);
  scr_collect_cycles();
  younger = make_ring(2);
  older->other = younger; /* transfer the younger external owner */
  younger->other = older;
  older->rc++;
  /* The nursery candidate is kept alive by an edge the restricted pass
   * cannot subtract. It must remain discoverable for the later full pass. */
  younger->rc++;
  release_live(younger);
  scr_cyc_collect_scheduled();
  check(freed == before, "cross-generation live cycle was reclaimed");
  release_live(older);
  scr_collect_cycles();
  check(freed == before + 4, "cross-generation cycle lost its candidate");
}

static void check_deep_cross_generation_chain(void) {
  enum { DEPTH = 100000 };
  size_t before = freed;
  Node *chain = NULL;
  for (size_t i = 0; i < DEPTH; i++) {
    static const ScrCycType cyc_type = { &node_trace, &node_free, 0 };
    Node *node = scr_cyc_alloc(sizeof(*node), &cyc_type);
    node->rc = 1;
    node->next = chain;
    chain = node;
  }
  chain->rc++;
  release_live(chain);
  scr_collect_cycles(); /* promote the externally live chain */
  check(freed == before, "promotion freed an owned deep chain");
  Node *young = make_ring(2);
  young->other = chain; /* the last external owner moves into the nursery */
  release_live(young);
  scr_cyc_collect_scheduled();
  scr_collect_cycles();
  check(freed == before + DEPTH + 2,
        "cross-generation destruction leaked a deep chain");
}

static void check_teardown_rebuffers_and_immortals(void) {
  size_t before = freed;
  static Node immortal = { .rc = SIZE_MAX };
  Node *first = make_ring(2);
  Node *second = make_ring(2);
  first->other = &immortal;
  first->untraced = second; /* a plain-RC owner released by the teardown */
  release_live(first);
  scr_collect_cycles();
  check(freed == before + 4, "teardown candidate did not reach the fixpoint");
  check(immortal.rc == SIZE_MAX, "immortal edge was trial-deleted");
}

static void check_deferred_white_restoration(void) {
  enum { DEPTH = 4096 };
  size_t before = freed;
  Node *root = make_ring(DEPTH);
  Node *outside = root;
  for (size_t i = 0; i < DEPTH / 2; i++) outside = outside->next;
  outside->rc++;
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "deferred white nodes lost an outside owner");
  Node *node = root;
  for (size_t i = 0; i < DEPTH; i++) {
    check(node->rc == (node == outside ? 2u : 1u),
          "deferred white restoration changed edge counts");
    node = node->next;
  }
  release_live(outside);
  scr_collect_cycles();
  check(freed == before + DEPTH, "restored deferred nodes leaked");
}

/* Nursery bypass (scr_cycle.c): candidates of an emitted type (kind != 0)
 * that keep surviving their nursery passes are promoted on release instead
 * of walked; dead cycles of that type are still found by older passes; and
 * once the type's objects die in nursery cycles again, it is walked again.
 * Window, ratio and sample mirror SCR_CYC_BYPASS_*. */
/* Tests only (SCR_CYC_TESTING): one pass at exactly `gen`. */
size_t scr_cyc_pass_at(unsigned gen);
static size_t bypass_traced; /* trace calls on bypass-kind nodes */
static size_t bypass_freed;  /* bypass-kind nodes freed */
static void bypass_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  bypass_traced++;
  node_trace(obj, visit, ctx);
}
static void bypass_free(void *obj) {
  bypass_freed++;
  node_free(obj);
}
static const ScrCycType bypass_type = { &bypass_trace, &bypass_free, 7 };

static Node *make_bypass_node(void) {
  Node *node = scr_cyc_alloc(sizeof(*node), &bypass_type);
  node->rc = 1;
  return node;
}

/* Run release-triggered passes, as a program does by releasing: a pass's
 * level then follows growth and backlogs only, never the scheduled age. */
static void run_release_passes(void) {
  for (size_t i = 0; i <= configured_nursery_threshold(); i++)
    release_live(make_ring(1));
}

/* Trace calls spent on PROBE fresh, externally owned bypass-kind
 * candidates. A full pass first resets the growth baselines, so the probe
 * never trips a mature or full pass: only nursery passes walk. */
static size_t probe_bypass_walks(Node **owned, size_t probe) {
  scr_collect_cycles();
  size_t before = bypass_traced;
  for (size_t i = 0; i < probe; i++) {
    owned[i] = make_bypass_node();
    read_live(owned[i]);
  }
  run_release_passes();
  return bypass_traced - before;
}

static void check_nursery_bypass(void) {
  enum { WINDOW = 8192, SAMPLE = 16, LIVE = 3 * WINDOW, PROBE = 4096, RINGS = 32 };
  Node **live = calloc(LIVE + 3 * PROBE, sizeof(*live));
  if (!live) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;

  /* A walked candidate costs two trace calls (markGray and the restoring
   * scan). Every survivor of the first window is walked; afterwards only
   * one in SAMPLE is. */
  for (; nlive < LIVE; nlive++) {
    live[nlive] = make_bypass_node();
    read_live(live[nlive]);
  }
  size_t walks = probe_bypass_walks(live + nlive, PROBE);
  nlive += PROBE;
  check(walks < PROBE / 2, "a type whose candidates always survive was not bypassed");

  /* Dead rings of the bypassed type wait in the mature buffer for an older
   * pass, which finds them. */
  size_t before = bypass_freed;
  for (size_t r = 0; r < RINGS; r++) {
    Node *a = make_bypass_node(), *b = make_bypass_node();
    a->next = b;
    b->next = a;
    a->rc++; /* the outside owner */
    release_live(a);
  }
  run_release_passes();
  check(bypass_freed - before < 2 * RINGS, "bypassed dead rings were all walked by the nursery");
  scr_collect_cycles();
  check(bypass_freed - before == 2 * RINGS, "an older pass missed dead rings of a bypassed type");

  /* Now the type's objects die in nursery cycles. The sampled candidates
   * keep measuring the yield, so after one window the type is walked again.
   * A nursery pass after each release walks every sampled candidate at its
   * own level: the promoted rings pile up in older buffers, and an older
   * pass the growth schedule runs there would otherwise sweep sampled
   * candidates too and leave the nursery's window unfinished. */
  for (size_t r = 0; r < (size_t)WINDOW * SAMPLE; r++) {
    Node *a = make_bypass_node(), *b = make_bypass_node();
    a->next = b;
    b->next = a;
    a->rc++;
    release_live(a);
    scr_cyc_pass_at(SCR_CYC_NURSERY);
  }
  scr_collect_cycles();
  walks = probe_bypass_walks(live + nlive, PROBE);
  nlive += PROBE;
  check(walks >= PROBE, "a type whose objects die in nursery cycles stayed bypassed");

  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  scr_collect_cycles();
}

/* The mature level's bypass: a type whose mature candidates keep surviving
 * goes straight to the old generation, its dead cycles are found by full
 * passes, and once its objects die at the mature level again it is judged
 * there again. Passes run at exact levels through the test entry point. */
static size_t mature_kind_freed;
static void mature_kind_free(void *obj) {
  mature_kind_freed++;
  node_free(obj);
}
static const ScrCycType mature_kind_type = { &node_trace, &mature_kind_free, 8 };

static Node *make_mature_kind_node(void) {
  Node *node = scr_cyc_alloc(sizeof(*node), &mature_kind_type);
  node->rc = 1;
  return node;
}

/* How many of PROBE fresh, externally owned candidates a release buffers
 * straight into the old generation. */
static size_t probe_old_on_release(Node **owned, size_t probe) {
  scr_collect_cycles(); /* reset the growth baselines: no pass runs below */
  size_t old = 0;
  for (size_t i = 0; i < probe; i++) {
    owned[i] = make_mature_kind_node();
    read_live(owned[i]);
    old += scr_cyc_hdr(owned[i])->gen == SCR_CYC_OLD;
  }
  return old;
}

static void check_mature_bypass(void) {
  enum { WINDOW = 8192, SAMPLE = 16, LIVE = 3 * WINDOW, PROBE = 4096, BATCH = 1024 };
  Node **live = calloc(LIVE + 2 * PROBE, sizeof(*live));
  Node **batch = calloc(BATCH, sizeof(*batch));
  if (!live || !batch) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;

  for (; nlive < LIVE; nlive++) {
    live[nlive] = make_mature_kind_node();
    read_live(live[nlive]);
  }
  /* Whatever passes those releases ran, put every node in the mature
   * generation as a candidate (any generation is sound), and walk them all
   * at that level: none dies. */
  scr_collect_cycles();
  for (size_t i = 0; i < nlive; i++) {
    scr_cyc_hdr(live[i])->gen = SCR_CYC_MATURE;
    read_live(live[i]);
  }
  scr_cyc_pass_at(SCR_CYC_MATURE);
  size_t old = probe_old_on_release(live + nlive, PROBE);
  nlive += PROBE;
  check(old >= PROBE / 2, "a type whose mature candidates always survive kept its mature passes");

  /* Dead rings of it wait for a full pass, which finds them. */
  size_t before = mature_kind_freed;
  for (size_t r = 0; r < 32; r++) {
    Node *a = make_mature_kind_node(), *b = make_mature_kind_node();
    a->next = b;
    b->next = a;
    a->rc++;
    release_live(a);
  }
  scr_cyc_pass_at(SCR_CYC_NURSERY);
  scr_cyc_pass_at(SCR_CYC_MATURE);
  check(mature_kind_freed - before < 64, "rings past the mature level were all walked by it");
  scr_collect_cycles();
  check(mature_kind_freed - before == 64, "a full pass missed dead rings of a type past the mature level");

  /* Now its rings survive the nursery and die before the next mature pass.
   * The candidates kept at the mature level measure that, and after one
   * window the type is judged there again. */
  for (size_t round = 0; round < (size_t)WINDOW * SAMPLE / BATCH; round++) {
    for (size_t r = 0; r < BATCH; r++) {
      Node *a = make_mature_kind_node(), *b = make_mature_kind_node();
      a->next = b;
      b->next = a;
      a->rc++; /* the outside owner */
      read_live(a);
      batch[r] = a;
    }
    scr_cyc_pass_at(SCR_CYC_NURSERY);
    for (size_t r = 0; r < BATCH; r++) release_live(batch[r]);
    scr_cyc_pass_at(SCR_CYC_MATURE);
  }
  scr_collect_cycles();
  old = probe_old_on_release(live + nlive, PROBE);
  nlive += PROBE;
  check(old < PROBE / 4, "a type whose objects die at the mature level stayed past it");

  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  free(batch);
  scr_collect_cycles();
}

/* A nursery pass re-buffers its survivors past the mature level when
 * their type bypasses it, even if the type's nursery candidates are
 * walked (here half of them die young, in rings). */
static const ScrCycType young_dying_type = { &node_trace, &node_free, 9 };

static void check_rebuffer_past_mature(void) {
  enum { BATCH = 1024, ROUNDS = 24, PROBE = 1024 };
  Node **live = calloc((size_t)BATCH * ROUNDS + PROBE, sizeof(*live));
  if (!live) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;
  for (size_t round = 0; round < ROUNDS; round++) {
    for (size_t i = 0; i < BATCH; i++) {
      Node *keep = scr_cyc_alloc(sizeof(*keep), &young_dying_type);
      keep->rc = 1;
      read_live(keep);
      live[nlive++] = keep;
      Node *a = scr_cyc_alloc(sizeof(*a), &young_dying_type);
      Node *b = scr_cyc_alloc(sizeof(*b), &young_dying_type);
      a->rc = 2; /* b's edge and the outside owner */
      b->rc = 1;
      a->next = b;
      b->next = a;
      release_live(a); /* dead, buffered in the nursery */
    }
    scr_cyc_pass_at(SCR_CYC_NURSERY); /* frees the rings, re-buffers the rest */
    scr_cyc_pass_at(SCR_CYC_MATURE);  /* finds nothing */
  }
  scr_collect_cycles();
  for (size_t i = 0; i < PROBE; i++) {
    Node *keep = scr_cyc_alloc(sizeof(*keep), &young_dying_type);
    keep->rc = 1;
    read_live(keep);
    live[nlive++] = keep;
  }
  scr_cyc_pass_at(SCR_CYC_NURSERY);
  size_t old = 0;
  for (size_t i = nlive - PROBE; i < nlive; i++) old += scr_cyc_hdr(live[i])->gen == SCR_CYC_OLD;
  check(old >= PROBE / 2, "nursery survivors were re-buffered into a level their type bypasses");
  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  scr_collect_cycles();
}

int main(void) {
  check_old_garbage_reclaimed_while_growing();
  check_older_rings_into_old();
  check_cycle_spanning_mature_and_old();
  check_unproductive_backlog_backs_off();
  check_sparse_mature_backlog(1);
  check_sparse_mature_backlog(2);
  check_age_reset_when_last_mature_root_dies();
  check_dead_backlog_rearms_release_trigger();
  check_deep_ring();
  check_shared_edges_and_outside_owner();
  check_repeated_buffered_release();
  check_disconnected_survivors();
  check_deferred_white_restoration();
  check_cross_generation_edges();
  check_deep_cross_generation_chain();
  check_teardown_rebuffers_and_immortals();
  check_growth_schedule_follows_yield();
  check_growth_cap_bounds_floating_garbage();
  check_nursery_bypass();
  check_mature_bypass();
  check_rebuffer_past_mature();
  printf("cycle collection checks passed: threshold=%zu growth_cap=%zu\n",
         configured_nursery_threshold(), configured_growth_cap());
  return 0;
}
