import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { computeMayThrow } from "./may-throw.js";

const loc = { file: "tdz.ts", start: 0, end: 1 };
const value: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
const local: IrLocal = {
  id: "value",
  name: "value",
  type: F64,
  mutable: true,
  boxed: true,
  tdz: true,
};
function fn(name: string, body: IrStmt[], locals: IrLocal[] = [local]): IrFunction {
  return { name, body, locals, params: [], returnType: VOID, loc };
}
function moduleWith(...functions: IrFunction[]): IrModule {
  return { irVersion: 15, sourceFile: loc.file, entry: "caller", functions };
}
const assignment: IrStmt = { kind: "assign", localId: local.id, value, loc };
const expression: IrExpr = { kind: "assignExpr", localId: local.id, value, type: F64, loc };
const increment: IrExpr = {
  kind: "incDec",
  localId: local.id,
  op: "+",
  prefix: false,
  type: F64,
  loc,
};
const read: IrExpr = { kind: "varRef", localId: local.id, type: F64, loc };
const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

test.each([
  ["store", assignment],
  ["assignment expression", exprStmt(expression)],
  ["increment", exprStmt(increment)],
  ["read", exprStmt(read)],
] as const)("TDZ %s propagates through the direct call graph", (_name, operation) => {
  const target = fn("target", [operation]);
  const middle = fn(
    "middle",
    [exprStmt({ kind: "call", callee: "target", args: [], type: VOID, loc })],
    [],
  );
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "middle", args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, middle, target));
  expect([...answer.fns].sort()).toEqual(["caller", "middle", "target"]);
  expect(answer.indirect).toBe(false);
});

test("TDZ stores seed indirect-call propagation", () => {
  const closure: IrExpr = {
    kind: "closure",
    fnName: "target",
    captures: [],
    type: funcOf([], VOID),
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "callValue", callee: closure, args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, fn("target", [assignment])));
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual(["caller", "target"]);
});

test.each([true, false])(
  "declaration stores do not throw solely for TDZ (mutable=%s)",
  (mutable) => {
    const initialize: IrStmt = { ...assignment, initializes: true };
    expect(
      computeMayThrow(moduleWith(fn("caller", [initialize], [{ ...local, mutable }]))).fns.size,
    ).toBe(0);
  },
);

test("legacy const TDZ stores remain initialization", () => {
  const immutable = { ...local, mutable: false };
  expect(computeMayThrow(moduleWith(fn("caller", [assignment], [immutable]))).fns.size).toBe(0);
});

test("ordinary boxed stores do not gain an exception edge", () => {
  const ordinary: IrLocal = {
    id: local.id,
    name: local.name,
    type: F64,
    mutable: true,
    boxed: true,
  };
  expect(
    computeMayThrow(
      moduleWith(fn("caller", [assignment, exprStmt(expression), exprStmt(increment)], [ordinary])),
    ).fns.size,
  ).toBe(0);
});

test("initializers still propagate exceptions from their right-hand side", () => {
  const initialize: IrStmt = {
    ...assignment,
    initializes: true,
    value: { kind: "call", callee: "failure", args: [], type: F64, loc },
  };
  const failure = fn("failure", [{ kind: "throw", value, loc }], []);
  expect([...computeMayThrow(moduleWith(fn("caller", [initialize]), failure)).fns].sort()).toEqual([
    "caller",
    "failure",
  ]);
});

const call = (callee: string): IrStmt =>
  exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
const closureOf = (fnName: string): IrExpr => ({
  kind: "closure",
  fnName,
  captures: [],
  type: funcOf([], VOID),
  loc,
});
const callClosure = (fnName: string): IrStmt =>
  exprStmt({ kind: "callValue", callee: closureOf(fnName), args: [], type: VOID, loc });
const failure: IrStmt = { kind: "throw", value, loc };

test("propagates through a long caller-first chain without recursive graph traversal", () => {
  const size = 6000;
  const functions = Array.from({ length: size }, (_, i) =>
    fn(`fn${i}`, [i === size - 1 ? failure : call(`fn${i + 1}`)], []),
  );
  for (const order of [functions, [...functions].reverse()]) {
    const answer = computeMayThrow(moduleWith(...order));
    expect(answer.indirect).toBe(false);
    expect(answer.fns).toEqual(new Set(functions.map((f) => f.name)));
  }
});

