/* Emitted object allocation and deallocation for records and class
 * instances.
 *
 * Every constructor allocates a constant-size block. The runtime's
 * small-object allocator (scr_alloc.c, contract in scr_runtime.h) serves it
 * from a per-size-class free list or bump pointer, but through an
 * out-of-line call the size class, the zeroing length, and the
 * collector-header setup are recomputed for every object. Here the fast
 * paths are inlined into the emitted `new`/release helpers instead, so they
 * fold to a constant class, a constant-length clear of only the bytes the
 * helper does not store itself, and a handful of loads and stores.
 *
 * Soundness does not depend on which runtime the program links against.
 * The runtime defines `scr_sa` in every build; where its allocator is
 * compiled out (AddressSanitizer, the RC audit) the state stays all-zero,
 * so the inline paths find no free block, no bump room and an empty span,
 * and always take the slow path: the same out-of-line calls as before
 * (scr_rt_calloc / scr_cyc_alloc, scr_rt_free) plus the RC-audit object
 * notes. The fast paths skip those notes, which are no-ops whenever the
 * allocator is live (SCR_RC_AUDIT forces it off; scr_runtime.h #errors
 * otherwise). Blocks outside the reservation (system fallbacks) go back
 * through scr_rt_free.
 *
 * Inlining is limited to the targets where the allocator can be live: 64-bit,
 * not WASI, not Windows, and not thread-instanced libraries (whose
 * allocator is compiled out). Worker programs inline too, against the
 * thread-local allocator state, live count and dispose hook of the calling
 * script thread (each thread owns an arena; see scr_runtime.h). Elsewhere
 * the out-of-line calls remain. */

/** The emitter surface this module needs (a subset of ShapeHost). */
export interface AllocHost {
  declare(decl: string): void;
  needOom(): void;
  readonly sizeType: "i32" | "i64";
  /** Inline the allocator fast paths (see the target rule above). */
  readonly inlineAlloc?: boolean;
  /** Emit the RC-audit object notes on the out-of-line paths (ShapeHost
   * objectAudit: only --sanitize builds count them). Absent means emit. */
  readonly objectAudit?: boolean;
  /** The allocator state, live count and dispose hook are thread-local
   * (worker executables). */
  readonly threadLocalAlloc?: boolean;
}

/** The state globals of the inline allocation paths and, in worker
 * executables, their byte offsets inside the runtime's one thread-local
 * ScrThreadHot block (layout asserted in scr_runtime.h). */
const STATE_GLOBALS: readonly [global: string, offset: number][] = [
  ["@scr_sa", 0],
  ["@scr_cyc_live", 792],
  ["@scr_cyc_old_freed", 800],
  ["@scr_weak_dispose_hook", 808],
];
const THREAD_HOT_TYPE = "{ { i64, i64, i32, [32 x ptr], [32 x ptr], [32 x ptr] }, i64, i64, ptr }";

/** Worker executables: address the thread's ScrThreadHot block once through
 * llvm.threadlocal.address (which LLVM can share across a function; on
 * Darwin each distinct thread-local costs a call) and rewrite the lines to
 * address the state globals at their offsets in it. */
function threadLocalState(host: AllocHost, prefix: string, lines: string[]): string[] {
  if (host.threadLocalAlloc !== true) return lines;
  const hot = `%${prefix}.tl.hot`;
  const preamble: string[] = [];
  let text = lines.join("\n");
  for (const [global, offset] of STATE_GLOBALS) {
    if (!text.includes(`ptr ${global}`)) continue;
    if (preamble.length === 0) {
      host.declare(`@scr_thread_hot = external thread_local global ${THREAD_HOT_TYPE}`);
      host.declare(`declare nonnull ptr @llvm.threadlocal.address.p0(ptr nonnull)`);
      preamble.push(`  ${hot} = call ptr @llvm.threadlocal.address.p0(ptr @scr_thread_hot)`);
    }
    const local = `%${prefix}.tl.${global.slice(5)}`;
    preamble.push(`  ${local} = getelementptr inbounds i8, ptr ${hot}, i64 ${offset}`);
    text = text
      .replaceAll(`ptr ${global},`, `ptr ${local},`)
      .replaceAll(`ptr ${global}`, `ptr ${local}`);
  }
  return [...preamble, ...text.split("\n")];
}

