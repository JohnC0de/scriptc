/* scriptc runtime — small-object allocator state and slow paths.
 *
 * The fast paths (free-list pop, bump carve, free-list push) are inline in
 * scr_runtime.h; see the contract there. This unit owns the process-wide
 * state, the address-space reservation, the refill/fallback path, realloc,
 * and the out-of-line entry points the LLVM backend calls for acyclic
 * records and class instances.
 *
 * Freed blocks are recycled within their class; the reservation itself
 * costs address space only, and pages are committed as the bump pointers
 * first touch them. Only an exiting worker thread returns pages, those
 * holding nothing but free blocks (scr_sa_trim, Linux). */
#include "scr_runtime.h"

/* Defined in every build: the emitted fast paths read it (see the layout
 * contract in scr_runtime.h); without the allocator it stays all-zero.
 * Explicitly initialized so it is an ordinary (localizable) definition: a
 * tentative definition becomes a COMMON symbol, which library localization
 * deliberately keeps global (abi.localize_runtime), leaking it from every
 * localized library archive. */
#ifdef SCR_WORKERS
_Thread_local ScrThreadHot scr_thread_hot = {{0}};
#else
ScrSaState scr_sa = {0};
#endif

#if SCR_SMALL_ALLOC
#include <sys/mman.h>

/* Page policy. Slice pages are committed by first touch, which on 4 KiB
 * pages is one fault (and page clear) per 4 KiB the bump pointers cross.
 * Transparent huge pages fault 2 MiB at a time and shrink the TLB working
 * set, but make the whole 2 MiB page around a bump pointer resident at once,
 * so every class slice in use (per arena, in worker executables) would cost
 * up to 2 MiB more than it holds. A slice therefore starts on small pages
 * and moves the rest of its range to huge pages once it has carved
 * SCR_SA_HUGE_AFTER bytes: only slices that already hold that much pay the
 * partial last huge page. The reservation is huge-page aligned so the
 * switch point and every slice start on a huge-page boundary. */
#if defined(__linux__) && defined(MADV_HUGEPAGE) && defined(MADV_NOHUGEPAGE)
#define SCR_SA_THP 1
#define SCR_SA_HUGE_PAGE ((size_t)2 << 20)
#define SCR_SA_HUGE_AFTER ((size_t)8 << 20)
#endif

/* Maps span bytes of address space for slices (huge-page aligned where the
 * policy above applies), or NULL. */
