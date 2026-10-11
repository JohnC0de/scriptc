/* Reference-cycle collector: generational Bacon–Rajan trial deletion (see
 * "Concurrent Cycle Collection in Reference Counted Systems", the
 * synchronous algorithm) over cycle-headered objects only — the object
 * model and the trace/teardown contract live in scr_runtime.h.
 *
 * Life of a candidate: a release that leaves rc > 0 buffers the object.
 * Collection walks the buffer in three phases over the graph
 * reachable from it:
 *   markGray     trial-delete: decrement rc once per internal edge;
 *   scan         nodes still rc > 0 are externally referenced — re-blacken
 *                their subgraph and restore the trial decrements;
 *   gather       filter the scanned white set, then free it, releasing
 *                only edges that LEAVE the white set (each member's
 *                teardown releases its untraced children; traced edges were
 *                already accounted by markGray).
 * The white set is gathered first and freed after the walk — freeing
 * during the walk would leave dangling sibling edges for later visits.
 *
 * Correctness leans on two global invariants (docs/memory.md):
 * - every strong reference is counted: stacks, locals, and runtime-owned
 *   buffers (timer callbacks, unhandled-rejection tracking) all hold +1,
 *   so trial deletion can never free something a root still reaches;
 * - mutators unlink before they release: a heap object's stored pointer is
 *   overwritten BEFORE the old value's release runs, so a threshold
 *   collection triggered inside that release never sees an edge whose
 *   count was already given up (which would over-decrement and free live
 *   data).
 *
 * The main graph phases keep a bounded depth-first walk and defer deeper
 * traces to reusable worklists. Ordinary RC destruction and cross-generation
 * releases are separate paths. White candidates are recorded during scan
 * and filtered after outside roots settle, avoiding a separate gather walk.
 *
 * ── generations ──────────────────────────────────────────────────────
 * A pass costs O(objects reachable from its candidates), and a candidate
 * deep in a live structure reaches all of it — so collecting on a fixed
 * candidate count makes total work QUADRATIC in a growing live heap. A
 * splay tree is the worst case: re-linking a node buffers it, the walk
 * from it drags in every node below, and none of it is ever garbage.
 *
 * So the collector is generational, in the shape CPython uses for this
 * same algorithm: nursery, mature and old. Each header carries a `gen`; a
 * pass names the oldest generation it will walk and SKIPS every object above
 * it, exactly as it skips NULL and immortals. Objects that survive a pass are
 * promoted one generation, so the next pass at a lower level never walks
 * them again: the cost of a nursery pass is proportional to what has been
 * allocated since the last one, and the cost of a mature pass to what has
 * survived a nursery pass since the last mature one — not to the live heap.
 * The third generation is what keeps a long-lived structure out of the walk
 * that reclaims medium-lived garbage: objects that die after surviving one
 * pass (scratch structures built for a phase of work, say) are reclaimed by
 * mature passes that never touch the data that has been live for a while.
 *
 * Restricting the walk stays sound because trial deletion is already
 * conservative in the right direction. An edge from a skipped (older)
 * object into the walked set is never trial-deleted, so its target keeps
 * that count, reads as externally referenced, and survives — the same
 * answer the collector gives for a reference held by the stack. Edges the
 * other way are simply not followed; the older object was not a candidate
 * for freeing in this pass. What this gives up is cycles that SPAN
 * generations: those are invisible to a restricted pass and are found by
 * the full pass, which walks every generation and so is exactly the
 * single-generation algorithm.
 *
 * Scheduling. One counter drives the release path: candidates buffered
 * since the last pass. When it trips, the pass runs at the highest level
 * whose condition holds:
 *   full, growth   the live cycle-headered heap is a fraction past its size
 *                  after the last full pass. The fraction starts at 1/4 and
 *                  is scheduled by YIELD: it widens by doublings (up to the
 *                  growth cap, 16 unless SCR_CYCLE_GROWTH_CAP lowers it)
 *                  as growth-triggered full passes reclaim fewer OLD objects
 *                  relative to the growth that triggered them, and narrows
 *                  back as soon as a pass finds old garbage again (see
 *                  scr_cyc_adapt_growth). Garbage younger than the old
 *                  generation does not count: the mature level reclaims it
 *                  without walking the old heap. This is what stops a large
 *                  retained structure from being re-walked at every quarter
 *                  of growth while it is building or while the garbage is
 *                  all young.
 *   full, backlog  the old candidate buffer has reached a fraction of the
 *                  live heap. This one is not redundant: live data that is
 *                  unlinked INTO a dead cycle grows no counter at all (it
 *                  was tallied when it was allocated) and is invisible to a
 *                  restricted pass, so without it a program that churns its
 *                  long-lived structures would never collect anything. But
 *                  an old object is also buffered whenever a temporary
 *                  reference to it is dropped, so merely READING a live
 *                  structure (walking a tree, say) refills the buffer with
 *                  objects that are not garbage. A pass that frees almost
 *                  nothing therefore doubles this fraction, and a productive
 *                  one restores it.
 *   mature         the same two rules one level down: a growth fraction
 *                  measured from the last mature-or-full pass and scheduled
 *                  by everything mature passes free, and a backlog rule over
 *                  the mature buffer.
 *   scheduled age  a mature or old candidate has waited through a nursery's
 *                  worth of event-loop checkpoints. Candidate COUNT cannot
 *                  bound the garbage behind one root, and an idle heap does
 *                  not trip growth, so this keeps a sparse backlog from
 *                  floating forever without putting a full walk on every
 *                  turn.
 * The growth and backlog rules bound collection work to a constant factor of
 * mutator work — one heap-sized walk per live/N candidates or per growth of
 * live/N — while the scheduled age is the liveness backstop, limiting its
 * forced full walks to one per nursery's worth of checkpoints while older
 * roots wait. That is the trade: a fixed root threshold bounds floating
 * garbage tightly and pays unbounded time for it; this bounds ordinary
 * mutator-triggered work and lets garbage float in proportion, but not
 * forever. Peak memory stays bounded the same way. Every dead cycle keeps a
 * buffered member (a restricted pass re-buffers what it spares), and a full
 * pass walks every buffer without skipping any generation, so it leaves no
 * cyclic garbage behind except what its own teardowns release for the next
 * pass. Between two full passes the cycle-headered heap can grow by at most
 * the old level's fraction, so it never exceeds 17 times its size after the
 * last full pass (or the growth floor), or twice it with
 * SCR_CYCLE_GROWTH_CAP=1; the mature level bounds younger garbage the same
 * way between mature passes. That cap is reached only after passes have
 * stopped finding garbage. While they find it, a level widens its
 * fraction only in inverse proportion to its yield, so if the yield holds,
 * the garbage floating by its next pass stays below an eighth of the heap
 * once widened, inside the quarter the base fraction allows.
 */
#include "scr_runtime.h"

#ifndef SCR_WORKERS /* worker executables keep it in scr_thread_hot */
SCR_TL void (*scr_weak_dispose_hook)(void *) = NULL;
#endif

void scr_weak_dispose(void *object) {
  if (scr_weak_dispose_hook) scr_weak_dispose_hook(object);
}

#include <stdio.h>
#include <stdlib.h>

/* Every heap object's first member is `size_t rc`. */
#define SCR_RC(obj) (*(size_t *)(obj))

static void scr_cyc_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* A pointer vector that only ever grows (these reuse their capacity across
 * passes rather than churning it). Pointer, count and capacity live in ONE
 * struct on purpose: buffering a candidate is the hot path, and splitting
 * them across three arrays indexed by generation would touch three cache
 * lines per release where the original single buffer touched one. */
typedef struct {
  void **v;
  size_t n, cap;
} ScrVec;

typedef struct {
  void *object;
  void (*destroy)(void *);
} ScrDestroyEntry;