const ALLOC_NOTE = `  call void @scr_obj_alloc_note()`;
const FREE_NOTE = `  call void @scr_obj_free_note()`;

/** Whether a target can use the inline allocation paths. */
export function inlineAllocSupported(options: {
  pointerBits?: 32 | 64 | undefined;
  wasi?: boolean | undefined;
  targetTriple?: string | undefined;
  threadInstances?: boolean | undefined;
}): boolean {
  if (options.pointerBits === 32 || options.wasi === true || options.threadInstances === true) {
    return false;
  }
  // An omitted triple means the host ABI. That stays sound even on a host
  // whose runtime compiles the allocator out: scr_sa is defined there too
  // and stays zero, so only the slow paths run.
  const triple = (options.targetTriple ?? "").toLowerCase();
  return !/windows|mingw|msvc|cygwin|wasm/.test(triple);
}

/* ScrSaState layout on 64-bit targets (asserted in scr_runtime.h). */
const SA_TYPE = "{ i64, i64, i32, [32 x ptr], [32 x ptr], [32 x ptr] }";
const SA_SPAN = 8;
const SA_SHIFT = 16;
const SA_FREE = 24;
const SA_BUMP = 280;
const SA_LIM = 536;
const SA_STEP_SHIFT = 4; // 16-byte classes
const SA_MAX = 512;
/** sizeof(ScrCycHdr); on 64-bit targets the type descriptor is its first
 * word, and every other header word starts zero. */
const CYC_HDR = 16;
/** ScrCycHdr.gen, an i8 at this header offset (scr_runtime.h asserts it). */
const CYC_GEN = 9;

function declareState(host: AllocHost): void {
  if (host.threadLocalAlloc !== true) host.declare(`@scr_sa = external global ${SA_TYPE}`);
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
}

function declareGlobal(host: AllocHost, decl: string): void {
  if (host.threadLocalAlloc !== true) host.declare(decl);
}

/** A collector header to install: the object type's constant ScrCycType
 * descriptor (its trace and teardown; see cycTypeDescriptor). */
export interface CycHeader {
  type: string;
}

/** The first collector statistics index of an emitted ScrCycType
 * descriptor; the runtime's own families use the ones below
 * (SCR_CYC_KIND_EMITTED in scr_runtime.h). */
export const FIRST_EMITTED_CYC_KIND = 32;

/** The definition of a shape's ScrCycType descriptor `{ trace, free_fn,
 * kind }`, referenced by every header of that shape. `kind` indexes the
 * collector's per-type statistics (scr_runtime.h); emitted shapes number
 * themselves from FIRST_EMITTED_CYC_KIND (ShapeHost.nextCycKind) and 0
 * keeps none. */
export function cycTypeDescriptor(name: string, trace: string, free: string, kind = 0): string {
  return `${name} = internal constant { ptr, ptr, i32 } { ptr ${trace}, ptr ${free}, i32 ${kind} }`;
}

/**
 * Lines that leave a zeroed object of `size` bytes (an integer constant
 * expression) in `%o`, aborting on OOM, with the RC-audit allocation note
 * on the out-of-line path. With `cyc`, the object carries a collector
 * header (scr_cyc_alloc's contract). `stored` is the number of leading
 * object bytes the caller stores unconditionally right after (at least the
 * refcount word), which a recycled block need not clear. Labels use the
 * `sa.` prefix; the lines end in an open block.
 */
