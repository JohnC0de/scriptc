/* Publication (@scriptc/threads publish): the graph walk that makes object
 * graphs immortal and immutable, and the frozen-object TypeErrors of the
 * emitted write guards. Kept out of scr_cycle.c so the collector unit links
 * without the string, number, dyn and exception runtimes. */

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── publication: immortal, immutable graphs (@scriptc/threads publish) ──
 * publish(root) walks everything the root reaches and makes it immortal:
 * rc == SIZE_MAX, so every retain and release skips it, the collector never
 * walks into it (SCR_CYC_SKIP) and nothing frees it, and the objects leave
 * this thread's candidate and tenured buffers. Immortal objects are never
 * written again (the emitted stores into publishable types throw the frozen-
 * object TypeError), which is what lets postMessage and workerData share
 * them with other threads by pointer.
 *
 * The compiler emits one walker per static type (llvm/publish.ts). A walker
 * marks its object through scr_pub_mark and hands every reference field to
 * scr_pub_push; containers, strings and dyn subgraphs have runtime walkers
 * here. The worklist keeps the walk iterative (parent chains and long lists
 * would overflow the stack). Every mark is logged: a refusal found later in
 * the walk (a dyn subgraph, or a value of an unpublishable static type,
 * whose emitted walker refuses) restores every logged count, so a publish
 * that throws leaves the graph unchanged, exactly like the Node.js
 * implementation, which validates before it freezes. */
typedef struct {
  void *obj;
  size_t rc;
  bool cyc;
  bool dyn; /* a dyn container frozen on success */
  uint8_t kind; /* SCR_PUB_KIND_*: leaves the RC audit's live count on success */
} ScrPubLog;

struct ScrPub {
  struct { void *v; ScrPubFn fn; } *stack;
  size_t len, cap;
  ScrPubLog *log;
  size_t logged, log_cap;
  const char *refusal; /* first refusal message; the walk stops */
};

static void *scr_pub_grow(void *p, size_t *cap, size_t size) {
  size_t n = *cap ? *cap * 2 : 256;
  void *q = realloc(p, n * size);
  if (!q) scr_trap("scriptc: out of memory\n");
  *cap = n;
  return q;
}

void scr_pub_str_fn(void *v, ScrPub *ctx);

void scr_pub_push(ScrPub *ctx, void *v, ScrPubFn fn) {
  if (!v || *(size_t *)v == SIZE_MAX || ctx->refusal) return;
  if (fn == scr_pub_str_fn) { /* a leaf: mark it now */
    scr_pub_str_fn(v, ctx);
    return;
  }
  if (ctx->len == ctx->cap) ctx->stack = scr_pub_grow(ctx->stack, &ctx->cap, sizeof *ctx->stack);
  ctx->stack[ctx->len].v = v;
  ctx->stack[ctx->len].fn = fn;
  ctx->len++;
}

bool scr_pub_mark(ScrPub *ctx, void *obj, bool cyc, int kind) {
  size_t *rc = obj;
  if (*rc == SIZE_MAX || ctx->refusal) return false;
  if (ctx->logged == ctx->log_cap) ctx->log = scr_pub_grow(ctx->log, &ctx->log_cap, sizeof *ctx->log);
  ctx->log[ctx->logged++] = (ScrPubLog){obj, *rc, cyc, false, (uint8_t)kind};
  *rc = SIZE_MAX;
  return true;
}

void scr_pub_refuse(ScrPub *ctx, const char *message) {
  if (!ctx->refusal) ctx->refusal = message;
}

/* An emitted refusing walker: the static path is diagnostic only. */
void scr_pub_refuse_at(ScrPub *ctx, const char *message, const char *detail) {
  if (!ctx->refusal && getenv("SCRIPTC_PUBLISH_TRACE"))
    fprintf(stderr, "scriptc: publish refused %s\n", detail);
  scr_pub_refuse(ctx, message);
}

/* Strings up to this length cache their Map key hash before they become
 * immortal (map keys are short); longer ones hash per lookup, since no
 * thread may write an immortal header (the map code skips them). */
#define SCR_PUB_HASH_PRIME_MAX 256

void scr_pub_str_fn(void *v, ScrPub *ctx) {
  ScrStr *s = v;
  if (s->rc == SIZE_MAX) return;
  if (s->len <= SCR_PUB_HASH_PRIME_MAX) scr_str_hash_prime(s);
  /* Record proven ASCII now: an immortal string cannot record it later,
   * and every UTF-16 index mapper answers ASCII strings by identity. */
  if (!s->ascii) {
    bool ascii = true;
    for (size_t i = 0; i < s->len && ascii; i++) ascii = (unsigned char)s->data[i] < 0x80;
    if (ascii) s->ascii = 1;
  }
  scr_pub_mark(ctx, s, false, SCR_PUB_KIND_STRING);
}