/* Keep shallow destruction synchronous without allocating. A chain may mix
 * program layouts, unions and runtime containers, so one instance-local
 * depth budget covers every participating destructor. Queued zero-count
 * objects still own their children until their callback runs. */
#define SCR_DESTROY_DEPTH 64
#ifdef SCR_WORKERS
/* Worker executables keep the collector's per-thread state in one
 * thread-local block: on Darwin every distinct thread-local costs a call
 * per function that touches it, and the release, disposal and walk paths
 * touch several. Ordinary and library builds keep separate variables. */
typedef struct {
  unsigned destroy_depth;
  ScrDestroyEntry *destroy_pending;
  size_t destroy_count;
  size_t destroy_capacity;
  ScrVec roots[SCR_CYC_NGENS];
  bool collecting;
  ScrVec cands;
  ScrVec promote;
  ScrVec pending;
  ScrVec restore_pending;
  ScrVec white;
  ScrVec xgen;
  unsigned gen_limit;
  size_t live_after[SCR_CYC_NGENS];
  unsigned char growth_shift[SCR_CYC_NGENS];
  unsigned char growth_streak[SCR_CYC_NGENS];
  unsigned backlog_shift[SCR_CYC_NGENS];
  size_t nbuffered;
  size_t trigger;
  size_t scheduled_mature_age;
  size_t xg_freed;
} ScrCycThread;
static _Thread_local ScrCycThread scr_cyc_thread = {.gen_limit = SCR_CYC_OLD};
#define scr_destroy_depth (scr_cyc_thread.destroy_depth)
#define scr_destroy_pending (scr_cyc_thread.destroy_pending)
#define scr_destroy_count (scr_cyc_thread.destroy_count)
#define scr_destroy_capacity (scr_cyc_thread.destroy_capacity)
#define scr_roots (scr_cyc_thread.roots)
#define scr_collecting (scr_cyc_thread.collecting)
#define scr_cands (scr_cyc_thread.cands)
#define scr_promote (scr_cyc_thread.promote)
#define scr_pending (scr_cyc_thread.pending)
#define scr_restore_pending (scr_cyc_thread.restore_pending)
#define scr_white (scr_cyc_thread.white)
#define scr_xgen (scr_cyc_thread.xgen)
#define scr_gen_limit (scr_cyc_thread.gen_limit)
#define scr_cyc_live_after (scr_cyc_thread.live_after)
#define scr_cyc_growth_shift (scr_cyc_thread.growth_shift)
#define scr_cyc_growth_streak (scr_cyc_thread.growth_streak)
#define scr_cyc_backlog_shift (scr_cyc_thread.backlog_shift)
#define scr_cyc_nbuffered (scr_cyc_thread.nbuffered)
#define scr_cyc_trigger (scr_cyc_thread.trigger)
#define scr_cyc_scheduled_mature_age (scr_cyc_thread.scheduled_mature_age)
#define scr_xg_freed (scr_cyc_thread.xg_freed)
#endif
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_destroy_depth;
static SCR_TL ScrDestroyEntry *scr_destroy_pending;
static SCR_TL size_t scr_destroy_count, scr_destroy_capacity;
#endif

void scr_rc_destroy(void *obj, void (*destroy)(void *)) {
  if (scr_destroy_depth == SCR_DESTROY_DEPTH) {
    if (scr_destroy_count == scr_destroy_capacity) {
      size_t capacity = scr_destroy_capacity ? scr_destroy_capacity * 2 : 64;
      if (capacity < scr_destroy_capacity || capacity > SIZE_MAX / sizeof(ScrDestroyEntry))
        scr_cyc_oom();
      ScrDestroyEntry *entries = realloc(scr_destroy_pending, capacity * sizeof(*entries));
      if (!entries) scr_cyc_oom();
      scr_destroy_pending = entries;
      scr_destroy_capacity = capacity;
    }
    scr_destroy_pending[scr_destroy_count++] = (ScrDestroyEntry){ obj, destroy };
    return;
  }
  scr_destroy_depth++;
  destroy(obj);
  scr_destroy_depth--;
  if (scr_destroy_depth) return;
  while (scr_destroy_count) {
    ScrDestroyEntry entry = scr_destroy_pending[--scr_destroy_count];
    scr_destroy_depth = 1;
    entry.destroy(entry.object);
    scr_destroy_depth = 0;
  }
  /* Deep teardown is exceptional; don't retain its peak queue allocation
   * throughout an otherwise idle executable or embedded runtime instance. */
  if (scr_destroy_pending) {
    free(scr_destroy_pending);
    scr_destroy_pending = NULL;
    scr_destroy_capacity = 0;
  }
}

/* Live cycle-headered objects and the running count of OLD objects freed.
 * The inline allocation/free paths (scr_runtime.h, llvm/alloc.ts) maintain
 * both counters so full passes can measure old-generation reclamation. */
#ifndef SCR_WORKERS /* worker executables keep them in scr_thread_hot */
SCR_TL size_t scr_cyc_live = 0;
SCR_TL size_t scr_cyc_old_freed = 0;
#endif

void *scr_cyc_alloc(size_t size, ScrTraceFn trace, ScrCycFreeFn free_fn) {
  return scr_cyc_alloc_inline(size, trace, free_fn);
}

void scr_cyc_free(void *obj) { scr_cyc_free_inline(obj); }

static void scr_cyc_grow(ScrVec *vec) {
  vec->cap = vec->cap ? vec->cap * 2 : 64;
  void **grown = realloc(vec->v, vec->cap * sizeof *grown);
  if (!grown) scr_cyc_oom();
  vec->v = grown;
}

static void scr_cyc_push(ScrVec *vec, void *obj) {
  if (vec->n == vec->cap) scr_cyc_grow(vec);
  vec->v[vec->n++] = obj;
}

/* ── the candidate-root buffers (one per generation) ──────────────────── */

#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_roots[SCR_CYC_NGENS];
static SCR_TL bool scr_collecting = false;
#endif

/* The candidates of the pass in flight, gathered across the generations it
 * collects so the phases can walk them without re-filtering the buffers. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_cands;
#endif

/* Nursery survivors awaiting promotion (see scr_scan_black). */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_promote;
#endif

/* Deferred traces cap recursive traversal without changing the common
 * depth-first walk. Restore can run inside scan, so it has its own stack. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_pending;
static SCR_TL ScrVec scr_restore_pending;
#endif
#define SCR_CYC_WALK_DEPTH 64

/* The gathered white set (freed after the walk completes). */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_white;
#endif

/* Cross-generation targets pinned by the white set (see scr_xg_pin_visit),
 * one entry per skipped edge. Drained after the teardowns. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_xgen;
#endif

/* Objects above this generation are invisible to the pass in flight. */
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_gen_limit = SCR_CYC_OLD;
#endif

static size_t scr_cyc_pass(unsigned gen_limit);

/* ── when to collect ──────────────────────────────────────────────────── */

#define SCR_CYC_NURSERY_CANDIDATES 256 /* nursery trigger */

/* Scheduling decisions run once per pass, never per object, so they are
 * kept out of line and built for size: every executable that can release a
 * cycle-capable value links them, including ones that never form a cycle. */
#define SCR_CYC_SCHEDULING __attribute__((cold, noinline, minsize))

/* Per-pass and cross-generation bookkeeping: work that is proportional to
 * candidates, dead objects or skipped edges and dominated by the calls it
 * makes, never the per-edge graph walk. Built for size for the same reason. */
#define SCR_CYC_COMPACT __attribute__((noinline, minsize))
#define SCR_CYC_GROWTH_DIV 4           /* growth pass per +1/4 of live heap */
#define SCR_CYC_GROWTH_FLOOR 4096      /* ...but not below this many objects */