test("recursive components only throw when they reach a throwing seed", () => {
  const mod = moduleWith(
    fn("caller", [call("left"), call("left")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("pure", [call("pure")], []),
  );
  expect(computeMayThrow(mod).fns.size).toBe(0);
  mod.functions[2]!.body.push(failure);
  expect(computeMayThrow(mod).fns).toEqual(new Set(["caller", "left", "right"]));
});

test("a transitively throwing closure activates indirect callers and their callers", () => {
  const mod = moduleWith(
    fn("outer", [call("indirect")], []),
    fn("indirect", [callClosure("wrapper")], []),
    fn("wrapper", [call("target")], []),
    fn("target", [failure], []),
    fn("otherIndirect", [callClosure("pure")], []),
    fn("pure", [], []),
  );
  const before = structuredClone(mod);
  const answer = computeMayThrow(mod);
  expect(answer.indirect).toBe(true);
  expect(answer.fns).toEqual(new Set(["outer", "indirect", "wrapper", "target", "otherIndirect"]));
  expect(mod).toEqual(before);
  mod.functions[3]!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
  expect(answer.fns.size).toBe(5);
});

test.each(["async", "generator", "async generator"])(
  "a throwing %s body does not unwind direct or indirect callers",
  (kind) => {
    const target = fn("target", [failure], []);
    if (kind.includes("async")) target.async = true;
    if (kind.includes("generator"))
      target.generator = {
        yieldT: F64,
        nextT: VOID,
        resultType: { kind: "record", shapeId: "result" },
      };
    const mod = moduleWith(fn("caller", [call("target"), callClosure("target")], []), target);
    expect(computeMayThrow(mod)).toEqual({ fns: new Set(["target"]), indirect: false });
  },
);

test("dynamic function adapters activate indirect calls without an IR closure target", () => {
  const adapter: IrExpr = {
    kind: "dynCheck",
    value: { kind: "varRef", localId: "unknown", type: DYN, loc },
    type: funcOf([], VOID),
    loc,
  };
  const callee: IrExpr = { kind: "varRef", localId: "callback", type: funcOf([], VOID), loc };
  const mod = moduleWith(
    fn("caller", [call("indirect")], []),
    fn("indirect", [exprStmt({ kind: "callValue", callee, args: [], type: VOID, loc })], []),
    fn("adapter", [exprStmt(adapter)], []),
  );
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["caller", "indirect", "adapter"]),
    indirect: true,
  });
});

const construct = (className: string, direct = false): IrStmt =>
  exprStmt(
    direct
      ? { kind: "new", className, args: [], type: { kind: "object", className }, loc }
      : {
          kind: "newValue",
          callee: { kind: "classRef", className, type: { kind: "classval", className }, loc },
          args: [],
          type: { kind: "object", className },
          loc,
        },
  );

test("class-value construction includes descendants without making direct or sibling construction throw", () => {
  const mod = moduleWith(
    fn("caller", [call("rootValue")], []),
    ...["Root", "Middle", "Leaf", "Sibling", "Other"].flatMap((name) => [
      fn(`${name.toLowerCase()}Value`, [construct(name), construct(name)], []),
      fn(`${name.toLowerCase()}Direct`, [construct(name, true)], []),
      fn(`%${name}.constructor`, name === "Leaf" || name === "Other" ? [call("failure")] : [], []),
    ]),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Leaf", base: "Middle", fields: [], loc },
    { name: "Sibling", base: "Root", fields: [], loc },
    { name: "Middle", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "Root", fields: [], loc },
  ];
  const before = structuredClone(mod);
  const expected = new Set([
    "failure",
    "%Leaf.constructor",
    "%Other.constructor",
    "caller",
    "rootValue",
    "middleValue",
    "leafValue",
    "leafDirect",
    "otherValue",
    "otherDirect",
  ]);
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  expect(mod).toEqual(before);
  mod.classes.reverse();
  mod.functions.reverse();
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  mod.functions.find((f) => f.name === "%Leaf.constructor")!.body = [];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["failure", "%Other.constructor", "otherValue", "otherDirect"]),
    indirect: false,
  });
});