export function emitObjectAlloc(
  host: AllocHost,
  size: string,
  cyc: CycHeader | null,
  stored = 8,
): string[] {
  const lines = threadLocalState(host, "sa", allocLines(host, size, cyc, stored));
  if (host.objectAudit === false) return lines.filter((line) => line !== ALLOC_NOTE);
  host.declare(`declare void @scr_obj_alloc_note()`);
  return lines;
}

function allocLines(
  host: AllocHost,
  size: string,
  cyc: CycHeader | null,
  stored: number,
): string[] {
  const S = host.sizeType;
  if (host.inlineAlloc !== true) {
    if (cyc) {
      host.declare(`declare ptr @scr_cyc_alloc(${S}, ptr)`);
      return [
        `  %o = call ptr @scr_cyc_alloc(${S} ${size}, ptr ${cyc.type})`,
        `  call void @scr_obj_alloc_note()`,
      ];
    }
    host.declare(`declare ptr @scr_rt_calloc(${S})`);
    host.needOom();
    return [
      `  %o = call ptr @scr_rt_calloc(${S} ${size})`,
      `  %isnull = icmp eq ptr %o, null`,
      `  br i1 %isnull, label %oom, label %ok`,
      `oom:`,
      `  call void @sc_oom()`,
      `  unreachable`,
      `ok:`,
      `  call void @scr_obj_alloc_note()`,
    ];
  }
  declareState(host);
  // Bytes of the block that the fast path itself stores after the clear:
  // the header's descriptor word, or the object's leading words.
  const keep = cyc ? 8 : stored;
  const lines = [
    `  %sa.n = add i64 ${size}, ${cyc ? CYC_HDR : 0}`,
    `  %sa.small = icmp ule i64 %sa.n, ${SA_MAX}`,
    `  br i1 %sa.small, label %sa.class, label %sa.slow`,
    `sa.class:`,
    `  %sa.nm1 = sub i64 %sa.n, 1`,
    `  %sa.c = lshr i64 %sa.nm1, ${SA_STEP_SHIFT}`,
    `  %sa.c8 = shl i64 %sa.c, 3`,
    `  %sa.fo = add i64 %sa.c8, ${SA_FREE}`,
    `  %sa.fp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.fo`,
    `  %sa.b = load ptr, ptr %sa.fp`,
    `  %sa.hit = icmp ne ptr %sa.b, null`,
    `  %sa.hitx = call i1 @llvm.expect.i1(i1 %sa.hit, i1 true)`,
    `  br i1 %sa.hitx, label %sa.pop, label %sa.bump`,
    `sa.pop: ; recycled blocks are dirty`,
    `  %sa.next = load ptr, ptr %sa.b`,
    `  store ptr %sa.next, ptr %sa.fp`,
    `  %sa.z = getelementptr inbounds i8, ptr %sa.b, i64 ${keep}`,
    `  %sa.zn = sub i64 %sa.n, ${keep}`,
    `  call void @llvm.memset.p0.i64(ptr align 8 %sa.z, i8 0, i64 %sa.zn, i1 false)`,
    `  br label %sa.fast`,
    `sa.bump: ; fresh reservation memory is already zero`,
    `  %sa.c1 = add i64 %sa.c, 1`,
    `  %sa.sz = shl i64 %sa.c1, ${SA_STEP_SHIFT}`,
    `  %sa.bo = add i64 %sa.c8, ${SA_BUMP}`,
    `  %sa.bp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.bo`,
    `  %sa.lo = add i64 %sa.c8, ${SA_LIM}`,
    `  %sa.lp = getelementptr inbounds i8, ptr @scr_sa, i64 %sa.lo`,
    `  %sa.p = load ptr, ptr %sa.bp`,
    `  %sa.l = load ptr, ptr %sa.lp`,
    `  %sa.pi = ptrtoint ptr %sa.p to i64`,
    `  %sa.li = ptrtoint ptr %sa.l to i64`,
    `  %sa.room = sub i64 %sa.li, %sa.pi`,
    `  %sa.fits = icmp uge i64 %sa.room, %sa.sz`,
    `  %sa.fitsx = call i1 @llvm.expect.i1(i1 %sa.fits, i1 true)`,
    `  br i1 %sa.fitsx, label %sa.carve, label %sa.slow`,
    `sa.carve:`,
    `  %sa.np = getelementptr inbounds i8, ptr %sa.p, i64 %sa.sz`,
    `  store ptr %sa.np, ptr %sa.bp`,
    `  br label %sa.fast`,
  ];
  host.declare(`declare void @llvm.memset.p0.i64(ptr, i8, i64, i1)`);
  if (cyc) {
    host.declare(`declare ptr @scr_cyc_alloc(${S}, ptr)`);
    declareGlobal(host, `@scr_cyc_live = external global i64`);
    lines.push(
      `sa.fast:`,
      `  %sa.blk = phi ptr [ %sa.b, %sa.pop ], [ %sa.p, %sa.carve ]`,
      `  store ptr ${cyc.type}, ptr %sa.blk ; ScrCycHdr.type`,
      `  %sa.live = load i64, ptr @scr_cyc_live`,
      `  %sa.live1 = add i64 %sa.live, 1`,
      `  store i64 %sa.live1, ptr @scr_cyc_live`,
      `  %sa.obj = getelementptr inbounds i8, ptr %sa.blk, i64 ${CYC_HDR}`,
      `  br label %sa.done`,
      `sa.slow:`,
      `  %sa.s = call ptr @scr_cyc_alloc(i64 ${size}, ptr ${cyc.type})`,
      `  call void @scr_obj_alloc_note()`,
      `  br label %sa.done`,
      `sa.done:`,
      `  %o = phi ptr [ %sa.obj, %sa.fast ], [ %sa.s, %sa.slow ]`,
    );
  } else {
    host.declare(`declare ptr @scr_rt_calloc(${S})`);
    host.needOom();
    lines.push(
      `sa.fast:`,
      `  %sa.blk = phi ptr [ %sa.b, %sa.pop ], [ %sa.p, %sa.carve ]`,
      `  br label %sa.done`,
      `sa.slow:`,
      `  %sa.s = call ptr @scr_rt_calloc(i64 ${size})`,
      `  %sa.null = icmp eq ptr %sa.s, null`,
      `  br i1 %sa.null, label %oom, label %sa.noted`,
      `oom:`,
      `  call void @sc_oom()`,
      `  unreachable`,
      `sa.noted:`,
      `  call void @scr_obj_alloc_note()`,
      `  br label %sa.done`,
      `sa.done:`,
      `  %o = phi ptr [ %sa.blk, %sa.fast ], [ %sa.s, %sa.noted ]`,
    );
  }
  return lines;
}