static void *scr_sa_map(size_t span) {
  int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
  flags |= MAP_NORESERVE;
#endif
#ifdef SCR_SA_THP
  size_t pad = SCR_SA_HUGE_PAGE;
#else
  size_t pad = 0;
#endif
  char *p = mmap(NULL, span + pad, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (p == MAP_FAILED) return NULL;
#ifdef SCR_SA_THP
  char *a = (char *)(((uintptr_t)p + pad - 1) & ~(uintptr_t)(pad - 1));
  if (a > p) (void)munmap(p, (size_t)(a - p));
  (void)munmap(a + span, (size_t)(p + pad - a)); /* a < p + pad */
  p = a;
  (void)madvise(p, span, MADV_NOHUGEPAGE);
#endif
  return p;
}

/* The next bump limit of a class slice [start, end) whose limit is lim
 * (< end): its small-page prefix ends at SCR_SA_HUGE_AFTER, where the rest
 * of the slice switches to huge pages. */
static char *scr_sa_extend(char *start, char *lim, char *end) {
#ifdef SCR_SA_THP
  if ((size_t)(lim - start) < SCR_SA_HUGE_AFTER && (size_t)(end - start) > SCR_SA_HUGE_AFTER)
    return start + SCR_SA_HUGE_AFTER;
  if (lim > start) (void)madvise(lim, (size_t)(end - lim), MADV_HUGEPAGE);
#else
  (void)start;
  (void)lim;
#endif
  return end;
}

/* Blocks above SCR_SA_MAX (array storage, hash tables, link pages, large
 * strings) come from glibc, whose heap and per-block mappings use small
 * pages where THP is in madvise mode (the common distribution default);
 * in large compiler-like programs that is most of the page faults and a
 * share of the TLB misses. glibc only advises huge pages for its own
 * memory when the glibc.malloc.hugetlb tunable is set in the environment,
 * which a program cannot do for itself. So once the brk heap has grown
 * past SCR_SA_HEAP_HUGE_AFTER (small programs keep small pages and their
 * RSS), every large allocation advises the heap grown since the previous
 * one, and the aligned interior of a block mapped outside the heap.
 * glibc grows the heap by its top pad beyond each request; the default
 * (128 KiB) is smaller than a huge page, so every 2 MiB range would be
 * first touched while it still straddles the heap end, where it can only
 * get small pages. The policy therefore raises the top pad. Setting it
 * fixes glibc's otherwise adaptive mmap and trim thresholds, so they are
 * set to the adaptive maxima the heap of such a program reaches anyway. */
#if defined(SCR_SA_THP) && defined(__GLIBC__)
#include <malloc.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#define SCR_SA_HEAP_HUGE_AFTER ((uintptr_t)32 << 20)
#define SCR_SA_HEAP_TOP_PAD (32 << 20)
#define SCR_SA_HEAP_MMAP_THRESHOLD (32 << 20) /* glibc's adaptive maximum */
#define SCR_SA_HEAP_TRIM_THRESHOLD (64 << 20) /* twice that, as glibc keeps it */
/* 0 = undecided, 1 = following, 2 = off (THP not in madvise mode). */
static _Atomic(int) scr_sa_heap_state;
static _Atomic(uintptr_t) scr_sa_heap_lo; /* heap start seen at the first large block */
static _Atomic(uintptr_t) scr_sa_heap_hi; /* end of the advised heap prefix */
static _Atomic(uintptr_t) scr_sa_heap_page; /* the page size, read with the mode */

static bool scr_sa_thp_madvise_mode(void) {
  FILE *f = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (!f) return false;
  char buf[96] = {0};
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  return strstr(buf, "[madvise]") != NULL;
}

static void scr_sa_large_note(void *p, size_t n) {
  int state = atomic_load_explicit(&scr_sa_heap_state, memory_order_relaxed);
  if (state == 2 || !p) return;
  uintptr_t top = (uintptr_t)sbrk(0);
  if (state == 0) {
    uintptr_t lo = atomic_load_explicit(&scr_sa_heap_lo, memory_order_relaxed);
    if (!lo) {
      long page = sysconf(_SC_PAGESIZE);
      if (page <= 0 || !scr_sa_thp_madvise_mode()) {
        atomic_store_explicit(&scr_sa_heap_state, 2, memory_order_relaxed);
        return;
      }
      atomic_store_explicit(&scr_sa_heap_page, (uintptr_t)page, memory_order_relaxed);
      lo = (top + (uintptr_t)page - 1) & ~((uintptr_t)page - 1);
      uintptr_t none = 0;
      if (!atomic_compare_exchange_strong(&scr_sa_heap_lo, &none, lo)) lo = none;
    }
    if (top < lo + SCR_SA_HEAP_HUGE_AFTER) return;
    uintptr_t unset = 0; /* the whole heap seen so far gets the advice */
    (void)atomic_compare_exchange_strong(&scr_sa_heap_hi, &unset, lo);
    int undecided = 0;
    if (atomic_compare_exchange_strong(&scr_sa_heap_state, &undecided, 1)) {
      (void)mallopt(M_MMAP_THRESHOLD, SCR_SA_HEAP_MMAP_THRESHOLD);
      (void)mallopt(M_TRIM_THRESHOLD, SCR_SA_HEAP_TRIM_THRESHOLD);
      (void)mallopt(M_TOP_PAD, SCR_SA_HEAP_TOP_PAD);
    }
  }
  /* The heap end moved since the last look: advise what it gained (pages
   * already touched keep their small pages), or follow a trim down. */
  uintptr_t hi = atomic_load_explicit(&scr_sa_heap_hi, memory_order_relaxed);
  if (!hi) return; /* another thread is switching the policy on */
  if (top > hi) {
    if (atomic_compare_exchange_strong(&scr_sa_heap_hi, &hi, top)) {
      /* madvise wants a page-aligned start */
      uintptr_t from = hi & ~(atomic_load_explicit(&scr_sa_heap_page, memory_order_relaxed) - 1);
      (void)madvise((void *)from, top - from, MADV_HUGEPAGE);
    }
  } else if (top < hi) {
    (void)atomic_compare_exchange_strong(&scr_sa_heap_hi, &hi, top);
  }
  /* A block glibc mapped by itself (or carved from a thread's heap). */
  uintptr_t a = (uintptr_t)p, lo = atomic_load_explicit(&scr_sa_heap_lo, memory_order_relaxed);
  if ((a < lo || a >= top) && n >= 2 * SCR_SA_HUGE_PAGE) {
    uintptr_t s = (a + SCR_SA_HUGE_PAGE - 1) & ~(uintptr_t)(SCR_SA_HUGE_PAGE - 1);
    uintptr_t e = (a + n) & ~(uintptr_t)(SCR_SA_HUGE_PAGE - 1);
    if (e > s) (void)madvise((void *)s, e - s, MADV_HUGEPAGE);
  }
}
#define SCR_SA_LARGE_NOTE(p, n) scr_sa_large_note((p), (n))
#else
#define SCR_SA_LARGE_NOTE(p, n) ((void)0)
#endif

#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdatomic.h>
#if defined(__linux__) && defined(MADV_DONTNEED)
#define SCR_SA_TRIM 1
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#if defined(__GLIBC__)
#include <malloc.h>
#endif
#endif

/* Per-thread arenas (contract in scr_runtime.h). The region is reserved
 * once; arena i spans [region + i * arena_span, + arena_span) and is split
 * into class slices exactly like the single-threaded reservation. */
#define SCR_SA_ARENAS 32u
static pthread_mutex_t scr_sa_region_lock = PTHREAD_MUTEX_INITIALIZER;
static _Atomic(uintptr_t) scr_sa_region; /* 0 until reserved */
static uintptr_t scr_sa_arena_span;
static unsigned scr_sa_region_shift;
static bool scr_sa_region_refused;
static _Atomic(uint32_t) scr_sa_claimed;              /* one bit per arena */
static ScrSaState scr_sa_parked[SCR_SA_ARENAS];         /* unowned arenas */
static _Atomic(ScrSaBlock *) scr_sa_remote[SCR_SA_ARENAS]; /* foreign frees */
static _Thread_local int scr_sa_arena = -1;
static _Thread_local bool scr_sa_refused; /* this thread got no arena */
_Static_assert(SCR_SA_ARENAS <= 32, "one claim bit per arena");

static bool scr_sa_reserve_region(void) {
  pthread_mutex_lock(&scr_sa_region_lock);
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_region_refused) {
    /* Same per-class slice ladder as the single-threaded reservation, for
     * every arena at once; hosts that limit address space get smaller
     * slices (each slice that fills falls back to the system). */
    for (unsigned shift = 30; shift >= 22; shift -= 2) {
      size_t arena = (size_t)SCR_SA_NCLASS << shift;
      size_t span = arena * SCR_SA_ARENAS;
      void *p = scr_sa_map(span);
      if (!p) continue;
      scr_sa_arena_span = arena;
      scr_sa_region_shift = shift;
      atomic_store_explicit(&scr_sa_region, (uintptr_t)p, memory_order_release);
      break;
    }
    if (!atomic_load_explicit(&scr_sa_region, memory_order_relaxed)) scr_sa_region_refused = true;
  }
  pthread_mutex_unlock(&scr_sa_region_lock);
  return atomic_load_explicit(&scr_sa_region, memory_order_acquire) != 0;
}