/* Objects without references (bigints): only the count. */
void scr_pub_leaf_fn(void *v, ScrPub *ctx) { (void)scr_pub_mark(ctx, v, false, SCR_PUB_KIND_LEAF); }

static void scr_pub_slot(ScrPub *ctx, uint64_t slot, ScrPubFn fn) {
  void *p = (void *)(uintptr_t)slot;
  if (fn) scr_pub_push(ctx, p, fn);
}

void scr_pub_arr(void *v, ScrPub *ctx, ScrPubFn elem) {
  ScrArr *a = v;
  if (a->ext && (a->ext->props || a->ext->metadata)) {
    scr_pub_refuse(ctx, "Cannot publish an array with non-index properties");
    return;
  }
  if (!scr_pub_mark(ctx, a, a->cyc != 0, SCR_PUB_KIND_ARRAY)) return;
  ScrPubFn fn = a->elem == SCR_ELEM_STR ? scr_pub_str_fn : a->elem == SCR_ELEM_REF ? elem : NULL;
  if (!fn) return;
  size_t dense = a->len < a->cap ? a->len : a->cap;
  for (size_t i = 0; i < dense; i++)
    if (!a->present || a->present[i]) scr_pub_slot(ctx, a->data[i], fn);
  if (a->ext)
    for (size_t i = 0; i < a->ext->sparse_len; i++)
      if (a->ext->sparse[i].state) scr_pub_slot(ctx, a->ext->sparse[i].slot, fn);
}

