import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { emitLlvmModule } from "./emitter.js";
import { keepUnionsBoxed } from "./test-boxed-unions.js";
import { borrowsMapReadInputs, findMapReadLifetimes } from "./map-read-lifetimes.js";

const loc = { file: "map-reads.ts", start: 0, end: 1 };
const record: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

function fixture(value: IrType = record, key: IrType = F64): IrModule {
  const map: IrType = { kind: "map", key, value };
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "key", name: "key", type: key },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: BOOL,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "value", name: "value", type: optional, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "value",
        loc,
        init: {
          kind: "mapIntrinsic",
          method: "get",
          receiver: ref("map", map),
          args: [ref("key", key)],
          type: optional,
          loc,
        },
      },
      {
        kind: "return",
        loc,
        value: {
          kind: "unionIsTag",
          value: ref("value", optional),
          unionId: "optional",
          tag: 0,
          negated: false,
          type: BOOL,
          loc,
        },
      },
    ],
  };
  return {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    unions: [{ id: "optional", arms: [value, UNDEFINED_T] }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

function facts(mod: IrModule) {
  const lifetimes = analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn])));
  return findMapReadLifetimes(
    mod.functions[1]!,
    new Map(mod.unions!.map((union) => [union.id, union])),
    lifetimes,
  );
}

function body(mod: IrModule, bits: 32 | 64 = 64): string {
  expect(validateModule(mod)).toEqual([]);
  // Record values are nullable pointers; the other fixtures pin stack boxes.
  const nullable = mod.unions?.[0]?.arms[0]?.kind === "record";
  const llvm = emitLlvmModule(nullable ? mod : keepUnionsBoxed(mod), { pointerBits: bits });
  return /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(llvm)![0];
}

test("local map results keep scalar and owned reference payloads without heap wrappers on both ABIs", () => {
  const keys: IrType[] = [F64, STRING];
  const values: IrType[] = [F64, BOOL, STRING];
  for (const key of keys)
    for (const value of values) {
      const mod = fixture(value, key);
      expect(facts(mod).locals.has("value")).toBe(true);
      for (const bits of [32, 64] as const) {
        const ir = body(mod, bits);
        expect(ir).toContain("alloca %ScrUnion");
        expect(ir).toContain("select i1");
        expect(ir).not.toContain("@scr_union_new");
        expect(ir).not.toContain("@scr_union_release");
        if (key === F64) {
          // Number keys read the entry's slot inline; booleans are stored 0/1.
          expect(ir).toContain("call ptr @sc_map_entry_f64(");
          expect(ir).not.toContain("@scr_map_get_");
        } else {
          // String keys read every value kind through the entry (behind the
          // inline absent-key filter); reference values retain inline.
          expect(ir).toContain("call ptr @sc_map_entry_str(");
          expect(ir).not.toContain("@scr_map_get_");
        }
        if (value === STRING) expect(ir).toContain("@scr_str_release");
      }
    }
});

test("nullable record results are the looked-up pointer itself on both ABIs", () => {
  const mod = fixture(record);
  for (const bits of [32, 64] as const) {
    const ir = body(mod, bits);
    expect(ir).not.toContain("%ScrUnion");
    expect(ir).not.toContain("@scr_union_");
    expect(ir).toMatch(/icmp (?:eq|ne) ptr %\w+, null/);
    expect(ir).toContain("@sc_rrelease_");
  }
});

test("direct helper arguments have independent stack boxes and call-scoped payload owners", () => {
  const mod = fixture(STRING);
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || !init.init) throw new Error("missing lookup");
  const helper: IrFunction = {
    name: "inspect",
    loc,
    returnType: BOOL,
    params: ["left", "right"].map((id) => ({ localId: id, name: id, type: optional })),
    locals: ["left", "right"].map((id) => ({ id, name: id, type: optional, mutable: false })),
    body: [
      {
        kind: "return",
        loc,
        value: {
          kind: "unionIsTag",
          value: ref("left", optional),
          unionId: "optional",
          tag: 0,
          negated: false,
          type: BOOL,
          loc,
        },
      },
    ],
  };
  fn.body = [
    {
      kind: "return",
      loc,
      value: {
        kind: "call",
        callee: helper.name,
        args: [init.init, { ...init.init }],
        type: BOOL,
        loc,
      },
    },
  ];
  mod.functions.push(helper);
  expect(facts(mod).arguments.size).toBe(2);
  const ir = body(mod);
  expect(ir.match(/alloca %ScrUnion/g)).toHaveLength(2);
  expect(ir).not.toContain("@scr_union_new");
  expect(ir).not.toContain("@scr_union_release");
  const call = ir.indexOf("@sc_bf_inspect");
  expect(call).toBeGreaterThan(0);
  expect(ir.slice(call).match(/call void @scr_str_release\(/g)).toHaveLength(2);
});

