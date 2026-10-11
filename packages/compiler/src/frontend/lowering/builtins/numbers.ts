import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { lowerCheckedPredicateValue } from "../lower-builtin-values.js";
import { locOf } from "../../program.js";
import { BOOL, F64, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { lowerBuiltinValuePreservingUndefined, lowerOptionalNumberPredicate } from "./arguments.js";

/** The lowered Number statics, by member name. The predicate quartet has
 * static C implementations (JS-exact: the ES2015 statics never coerce, so
 * only f64-typed arguments route through — anything else fences honestly
 * instead of folding to false past possible side effects). */
const NUMBER_STATIC_PREDICATES: Record<string, IrLibFn | undefined> = {
  isFinite: "number.isFinite",
  isNaN: "number.isNaN",
  isInteger: "number.isInteger",
  isSafeInteger: "number.isSafeInteger",
};

/** The Number constants, baked as literals — non-finite ones included
 * (numLits carry NaN and the infinities; the backend preserves them). */
const NUMBER_CONSTANTS: Record<string, number | undefined> = {
  MAX_SAFE_INTEGER: 9007199254740991,
  MIN_SAFE_INTEGER: -9007199254740991,
  EPSILON: 2.220446049250313e-16,
  MAX_VALUE: 1.7976931348623157e308,
  MIN_VALUE: 5e-324,
  NaN: NaN,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
};

export function lowerNumberStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "Number");
  if (member === null) return null;
  const loc = locOf(call);
  const fn = own(NUMBER_STATIC_PREDICATES, member);
  if (fn !== undefined) {
    if (call.arguments.length !== 1) {
      lowerer.noLowering(`Number.${member} with ${call.arguments.length} arguments`, call);
    }
    const argNode = call.arguments[0]!;
    const arg = lowerBuiltinValuePreservingUndefined(lowerer, argNode);

    const optional = lowerOptionalNumberPredicate(lowerer, arg, fn, loc);
    if (optional) return optional;
    if (arg.type.kind !== "f64") {
      lowerer.noLowering(
        `Number.${member} of '${lowerer.fmt(arg.type)}' values`,
        argNode,
        "the Number statics never coerce — a statically non-number argument is constantly false in JS (narrow unions first, or write the constant)",
      );
    }
    return { kind: "libCall", fn, args: [arg], type: BOOL, loc };
  }
  if (member === "parseFloat" || member === "parseInt") {
    const want = member === "parseFloat" ? 1 : 2;
    if (call.arguments.length !== want) {
      lowerer.noLowering(
        `Number.${member} with ${call.arguments.length} argument${call.arguments.length === 1 ? "" : "s"}`,
        call,
        member === "parseInt" ? "pass an explicit radix: Number.parseInt(s, 10)" : undefined,
      );
    }
    lowerer.refuseUnsupportedApi(`'Number.${member}'`, call);
  }
  return null; // other Number statics land on the member fence
}

/** Property READS on THE `Number` global: the finite constants bake as
 * number literals. NaN/POSITIVE_INFINITY/NEGATIVE_INFINITY and method
 * members as values fall through to the member fence. Null for
 * non-Number receivers. */
export function lowerNumberStaticProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "Number");
  if (member === null) return null;
  const predicate = own(NUMBER_STATIC_PREDICATES, member);
  if (predicate)
    return lowerCheckedPredicateValue(
      lowerer,
      `Number.${member}`,
      "number",
      locOf(expr),
      predicate,
    );
  const value = own(NUMBER_CONSTANTS, member);
  if (value === undefined) return null;
  return { kind: "numLit", value, type: F64, loc: locOf(expr) };
}
