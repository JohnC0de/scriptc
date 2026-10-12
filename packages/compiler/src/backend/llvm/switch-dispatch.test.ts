import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrExpr, type IrModule, type IrType } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "switch.ts", start: 0, end: 0 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const string = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });

function emit(type: IrType, tests: (IrExpr | null)[], pointerBits: 32 | 64 = 64): string {
  return emitWith({ kind: "varRef", localId: "value", type, loc }, tests, pointerBits);
}

function emitWith(disc: IrExpr, tests: (IrExpr | null)[], pointerBits: 32 | 64 = 64): string {
  const type = disc.kind === "varRef" ? disc.type : F64;
  const mod: IrModule = {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "dispatch",
        params: [{ name: "value", localId: "value", type }],
        returnType: F64,
        locals: [{ id: "value", name: "value", type, mutable: false }],
        loc,
        body: [
          {
            kind: "switch",
            disc,
            cases: tests.map((test, index) => ({
              test,
              body: [{ kind: "return", value: number(index), loc }],
            })),
            loc,
          },
          { kind: "return", value: number(-1), loc },
        ],
      },
    ],
  };
  return /^define internal [^\n]*@sc_[bf]+_dispatch\([^]*?^}/m.exec(
    emitLlvmModule(mod, { pointerBits }),
  )![0];
}

test("integer dispatch round-trips a frozen conversion before selecting a native case", () => {
  for (const [values, bits] of [
    [[-2147483648, -1, 0, 2147483647], "i32"],
    [[0, 1, 2147483648, 4294967295], "i64"],
    [[-9007199254740991, -1, 0, 9007199254740991], "i64"],
  ] as const) {
    const body = emit(F64, values.map(number));
    expect(body).toContain(`switch ${bits}`);
    expect(body).toContain(`fptosi double`);
    expect(body).toContain(`freeze ${bits}`);
    expect(body).toContain(`sitofp ${bits}`);
    expect(body).toContain("fcmp oeq double");
    // NaN, infinities and out-of-range values fail the exact round trip;
    // no separate range tests are needed.
    expect(body).not.toContain("fcmp oge double");
    expect(body).not.toContain("fcmp ole double");
    expect(body.indexOf("freeze")).toBeLessThan(body.indexOf("br i1"));
  }
});

test("a proven integer discriminant selects without converting", () => {
  const value: IrExpr = { kind: "varRef", localId: "value", type: F64, loc };
  const disc: IrExpr = { kind: "bin", op: "|", left: value, right: number(0), type: F64, loc };
  const body = emitWith(disc, [1, 2, 3, 4].map(number));
  expect(body).toContain("switch i32");
  // The ToInt32 coercion of `value | 0` converts once; dispatch adds no
  // round trip of its own.
  expect(body).not.toContain("freeze");
  expect(body).not.toContain("fcmp oeq double");
});

test("duplicate numeric labels keep the first destination and share zero", () => {
  const body = emit(F64, [-0, 0, 1, 2, 3, 1].map(number));
  const dispatch = body.split("\n").find((line) => line.includes("switch i32"))!;
  expect(dispatch.match(/i32 0, label/g)).toHaveLength(1);
  expect(dispatch.match(/i32 1, label/g)).toHaveLength(1);
});

test("noninteger literals and computed tests retain source-order comparisons", () => {
  for (const extra of [
    number(0.5),
    number(NaN),
    number(Infinity),
    { kind: "bin", op: "+", left: number(9), right: number(0), type: F64, loc } as IrExpr,
  ]) {
    const body = emit(F64, [number(1), number(2), number(3), number(4), extra]);
    expect(body).not.toContain("switch i32");
    expect(body).not.toContain("fptosi");
    expect(body.match(/fcmp oeq double/g)).toHaveLength(5);
  }
});

test("string dispatch uses target-width byte lengths and checks equality inside each group", () => {
  for (const bits of [32, 64] as const) {
    const body = emit(STRING, ["", "a", "é", "😀", "tail", "é"].map(string), bits);
    expect(body).toContain(`load i${bits}, ptr`);
    expect(body).toContain(`switch i${bits}`);
    expect(body).not.toContain("_str_utf16_len");
    expect(body.match(/call zeroext i1 @sc_str_eq/g)).toHaveLength(5);
    const dispatch = body.split("\n").find((line) => line.includes(`switch i${bits}`))!;
    expect(dispatch).toContain(`i${bits} 2, label`);
    expect(dispatch.match(new RegExp(`i${bits} 4, label`, "g"))).toHaveLength(1);
  }
});