/* Per level, the live count as of the end of the last pass that walked it:
 * the mature entry is set by mature and full passes, the old entry by full
 * passes. The nursery entry is unused. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_live_after[SCR_CYC_NGENS];
#endif

/* Per level, doublings of the growth fraction (see scr_cyc_adapt_growth),
 * and whether the last growth-triggered pass at that level asked for a wider
 * fraction than the current one. Only the mature and old entries are used.
 *
 * The fraction is capped at 16 (shift 6): after passes at a level stop
 * finding garbage, the heap may grow to 17 times its size after the last
 * pass there before the next. A lower cap bounds dead cyclic garbage more
 * tightly, but a large live heap that keeps growing is then walked in full
 * each time it grows by the cap, and on such heaps (a compiler checking a
 * large program, say) those walks dominate collection time. The cap trades
 * that walking for memory only when passes find nothing: while they find
 * garbage, the yield keeps the fraction narrow. SCR_CYCLE_GROWTH_CAP lowers
 * the cap for memory-sensitive programs: a power of two from 1 to 16, with
 * other positive values rounded down to a power of two and larger ones read
 * as 16. At 1 the heap may at most double past its size after the last pass
 * at a level before the next. */
#define SCR_CYC_GROWTH_MAX_SHIFT 6
#ifndef SCR_WORKERS
static SCR_TL unsigned char scr_cyc_growth_shift[SCR_CYC_NGENS];
static SCR_TL unsigned char scr_cyc_growth_streak[SCR_CYC_NGENS];
#endif

/* Shift of the configured growth cap: 2 + log2(cap), since the base
 * fraction is 1/4. */
static unsigned scr_cyc_growth_max_shift(void) {
  static SCR_TL unsigned char cached = 0;
  if (cached == 0) {
    const char *env = scr_getenv("SCR_CYCLE_GROWTH_CAP");
    long v = env ? strtol(env, NULL, 10) : 0;
    unsigned shift = SCR_CYC_GROWTH_MAX_SHIFT;
    if (v > 0)
      for (shift = 2; shift < SCR_CYC_GROWTH_MAX_SHIFT && (2L << (shift - 2)) <= v;)
        shift++;
    cached = (unsigned char)shift;
  }
  return cached;
}

/* Doublings of each generation's backlog threshold earned by consecutive
 * passes that found almost nothing to free (see scr_cyc_backlog_threshold).
 * Only the mature and old entries are used. */
#define SCR_CYC_BACKLOG_MAX_SHIFT 8
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_cyc_backlog_shift[SCR_CYC_NGENS];
#endif

static size_t scr_cyc_nursery_threshold(void) {
  static SCR_TL size_t cached = 0;
  if (cached == 0) {
    const char *env = scr_getenv("SCR_CYCLE_THRESHOLD");
    long v = env ? strtol(env, NULL, 10) : 0;
    cached = v > 0 ? (size_t)v : SCR_CYC_NURSERY_CANDIDATES;
  }
  return cached;
}

/* Buffered candidates across every generation, and the count at which the
 * release path next collects. Keeping a running total (rather than summing
 * the buffers) is what holds the hot path to one load and one compare, as
 * it was when there was a single buffer. The trigger is re-armed at the end
 * of every pass to "whatever survived, plus a nursery's worth": without that
 * hysteresis a large older buffer — which a nursery pass cannot drain —
 * would re-arm on every single release. Both start at zero, so the first
 * release runs one trivial pass that arms them properly. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_nbuffered = 0;
static SCR_TL size_t scr_cyc_trigger = 0;
#endif

/* Scheduled nursery passes for which at least one mature or old root was
 * waiting. A full pass resets the age; with no such backlog there is nothing
 * to age. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_scheduled_mature_age = 0;
#endif

static size_t scr_cyc_buffered(void) {
  return scr_roots[SCR_CYC_NURSERY].n + scr_roots[SCR_CYC_MATURE].n
         + scr_roots[SCR_CYC_OLD].n;
}

static bool scr_cyc_older_backlog(void) {
  return scr_roots[SCR_CYC_MATURE].n != 0 || scr_roots[SCR_CYC_OLD].n != 0;
}

static size_t scr_cyc_growth_base(size_t live_after) {
  return live_after < SCR_CYC_GROWTH_FLOOR ? SCR_CYC_GROWTH_FLOOR : live_after;
}

/* A pass at `gen` is due once the live heap has grown that level's fraction
 * past what it was when the last pass at that level finished. Since a pass
 * resets its baseline to the live count it leaves behind, an unproductive
 * pass cannot re-trigger itself — the next one waits for another fraction of
 * growth. */
static SCR_CYC_SCHEDULING bool scr_cyc_grown(unsigned gen) {
  size_t base = scr_cyc_growth_base(scr_cyc_live_after[gen]);
  return scr_cyc_live > base + ((base / SCR_CYC_GROWTH_DIV) << scr_cyc_growth_shift[gen]);
}

/* The backlog rule for one generation's candidate buffer.
 *
 * Heap growth is not the only thing that owes a pass. Live data that TURNS
 * INTO garbage — an older structure unlinked into a dead cycle — grows no
 * counter at all: those objects were already tallied in scr_cyc_live when
 * they were allocated, so the growth rules stay false forever, and a
 * restricted pass cannot see them because they sit above its level. Left at
 * that, a program that churns its long-lived structures without allocating
 * would never collect anything. So a buffer's own size is the second trigger
 * for its level, at a fraction of the live heap: that bounds uncollected
 * candidates proportionally and keeps the amortized cost linear (one walk
 * per live/N candidates).
 *
 * Re-buffered live objects cannot be told apart from new garbage until a
 * pass walks them, and a program that keeps traversing one live structure
 * buffers it again after every pass. Each backlog-level pass that frees
 * almost none of its candidates doubles the threshold, so repeated
 * unproductive walks thin out geometrically; once it exceeds the population
 * this trigger rests, leaving heap growth, the scheduled age and exit to
 * collect. That only delays garbage made from existing data: replacing it
 * requires allocation, which grows the heap and trips a growth trigger. The
 * first productive pass at that level restores the original fraction. */
static size_t scr_cyc_backlog_threshold(unsigned gen) {
  size_t t = scr_cyc_live / SCR_CYC_GROWTH_DIV;
  if (t < SCR_CYC_NURSERY_CANDIDATES) t = SCR_CYC_NURSERY_CANDIDATES;
  unsigned shift = scr_cyc_backlog_shift[gen];
  return t > (SIZE_MAX >> shift) ? SIZE_MAX : t << shift;
}

/* Adapt a level's growth fraction to the yield of a growth-triggered pass at
 * that level: `reclaimed` objects found against `growth` objects of heap
 * growth since the previous pass there. Only full passes reclaim the old
 * generation, so a full pass counts old objects alone (younger garbage is the
 * mature level's to find, without walking the old heap); a mature pass counts
 * everything it freed.
 *
 * The fraction is sized so the garbage a level lets float stays near what the
 * base schedule allows. A pass whose yield reaches 1/GROWTH_DIV of the growth
 * keeps the base fraction of 1/4; each halving of the yield below that asks
 * for one doubling of the fraction, up to the cap. A level that keeps
 * reclaiming in proportion to growth therefore stays on the base schedule,
 * while one whose passes walk a large retained structure and find nothing
 * spaces them out geometrically, so its total walking stays a small multiple
 * of the heap it ends with instead of growing with every fraction of growth.
 *
 * Narrowing takes effect at once: a pass that finds garbage again moves the
 * fraction straight to what its yield asks for. Widening waits for two
 * passes in a row that asked for it. A program that discards older
 * structures at a steady rate sees its passes alternate between finding the
 * garbage just aged into the level and finding it still younger, and a
 * single miss says little.
 *
 * How far a qualifying pass widens depends on what the level's passes walk.
 * A full pass walks the whole heap, and a heap that grows for a whole run
 * gets only a handful of them, so widening a doubling per pass spent the
 * largest walks on the way to the cap (a run with seven full passes never
 * reached it). The old level therefore widens two doublings per qualifying
 * pass, never past what the pass asked for: passes that keep finding
 * nothing reach the cap of 16 on the fourth pass instead of the sixth, while
 * the heap is still small. A mature pass walks only what was promoted since
 * the last one, so its total walking hardly depends on how passes are
 * spaced, and the mature level keeps widening a doubling per pass, which
 * lets less young garbage float. */