#ifdef SCR_SA_TRIM
/* The arena's carved bytes when the current thread claimed it (see
 * scr_sa_trim). */
static size_t scr_sa_claim_carved[SCR_SA_ARENAS];
static size_t scr_sa_carved(void);
#endif

/* Moves every block other threads freed into this arena's free lists. */
static void scr_sa_drain_remote(void) {
  ScrSaBlock *b = atomic_exchange_explicit(&scr_sa_remote[scr_sa_arena], NULL, memory_order_acquire);
  while (b) {
    ScrSaBlock *next = b->next;
    unsigned c = (unsigned)(((uintptr_t)b - scr_sa.base) >> scr_sa.shift);
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
    b = next;
  }
}

/* Claims an arena for the calling thread: a parked one continues with its
 * free lists and bump pointers, a fresh one starts empty. */
static bool scr_sa_reserve(void) {
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_reserve_region()) {
    scr_sa_refused = true;
    return false;
  }
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uint32_t claimed = atomic_load_explicit(&scr_sa_claimed, memory_order_relaxed);
  for (;;) {
    if (claimed == UINT32_MAX) {
      scr_sa_refused = true;
      return false;
    }
    unsigned i = (unsigned)__builtin_ctz(~claimed);
    if (atomic_compare_exchange_weak_explicit(&scr_sa_claimed, &claimed, claimed | (1u << i),
                                              memory_order_acquire, memory_order_relaxed)) {
      scr_sa_arena = (int)i;
      scr_sa = scr_sa_parked[i];
      if (!scr_sa.span) {
        memset(&scr_sa, 0, sizeof scr_sa);
        scr_sa.base = region + (uintptr_t)i * scr_sa_arena_span;
        scr_sa.span = scr_sa_arena_span;
        scr_sa.shift = scr_sa_region_shift;
      }
      scr_sa_drain_remote();
#ifdef SCR_SA_TRIM
      scr_sa_claim_carved[i] = scr_sa_carved();
#endif
      return true;
    }
  }
}