test("class-value dependencies participate in the call graph fixpoint", () => {
  const mod = moduleWith(
    fn("caller", [construct("Root")], []),
    fn("direct", [construct("Root", true)], []),
    fn("%Root.constructor", [], []),
    fn("%Child.constructor", [construct("Other")], []),
    fn("%Other.constructor", [construct("Root")], []),
    fn("%OtherChild.constructor", [call("failure")], []),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Root", fields: [], loc },
    { name: "Child", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "OtherChild", base: "Other", fields: [], loc },
  ];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set([
      "failure",
      "%OtherChild.constructor",
      "%Child.constructor",
      "%Other.constructor",
      "caller",
    ]),
    indirect: false,
  });
  mod.functions.find((f) => f.name === "failure")!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
});

test("propagates construction through a deep hierarchy without descendant expansion or recursive traversal", () => {
  const size = 6000;
  const mod = moduleWith(
    ...Array.from({ length: size }, (_, i) => fn(`factory${i}`, [construct(`C${i}`)], [])),
    fn(`%C${size - 1}.constructor`, [failure], []),
  );
  mod.classes = Array.from({ length: size }, (_, i) => ({
    name: `C${i}`,
    ...(i > 0 ? { base: `C${i - 1}` } : {}),
    fields: [],
    loc,
  })).reverse();
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(mod.functions.map((f) => f.name)),
    indirect: false,
  });
});

test("generic collection mutation propagates checked storage failures to callers", () => {
  const mapType = { kind: "map" as const, key: DYN, value: DYN };
  const setType = { kind: "set" as const, elem: DYN };
  const map: IrExpr = { kind: "varRef", localId: "map", type: mapType, loc };
  const set: IrExpr = { kind: "varRef", localId: "set", type: setType, loc };
  const input: IrExpr = { kind: "varRef", localId: "input", type: DYN, loc };
  const write: IrExpr = {
    kind: "mapIntrinsic",
    method: "set",
    receiver: map,
    args: [input, input],
    type: VOID,
    loc,
  };
  const add: IrExpr = {
    kind: "setIntrinsic",
    method: "add",
    receiver: set,
    args: [input],
    type: VOID,
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "write", args: [], type: VOID, loc })],
    [],
  );
  expect(
    computeMayThrow(
      moduleWith(caller, fn("write", [exprStmt(write)], []), fn("add", [exprStmt(add)], [])),
    ).fns,
  ).toEqual(new Set(["caller", "write", "add"]));
});

test("worker programs poll for termination only where execution can be unbounded", () => {
  const call = (callee: string): IrStmt =>
    exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
  const plain = (name: string, body: IrStmt[]): IrFunction => fn(name, body, []);
  const loop: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    body: [],
    loc,
  };
  const mod: IrModule = {
    ...moduleWith(
      plain("caller", [call("leaf"), call("looping"), call("left"), call("indirect")]),
      plain("leaf", [exprStmt(value)]),
      plain("leafCaller", [call("leaf")]),
      plain("looping", [loop]),
      plain("left", [call("right")]),
      plain("right", [call("left")]),
      plain("self", [call("self")]),
      plain("indirect", [
        exprStmt({
          kind: "callValue",
          callee: { kind: "closure", fnName: "leaf", captures: [], type: funcOf([], VOID), loc },
          args: [],
          type: VOID,
          loc,
        }),
      ]),
    ),
    workers: true,
  };
  const answer = computeMayThrow(mod);
  // The entry, call cycles and unbounded operations poll on entry; a loop
  // polls itself; bounded leaves poll nowhere and unwind nothing.
  expect([...answer.workerEntryPolls!].sort()).toEqual([
    "caller",
    "indirect",
    "left",
    "right",
    "self",
  ]);
  expect([...answer.fns].sort()).toEqual([
    "caller",
    "indirect",
    "left",
    "looping",
    "right",
    "self",
  ]);
  expect(computeMayThrow({ ...mod, workers: false }).workerEntryPolls).toBeUndefined();
});

