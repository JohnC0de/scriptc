import { expect, test } from "vitest";
import { analyzeIntegerRanges } from "./integer-ranges.js";
import { BOOL, F64, STRING, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId = "x"): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bin = (op: Extract<IrExpr, { kind: "bin" }>["op"], left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
});
const assign = (value: IrExpr): IrStmt => ({ loc, kind: "assign", localId: "x", value });
const fn = (body: IrStmt[], boxed = false): IrFunction => ({
  loc,
  name: "f",
  params: [],
  returnType: F64,
  locals: [
    { id: "x", name: "x", type: F64, mutable: true, ...(boxed ? { boxed: true as const } : {}) },
  ],
  body,
});

test("tracks exact additions and bitwise conversions through assignments", () => {
  const sum = bin("+", ref(), bin("<<", ref(), num(3)));
  const unsigned = bin(">>>", ref(), num(0));
  const ranges = analyzeIntegerRanges(
    fn([assign(bin("|", num(0), num(0))), assign(sum), { loc, kind: "return", value: unsigned }]),
  );
  expect(ranges.get(sum)).toEqual({ min: -4294967296, max: 4294967294 });
  expect(ranges.get(unsigned)).toEqual({ min: 0, max: 4294967295 });
});

test("rejects negative zero, fractions, nonfinite values and imprecise sums", () => {
  for (const value of [-0, 0.5, NaN, Infinity, -Infinity, 9007199254740992]) {
    const sum = bin("+", num(value), num(0));
    expect(analyzeIntegerRanges(fn([{ loc, kind: "return", value: sum }])).get(sum)).toBeNull();
  }
  const exact = bin("-", num(Number.MAX_SAFE_INTEGER), num(1));
  const rounded = bin("+", num(Number.MAX_SAFE_INTEGER), num(2));
  const ranges = analyzeIntegerRanges(fn([assign(exact), { loc, kind: "return", value: rounded }]));
  expect(ranges.get(exact)).toEqual({ min: 9007199254740990, max: 9007199254740990 });
  expect(ranges.get(rounded)).toBeNull();
});

test("preserves uncaptured slots across calls and invalidates writes and boxed locals", () => {
  const sum = (): IrExpr => bin("+", ref(), num(1));
  const call: IrExpr = { loc, kind: "call", callee: "unknown", args: [], type: F64 };
  const afterCall = sum();
  const afterBlock = sum();
  const boxed = sum();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: call },
      assign(afterCall),
      assign(num(1)),
      { loc, kind: "block", body: [assign(num(Infinity))] },
      { loc, kind: "return", value: afterBlock },
    ]),
  );
  expect(ranges.get(afterCall)).toEqual({ min: 2, max: 2 });
  expect(ranges.get(afterBlock)).toBeNull();
  expect(
    analyzeIntegerRanges(fn([assign(num(1)), { loc, kind: "return", value: boxed }], true)).get(
      boxed,
    ),
  ).toBeNull();
});

test("analyzes nested bodies independently and snapshots operands before writes", () => {
  const before = ref();
  const write: IrExpr = { loc, kind: "assignExpr", localId: "x", value: num(Infinity), type: F64 };
  const after = ref();
  const nested = bin("+", ref(), num(1));
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: bin("|", before, write) },
      { loc, kind: "exprStmt", expr: after },
      { loc, kind: "block", body: [assign(num(2)), { loc, kind: "return", value: nested }] },
    ]),
  );
  expect(ranges.get(before)).toEqual({ min: 1, max: 1 });
  expect(ranges.get(after)).toBeNull();
  expect(ranges.get(nested)).toEqual({ min: 3, max: 3 });
});

test("shared expression objects never inherit a proof from another occurrence", () => {
  const shared = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: shared },
      assign(num(Infinity)),
      {
        loc,
        kind: "return",
        value: { loc, kind: "call", callee: "unknown", args: [shared], type: F64 },
      },
    ]),
  );
  expect(ranges.get(shared)).toBeNull();
});

const condition = (
  op: Extract<IrExpr, { kind: "bin" }>["op"],
  left: IrExpr,
  right: IrExpr,
): IrExpr => ({ loc, kind: "bin", op, left, right, type: BOOL });
const observe = (value: IrExpr): IrStmt => ({ loc, kind: "exprStmt", expr: value });
const INT32 = { min: -2147483648, max: 2147483647 };

test("joins branch assignments and refines signed masks on guarded paths", () => {
  const inside = ref(),
    joined = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(bin("|", ref("unknown"), num(0))),
      {
        loc,
        kind: "if",
        cond: condition(">=", ref(), num(0)),
        then: [observe(inside), assign(bin("&", ref(), num(255)))],
        else_: [assign(num(7))],
      },
      observe(joined),
    ]),
  );
  expect(ranges.get(inside)).toEqual({ min: 0, max: 2147483647 });
  expect(ranges.get(joined)).toEqual({ min: 0, max: 255 });
});