#ifdef SCR_SA_TRIM
/* Returning an exited thread's free memory (Linux). When a script thread
 * exits, every page of its arena that holds only free blocks goes back to
 * the system (MADV_DONTNEED, after which it reads as zero), so other
 * threads can use that memory while the arena is parked. The free blocks on
 * the kept pages are relinked in address order; the returned runs of pages
 * become zeroed carve regions (`ScrSaHoles`), which the next thread to claim
 * the arena carves before the slice's own frontier: the bump fast paths
 * already rely on carved memory being zero. A thread that carved less than
 * SCR_SA_TRIM_MIN, or whose arena holds less than that in free blocks,
 * leaves the arena as it is. */
#define SCR_SA_TRIM_MIN ((size_t)16 << 20)
typedef struct {
  char *lo, *hi;
} ScrSaRun;
typedef struct {
  ScrSaRun *runs; /* zeroed regions left to carve, carved from the end */
  size_t n, cap;
  char *bump, *lim; /* the frontier while a region is carved (lim != NULL) */
} ScrSaHoles;
static ScrSaHoles scr_sa_holes[SCR_SA_ARENAS][SCR_SA_NCLASS];

/* Bytes carved from the calling thread's slices: up to each frontier. */
static size_t scr_sa_carved(void) {
  size_t carved = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    if (!scr_sa.lim[c]) continue;
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    char *top = h->lim ? h->bump : scr_sa.bump[c];
    carved += (size_t)(top - ((char *)scr_sa.base + ((size_t)c << scr_sa.shift)));
  }
  return carved;
}

/* For the slow path of class c, whose bump room is below sz: moves the
 * bump pointer to the next zeroed region, or back to the frontier. */
static void scr_sa_next_hole(unsigned c, size_t sz) {
  ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
  if ((size_t)(scr_sa.lim[c] - scr_sa.bump[c]) >= sz || (!h->n && !h->lim)) return;
  if (h->n) {
    if (!h->lim) {
      h->bump = scr_sa.bump[c];
      h->lim = scr_sa.lim[c];
    }
    ScrSaRun r = h->runs[--h->n];
    scr_sa.bump[c] = r.lo;
    scr_sa.lim[c] = r.hi;
  } else {
    scr_sa.bump[c] = h->bump;
    scr_sa.lim[c] = h->lim;
    h->bump = h->lim = NULL;
  }
}

static bool scr_sa_push_run(ScrSaHoles *h, char *lo, char *hi) {
  if (h->n == h->cap) {
    size_t cap = h->cap ? 2 * h->cap : 64;
    ScrSaRun *runs = realloc(h->runs, cap * sizeof *runs);
    if (!runs) return false;
    h->runs = runs;
    h->cap = cap;
  }
  h->runs[h->n++] = (ScrSaRun){lo, hi};
  return true;
}

/* With SCR_SA_STATS=1: carved, free and returned bytes of the parking thread. */
static _Thread_local size_t scr_sa_trim_stats[3];