test("stack checks cover recursive components and recursion through reentrant operations", () => {
  const mod = moduleWith(
    fn("caller", [call("self"), call("left"), call("leaf"), call("walker")], []),
    fn("self", [call("self"), call("leaf")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("leaf", [exprStmt(value)], []),
    // walker reaches itself only through a closure it calls indirectly.
    fn("walker", [callClosure("step")], []),
    fn("step", [call("walker")], []),
    // A reentrant leaf whose closure targets never come back stays unchecked.
    fn("visitor", [callClosure("leaf")], []),
  );
  const answer = computeMayThrow(mod, { stackChecks: true });
  expect([...answer.stackChecks!].sort()).toEqual(["left", "right", "self", "step", "walker"]);
  // Checked functions throw the overflow RangeError, so their callers poll;
  // a throwing closure target makes every indirect call poll as well.
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual([
    "caller",
    "left",
    "right",
    "self",
    "step",
    "visitor",
    "walker",
  ]);
  expect(computeMayThrow(mod).stackChecks).toBeUndefined();
  expect(computeMayThrow(mod).fns.size).toBe(0);
});

test("class members are reachable from reentrant operations", () => {
  const mod: IrModule = {
    ...moduleWith(
      fn("%Shape.describe", [exprStmt({ kind: "dynFrom", value, type: DYN, loc })], []),
      fn("%Shape.area", [exprStmt(value)], []),
      fn("%main", [exprStmt({ kind: "dynFrom", value, type: DYN, loc })], []),
    ),
    classes: [{ name: "Shape", fields: [], methods: ["describe", "area"], loc }],
  };
  const answer = computeMayThrow(mod, { stackChecks: true });
  // describe stays bounded too: dynFrom is a plain conversion.
  expect([...answer.stackChecks!]).toEqual([]);
  mod.functions[0]!.body = [
    exprStmt({
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value, type: DYN, loc },
      method: "describe",
      calleeName: "describe",
      args: [],
      type: DYN,
      loc,
    }),
  ];
  mod.functions[2]!.body = mod.functions[0]!.body;
  expect([...computeMayThrow(mod, { stackChecks: true }).stackChecks!]).toEqual([
    "%Shape.describe",
  ]);
});

test("throw-only, storage and primitive library operations stay bounded in workers", () => {
  const text: IrExpr = { kind: "strLit", value: "a", type: STRING, loc };
  const nodeThrow: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [value, text, text],
    type: VOID,
    loc,
  };
  const stringCall = (arg: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "string.lastIndexOf",
    args: [text, arg],
    type: F64,
    loc,
  });
  const dynArg: IrExpr = { kind: "dynFrom", value: { ...value }, type: DYN, loc };
  const mod: IrModule = {
    ...moduleWith(
      fn("thrower", [exprStmt(nodeThrow)], []),
      fn("primitive", [exprStmt(stringCall(text))], []),
      fn("dynamic", [exprStmt(stringCall(dynArg))], []),
    ),
    workers: true,
  };
  // Only a library call that can reach a dynamic value's conversion polls.
  expect([...computeMayThrow(mod).workerEntryPolls!].sort()).toEqual(["dynamic"]);
});

test("explain names the first throwing operation and each call edge", () => {
  const message: IrExpr = {
    kind: "strLit",
    value: "Cannot read properties of undefined (reading 'length')",
    type: STRING,
    loc,
  };
  const code: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const typeError: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  const nodeThrow: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [typeError, code, message],
    type: VOID,
    loc,
  };
  const callLoc = { file: "tdz.ts", start: 5, end: 9 };
  const mod = moduleWith(
    fn("thrower", [exprStmt(nodeThrow)], []),
    fn("caller", [exprStmt({ kind: "call", callee: "thrower", args: [], type: VOID, loc: callLoc })], []),
    fn("quiet", [exprStmt(value)], []),
  );
  const result = computeMayThrow(mod, { explain: true });
  expect([...result.fns].sort()).toEqual(["caller", "thrower"]);
  expect(result.why?.get("thrower")).toEqual({
    kind: "seed",
    what: "throws TypeError: Cannot read properties of undefined (reading 'length')",
    loc,
  });
  expect(result.why?.get("caller")).toEqual({ kind: "call", callee: "thrower", loc: callLoc });
  // Without the option the analysis records nothing extra.
  expect(computeMayThrow(mod).why).toBeUndefined();
});