#define SCR_CYC_OLD_WIDEN_STEP 2
static void scr_cyc_adapt_growth(unsigned gen, size_t growth,
                                 size_t reclaimed) {
  unsigned want = 0, max = scr_cyc_growth_max_shift();
  while (want < max && reclaimed * SCR_CYC_GROWTH_DIV < (growth >> want))
    want++;
  if (want <= scr_cyc_growth_shift[gen]) {
    scr_cyc_growth_shift[gen] = (unsigned char)want;
    scr_cyc_growth_streak[gen] = 0;
  } else if (scr_cyc_growth_streak[gen]) {
    unsigned shift = scr_cyc_growth_shift[gen] + (gen == SCR_CYC_OLD ? SCR_CYC_OLD_WIDEN_STEP : 1);
    scr_cyc_growth_shift[gen] = (unsigned char)(shift < want ? shift : want);
  } else {
    scr_cyc_growth_streak[gen] = 1;
  }
}

/* One scheduled pass at `gen`. A mature or old pass adapts that level's
 * backlog threshold to its yield; the explicit sweep (scr_collect_cycles) is
 * not a scheduling decision and leaves the thresholds alone. Productive means
 * at least one object freed per GROWTH_DIV candidates; a pass with no
 * candidates says nothing. A pass that its level's growth rule triggered also
 * adapts that level's growth fraction (scr_cyc_adapt_growth).
 *
 * Every level shares this one body, so a program that links the collector
 * carries a single copy of the scheduling logic. */
static SCR_CYC_SCHEDULING void scr_cyc_scheduled_pass(unsigned gen, bool by_growth) {
  size_t base = scr_cyc_growth_base(scr_cyc_live_after[gen]);
  size_t growth = scr_cyc_live > base ? scr_cyc_live - base : 0;
  size_t old_freed_before = scr_cyc_old_freed;
  size_t freed = scr_cyc_pass(gen);
  if (gen == SCR_CYC_NURSERY) return;
  if (scr_cands.n != 0) {
    if (freed * SCR_CYC_GROWTH_DIV >= scr_cands.n)
      scr_cyc_backlog_shift[gen] = 0;
    else if (scr_cyc_backlog_shift[gen] < SCR_CYC_BACKLOG_MAX_SHIFT)
      scr_cyc_backlog_shift[gen]++;
  }
  if (by_growth)
    scr_cyc_adapt_growth(gen, growth,
                         gen == SCR_CYC_OLD ? scr_cyc_old_freed - old_freed_before : freed);
}

/* Cold half of the release path: pick the level and collect. It runs once
 * per pass, so it is kept out of line and built for size, which leaves the
 * hot buffering path in scr_cyc_on_release small. */
static SCR_CYC_SCHEDULING void scr_cyc_collect_due(void) {
  unsigned gen = SCR_CYC_OLD;
  bool by_growth = scr_cyc_grown(SCR_CYC_OLD);
  if (!by_growth && scr_roots[SCR_CYC_OLD].n < scr_cyc_backlog_threshold(SCR_CYC_OLD)) {
    gen = SCR_CYC_MATURE;
    by_growth = scr_cyc_grown(SCR_CYC_MATURE);
    if (!by_growth && scr_roots[SCR_CYC_MATURE].n < scr_cyc_backlog_threshold(SCR_CYC_MATURE))
      gen = SCR_CYC_NURSERY;
  }
  scr_cyc_scheduled_pass(gen, by_growth);
}

/* One scheduled pass, for callers that reach a natural collection point
 * (the event loop between turns) rather than a threshold. Deliberately NOT
 * scr_collect_cycles: that one is the exit-time full sweep, and running it
 * per turn would walk the whole live heap every turn — which is exactly the
 * cost the generations exist to avoid. */
void scr_cyc_collect_scheduled(void) {
  if (scr_cyc_buffered() == 0) {
    scr_cyc_scheduled_mature_age = 0;
    return;
  }
  if (!scr_cyc_older_backlog()) {
    scr_cyc_scheduled_mature_age = 0;
  } else if (++scr_cyc_scheduled_mature_age
             >= scr_cyc_nursery_threshold()) {
    scr_cyc_scheduled_pass(SCR_CYC_OLD, false);
    return;
  }
  scr_cyc_collect_due();
}

void scr_cyc_on_dead(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (!h->buffered) return;
  /* O(1) removal: swap the last entry into the hole. A buffered object's
   * generation never changes (promotion runs only on objects the pass has
   * already drained from the buffers), so `gen` names the right one. */
  ScrVec *b = &scr_roots[h->gen];
  size_t i = h->buf_index;
  void *last = b->v[--b->n];
  b->v[i] = last;
  if (last != obj) scr_cyc_hdr(last)->buf_index = i;
  h->buffered = 0;
  scr_cyc_nbuffered--;
  /* A death must not consume room reserved for a future candidate. */
  scr_cyc_trigger--;
  if (h->gen != SCR_CYC_NURSERY && !scr_cyc_older_backlog())
    scr_cyc_scheduled_mature_age = 0;
}

/* Every release that leaves an unbuffered object alive lands here (the
 * emitted and inline release paths test `buffered` first), so it stays what
 * it has always been: buffer inline, then one compare. */
void scr_cyc_on_release(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  /* Releasing an existing candidate cannot advance the trigger. A pass
   * always re-arms after its teardowns, including any candidates they add. */
  if (h->buffered) return;
  ScrVec *b = &scr_roots[h->gen];
  if (b->n == b->cap) scr_cyc_grow(b);
  h->buffered = 1;
  h->buf_index = b->n;
  b->v[b->n++] = obj;
  scr_cyc_nbuffered++;
  /* Never re-entered: a teardown's releases of untraced children can buffer
   * new candidates mid-collection, but they only wait for the next pass. */
  if (!scr_collecting && scr_cyc_nbuffered >= scr_cyc_trigger)
    scr_cyc_collect_due();
}

/* ── trial deletion ───────────────────────────────────────────────────── */

/* Child filter shared by every phase — and it MUST be shared by every
 * phase: scan restores exactly the trial decrements markGray made, so the
 * two must agree on which edges are internal. Nothing to do for NULL
 * (unassigned slots), immortal (interned statics have no header at all), or
 * a generation this pass does not collect. */
#define SCR_CYC_SKIP(child)                     \
  ((child) == NULL || SCR_RC(child) == SIZE_MAX \
   || scr_cyc_hdr(child)->gen > scr_gen_limit)

/* Trace callbacks forward an integer depth through their opaque context;
 * it is never dereferenced. The ABI already carries it through every edge. */
static void scr_mark_gray(void *obj, uintptr_t depth);
static void scr_mg_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) -= 1;
  scr_mark_gray(child, (uintptr_t)ctx);
}
static void scr_mark_gray(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color == SCR_CYC_GRAY) return;
  h->color = SCR_CYC_GRAY;
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_pending, obj);
    return;
  }
  h->trace(obj, scr_mg_visit, (void *)(depth + 1));
}

static void scr_scan_black(void *obj, uintptr_t depth);
static void scr_sb_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) += 1;
  if (scr_cyc_hdr(child)->color != SCR_CYC_BLACK)
    scr_scan_black(child, (uintptr_t)ctx);
}
static void scr_scan_black(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->color = SCR_CYC_BLACK;
  if (h->gen < SCR_CYC_OLD) scr_cyc_push(&scr_promote, obj);
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_restore_pending, obj);
    return;
  }
  h->trace(obj, scr_sb_visit, (void *)(depth + 1));
}