/* Returns the pages of class c that hold only free blocks (see above). */
static void scr_sa_trim_class(unsigned c, size_t page) {
  ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
  size_t sz = (size_t)(c + 1) * SCR_SA_STEP;
  char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
  /* Close the region being carved: its rest is still zero. */
  if (h->lim) {
    char *lo = scr_sa.bump[c], *hi = scr_sa.lim[c];
    scr_sa.bump[c] = h->bump;
    scr_sa.lim[c] = h->lim;
    h->bump = h->lim = NULL;
    if ((size_t)(hi - lo) >= sz && !scr_sa_push_run(h, lo, hi)) return;
  }
  char *top = scr_sa.bump[c];
  size_t nblocks = (size_t)(top - start) / sz;
  if (!nblocks) return;
  size_t words = (nblocks + 63) / 64;
  uint64_t *bits = mmap(NULL, words * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (bits == MAP_FAILED) return;
  size_t nfree = 0;
  for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) {
    size_t k = (size_t)((char *)b - start) / sz;
    bits[k / 64] |= (uint64_t)1 << (k % 64);
    nfree++;
  }
  /* Uncarved zeroed regions count as free; they are rebuilt below. */
  for (size_t r = 0; r < h->n; r++) {
    for (char *q = h->runs[r].lo; q + sz <= h->runs[r].hi; q += sz) {
      size_t k = (size_t)(q - start) / sz;
      bits[k / 64] |= (uint64_t)1 << (k % 64);
    }
  }
  scr_sa_trim_stats[0] += nblocks * sz;
  scr_sa_trim_stats[1] += nfree * sz;
#define SCR_SA_BIT(k) ((bits[(k) / 64] >> ((k) % 64)) & 1)
  /* Whole pages below the frontier whose blocks are all free. */
  uintptr_t first = ((uintptr_t)start + page - 1) & ~(uintptr_t)(page - 1);
  uintptr_t last = (uintptr_t)top & ~(uintptr_t)(page - 1);
  h->n = 0;
  char *run = NULL;
  for (uintptr_t pg = first; pg <= last; pg += page) {
    bool empty = false;
    if (pg < last) {
      size_t k0 = (size_t)((char *)pg - start) / sz;
      size_t k1 = (size_t)((char *)pg + page - 1 - start) / sz;
      if (k1 >= nblocks) k1 = nblocks - 1;
      empty = true;
      for (size_t k = k0; k <= k1 && empty; k++) empty = SCR_SA_BIT(k);
    }
    if (empty && !run) run = (char *)pg;
    if (!empty && run) {
      (void)madvise(run, (size_t)((char *)pg - run), MADV_DONTNEED);
      scr_sa_trim_stats[2] += (size_t)((char *)pg - run);
      /* Blocks wholly inside the returned pages carve from it later. */
      char *lo = start + ((size_t)(run - start) + sz - 1) / sz * sz;
      char *hi = start + ((size_t)((char *)pg - start) / sz) * sz;
      if (hi > lo) (void)scr_sa_push_run(h, lo, hi);
      for (char *q = lo; q < hi; q += sz) {
        size_t k = (size_t)(q - start) / sz;
        bits[k / 64] &= ~((uint64_t)1 << (k % 64));
      }
      /* A block starting in the returned pages but ending on a kept one is
       * dropped: relinking it would fault its page back in. */
      if (hi < (char *)pg && hi >= run) {
        size_t k = (size_t)(hi - start) / sz;
        bits[k / 64] &= ~((uint64_t)1 << (k % 64));
      }
      run = NULL;
    }
  }
#undef SCR_SA_BIT
  /* The remaining free blocks, in address order. */
  ScrSaBlock *head = NULL, **tail = &head;
  for (size_t w = 0; w < words; w++) {
    for (uint64_t m = bits[w]; m; m &= m - 1) {
      size_t k = w * 64 + (size_t)__builtin_ctzll(m);
      ScrSaBlock *b = (ScrSaBlock *)(start + k * sz);
      *tail = b;
      tail = &b->next;
    }
  }
  *tail = NULL;
  scr_sa.free[c] = head;
  munmap(bits, words * 8);
  /* The next owner carves the returned regions before the frontier. */
  if (h->n) {
    h->bump = scr_sa.bump[c];
    h->lim = scr_sa.lim[c];
    ScrSaRun r = h->runs[--h->n];
    scr_sa.bump[c] = r.lo;
    scr_sa.lim[c] = r.hi;
  }
}

/* Whether the calling thread carved at least SCR_SA_TRIM_MIN since it
 * claimed its arena: a short-lived thread reusing the arena's free blocks
 * leaves them for the next one. */
static bool scr_sa_trim_worth(void) {
  return scr_sa_carved() - scr_sa_claim_carved[scr_sa_arena] >= SCR_SA_TRIM_MIN;
}