test("escaping local boxes retain ordinary ownership", () => {
  const mod = fixture(STRING);
  const fn = mod.functions[1]!;
  fn.returnType = optional;
  fn.body[1] = { kind: "return", value: ref("value", optional), loc };
  expect(facts(mod).locals.size).toBe(0);
  expect(body(mod)).toContain("@scr_union_new_ref");
});

test("stored union boxes and dynamic views stay on the general path", () => {
  const union: IrType = { kind: "union", unionId: "stored" };
  const mod = fixture(union);
  mod.unions!.push({ id: "stored", arms: [record, UNDEFINED_T] });
  expect(facts(mod).locals.size).toBe(0);
  expect(facts(fixture(record, DYN)).locals.size).toBe(0);
  expect(facts(fixture(DYN)).locals.size).toBe(0);
});

test("typed read helpers borrow string keys while mutations retain the owned convention", () => {
  const mod = fixture(record, STRING);
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || init.init?.kind !== "mapIntrinsic")
    throw new Error("missing lookup");
  const keyFacts = () =>
    analyzeCallLifetimes(new Map(mod.functions.map((f) => [f.name, f]))).parameters.get(fn.name);
  expect(keyFacts()).toEqual(new Set([1]));
  const ir = body(mod);
  expect(ir).not.toContain("@scr_map_retain");
  expect(ir).not.toContain("@scr_str_retain");
  expect(ir).not.toContain("@scr_str_release");
  const mutation: IrExpr = { ...init.init, method: "delete", type: BOOL };
  expect(borrowsMapReadInputs(mutation)).toBe(false);
  fn.body.push({ kind: "exprStmt", expr: mutation, loc });
  expect(keyFacts()).toBeUndefined();
});

test("reference-preserving keys borrow receivers across unrelated later assignments", () => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || init.init?.kind !== "mapIntrinsic")
    throw new Error("missing lookup");
  init.init.args[0] = { kind: "call", callee: "key", args: [], type: F64, loc };
  mod.functions.push({
    name: "key",
    params: [],
    locals: [],
    body: [{ kind: "return", value: { kind: "numLit", value: 0, type: F64, loc }, loc }],
    returnType: F64,
    loc,
  });
  expect(body(mod)).not.toContain("@scr_map_retain_v");
  const work = mod.functions[1]!;
  const type = work.params[0]!.type;
  work.body.splice(1, 0, { kind: "assign", localId: "map", value: ref("map", type), loc });
  const ir = body(mod);
  expect(ir.indexOf("@scr_map_retain_v")).toBeGreaterThan(0);
  expect(ir.indexOf("@scr_map_retain_v")).toBeGreaterThan(ir.indexOf("@sc_f_key"));
});

test("string-key lookups test the absent-key filter inline on 64-bit targets only", () => {
  const mod = keepUnionsBoxed(fixture(F64, STRING));
  expect(validateModule(mod)).toEqual([]);
  const helper = (bits: 32 | 64) =>
    /^define internal ptr @sc_map_entry_str\([^]*?^}/m.exec(
      emitLlvmModule(mod, { pointerBits: bits }),
    )![0];
  const wide = helper(64);
  // The cached hash is the capacity word's high half; the filter bits are its
  // bits 44..55 (scr_map.c scr_map_filter_bits). %ScrMapIx field 11 is the filter.
  expect(wide).toContain("getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11");
  expect(wide).toContain("icmp uge i64 %cap, 4294967296");
  expect(wide).toContain("lshr i64 %cap, 44");
  expect(wide).toContain("lshr i64 %cap, 50");
  expect(wide).toContain("ret ptr null");
  expect(wide).toContain("call ptr @scr_map_entry_str(ptr %m, ptr %k)");
  // 32-bit strings cache no hash: every lookup takes the runtime.
  const narrow = helper(32);
  expect(narrow).not.toContain("%ScrMapIx");
  expect(narrow).toContain("call ptr @scr_map_entry_str(ptr %m, ptr %k)");
});
