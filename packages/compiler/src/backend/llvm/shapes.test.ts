import { describe, expect, test } from "vitest";
import { F64, type IrModule, RUNTIME_EMITTER_CLASS } from "../../ir/ir.js";
import {
  boxReleaseSym,
  emitInlineRcHelpers,
  emitRecordShapes,
  inlineRcDecls,
  releaseSym,
  retainSym,
  type ShapeHost,
  vAdapters,
} from "./shapes.js";
import { NullableUnions } from "./nullable-unions.js";

function declarationHost(
  pointerBits: 32 | 64 = 64,
  inlineRc = false,
): { host: ShapeHost; declarations: string[] } {
  const declarations: string[] = [];
  const host: ShapeHost = {
    declare(decl) {
      declarations.push(decl);
    },
    needOom() {},
    sizeType: pointerBits === 32 ? "i32" : "i64",
    cycleBufferedOffset: 6,
    tracedShapes: new Set(),
    tracedUnions: new Set(),
    nullableUnions: new NullableUnions({
      irVersion: 16,
      sourceFile: "test.ts",
      functions: [],
      entry: "main",
    }),
    recordsById: new Map(),
    recordCloneShapes: new Set(),
    rcHelpers: inlineRc ? new Set() : null,
  };
  return { host, declarations };
}

describe("LLVM runtime RC symbols", () => {
  test("derives adapter declarations from the shared stems", () => {
    const { host, declarations } = declarationHost();
    expect(vAdapters(host, { kind: "netSocket" })).toEqual({
      retain: "@scr_net_sock_retain_v",
      release: "@scr_net_sock_release_v",
    });
    expect(declarations).toEqual([
      "declare ptr @scr_net_sock_retain_v(ptr)",
      "declare void @scr_net_sock_release_v(ptr)",
    ]);
  });

  test("uses typed releases and preserves ABI exceptions", () => {
    const { host, declarations } = declarationHost();
    expect(releaseSym(host, { kind: "url" })).toBe("@scr_url_release");
    expect(releaseSym(host, { kind: "classval", className: "Widget" })).toBe(
      "@scr_classobj_release_v",
    );
    expect(vAdapters(host, { kind: "caught" })).toEqual({
      retain: "@scr_caught_retain",
      release: "@scr_caught_release",
    });
    expect(declarations).toContain("declare void @scr_url_release(ptr)");
  });

  test("keeps runtime and emitted object families distinct", () => {
    const { host } = declarationHost();
    expect(vAdapters(host, { kind: "object", className: RUNTIME_EMITTER_CLASS })).toEqual({
      retain: "@scr_emitter_retain_v",
      release: "@scr_emitter_release_v",
    });
    expect(vAdapters(host, { kind: "object", className: "Widget" })).toEqual({
      retain: "@sc_retain_Widget",
      release: "@sc_release_Widget",
    });
  });

  test("release emission keeps every retain and release a runtime call", () => {
    const { host, declarations } = declarationHost();
    expect(retainSym(host, { kind: "string" })).toBe("@scr_str_retain_v");
    expect(releaseSym(host, { kind: "string" })).toBe("@scr_str_release");
    expect(releaseSym(host, { kind: "union", unionId: "u0" } as never)).toBe("@scr_union_release");
    expect(boxReleaseSym(host)).toBe("@scr_box_release");
    expect(declarations).toContain("declare void @scr_box_release(ptr)");
    expect(inlineRcDecls(host)).toEqual([]);
    expect(emitInlineRcHelpers(host)).toEqual([]);
  });

  test("routes mirrored families through inline fast-path helpers", () => {
    const { host, declarations } = declarationHost(64, true);
    expect(retainSym(host, { kind: "string" })).toBe("@sc_rc_retain_str");
    expect(releaseSym(host, { kind: "string" })).toBe("@sc_rc_release_str");
    expect(releaseSym(host, { kind: "set", elem: { kind: "f64" } } as never)).toBe(
      "@sc_rc_release_map",
    );
    expect(releaseSym(host, { kind: "union", unionId: "u0" } as never)).toBe(
      "@sc_rc_release_union",
    );
    // Array retains inline; array releases and dyn releases stay calls.
    const array = { kind: "array", elem: { kind: "string" } } as never;
    expect(retainSym(host, array)).toBe("@sc_rc_retain_arr");
    expect(releaseSym(host, array)).toBe("@scr_arr_release");
    expect(retainSym(host, { kind: "dyn" })).toBe("@sc_rc_retain_dyn");
    expect(releaseSym(host, { kind: "dyn" })).toBe("@scr_dyn_release");
    // Unmirrored families and caught snapshots keep their runtime entry points.
    expect(retainSym(host, { kind: "url" })).toBe("@scr_url_retain_v");
    expect(retainSym(host, { kind: "caught" })).toBe("@scr_caught_retain");
    // Container function pointers keep the runtime symbols (identity tests).
    expect(vAdapters(host, { kind: "dyn" }).retain).toBe("@scr_dyn_retain_v");
    expect(vAdapters(host, { kind: "string" }).release).toBe("@scr_str_release_v");
    expect(declarations).toContain("declare void @scr_str_release(ptr)");
    expect(declarations).toContain("declare void @scr_cyc_on_release(ptr)");
    expect(inlineRcDecls(host).sort()).toEqual([
      "declare void @scr_cyc_on_release(ptr)",
      "declare void @scr_map_release(ptr)",
      "declare void @scr_str_release(ptr)",
      "declare void @scr_union_release(ptr)",
    ]);
  });

  test("mirrors the C fast paths and header offsets", () => {
    const { host } = declarationHost(64, true);
    retainSym(host, { kind: "string" });
    releaseSym(host, { kind: "string" });
    retainSym(host, { kind: "array", elem: { kind: "string" } } as never);
    releaseSym(host, { kind: "map", key: { kind: "string" }, value: { kind: "f64" } } as never);
    releaseSym(host, { kind: "union", unionId: "u0" } as never);
    retainSym(host, { kind: "promise", inner: { kind: "f64" } } as never);
    const ir = emitInlineRcHelpers(host).join("\n");
    const fn = (name: string): string => {
      const start = ir.indexOf(`@${name}(`);
      expect(start).toBeGreaterThan(-1);
      return ir.slice(start, ir.indexOf("\n}", start));
    };
    // Strings: no NULL test on retain (scr_str_retain dereferences), no header.
    expect(fn("sc_rc_retain_str")).not.toContain("null");
    expect(fn("sc_rc_retain_str")).not.toContain("store i32");
    expect(fn("sc_rc_release_str")).toContain("icmp eq i64 %rc, 1");
    expect(fn("sc_rc_release_str")).toContain("call void @scr_str_release(ptr %o) cold");
    expect(fn("sc_rc_release_str")).not.toContain("scr_cyc_on_release");
    // Retains never touch the cycle header, headered or not.
    expect(fn("sc_rc_retain_arr")).not.toContain("%ScrArr");
    expect(fn("sc_rc_retain_arr")).not.toContain("store i32");
    // Maps: a headered map's release is the runtime's; no inline buffering.
    expect(fn("sc_rc_release_map")).toContain("%ScrMapRc, ptr %o, i32 0, i32 5");
    expect(fn("sc_rc_release_map")).toContain("%ScrMapRc, ptr %o, i32 0, i32 8");
    expect(fn("sc_rc_release_map")).toContain("br i1 %headered, label %slow, label %dec");
    expect(fn("sc_rc_release_map")).not.toContain("store i32 1");
    // Unions: no color store, only the i16 `buffered` read at obj-6.
    expect(fn("sc_rc_release_union")).not.toContain("store i32");
    expect(fn("sc_rc_release_union")).toContain("getelementptr i8, ptr %o, i64 -6");
    expect(fn("sc_rc_release_union")).toContain("load i16, ptr %bufp");
    expect(fn("sc_rc_release_union")).toContain("call void @scr_cyc_on_release(ptr %o)");
    // Promises tolerate NULL and always carry a header.
    expect(fn("sc_rc_retain_promise")).toContain("icmp eq ptr %o, null");
    expect(fn("sc_rc_retain_promise")).not.toContain("store i32");
  });

  test("uses the wasm32 header offsets", () => {
    const { host } = declarationHost(32, true);
    releaseSym(host, { kind: "union", unionId: "u0" } as never);
    const ir = emitInlineRcHelpers(host).join("\n");
    expect(ir).toContain("load i32, ptr %o");
    expect(ir).toContain("getelementptr i8, ptr %o, i32 -6");
  });
});

