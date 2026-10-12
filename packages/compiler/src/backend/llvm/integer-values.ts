import type { IrExpr, IrType } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";

export type LlInteger = NonNullable<LlValue["integer"]>;

/** Materialize a proven integer only at an integer consumer. The ordinary
 * double remains authoritative when there is no proof, and ToUint32 views
 * are reused only when the range proves they have not lost high bits. */
export function exactInteger(
  host: LlvmEmitterContext,
  value: LlValue,
  expr?: IrExpr,
): LlInteger | null {
  if (value.integer) {
    const range = expr ? host.integerRanges.get(expr) : null;
    return range
      ? {
          ...value.integer,
          range: {
            min: Math.max(value.integer.range.min, range.min),
            max: Math.min(value.integer.range.max, range.max),
          },
        }
      : value.integer;
  }
  if (expr?.kind === "numLit" && Number.isSafeInteger(expr.value) && !Object.is(expr.value, -0)) {
    return {
      name: String(expr.value),
      type: "i64",
      signed: expr.value < 0,
      range: { min: expr.value, max: expr.value },
    };
  }
  const range = expr ? host.integerRanges.get(expr) : null;
  if (!range) return null;
  if (value.uint32 !== undefined && range.min >= 0 && range.max <= 4294967295) {
    return { name: value.uint32, type: "i32", signed: false, range };
  }
  if (value.uint32 !== undefined && range.min >= -2147483648 && range.max <= 2147483647) {
    return { name: value.uint32, type: "i32", signed: true, range };
  }
  if (range.min >= -2147483648 && range.max <= 2147483647) {
    // An int32 conversion lets LLVM fold it with an int32 source's sitofp.
    const name = host.B.tmp();
    host.B.line(`${name} = fptosi double ${value.name} to i32`);
    return { name, type: "i32", signed: true, range };
  }
  const name = host.B.tmp();
  host.B.line(`${name} = fptosi double ${value.name} to i64`);
  return { name, type: "i64", signed: true, range };
}

export function widenInteger(host: LlvmEmitterContext, value: LlInteger): string {
  if (value.type === "i64") return value.name;
  const wide = host.B.tmp();
  host.B.line(`${wide} = ${value.signed ? "sext" : "zext"} i32 ${value.name} to i64`);
  return wide;
}

/** The i32 of an integer whose range is within int32. */
export function narrowInteger(host: LlvmEmitterContext, value: LlInteger): string {
  if (value.type === "i32") return value.name;
  const narrow = host.B.tmp();
  host.B.line(`${narrow} = trunc i64 ${value.name} to i32`);
  return narrow;
}

/** `integerNumber` for an i32 whose range is within int32. */
export function int32Number(
  host: LlvmEmitterContext,
  name: string,
  range: IntegerRange,
  type: IrType,
): LlValue {
  const number = host.B.tmp();
  host.B.line(`${number} = sitofp i32 ${name} to double`);
  return { name: number, type, uint32: name, integer: { name, type: "i32", signed: true, range } };
}

export function integerNumber(
  host: LlvmEmitterContext,
  name: string,
  range: IntegerRange,
  type: IrType,
): LlValue {
  const number = host.B.tmp();
  const uint32 = host.B.tmp();
  host.B.line(`${uint32} = trunc i64 ${name} to i32`);
  // A proven int32 converts from its low half. The value is the same, but
  // LLVM folds `fptosi (sitofp i32 x)` back to x, also through the phis of
  // loop-carried locals (whose other incoming values are int32 too, such as
  // `x | 0`), while a 64-bit source is not known to convert exactly. So a
  // counter written `i = (i + 1) | 0` stays an integer instead of taking a
  // double round trip on every iteration.
  const int32 = range.min >= -2147483648 && range.max <= 2147483647;
  host.B.line(
    int32
      ? `${number} = sitofp i32 ${uint32} to double`
      : `${number} = sitofp i64 ${name} to double`,
  );
  return { name: number, type, uint32, integer: { name, type: "i64", signed: true, range } };
}