test("assignment snapshots and lazy joins do not overwrite earlier operands", () => {
  const before = ref(),
    after = ref(),
    last = ref();
  const write: IrExpr = { loc, kind: "assignExpr", localId: "x", value: num(3), type: F64 };
  const ternary: IrExpr = {
    loc,
    kind: "ternary",
    cond: condition("===", ref("flag"), num(0)),
    then: write,
    else_: num(5),
    type: F64,
  };
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      observe(bin("+", before, ternary)),
      observe(after),
      observe({
        loc,
        kind: "logical",
        op: "&&",
        left: ref("flag"),
        right: { ...write, value: num(9) },
        type: F64,
      }),
      observe(last),
    ]),
  );
  expect(ranges.get(before)).toEqual({ min: 1, max: 1 });
  expect(ranges.get(after)).toEqual({ min: 1, max: 3 });
  expect(ranges.get(last)).toEqual({ min: 1, max: 9 });
});

test("guards that mutate a compared binding cannot refine its later value", () => {
  const current = ref();
  const writes: IrExpr = {
    loc,
    kind: "seqExpr",
    stmts: [assign(bin(">>>", ref("unknown"), num(0)))],
    result: num(100),
    type: F64,
  };
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      {
        loc,
        kind: "if",
        cond: condition("<", ref(), writes),
        then: [observe(current)],
        else_: null,
      },
    ]),
  );
  expect(ranges.get(current)).toEqual({ min: 0, max: 4294967295 });
});

test("labeled exits and do-while conditions cannot lend facts to skipped paths", () => {
  const afterBlock = ref(),
    firstBody = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(100)),
      {
        loc,
        kind: "block",
        labels: ["done"],
        body: [
          {
            loc,
            kind: "if",
            cond: condition("===", ref("flag"), num(0)),
            then: [{ loc, kind: "break", label: "done" }],
            else_: null,
          },
          assign(num(1)),
        ],
      },
      observe(afterBlock),
      {
        loc,
        kind: "doWhile",
        cond: condition(
          "<",
          { loc, kind: "assignExpr", localId: "x", value: num(0), type: F64 },
          num(-1),
        ),
        body: [observe(firstBody)],
      },
    ]),
  );
  // The break skips `x = 1`; both writes are int32 literals, so the join
  // keeps only the int32-closed range, never the skipped path's fact.
  expect(ranges.get(afterBlock)).toEqual(INT32);
  // Likewise the condition's `x = 0` does not reach the first iteration.
  expect(ranges.get(firstBody)).toEqual(INT32);
});

test("unit induction is exact but loop-carried assignments remain unknown", () => {
  const counter = ref(),
    carried = ref("state"),
    after = ref();
  const f = fn([
    {
      loc,
      kind: "for",
      init: { loc, kind: "varDecl", localId: "x", init: num(0) },
      cond: condition("<", ref(), num(10)),
      update: assign(bin("+", ref(), num(1))),
      body: [
        observe(counter),
        observe(carried),
        { loc, kind: "assign", localId: "state", value: num(3) },
      ],
    },
    observe(after),
  ]);
  f.locals.push({ id: "state", name: "state", type: F64, mutable: true });
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(counter)).toEqual({ min: 0, max: 9 });
  expect(ranges.get(carried)).toBeNull();
  expect(ranges.get(after)).toBeNull();
});

test("filtered strided loops retain decoded values and bound secondary cursors", () => {
  const cursor = ref("position"),
    decoded = ref("decoded"),
    conditionRead = ref("x");
  const loop: IrStmt & { kind: "for" } = {
    loc,
    kind: "for",
    init: { loc, kind: "varDecl", localId: "x", init: num(0) },
    cond: condition("<", conditionRead, num(100)),
    update: assign(bin("+", ref(), num(24))),
    body: [
      { loc, kind: "varDecl", localId: "decoded", init: bin(">>>", ref("input"), num(0)) },
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(0)),
        then: [{ loc, kind: "continue" }],
        else_: null,
      },
      observe(decoded),
      observe(cursor),
      { loc, kind: "assign", localId: "position", value: bin("+", ref("position"), num(16)) },
    ],
  };
  const f = fn([{ loc, kind: "varDecl", localId: "position", init: num(0) }, loop]);
  f.locals.push(
    ...["position", "decoded"].map((id) => ({ id, name: id, type: F64, mutable: true })),
  );
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(cursor)).toEqual({ min: 0, max: 80 });
  expect(ranges.get(decoded)).toEqual({ min: 0, max: 4294967295 });
  expect(ranges.get(conditionRead)).toEqual({ min: 0, max: 124 });
  for (const mutation of ["fraction", "repeat", "overflow", "counter"] as const) {
    const changed = structuredClone(f);
    const body = (changed.body[1] as IrStmt & { kind: "for" }).body;
    const update = body[4] as IrStmt & { kind: "assign" };
    if (mutation === "fraction") update.value = bin("+", ref("position"), num(0.5));
    if (mutation === "repeat")
      body[4] = {
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [update],
      };
    if (mutation === "overflow")
      (changed.body[0] as IrStmt & { kind: "varDecl" }).init = num(Number.MAX_SAFE_INTEGER);
    if (mutation === "counter") body.push(assign(num(0)));
    const observation = body[3] as IrStmt & { kind: "exprStmt" };
    expect(analyzeIntegerRanges(changed).get(observation.expr), mutation).toBeNull();
  }
});