static void scr_scan(void *obj, uintptr_t depth);
static void scr_scan_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  scr_scan(child, (uintptr_t)ctx);
}
static void scr_scan(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color != SCR_CYC_GRAY) return;
  if (SCR_RC(obj) > 0) {
    scr_scan_black(obj, 0);
    while (scr_restore_pending.n) {
      void *next = scr_restore_pending.v[--scr_restore_pending.n];
      scr_cyc_hdr(next)->trace(next, scr_sb_visit, NULL);
    }
    return;
  }
  h->color = SCR_CYC_WHITE;
  /* Record each whitened object once. A later outside root can restore it;
   * filter the list only after every scan finishes. No gather trace needed. */
  scr_cyc_push(&scr_white, obj);
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_pending, obj);
    return;
  }
  h->trace(obj, scr_scan_visit, (void *)(depth + 1));
}

/* ── cross-generation edges ───────────────────────────────────────────── */

/* A restricted pass leaves one edge unaccounted, and it is the one edge that
 * nothing else accounts either. markGray does not trial-delete an edge into a
 * generation it refused to walk (SCR_CYC_SKIP), and the teardown contract has
 * free_fn release exactly the UNTRACED children — because every traced edge
 * was supposed to have been decremented by markGray. So when a white object
 * holds a traced edge into an older generation, freeing it drops the edge
 * while the target keeps the count: a phantom reference that reads as an
 * external one to every later pass, full ones included. The target and
 * everything under it would never be reclaimable again.
 *
 * So the white set pays those edges off explicitly. The walk cannot do it
 * inline — a release there could free a survivor that scr_promote still
 * points at, or cascade into the white set mid-teardown — so it runs in two
 * halves: PIN each target with a retain while `gen` still holds walk-time
 * values, then DROP THE PIN AND GIVE UP THE EDGE after the teardowns, when
 * generations have settled and the white set is gone. Two decrements per
 * entry, because the pin is one of them — a single release would only undo
 * the pin and leave the phantom edge exactly where it was. The pin is what
 * makes the second decrement safe: a teardown's releases of untraced
 * children can reach a cycle-headered object (that is how they re-buffer
 * survivors), so without it a target could be freed before the drain runs.
 *
 * One entry per skipped edge, so several edges sharing a target settle it
 * once each.
 *
 * Nothing pinned here can be in the white set: a skipped older object's
 * edges were never trial-deleted, so anything it references kept that count
 * and was scan-blacked rather than whitened — the same conservatism that
 * makes restricting the walk sound in the first place. */
static SCR_CYC_COMPACT void scr_xg_pin_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  if (scr_cyc_hdr(child)->gen <= scr_gen_limit) return; /* markGray had it */
  SCR_RC(child) += 1; /* pin across the teardowns */
  scr_cyc_push(&scr_xgen, child);
}

/* Freed by the cross-generation drain, for the caller's fixpoint. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_xg_freed = 0;
#endif

static void scr_xg_release(void *obj);
static void scr_xg_child_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  scr_xg_release(child);
}

/* One genuine release, generically: the header carries everything needed. */
static void scr_xg_destroy(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->trace(obj, scr_xg_child_visit, NULL);
  h->free_fn(obj);
  scr_xg_freed++;
}

static SCR_CYC_COMPACT void scr_xg_release(void *obj) {
  if (SCR_RC(obj) > 1) {
    SCR_RC(obj) -= 1;
    scr_cyc_on_release(obj); /* lost a reference: a possible cycle root */
    return;
  }
  SCR_RC(obj) = 0;
  scr_cyc_on_dead(obj); /* out of its candidate buffer before the block goes */
  scr_rc_destroy(obj, scr_xg_destroy);
}

/* One pass over every candidate at or below `gen_limit`; returns how many
 * objects it freed. */
/* The second half of a pass: settle the white set, promote, re-buffer,
 * tear down and re-arm. Its loops run once per candidate or dead object and
 * spend their time in the trace and teardown calls they make, so this half is
 * built for size; the graph walk above it stays fully optimized. Returns how
 * many objects the pass freed. */
static SCR_CYC_COMPACT size_t scr_cyc_settle(unsigned gen_limit) {
  size_t dead = 0;
  for (size_t i = 0; i < scr_white.n; i++) {
    void *obj = scr_white.v[i];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    if (h->color != SCR_CYC_WHITE) continue;
    h->color = SCR_CYC_DOOMED;
    scr_white.v[dead++] = obj;
  }
  scr_white.n = dead;

  /* Pin the cross-generation targets of everything about to be freed, while
   * `gen` still holds the values the walk filtered on (promotion below is
   * what changes them). A full pass skips no edge, so it pins nothing. */
  scr_xgen.n = 0;
  if (gen_limit < SCR_CYC_OLD) {
    for (size_t i = 0; i < scr_white.n; i++) {
      void *obj = scr_white.v[i];
      scr_cyc_hdr(obj)->trace(obj, scr_xg_pin_visit, NULL);
    }
  }

  /* Every phase that consults SCR_CYC_SKIP has run, so the recorded
   * survivors can graduate now, one generation each. They are externally
   * referenced, so none of them is in the white set about to be freed. */
  for (size_t i = 0; i < scr_promote.n; i++) {
    ScrCycHdr *h = scr_cyc_hdr(scr_promote.v[i]);
    if (h->gen < SCR_CYC_OLD) h->gen++;
  }
  scr_promote.n = 0;

  /* A restricted pass may have spared a candidate only because the edge
   * keeping it alive came from a generation it refused to walk — the
   * deliberate conservatism above. But the candidate buffer is the ONLY
   * root set this collector has, and markRoots consumed the entry. Dropping
   * it would retire the one record that this object is a possible cycle
   * root, and a dead cycle whose members all got spared that way would
   * never be walked again by any pass, full ones included. So a restricted
   * pass hands its survivors back as candidates in the generation they were
   * just promoted into, where a later pass at that level — and in the end a
   * full pass, which skips nothing and so judges them on real reference
   * counts — will settle them. A full pass
   * needs none of this: it walked every edge, so rc > 0 there means a
   * genuine outside reference and Bacon-Rajan's own reasoning retires the
   * candidate. Re-buffering costs a walk, never correctness: an object that
   * is truly live survives the next pass at its level and is dropped then. */
  if (gen_limit < SCR_CYC_OLD) {
    for (size_t i = 0; i < scr_cands.n; i++) {
      void *obj = scr_cands.v[i];
      ScrCycHdr *h = scr_cyc_hdr(obj);
      if (h->color == SCR_CYC_DOOMED) continue; /* being freed below */
      if (!h->buffered) {
        h->buffered = 1;
        h->buf_index = scr_roots[h->gen].n;
        scr_cyc_push(&scr_roots[h->gen], obj);
      }
    }
  }

  /* Teardowns run after the full walk. They may release untraced children
   * (plain RC) — which can re-buffer survivors for the NEXT pass — but
   * never touch traced (white, already-accounted) edges. */
  size_t freed = scr_white.n;
  for (size_t i = 0; i < scr_white.n; i++) {
    void *obj = scr_white.v[i];
    scr_cyc_hdr(obj)->free_fn(obj);
  }
  scr_white.n = 0;

  /* Now drain the pins: the white set is gone and generations have settled,
   * so each of those edges can be given up for real. A target that survives
   * lands back in the candidate buffer — it just lost a reference, which is
   * exactly what makes an object a possible cycle root. */
  scr_xg_freed = 0;
  for (size_t i = 0; i < scr_xgen.n; i++) {
    void *obj = scr_xgen.v[i];
    /* Drop the pin first. The phantom edge is still counted, so this cannot
     * reach zero and the release below is the one that settles the object. */
    SCR_RC(obj) -= 1;
    scr_xg_release(obj);
  }
  scr_xgen.n = 0;
  freed += scr_xg_freed;

  if (gen_limit >= SCR_CYC_MATURE) scr_cyc_live_after[SCR_CYC_MATURE] = scr_cyc_live;
  if (gen_limit >= SCR_CYC_OLD) {
    scr_cyc_live_after[SCR_CYC_OLD] = scr_cyc_live;
    scr_cyc_scheduled_mature_age = 0;
  }
  /* markRoots drained buffers in bulk and teardowns moved the count around;
   * resync from the buffers themselves and re-arm. */
  scr_cyc_nbuffered = scr_cyc_buffered();
  scr_cyc_trigger = scr_cyc_nbuffered + scr_cyc_nursery_threshold();
  scr_collecting = false;
  return freed;
}