/* publish() of a scalar Node.js refuses (a Date): nothing to walk. */
void scr_publish_refuse(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

void scr_pub_map(void *v, ScrPub *ctx, ScrPubFn key, ScrPubFn val) {
  ScrMap *m = v;
  if (!scr_pub_mark(ctx, m, m->key_trace || m->val_trace, SCR_PUB_KIND_MAP)) return;
  ScrPubFn kfn = m->key_kind == SCR_MAP_KEY_STR ? scr_pub_str_fn
      : m->key_kind == SCR_MAP_KEY_DYN ? scr_pub_dyn_fn
      : m->key_kind == SCR_MAP_KEY_REF || m->key_kind == SCR_MAP_KEY_UNION_REF ||
              m->key_kind == SCR_MAP_KEY_BIGINT || m->key_kind == SCR_MAP_KEY_UNION_VALUE
          ? key
          : NULL;
  ScrPubFn vfn = m->val_kind == SCR_MAP_VAL_REF ? val : NULL;
  for (size_t i = 0; i < m->nentries; i++) {
    const ScrMapEntry *e = &m->entries[i];
    if (!e->hash) continue; /* tombstone */
    if (kfn) scr_pub_slot(ctx, e->key, kfn);
    if (vfn) scr_pub_slot(ctx, e->val, vfn);
  }
}

/* A dyn subgraph: plain objects, arrays and primitives, validated as a
 * whole before anything in it is frozen and made immortal. */
static bool scr_pub_dyn_ok(const ScrDyn *d, const char **why) {
  if (d->prototype || d->symbol_properties || d->symbol_keys || d->copied_from_native) {
    *why = "Cannot publish an object with a prototype or symbol keys";
    return false;
  }
  if (d->kind == SCR_DYN_ARR) {
    if (d->v.arr.properties) {
      *why = "Cannot publish an array with non-index properties";
      return false;
    }
    return true;
  }
  if (d->null_proto || d->v.obj.source_identity || d->v.obj.source_access) {
    *why = "Cannot publish an Object object";
    return false;
  }
  for (size_t i = 0; i < d->v.obj.len; i++)
    if (d->v.obj.entries[i].accessor) {
      *why = "Cannot publish an accessor property";
      return false;
    }
  return true;
}

/* Collected dyn-subgraph entries: containers untagged, heap strings tagged
 * with 1, bigints with 2 (all three are at least 8-byte aligned). */
#define SCR_PUB_STR ((uintptr_t)1)
#define SCR_PUB_BIGINT ((uintptr_t)2)

void scr_pub_dyn_fn(void *v, ScrPub *ctx) {
  ScrDyn *root = v;
  if (root->rc == SIZE_MAX || ctx->refusal) return;
  uintptr_t *nodes = NULL;
  size_t count = 0, cap = 0, cursor = 0;
  const char *why = NULL;
#define SCR_PUB_ADD(entry)                                                         \
  do {                                                                             \
    uintptr_t e_ = (entry);                                                        \
    bool seen_ = false;                                                            \
    for (size_t j_ = 0; j_ < count && !seen_; j_++) seen_ = nodes[j_] == e_;       \
    if (!seen_) {                                                                  \
      if (count == cap) nodes = scr_pub_grow(nodes, &cap, sizeof *nodes);          \
      nodes[count++] = e_;                                                         \
    }                                                                              \
  } while (0)
  SCR_PUB_ADD((uintptr_t)root);
  /* Collect and validate (a linear duplicate check: dyn subgraphs inside
   * typed graphs are small). */
  while (cursor < count && !why) {
    uintptr_t entry = nodes[cursor++];
    if (entry & 3) continue;
    ScrDyn *d = (ScrDyn *)entry;
    switch (d->kind) {
    case SCR_DYN_NULL: case SCR_DYN_UNDEF: case SCR_DYN_BOOL: case SCR_DYN_NUM: break;
    case SCR_DYN_STR:
      if (d->v.str->rc != SIZE_MAX) SCR_PUB_ADD((uintptr_t)d->v.str | SCR_PUB_STR);
      break;
    case SCR_DYN_BIGINT:
      if (*(size_t *)d->v.bigint != SIZE_MAX) SCR_PUB_ADD((uintptr_t)d->v.bigint | SCR_PUB_BIGINT);
      break;
    case SCR_DYN_ARR:
    case SCR_DYN_OBJ: {
      if (!scr_pub_dyn_ok(d, &why)) break;
      size_t n = d->kind == SCR_DYN_ARR ? d->v.arr.len : d->v.obj.len;
      for (size_t i = 0; i < n; i++) {
        ScrDyn *child = d->kind == SCR_DYN_ARR ? d->v.arr.items[i] : d->v.obj.entries[i].value;
        if (child && child->rc != SIZE_MAX) SCR_PUB_ADD((uintptr_t)child);
      }
      break;
    }
    case SCR_DYN_FUNC: why = "Cannot publish a function"; break;
    case SCR_DYN_SYMBOL: why = "Cannot publish a symbol"; break;
    default: why = "Cannot publish this value"; break;
    }
  }
#undef SCR_PUB_ADD
  if (why) scr_pub_refuse(ctx, why);
  else
    for (size_t i = 0; i < count; i++) {
      uintptr_t entry = nodes[i];
      void *p = (void *)(entry & ~(uintptr_t)3);
      if (entry & SCR_PUB_STR) scr_pub_str_fn(p, ctx);
      else if (entry & SCR_PUB_BIGINT) scr_pub_leaf_fn(p, ctx);
      else {
        ScrDyn *d = p;
        if (scr_pub_mark(ctx, d, true, SCR_PUB_KIND_DYN) && (d->kind == SCR_DYN_ARR || d->kind == SCR_DYN_OBJ))
          ctx->log[ctx->logged - 1].dyn = true;
      }
    }
  free(nodes);
}

#ifdef SCR_RC_AUDIT
/* Immortal objects are never freed, so they leave the RC audit's counts. */
static void scr_pub_audit_forget(int kind) {
  switch (kind) {
  case SCR_PUB_KIND_STRING: scr_str_live_forget(); break;
  case SCR_PUB_KIND_ARRAY: scr_arr_live_forget(); break;
  case SCR_PUB_KIND_MAP: scr_map_live_forget(); break;
  case SCR_PUB_KIND_OBJECT: scr_obj_free_note(); break;
  case SCR_PUB_KIND_UNION: scr_union_live_forget(); break;
  case SCR_PUB_KIND_DYN: scr_dyn_live_forget(); break;
  default: break;
  }
}
#endif

void scr_publish(void *root, ScrPubFn fn) {
  if (!root || *(size_t *)root == SIZE_MAX) return;
  ScrPub ctx = {0};
  bool trace = getenv("SCRIPTC_PUBLISH_TRACE") != NULL;
  uint64_t t0 = trace ? scr_hrtime_ns() : 0, t1 = 0;
  scr_pub_push(&ctx, root, fn);
  while (ctx.len > 0 && !ctx.refusal) {
    ctx.len--;
    ctx.stack[ctx.len].fn(ctx.stack[ctx.len].v, &ctx);
  }
  if (ctx.refusal) {
    for (size_t i = ctx.logged; i-- > 0;) *(size_t *)ctx.log[i].obj = ctx.log[i].rc;
    scr_throw_error_msg(SCR_ERR_TYPE, ctx.refusal, strlen(ctx.refusal));
  } else {
    if (trace) t1 = scr_hrtime_ns();
    /* Leave this thread's collector buffers: no pass may visit them. */
    for (size_t i = 0; i < ctx.logged; i++) {
      if (ctx.log[i].cyc) scr_cyc_on_dead(ctx.log[i].obj);
      if (ctx.log[i].dyn) scr_dyn_release(scr_dyn_freeze(ctx.log[i].obj));
#ifdef SCR_RC_AUDIT
      scr_pub_audit_forget(ctx.log[i].kind);
#endif
      scr_lsan_immortal(ctx.log[i].obj);
    }
    if (trace) {
      uint64_t t2 = scr_hrtime_ns();
      double walk = (double)(t1 - t0) / 1e6, post = (double)(t2 - t1) / 1e6;
      fprintf(stderr, "scriptc: published %zu objects (walk %.1fms, commit %.1fms)\n", ctx.logged, walk, post);
    }
  }
  free(ctx.stack);
  free(ctx.log);
}

/* Writes into published objects (the emitted guards' cold paths): Node's
 * frozen-object TypeErrors, word for word. */
static void scr_pub_throw(const char *fmt, const char *a, const char *b) {
  char text[512];
  int n = snprintf(text, sizeof text, fmt, a, b);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof text) n = (int)sizeof text - 1;
  scr_throw_error_msg(SCR_ERR_TYPE, text, (size_t)n);
}