test("an exit branch does not discard the surviving facts or escape its own label", () => {
  const afterReturn = ref(),
    afterLabel = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(3)),
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(0)),
        then: [{ loc, kind: "return", value: num(1) }],
        else_: null,
      },
      observe(afterReturn),
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(1)),
        then: [
          {
            loc,
            kind: "block",
            labels: ["done"],
            body: [assign(num(0.5)), { loc, kind: "break", label: "done" }],
          },
        ],
        else_: null,
      },
      observe(afterLabel),
    ]),
  );
  expect(ranges.get(afterReturn)).toEqual({ min: 3, max: 3 });
  expect(ranges.get(afterLabel)).toBeNull();
});

test("int32-closed locals keep the int32 range across loops and switches", () => {
  const loop = (write: IrExpr): { inside: IrExpr; after: IrExpr; f: IrFunction } => {
    const inside = ref(),
      after = ref();
    const f = fn([
      assign(num(0)),
      {
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [assign(write), observe(inside)],
      },
      observe(after),
    ]);
    return { inside, after, f };
  };
  const closed = loop(bin("|", ref(), ref("unknown")));
  const closedRanges = analyzeIntegerRanges(closed.f);
  expect(closedRanges.get(closed.inside)).toEqual(INT32);
  expect(closedRanges.get(closed.after)).toEqual(INT32);
  for (const write of [
    bin("+", ref(), num(1)),
    bin("/", ref(), num(2)),
    bin(">>>", ref(), num(0)),
  ]) {
    const open = loop(write);
    expect(analyzeIntegerRanges(open.f).get(open.after), write.kind).toBeNull();
  }
  const afterSwitch = ref();
  const switched = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      {
        loc,
        kind: "switch",
        disc: ref("unknown"),
        cases: [
          { test: num(0), body: [assign(bin("^", ref(), num(4)))] },
          { test: null, body: [assign(num(-1))] },
        ],
      } as IrStmt,
      observe(afterSwitch),
    ]),
  );
  expect(switched.get(afterSwitch)).toEqual(INT32);
});

test("whole-program slot facts seed parameters, field reads and call results", () => {
  const field: IrExpr = {
    loc,
    kind: "fieldGet",
    obj: { loc, kind: "varRef", localId: "o", type: { kind: "object", className: "C" } },
    className: "C",
    field: "flags",
    type: F64,
  };
  const result: IrExpr = { loc, kind: "call", callee: "bits", args: [], type: F64 };
  const param = ref("p");
  const f: IrFunction = {
    ...fn([observe(field), observe(result), observe(param)]),
    params: [{ localId: "p", name: "p", type: F64 }],
    locals: [{ id: "p", name: "p", type: F64, mutable: true }],
  };
  const plain = analyzeIntegerRanges(f);
  expect([plain.get(field), plain.get(result), plain.get(param)]).toEqual([null, null, null]);
  const seeded = analyzeIntegerRanges(f, {
    params: new Map([["p", INT32]]),
    field: (className, name) => (className === "C" && name === "flags" ? INT32 : null),
    call: (callee) => (callee === "bits" ? INT32 : null),
  });
  expect([seeded.get(field), seeded.get(result), seeded.get(param)]).toEqual([INT32, INT32, INT32]);
});

test("string lengths and found indices are int32, other string reads stay unknown", () => {
  const text: IrExpr = { loc, kind: "strLit", value: "abc", type: STRING };
  const read = (method: "length" | "indexOf" | "charCodeAt", args: IrExpr[] = []): IrExpr => ({
    loc,
    kind: "strIntrinsic",
    method,
    receiver: text,
    args,
    type: F64,
  });
  const length = read("length");
  const found = read("indexOf", [{ loc, kind: "strLit", value: "b", type: STRING }]);
  const code = read("charCodeAt", [num(0)]);
  const next = bin("+", length, num(1));
  const ranges = analyzeIntegerRanges(
    fn([observe(length), observe(found), observe(code), observe(next)]),
  );
  expect(ranges.get(length)).toEqual({ min: 0, max: 2147483647 });
  expect(ranges.get(found)).toEqual({ min: -1, max: 2147483647 });
  // charCodeAt can be NaN.
  expect(ranges.get(code)).toBeNull();
  expect(ranges.get(next)).toEqual({ min: 1, max: 2147483648 });
});