/* Returns the free pages of the calling thread's arena (see above). */
static void scr_sa_trim(void) {
  scr_sa_drain_remote();
  size_t free_bytes = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    size_t n = 0;
    for (ScrSaBlock *b = scr_sa.free[c]; b && n * (c + 1) * SCR_SA_STEP < SCR_SA_TRIM_MIN;
         b = b->next)
      n++;
    free_bytes += n * (c + 1) * SCR_SA_STEP;
    if (free_bytes >= SCR_SA_TRIM_MIN) break;
  }
  const char *stats = getenv("SCR_SA_STATS");
  const char *off = getenv("SCR_SA_TRIM");
  bool trim = free_bytes >= SCR_SA_TRIM_MIN && !(off && off[0] == '0');
  memset(scr_sa_trim_stats, 0, sizeof scr_sa_trim_stats);
  if (!trim && stats && stats[0] == '1')
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
      if (!scr_sa.lim[c]) continue;
      size_t sz = (size_t)(c + 1) * SCR_SA_STEP;
      char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
      scr_sa_trim_stats[0] += (size_t)(scr_sa.bump[c] - start);
      for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) scr_sa_trim_stats[1] += sz;
    }
  if (trim) {
    long page = sysconf(_SC_PAGESIZE);
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++)
      if (scr_sa.lim[c]) scr_sa_trim_class(c, page > 0 ? (size_t)page : 4096);
  }
#if defined(__GLIBC__)
  /* Large blocks: the system allocator's free pages too. */
  if (trim) (void)malloc_trim(0);
#endif
  if (stats && stats[0] == '1')
    fprintf(stderr, "scr_sa: park arena %d trim %d carved %zu MB free %zu MB returned %zu MB\n",
            scr_sa_arena, (int)trim, scr_sa_trim_stats[0] >> 20, scr_sa_trim_stats[1] >> 20,
            scr_sa_trim_stats[2] >> 20);
}
#endif

#ifdef SCR_SA_TRIM
/* Trims run on a detached helper thread: the parent of a worker joins it
 * when it handles the worker's exit, which must not wait for the trim (at
 * the end of a program every worker exits at once, and the process ends
 * right after). The helper takes over the exiting thread's claim on the
 * arena, so no thread claims it during the trim. */
static _Atomic(unsigned) scr_sa_trimming; /* helpers running */