/**
 * Lines that free the object `%o` after its members were released: the
 * RC-audit free note, the weak-collection dispose hook, and the block —
 * `scr_cyc_free` for collector-headered objects, `scr_rt_free` otherwise.
 * Labels use the `sf.` prefix; the lines end in an open block.
 */
export function emitObjectFree(host: AllocHost, cyc: boolean): string[] {
  const lines = threadLocalState(host, "sf", freeLines(host, cyc));
  if (host.objectAudit === false) return lines.filter((line) => line !== FREE_NOTE);
  host.declare(`declare void @scr_obj_free_note()`);
  return lines;
}

function freeLines(host: AllocHost, cyc: boolean): string[] {
  if (host.inlineAlloc !== true) {
    if (cyc) {
      host.declare(`declare void @scr_cyc_free(ptr)`);
      return [`  call void @scr_obj_free_note()`, `  call void @scr_cyc_free(ptr %o)`];
    }
    host.declare(`declare void @scr_rt_free(ptr)`);
    host.declare(`declare void @scr_weak_dispose(ptr)`);
    return [
      `  call void @scr_obj_free_note()`,
      `  call void @scr_weak_dispose(ptr %o)`,
      `  call void @scr_rt_free(ptr %o)`,
    ];
  }
  declareState(host);
  host.declare(`declare void @scr_rt_free(ptr)`);
  declareGlobal(host, `@scr_weak_dispose_hook = external global ptr`);
  const lines = [
    `  %sf.hook = load ptr, ptr @scr_weak_dispose_hook`,
    `  %sf.has = icmp ne ptr %sf.hook, null`,
    `  %sf.hasx = call i1 @llvm.expect.i1(i1 %sf.has, i1 false)`,
    `  br i1 %sf.hasx, label %sf.observe, label %sf.block`,
    `sf.observe: ; weak collections observe the disposal`,
    `  call void %sf.hook(ptr %o)`,
    `  br label %sf.block`,
    `sf.block:`,
  ];
  if (cyc) {
    declareGlobal(host, `@scr_cyc_live = external global i64`);
    declareGlobal(host, `@scr_cyc_old_freed = external global i64`);
    lines.push(
      `  %sf.live = load i64, ptr @scr_cyc_live`,
      `  %sf.live1 = sub i64 %sf.live, 1`,
      `  store i64 %sf.live1, ptr @scr_cyc_live`,
      `  %sf.blk = getelementptr inbounds i8, ptr %o, i64 -${CYC_HDR}`,
      `  %sf.genp = getelementptr inbounds i8, ptr %sf.blk, i64 ${CYC_GEN}`,
      `  %sf.gen = load i8, ptr %sf.genp`,
      `  %sf.old = icmp eq i8 %sf.gen, 2`,
      `  br i1 %sf.old, label %sf.oldcount, label %sf.accounted`,
      `sf.oldcount:`,
      `  %sf.freed = load i64, ptr @scr_cyc_old_freed`,
      `  %sf.freed1 = add i64 %sf.freed, 1`,
      `  store i64 %sf.freed1, ptr @scr_cyc_old_freed`,
      `  br label %sf.accounted`,
      `sf.accounted:`,
    );
  }
  const blk = cyc ? "%sf.blk" : "%o";
  lines.push(
    `  %sf.base = load i64, ptr @scr_sa`,
    `  %sf.spanp = getelementptr inbounds i8, ptr @scr_sa, i64 ${SA_SPAN}`,
    `  %sf.span = load i64, ptr %sf.spanp`,
    `  %sf.bi = ptrtoint ptr ${blk} to i64`,
    `  %sf.off = sub i64 %sf.bi, %sf.base`,
    `  %sf.in = icmp ult i64 %sf.off, %sf.span`,
    `  %sf.inx = call i1 @llvm.expect.i1(i1 %sf.in, i1 true)`,
    `  br i1 %sf.inx, label %sf.push, label %sf.sys`,
    `sf.push:`,
    `  %sf.shp = getelementptr inbounds i8, ptr @scr_sa, i64 ${SA_SHIFT}`,
    `  %sf.sh32 = load i32, ptr %sf.shp`,
    `  %sf.sh = zext i32 %sf.sh32 to i64`,
    `  %sf.c = lshr i64 %sf.off, %sf.sh`,
    `  %sf.c8 = shl i64 %sf.c, 3`,
    `  %sf.fo = add i64 %sf.c8, ${SA_FREE}`,
    `  %sf.fp = getelementptr inbounds i8, ptr @scr_sa, i64 %sf.fo`,
    `  %sf.head = load ptr, ptr %sf.fp`,
    `  store ptr %sf.head, ptr ${blk}`,
    `  store ptr ${blk}, ptr %sf.fp`,
    `  br label %sf.done`,
    `sf.sys: ; outside the reservation, or the allocator is compiled out`,
    `  call void @scr_obj_free_note()`,
    `  call void @scr_rt_free(ptr ${blk})`,
    `  br label %sf.done`,
    `sf.done:`,
  );
  return lines;
}