/* ── parallel trial deletion for large passes ─────────────────────────
 * A full pass over a large heap walks every live object twice (markGray,
 * then scan restoring the counts) and is bound by cache misses, so it
 * parallelizes like any marking phase. The pass stays stop-the-world for its
 * own thread: the owner blocks while helper threads run markRoots, markGray
 * and scan with it, then settles (white filtering, promotion, re-buffering,
 * teardown, re-arming) alone, so every free_fn, weak-reference disposal and
 * FinalizationRegistry notification still runs on the owner thread, at the
 * same point of the program as before.
 *
 * The result is the sequential algorithm's partition. MARK: each node is
 * claimed once per phase by an atomic exchange of its color (read first, so
 * already-claimed nodes, which are most targets, are not dirtied), and each
 * internal edge is trial-deleted once by an atomic decrement; every grayed
 * node lands on its claimer's gray list. SCAN starts only after every
 * decrement (a phase barrier): a gray node whose count stayed positive is
 * externally referenced, and it and everything gray it reaches are
 * blackened, each node once (atomic exchange), restoring its edges once.
 * WHITE: whatever is still gray is reachable only from garbage. That is the
 * sequential scan's answer (white = gray and not reachable from a gray node
 * with a positive count) without its provisional whitening, which under
 * contention would whiten live subgraphs that a black wave then traces
 * again. Only the order of teardowns within a pass can differ, and that
 * order is unspecified. Parallel passes are full passes, which skip no
 * generation, so survivors are promoted as they are blackened.
 *
 * Helpers touch only counts, colors, `buffered`, `gen` and the objects'
 * fields, through trace functions, which are reads (scr_dyn_trace_v also
 * records its per-entry edge decision, on the one worker that traces the
 * object in that phase). Only the owner's heap is walked: script objects
 * point into another thread's heap only through immortal (published)
 * objects, which the filter skips, and other threads never touch this heap,
 * so other script threads keep running.
 *
 * Helpers are taken only from idle CPUs: CPUs available to the process
 * minus its threads that are running or runnable (counted once per large
 * pass: /proc/self/task on Linux, the Mach thread list on Darwin), so a
 * process whose script threads already occupy every core collects
 * sequentially. One parallel pass runs at a time per process; another
 * thread's large pass meanwhile walks sequentially. Helpers are created on
 * first use and sleep between passes; small heaps never create any.
 *
 * Executables built with --optimization=speed on Linux and Darwin carry it
 * (the runtime pack's speed flavor defines SCR_SPEED), worker executables or
 * not; all of them link with -pthread already. It costs nothing at startup
 * but 4-10 KiB of code, a tenth of a small program, so the default release
 * runtime stays sequential. Library archives never carry it: an embedding
 * host's threads are its own.
 *
 * SCR_CYCLE_PARALLEL caps the helpers (0 walks every pass sequentially; at
 * most 15, and one less than the CPUs by default). SCR_CYCLE_PARALLEL_MIN
 * sets the live cycle-headered object count from which a full pass may run
 * in parallel (100000 by default). Both are read once per process. */
#ifndef SCR_CYC_PARALLEL
#if defined(SCR_SPEED) && !defined(SCR_LIB) && (defined(__linux__) || defined(__APPLE__))
#define SCR_CYC_PARALLEL 1
#else
#define SCR_CYC_PARALLEL 0
#endif
#endif

#if SCR_CYC_PARALLEL
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <string.h>
#include <unistd.h>
#ifdef __linux__
#include <dirent.h>
#include <fcntl.h>
#include <sched.h>
#elif defined(__APPLE__)
#include <mach/mach.h>
#endif

#define SCR_PAR_MAX 16      /* workers, owner included */
#define SCR_PAR_CHUNK 128   /* work items moved between workers at once */
#define SCR_PAR_SEED 32     /* candidates claimed at once */
#define SCR_PAR_MIN_LIVE 100000

enum { SCR_PAR_MARK = 1, SCR_PAR_SCAN = 2, SCR_PAR_WHITE = 3 };

typedef struct ScrParChunk {
  struct ScrParChunk *next;
  size_t n;
  void *v[SCR_PAR_CHUNK];
} ScrParChunk;

/* One cache-line pair per worker: every push and pop writes `stack.n`. */
typedef struct {
  _Alignas(128) ScrVec stack; /* objects to trace in the current phase */
  ScrVec gray;                /* every node this worker grayed */
  ScrVec white;
} ScrParWorker;

/* Process-wide; everything but the busy flag is used only by the thread
 * that holds it, its helpers, and (under `mu`/`pool_mu`) their handshakes. */
static struct {
  pthread_mutex_t mu;
  pthread_cond_t start, done;
  unsigned created, epoch, want, joined, running;
  int phase;
  pthread_mutex_t pool_mu;
  pthread_cond_t pool_cv;
  ScrParChunk *pool, *spare;
  unsigned idle, nworkers;
  bool finished;
  bool configured;
  unsigned cap, cpus;
  size_t min_live;
  void **cands;
  size_t ncands;
  atomic_size_t next;
} scr_par = {
  .mu = PTHREAD_MUTEX_INITIALIZER,
  .start = PTHREAD_COND_INITIALIZER,
  .done = PTHREAD_COND_INITIALIZER,
  .pool_mu = PTHREAD_MUTEX_INITIALIZER,
  .pool_cv = PTHREAD_COND_INITIALIZER,
};
/* Zero-initialized, so it costs no file size (the mutex initializers keep
 * scr_par itself in initialized data on Darwin). */
static ScrParWorker scr_par_w[SCR_PAR_MAX];
static atomic_flag scr_par_busy = ATOMIC_FLAG_INIT;

#define SCR_PAR_RC(obj) ((size_t *)(obj))
/* Parallel passes are full passes: no generation is skipped, so the filter
 * is NULL and immortal, and survivors can be promoted the moment they are
 * blackened (nothing consults `gen` again before settle). */
#define SCR_PAR_SKIP(child) \
  ((child) == NULL || __atomic_load_n(SCR_PAR_RC(child), __ATOMIC_RELAXED) == SIZE_MAX)

static inline void scr_par_push(ScrParWorker *w, void *item) {
  if (w->stack.n == w->stack.cap) scr_cyc_grow(&w->stack);
  w->stack.v[w->stack.n++] = item;
}

/* Hand the top of a long local stack to idle workers. */
static void scr_par_share(ScrParWorker *w) {
  if (w->stack.n < 2 * SCR_PAR_CHUNK || __atomic_load_n(&scr_par.idle, __ATOMIC_RELAXED) == 0) return;
  pthread_mutex_lock(&scr_par.pool_mu);
  ScrParChunk *c = scr_par.spare;
  if (c) scr_par.spare = c->next;
  else if (!(c = malloc(sizeof *c))) scr_cyc_oom();
  c->n = SCR_PAR_CHUNK;
  w->stack.n -= SCR_PAR_CHUNK;
  memcpy(c->v, w->stack.v + w->stack.n, sizeof c->v);
  c->next = scr_par.pool;
  scr_par.pool = c;
  pthread_cond_signal(&scr_par.pool_cv);
  pthread_mutex_unlock(&scr_par.pool_mu);
}