static void scr_sa_release(unsigned i) {
  scr_sa_parked[i] = scr_sa;
  memset(&scr_sa, 0, sizeof scr_sa);
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

static void *scr_sa_trim_main(void *arg) {
  unsigned i = (unsigned)(uintptr_t)arg;
  scr_sa_arena = (int)i;
  scr_sa = scr_sa_parked[i];
  scr_sa_trim();
  scr_sa_release(i);
  atomic_fetch_sub_explicit(&scr_sa_trimming, 1, memory_order_release);
  return NULL;
}

void scr_sa_wait_trims(void) {
  while (atomic_load_explicit(&scr_sa_trimming, memory_order_acquire)) {
    struct timespec pause = {0, 1000000};
    nanosleep(&pause, NULL);
  }
}
#else
void scr_sa_wait_trims(void) {}
#endif

void scr_sa_thread_park(void) {
  if (scr_sa_arena < 0) return;
  unsigned i = (unsigned)scr_sa_arena;
#ifdef SCR_SA_TRIM
  if (scr_sa_trim_worth()) {
    scr_sa_parked[i] = scr_sa;
    atomic_fetch_add_explicit(&scr_sa_trimming, 1, memory_order_relaxed);
    pthread_attr_t attr;
    pthread_t helper;
    bool started = pthread_attr_init(&attr) == 0;
    if (started) {
      started = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) == 0 &&
                pthread_create(&helper, &attr, scr_sa_trim_main, (void *)(uintptr_t)i) == 0;
      pthread_attr_destroy(&attr);
    }
    if (started) {
      /* Later frees on this thread take the foreign path into the arena's
       * remote list; the helper releases the claim. */
      memset(&scr_sa, 0, sizeof scr_sa);
      scr_sa_arena = -1;
      scr_sa_refused = true;
      return;
    }
    atomic_fetch_sub_explicit(&scr_sa_trimming, 1, memory_order_relaxed);
    scr_sa_trim();
  }
#endif
  scr_sa_parked[i] = scr_sa;
  /* Later frees on this thread (thread-exit destructors) take the foreign
   * path into the parked arena's remote list. */
  memset(&scr_sa, 0, sizeof scr_sa);
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

/* The class size of a block in another thread's arena, or 0 outside the
 * region (a system block). */
static size_t scr_sa_foreign_size(const void *p) {
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (!region || off >= scr_sa_arena_span * SCR_SA_ARENAS) return 0;
  return (size_t)(((off % scr_sa_arena_span) >> scr_sa_region_shift) + 1) * SCR_SA_STEP;
}

void scr_sa_free_foreign(void *p) {
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (region && off < scr_sa_arena_span * SCR_SA_ARENAS) {
    unsigned i = (unsigned)(off / scr_sa_arena_span);
    ScrSaBlock *b = p;
    ScrSaBlock *head = atomic_load_explicit(&scr_sa_remote[i], memory_order_relaxed);
    do b->next = head;
    while (!atomic_compare_exchange_weak_explicit(&scr_sa_remote[i], &head, b, memory_order_release,
                                                  memory_order_relaxed));
    return;
  }
  free(p);
}
#else
static bool scr_sa_refused;

/* Reserve address space for every class slice at once; smaller slices are
 * tried when the host limits address space or overcommit. */
static bool scr_sa_reserve(void) {
  for (unsigned shift = 30; shift >= 24; shift -= 2) {
    size_t span = (size_t)SCR_SA_NCLASS << shift;
    void *p = scr_sa_map(span);
    if (!p) continue;
    scr_sa.base = (uintptr_t)p;
    scr_sa.shift = shift;
    scr_sa.span = span;
    return true;
  }
  scr_sa_refused = true;
  return false;
}
#endif /* SCR_WORKERS */

/* Runs once per class (to reserve and open its slice) and then only for
 * blocks the fast path does not serve. */
__attribute__((cold, noinline)) void *scr_sa_slow(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX && (scr_sa.span || (!scr_sa_refused && scr_sa_reserve()))) {
    unsigned c = (unsigned)((n - 1) / SCR_SA_STEP);
#ifdef SCR_WORKERS
    /* A claimed arena may be a parked one with free blocks and bump room,
     * and other threads may have returned blocks since the last miss. */
    if (atomic_load_explicit(&scr_sa_remote[scr_sa_arena], memory_order_relaxed))
      scr_sa_drain_remote();
    ScrSaBlock *b = scr_sa.free[c];
    if (b) {
      scr_sa.free[c] = b->next;
      if (zero) memset(b, 0, n);
      return b;
    }
#endif
    /* Carve from the slice, opening it or raising its limit as needed;
     * fresh pages are zero. */
    size_t sz = (size_t)(c + 1) * SCR_SA_STEP;
#ifdef SCR_SA_TRIM
    if (scr_sa.lim[c]) scr_sa_next_hole(c, sz);
#endif
    char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
    char *end = start + ((size_t)1 << scr_sa.shift);
    char *p = scr_sa.lim[c] ? scr_sa.bump[c] : start;
    char *lim = scr_sa.lim[c] ? scr_sa.lim[c] : start;
    while ((size_t)(lim - p) < sz && lim < end) lim = scr_sa_extend(start, lim, end);
    scr_sa.lim[c] = lim;
    if ((size_t)(lim - p) >= sz) {
      scr_sa.bump[c] = p + sz;
      return p;
    }
    scr_sa.bump[c] = p;
  }
  /* Large or zero-sized, an exhausted slice, or no reservation. */
  void *q = zero ? calloc(1, n) : malloc(n);
  if (n > SCR_SA_MAX) SCR_SA_LARGE_NOTE(q, n);
  return q;
}

void *scr_mem_realloc(void *p, size_t n) {
  if (!p) return scr_mem_alloc(n);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  size_t have;
  if (off < scr_sa.span) have = (size_t)((off >> scr_sa.shift) + 1) * SCR_SA_STEP;
#ifdef SCR_WORKERS
  else if ((have = scr_sa_foreign_size(p)) != 0) {
    /* Another arena's block: move it into this thread's allocator. */
  }
#endif
  else {
    void *q = realloc(p, n);
    if (n > SCR_SA_MAX) SCR_SA_LARGE_NOTE(q, n);
    return q;
  }
  if (n && n <= have) return p; /* still fits its block */
  void *q = scr_mem_alloc(n ? n : 1);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_mem_free(p);
  return q;
}
#else
void *scr_mem_realloc(void *p, size_t n) { return realloc(p, n); }
#ifdef SCR_WORKERS
void scr_sa_thread_park(void) {}
void scr_sa_wait_trims(void) {}
void scr_sa_free_foreign(void *p) { free(p); }
#endif
#endif

void *scr_rt_calloc(size_t n) { return scr_mem_calloc(n); }
void scr_rt_free(void *p) { scr_mem_free(p); }