describe("emitted object releases", () => {
  test("a surviving headered record enqueues only when not already buffered", () => {
    const mod: IrModule = {
      irVersion: 16,
      sourceFile: "cycle.ts",
      entry: "main",
      functions: [],
      records: [{ id: "r0", fields: [{ name: "self", type: { kind: "record", shapeId: "r0" } }] }],
    };
    const { host } = declarationHost();
    host.tracedShapes.add("record:r0");
    const defs = emitRecordShapes({ ...host, objectAudit: false }, mod).defs.join("\n");
    const start = defs.indexOf("root:");
    const root = defs.slice(start, defs.indexOf("done:", start));
    expect(root).not.toContain("store i32");
    expect(root).toContain("getelementptr i8, ptr %o, i64 -6");
    expect(root).toContain("br i1 %queued, label %done, label %enqueue");
    expect(root.indexOf("enqueue:")).toBeLessThan(
      root.indexOf("call void @scr_cyc_on_release(ptr %o)"),
    );
  });
});

describe("live-object audit notes", () => {
  const mod: IrModule = {
    irVersion: 16,
    sourceFile: "audit.ts",
    entry: "main",
    functions: [],
    records: [{ id: "r0", fields: [{ name: "x", type: F64 }] }],
  };
  const emit = (objectAudit?: boolean) => {
    const { host, declarations } = declarationHost();
    const defs = emitRecordShapes(
      objectAudit === undefined ? host : { ...host, objectAudit },
      mod,
    ).defs.join("\n");
    return { defs, declarations };
  };

  test("direct emission keeps the SCR_RC_AUDIT notes by default", () => {
    const { defs, declarations } = emit();
    expect(defs).toContain("call void @scr_obj_alloc_note()");
    expect(defs).toContain("call void @scr_obj_free_note()");
    expect(declarations).toContain("declare void @scr_obj_alloc_note()");
  });

  test("plain builds omit the calls and their declarations", () => {
    const { defs, declarations } = emit(false);
    expect(defs).not.toContain("_note()");
    expect(declarations.filter((decl) => decl.includes("_note()"))).toEqual([]);
  });
});