/* Out of local work: take a shared chunk, or detect the end of the phase
 * (every worker idle with nothing shared; candidates are seeded before a
 * worker ever gets here). */
static bool scr_par_take(ScrParWorker *w) {
  pthread_mutex_lock(&scr_par.pool_mu);
  __atomic_store_n(&scr_par.idle, scr_par.idle + 1, __ATOMIC_RELAXED);
  for (;;) {
    if (scr_par.pool) {
      ScrParChunk *c = scr_par.pool;
      scr_par.pool = c->next;
      __atomic_store_n(&scr_par.idle, scr_par.idle - 1, __ATOMIC_RELAXED);
      while (w->stack.cap < w->stack.n + c->n) scr_cyc_grow(&w->stack);
      memcpy(w->stack.v + w->stack.n, c->v, c->n * sizeof(void *));
      w->stack.n += c->n;
      c->next = scr_par.spare;
      scr_par.spare = c;
      pthread_mutex_unlock(&scr_par.pool_mu);
      return true;
    }
    if (scr_par.finished) break;
    if (scr_par.idle == scr_par.nworkers) {
      scr_par.finished = true;
      pthread_cond_broadcast(&scr_par.pool_cv);
      break;
    }
    pthread_cond_wait(&scr_par.pool_cv, &scr_par.pool_mu);
  }
  pthread_mutex_unlock(&scr_par.pool_mu);
  return false;
}

static inline void scr_par_gray(ScrParWorker *w, void *obj) {
  uint32_t *color = &scr_cyc_hdr(obj)->color;
  if (__atomic_load_n(color, __ATOMIC_RELAXED) == SCR_CYC_GRAY) return;
  if (__atomic_exchange_n(color, SCR_CYC_GRAY, __ATOMIC_RELAXED) != SCR_CYC_GRAY) {
    scr_cyc_push(&w->gray, obj);
    scr_par_push(w, obj);
  }
}
static void scr_par_mg_visit(void *child, void *ctx) {
  ScrParWorker *w = ctx;
  if (SCR_PAR_SKIP(child)) return;
  __atomic_fetch_sub(SCR_PAR_RC(child), 1, __ATOMIC_RELAXED);
  scr_par_gray(w, child);
}

static inline void scr_par_black(ScrParWorker *w, void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (__atomic_exchange_n(&h->color, SCR_CYC_BLACK, __ATOMIC_RELAXED) == SCR_CYC_BLACK) return;
  if (h->gen < SCR_CYC_OLD) h->gen++; /* promote now (see SCR_PAR_SKIP) */
  scr_par_push(w, obj);
}
static void scr_par_sb_visit(void *child, void *ctx) {
  ScrParWorker *w = ctx;
  if (SCR_PAR_SKIP(child)) return;
  __atomic_fetch_add(SCR_PAR_RC(child), 1, __ATOMIC_RELAXED);
  if (__atomic_load_n(&scr_cyc_hdr(child)->color, __ATOMIC_RELAXED) != SCR_CYC_BLACK)
    scr_par_black(w, child);
}

static void scr_par_drain(ScrParWorker *w, int phase) {
  while (w->stack.n) {
    void *obj = w->stack.v[--w->stack.n];
    scr_cyc_hdr(obj)->trace(obj, phase == SCR_PAR_MARK ? scr_par_mg_visit : scr_par_sb_visit, w);
    scr_par_share(w);
  }
}

/* One worker's share of a phase (see the section comment). */
static void scr_par_run(ScrParWorker *w, int phase) {
  if (phase == SCR_PAR_WHITE) {
    for (size_t i = 0; i < w->gray.n; i++) {
      ScrCycHdr *h = scr_cyc_hdr(w->gray.v[i]);
      if (h->color != SCR_CYC_GRAY) continue;
      h->color = SCR_CYC_WHITE;
      scr_cyc_push(&w->white, w->gray.v[i]);
    }
    w->gray.n = 0;
    return;
  }
  if (phase == SCR_PAR_SCAN) {
    /* Seeds: this worker's own gray nodes (the lists are balanced by
     * construction); propagation work is shared through the pool. */
    for (size_t i = 0; i < w->gray.n; i++) {
      void *obj = w->gray.v[i];
      if (__atomic_load_n(&scr_cyc_hdr(obj)->color, __ATOMIC_RELAXED) == SCR_CYC_GRAY
          && __atomic_load_n(SCR_PAR_RC(obj), __ATOMIC_RELAXED) > 0)
        scr_par_black(w, obj);
      if (w->stack.n >= SCR_PAR_CHUNK) scr_par_drain(w, phase);
    }
  }
  for (;;) {
    scr_par_drain(w, phase);
    if (phase == SCR_PAR_MARK) {
      size_t i = atomic_fetch_add_explicit(&scr_par.next, SCR_PAR_SEED, memory_order_relaxed);
      if (i < scr_par.ncands) {
        size_t end = i + SCR_PAR_SEED < scr_par.ncands ? i + SCR_PAR_SEED : scr_par.ncands;
        for (; i < end; i++) {
          void *obj = scr_par.cands[i];
          scr_cyc_hdr(obj)->buffered = 0; /* markRoots, spread over the workers */
          scr_par_gray(w, obj);
        }
        continue;
      }
    }
    if (!scr_par_take(w)) return;
  }
}

static void *scr_par_helper(void *arg) {
  (void)arg;
  unsigned seen = 0;
  pthread_mutex_lock(&scr_par.mu);
  for (;;) {
    while (scr_par.epoch == seen) pthread_cond_wait(&scr_par.start, &scr_par.mu);
    seen = scr_par.epoch;
    if (scr_par.joined >= scr_par.want) continue;
    unsigned slot = 1 + scr_par.joined++;
    int phase = scr_par.phase;
    pthread_mutex_unlock(&scr_par.mu);
    scr_par_run(&scr_par_w[slot], phase);
    pthread_mutex_lock(&scr_par.mu);
    if (--scr_par.running == 0) pthread_cond_signal(&scr_par.done);
  }
  return NULL;
}

static size_t scr_par_env(const char *name, size_t dflt) {
  const char *v = scr_getenv(name);
  return v && *v ? (size_t)strtoull(v, NULL, 10) : dflt;
}

static unsigned scr_par_cpus(void) {
#if defined(__linux__) && defined(CPU_COUNT) /* CPU_COUNT needs _GNU_SOURCE */
  cpu_set_t set;
  if (sched_getaffinity(0, sizeof set, &set) == 0) return (unsigned)CPU_COUNT(&set);
#endif
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  return n > 0 ? (unsigned)n : 1;
}

/* Threads of this process that are running or runnable right now, the
 * caller included. */
static unsigned scr_par_running(void) {
  unsigned running = 0;
#ifdef __linux__
  DIR *d = opendir("/proc/self/task");
  if (!d) return 1;
  struct dirent *e;
  char path[64], buf[512];
  while ((e = readdir(d))) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    snprintf(path, sizeof path, "/proc/self/task/%s/stat", e->d_name);
    int fd = open(path, O_RDONLY);
    if (fd < 0) continue;
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) continue;
    buf[n] = 0;
    char *p = strrchr(buf, ')'); /* the command name may contain anything */
    if (p && p[1] == ' ' && p[2] == 'R') running++;
  }
  closedir(d);
#elif defined(__APPLE__)
  thread_act_array_t threads;
  mach_msg_type_number_t n = 0;
  if (task_threads(mach_task_self(), &threads, &n) != KERN_SUCCESS) return 1;
  for (mach_msg_type_number_t i = 0; i < n; i++) {
    thread_basic_info_data_t info;
    mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
    if (thread_info(threads[i], THREAD_BASIC_INFO, (thread_info_t)&info, &count) == KERN_SUCCESS
        && info.run_state == TH_STATE_RUNNING && !(info.flags & TH_FLAGS_IDLE))
      running++;
    mach_port_deallocate(mach_task_self(), threads[i]);
  }
  vm_deallocate(mach_task_self(), (vm_address_t)threads, n * sizeof *threads);