void scr_throw_published_field(const char *prop, const char *owner) {
  scr_pub_throw("Cannot assign to read only property '%s' of object '#<%s>'", prop, owner);
}

static void scr_pub_index_text(double index, char *out, size_t size) {
  char buf[64];
  size_t n = scr_f64_to_str(index, buf);
  if (n > size - 1) n = size - 1;
  memcpy(out, buf, n);
  out[n] = 0;
}

/* op: 0 index write, 1 push (n = argument count), 2 pop, 3 length write,
 * 4 unshift (n = argument count), 5 delete, 6 shift, 7 other in-place
 * rewrites (splice, reverse, fill, copyWithin, sort). Returns false when
 * Node's operation would not write the frozen array at all (it then is not
 * an error: e.g. reversing an empty array). */
bool scr_throw_published_array(int op, const ScrArr *a, double index, double n) {
  static const char length[] = "Cannot assign to read only property 'length' of object '[object Array]'";
  char text[64];
  size_t len = a->len;
  switch (op) {
  case 0:
    scr_pub_index_text(index, text, sizeof text);
    if (index >= 0 && index < (double)len && index == (double)(size_t)index)
      scr_pub_throw("Cannot assign to read only property '%s' of object '[object Array]'%s", text, "");
    else scr_pub_throw("Cannot add property %s, object is not extensible%s", text, "");
    return true;
  case 1:
    if (n == 0) break;
    scr_pub_index_text((double)len, text, sizeof text);
    scr_pub_throw("Cannot add property %s, object is not extensible%s", text, "");
    return true;
  case 2:
  case 6:
    if (len == 0) break;
    if (op == 6 && len > 1) {
      scr_pub_throw("Cannot assign to read only property '0' of object '[object Array]'%s%s", "", "");
      return true;
    }
    scr_pub_index_text((double)(len - 1), text, sizeof text);
    scr_pub_throw("Cannot delete property '%s' of [object Array]%s", text, "");
    return true;
  case 3: break;
  case 4:
    if (n == 0) break;
    scr_pub_index_text(len ? (double)len + n - 1 : 0, text, sizeof text);
    scr_pub_throw("Cannot add property %s, object is not extensible%s", text, "");
    return true;
  case 5:
    scr_pub_index_text(index, text, sizeof text);
    scr_pub_throw("Cannot delete property '%s' of [object Array]%s", text, "");
    return true;
  default:
    if (len == 0) return false;
    scr_pub_throw("Cannot assign to read only property '0' of object '[object Array]'%s%s", "", "");
    return true;
  }
  scr_throw_error_msg(SCR_ERR_TYPE, length, sizeof length - 1);
  return true;
}

void scr_throw_published_collection(bool set) {
  scr_pub_throw("Cannot modify a published %s%s", set ? "Set" : "Map", "");
}