#endif
  return running ? running : 1;
}

/* Helpers this pass may use: idle CPUs, up to the cap. Creates helper
 * threads on first use. Called with the busy flag held. */
static unsigned scr_par_helpers(void) {
  if (scr_par.cap == 0) return 0;
  unsigned running = scr_par_running();
  unsigned idle = scr_par.cpus > running ? scr_par.cpus - running : 0;
  unsigned want = idle < scr_par.cap ? idle : scr_par.cap;
  if (scr_par.created >= want) return want;
  /* Helpers never run script code: keep every signal on the threads that
   * do. A new thread inherits its creator's mask. */
  sigset_t all, old;
  sigfillset(&all);
  pthread_sigmask(SIG_BLOCK, &all, &old);
  while (scr_par.created < want) {
    pthread_t t;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 256 << 10);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    int rc = pthread_create(&t, &attr, scr_par_helper, NULL);
    pthread_attr_destroy(&attr);
    if (rc != 0) break;
    scr_par.created++;
  }
  pthread_sigmask(SIG_SETMASK, &old, NULL);
  return want < scr_par.created ? want : scr_par.created;
}

static void scr_par_phase(int phase, unsigned helpers) {
  scr_par.pool = NULL;
  scr_par.idle = 0;
  scr_par.finished = false;
  scr_par.nworkers = 1 + helpers;
  atomic_store_explicit(&scr_par.next, 0, memory_order_relaxed);
  pthread_mutex_lock(&scr_par.mu);
  scr_par.phase = phase;
  scr_par.want = helpers;
  scr_par.joined = 0;
  scr_par.running = helpers;
  scr_par.epoch++;
  pthread_cond_broadcast(&scr_par.start);
  pthread_mutex_unlock(&scr_par.mu);
  scr_par_run(&scr_par_w[0], phase);
  pthread_mutex_lock(&scr_par.mu);
  while (scr_par.running) pthread_cond_wait(&scr_par.done, &scr_par.mu);
  pthread_mutex_unlock(&scr_par.mu);
}

static void scr_par_merge(ScrVec *into, ScrVec *from) {
  while (into->cap < into->n + from->n) scr_cyc_grow(into);
  if (from->n) memcpy(into->v + into->n, from->v, from->n * sizeof(void *));
  into->n += from->n;
  from->n = 0;
}

/* markRoots, markGray and scan of the pass in flight, in parallel, when it
 * is large enough and CPUs are idle. False: nothing was done (the buffers
 * are untouched), walk sequentially. */
static bool scr_par_walk(unsigned gen_limit) {
  if (gen_limit < SCR_CYC_OLD) return false;
  if (atomic_flag_test_and_set(&scr_par_busy)) return false; /* another thread's pass has them */
  if (!scr_par.configured) {
    scr_par.configured = true;
    scr_par.cpus = scr_par_cpus();
    size_t cap = scr_par_env("SCR_CYCLE_PARALLEL", scr_par.cpus > 1 ? scr_par.cpus - 1 : 0);
    scr_par.cap = cap > SCR_PAR_MAX - 1 ? SCR_PAR_MAX - 1 : (unsigned)cap;
    scr_par.min_live = scr_par_env("SCR_CYCLE_PARALLEL_MIN", SCR_PAR_MIN_LIVE);
  }
  unsigned helpers = scr_cyc_live < scr_par.min_live ? 0 : scr_par_helpers();
  if (helpers == 0) {
    atomic_flag_clear(&scr_par_busy);
    return false;
  }
  /* markRoots without the per-candidate header store: the buffers are
   * copied wholesale and the workers clear `buffered` as they seed. */
  scr_cands.n = 0;
  for (unsigned g = 0; g <= gen_limit; g++) scr_par_merge(&scr_cands, &scr_roots[g]);
  scr_par.cands = scr_cands.v;
  scr_par.ncands = scr_cands.n;
  scr_par_phase(SCR_PAR_MARK, helpers);
  scr_par_phase(SCR_PAR_SCAN, helpers);
  scr_par_phase(SCR_PAR_WHITE, helpers);
  scr_white.n = 0;
  for (unsigned i = 0; i <= helpers; i++) {
    ScrParWorker *w = &scr_par_w[i];
    scr_par_merge(&scr_white, &w->white);
    /* A deep walk can leave a large stack behind; do not keep it. */
    if (w->stack.cap > (1u << 16)) {
      free(w->stack.v);
      w->stack = (ScrVec){0};
    }
    if (w->gray.cap > (1u << 20)) {
      free(w->gray.v);
      w->gray = (ScrVec){0};
    }
  }
  atomic_flag_clear(&scr_par_busy);
  return true;
}
#endif

static size_t scr_cyc_pass(unsigned gen_limit) {
  if (scr_collecting) return 0;
  scr_collecting = true;
  scr_gen_limit = gen_limit;
#if SCR_CYC_PARALLEL
  if (scr_par_walk(gen_limit)) return scr_cyc_settle(gen_limit);
#endif

  /* markRoots: every buffered entry is a candidate (retains do not mark
   * candidates live; measured on the tsc-ts self-check, that filter dropped
   * almost none, and it cost a header store per retain). Drain the buffers
   * before walking: tracing only adjusts counts and worklists, so nothing
   * can re-buffer underneath us. Candidates ABOVE the limit keep their
   * slots and wait for a pass at their own level. */
  scr_cands.n = 0;
  for (unsigned g = 0; g <= gen_limit; g++) {
    for (size_t i = 0; i < scr_roots[g].n; i++) {
      void *obj = scr_roots[g].v[i];
      ScrCycHdr *h = scr_cyc_hdr(obj);
      h->buffered = 0;
      scr_cyc_push(&scr_cands, obj);
    }
    scr_roots[g].n = 0;
  }
  for (size_t i = 0; i < scr_cands.n; i++) scr_mark_gray(scr_cands.v[i], 0);
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    scr_cyc_hdr(obj)->trace(obj, scr_mg_visit, NULL);
  }

  scr_white.n = 0;
  for (size_t i = 0; i < scr_cands.n; i++) scr_scan(scr_cands.v[i], 0);
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    /* A later outside root may have restored this deferred white node and
     * its descendants already. Never scan a black node's edges again. */
    if (scr_cyc_hdr(obj)->color == SCR_CYC_WHITE)
      scr_cyc_hdr(obj)->trace(obj, scr_scan_visit, NULL);
  }

  return scr_cyc_settle(gen_limit);
}

void scr_collect_cycles(void) {
  /* The full pass, run to a fixpoint. A teardown's releases can drop the
   * last reference to a further cycle, so one pass does not always drain
   * everything reclaimable — and the callers that matter (program exit,
   * library session reset) are immediately followed by the RC audit and
   * want nothing reclaimable left behind. Only a pass that freed something
   * can have buffered anything new, so a pass that comes up empty ends
   * this; and since each repeat needs a strictly smaller live heap to
   * continue, it terminates. */
  while (scr_cyc_pass(SCR_CYC_OLD) && scr_cyc_buffered()) {
  }
}

/* Worker TLS becomes unreachable when its OS thread returns. Release the
 * reusable traversal buffers after all context-owned roots are retired. */
void scr_cyc_context_cleanup(void) {
  scr_collect_cycles();
  ScrVec *vectors[] = {&scr_roots[SCR_CYC_NURSERY], &scr_roots[SCR_CYC_MATURE],
    &scr_roots[SCR_CYC_OLD], &scr_cands, &scr_promote, &scr_pending, &scr_restore_pending, &scr_white, &scr_xgen};
  for (size_t i = 0; i < sizeof vectors / sizeof vectors[0]; i++) {
    free(vectors[i]->v);
    *vectors[i] = (ScrVec){0};
  }
}
