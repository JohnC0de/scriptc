import type { IrExpr, IrFunction, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";
import { byteNumberAccess, byteNumberRange } from "./byte-numbers.js";
import { boundedIntegerLoopFacts, integerPathFallsThrough } from "./integer-loop-facts.js";

/** Exactly representable integers, excluding negative zero. Facts describe
 * the evaluated value, never a later read of the same local binding. */
export interface IntegerRange {
  min: number;
  max: number;
}
export type IntegerRanges = ReadonlyMap<IrExpr, IntegerRange | null>;
const SIGNED: IntegerRange = { min: -2147483648, max: 2147483647 };
const UNSIGNED: IntegerRange = { min: 0, max: 4294967295 };
const EXACT_LIMIT = 2 ** 53;
/** The most UTF-16 code units a runtime string holds: SCR_STR_MAX_CAP
 * (scr_runtime.h) caps a string's UTF-8 bytes, and a UTF-16 length never
 * exceeds the UTF-8 byte length. */
const STRING_MAX_UNITS = 0x7fffffff;
type Facts = Map<string, IntegerRange>;

function union(left: IntegerRange, right: IntegerRange): IntegerRange {
  return { min: Math.min(left.min, right.min), max: Math.max(left.max, right.max) };
}
function merge(into: Facts, left: Facts, right: Facts): void {
  into.clear();
  for (const [id, value] of left) {
    const other = right.get(id);
    if (other) into.set(id, union(value, other));
  }
}
export function integerArithmeticRange(
  op: string,
  left: IntegerRange,
  right: IntegerRange,
): IntegerRange | null {
  let min: number;
  let max: number;
  if (op === "+") {
    min = left.min + right.min;
    max = left.max + right.max;
  } else if (op === "-") {
    min = left.min - right.max;
    max = left.max - right.min;
  } else if (op === "*") {
    if (
      (left.min <= 0 && left.max >= 0 && right.min < 0) ||
      (right.min <= 0 && right.max >= 0 && left.min < 0)
    )
      return null;
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    min = Math.min(...products);
    max = Math.max(...products);
  } else if (op === "%" && left.min >= 0 && right.min > 0) {
    return { min: 0, max: Math.min(left.max, right.max - 1) };
  } else return null;
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : null;
}

export const INT32_RANGE: IntegerRange = SIGNED;
export function withinInt32(range: IntegerRange | null | undefined): boolean {
  return !!range && range.min >= SIGNED.min && range.max <= SIGNED.max;
}
export function withinUint32(range: IntegerRange | null | undefined): boolean {
  return !!range && range.min >= UNSIGNED.min && range.max <= UNSIGNED.max;
}

export type BitwiseOp = "&" | "|" | "^" | "<<" | ">>" | ">>>";
export function isBitwiseOp(op: string): op is BitwiseOp {
  return op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>" || op === ">>>";
}

/** What an operand of a bitwise operator is known to be: a range of exact
 * integers, or, for a numeric literal that is not one (2^53 + 2, 0.5, NaN,
 * Infinity), its value. Unknown operands are null. */
export type BitwiseOperand = IntegerRange | number | null;
function operandView(e: IrExpr, range: IntegerRange | null): BitwiseOperand {
  return range ?? (e.kind === "numLit" ? e.value : null);
}

/** The values ToInt32 can produce from the operand. A range inside int32 is
 * its own image; [2^31, 2^32) shifts down by 2^32; anything wider or unknown
 * wraps to the whole int32 range. */
function int32View(operand: BitwiseOperand): IntegerRange {
  if (typeof operand === "number") return { min: operand | 0, max: operand | 0 };
  if (withinInt32(operand)) return operand!;
  if (operand && operand.min > SIGNED.max && operand.max <= UNSIGNED.max)
    return { min: operand.min - 2 ** 32, max: operand.max - 2 ** 32 };
  return SIGNED;
}
/** The values ToUint32 can produce from the operand. */
function uint32View(operand: BitwiseOperand): IntegerRange {
  if (typeof operand === "number") return { min: operand >>> 0, max: operand >>> 0 };
  if (withinUint32(operand)) return operand!;
  if (operand && operand.min >= SIGNED.min && operand.max < 0)
    return { min: operand.min + 2 ** 32, max: operand.max + 2 ** 32 };
  return UNSIGNED;
}
/** The shift counts (`ToUint32(count) & 31`) the operand can produce. */
function shiftCounts(operand: BitwiseOperand): IntegerRange {
  const counts = uint32View(operand);
  return counts.max - counts.min < 32 && (counts.min & 31) <= (counts.max & 31)
    ? { min: counts.min & 31, max: counts.max & 31 }
    : { min: 0, max: 31 };
}
/** The smallest 2^k - 1 at or above a non-negative int32 or uint32. */
function bitCover(value: number): number {
  let cover = 0;
  while (cover < value) cover = cover * 2 + 1;
  return cover;
}

/** The result range of a JS bitwise operator over its operands' ranges.
 * Every result is an exact integer and never -0. */
export function bitwiseRange(
  op: BitwiseOp,
  leftOperand: BitwiseOperand,
  rightOperand: BitwiseOperand,
): IntegerRange {
  if (op === ">>>") {
    const value = uint32View(leftOperand),
      counts = shiftCounts(rightOperand);
    return {
      min: Math.floor(value.min / 2 ** counts.max),
      max: Math.floor(value.max / 2 ** counts.min),
    };
  }
  const left = int32View(leftOperand);
  if (op === ">>" || op === "<<") {
    const counts = shiftCounts(rightOperand);
    if (op === ">>")
      return {
        min: Math.min(
          Math.floor(left.min / 2 ** counts.min),
          Math.floor(left.min / 2 ** counts.max),
        ),
        max: Math.max(
          Math.floor(left.max / 2 ** counts.min),
          Math.floor(left.max / 2 ** counts.max),
        ),
      };
    const min = Math.min(left.min * 2 ** counts.min, left.min * 2 ** counts.max),
      max = Math.max(left.max * 2 ** counts.min, left.max * 2 ** counts.max);
    return withinInt32({ min, max }) ? { min, max } : SIGNED;
  }
  const right = int32View(rightOperand);
  if (op === "&") {
    // Clearing bits of a non-negative value cannot raise it; a negative
    // operand keeps the result at or below the other operand's maximum.
    if (left.min >= 0 && right.min >= 0) return { min: 0, max: Math.min(left.max, right.max) };
    if (left.min >= 0) return { min: 0, max: left.max };
    if (right.min >= 0) return { min: 0, max: right.max };
    if (left.max < 0 && right.max < 0)
      return { min: SIGNED.min, max: Math.min(left.max, right.max) };
    return SIGNED;
  }
  if (left.min === 0 && left.max === 0) return right;
  if (right.min === 0 && right.max === 0) return left;
  if (left.min >= 0 && right.min >= 0) {
    const max = bitCover(Math.max(left.max, right.max));
    return op === "|" ? { min: Math.max(left.min, right.min), max } : { min: 0, max };
  }
  if (op === "|") {
    // Setting bits of a negative int32 raises it toward -1.
    if (left.max < 0 && right.max < 0) return { min: Math.max(left.min, right.min), max: -1 };
    if (left.max < 0) return { min: left.min, max: -1 };
    if (right.max < 0) return { min: right.min, max: -1 };
  }
  return SIGNED;
}

/** The operand a bitwise operator returns unchanged when that operand is an
 * int32 (a uint32 for `>>>`): `x | 0`, `x ^ 0`, `x & -1`, `x << 0`, `x >> 0`
 * and `x >>> 0`, with the literal on either side where the operator is
 * commutative. Literals count by their converted value (`x | 2 ** 32`). */
export function bitwiseIdentityOperand(e: IrExpr & { kind: "bin" }): "left" | "right" | null {
  const neutral = (literal: IrExpr): boolean => {
    if (literal.kind !== "numLit") return false;
    if (e.op === "&") return (literal.value | 0) === -1;
    if (e.op === "|" || e.op === "^") return (literal.value | 0) === 0;
    return false;
  };
  if (e.op === "<<" || e.op === ">>" || e.op === ">>>")
    return e.right.kind === "numLit" && ((e.right.value >>> 0) & 31) === 0 ? "left" : null;
  if (e.op !== "&" && e.op !== "|" && e.op !== "^") return null;
  if (neutral(e.right)) return "left";
  if (neutral(e.left)) return "right";
  return null;
}

/** Whole-program facts about storage outside the analyzed function, each
 * proven by the caller (int32-slots.ts): every value a field slot, a
 * captured (boxed) binding or a function result can hold, and the values
 * every caller passes to a parameter. Absent entries carry no proof. */
export interface IntegerSlotFacts {
  params?: ReadonlyMap<string, IntegerRange>;
  field?: (className: string, field: string) => IntegerRange | null;
  call?: (callee: string) => IntegerRange | null;
  boxed?: (localId: string) => IntegerRange | null;
  /** Locals and globals an Int32 contract covers (ir/contract-check.ts):
   * every write anywhere is proven int32, so every read is one. */
  locals?: (localId: string) => IntegerRange | null;
}

/** Structured local dataflow. Calls cannot write uncaptured local slots,
 * but argument expressions can; unknown evaluation forms invalidate all
 * syntactically written slots before their children are inspected. Loops
 * discard loop-carried facts and retain only invariant or induction facts,
 * except closed locals: a local whose region-entry value is an int32 (a
 * uint32) and whose every write inside the region is one by construction
 * (bitwise results, `>>>` results for uint32, literals and slots in range,
 * other such locals) remains a full int32 (uint32) range across the region. Suspensions and captured bindings
 * deliberately remain outside the proof. */
export function analyzeIntegerRanges(fn: IrFunction, slots: IntegerSlotFacts = {}): IntegerRanges {
  const ranges = new Map<IrExpr, IntegerRange | null>();
  if (fn.async || fn.generator) return ranges;
  const captures = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const eligible = new Set(
    fn.locals
      .filter((l) => l.type.kind === "f64" && !l.boxed && !l.tdz && !captures.has(l.id))
      .map((l) => l.id),
  );
  const loopLocals = new Map(fn.locals.filter((l) => !captures.has(l.id)).map((l) => [l.id, l]));
  // A captured binding has no local dataflow: only a proof that covers
  // every write of the shared box anywhere applies to its reads.
  const boxedRange = (localId: string): IntegerRange | null => {
    const boxed = eligible.has(localId) ? null : (slots.boxed?.(localId) ?? null);
    return boxed ?? slots.locals?.(localId) ?? null;
  };
  const slotRange = (e: IrExpr): IntegerRange | null =>
    e.type.kind !== "f64"
      ? null
      : e.kind === "fieldGet"
        ? (slots.field?.(e.className, e.field) ?? null)
        : e.kind === "call"
          ? (slots.call?.(e.callee) ?? null)
          : null;

  /** Every write of a local in the given nodes: the written value, or null
   * for writes whose value is not an ordinary expression (++/--, for-of
   * and catch bindings). Declarations are reported separately. */
  function regionWrites(nodes: (IrExpr | IrStmt)[]): {
    values: Map<string, (IrExpr | null)[]>;
    declared: Set<string>;
  } {
    const values = new Map<string, (IrExpr | null)[]>();
    const declared = new Set<string>();
    const add = (id: string, value: IrExpr | null): void => {
      if (!eligible.has(id)) return;
      const list = values.get(id);
      if (list) list.push(value);
      else values.set(id, [value]);
    };
    const walkExpr = (value: IrExpr): boolean => {
      if (value.kind === "assignExpr") add(value.localId, value.value);
      else if (value.kind === "incDec") add(value.localId, null);
      return everyExprChild(value, walkExpr, walkStmt);
    };
    const walkStmt = (value: IrStmt): boolean => {
      if (value.kind === "assign") add(value.localId, value.value);
      else if (value.kind === "varDecl") {
        declared.add(value.localId);
        if (value.init) add(value.localId, value.init);
      } else if (value.kind === "forOf") add(value.localId, null);
      else if (value.kind === "tryCatch" && value.catchLocalId) add(value.catchLocalId, null);
      return everyStmtChild(value, walkExpr, walkStmt);
    };
    for (const node of nodes) {
      if ("type" in node) walkExpr(node as IrExpr);
      else walkStmt(node as IrStmt);
    }
    return { values, declared };
  }
  let functionWrites: Map<string, (IrExpr | null)[]> | null = null;

  /** Locals that hold an int32 or a uint32 everywhere inside and after a
   * region whose control flow this analysis does not follow, with that
   * range. A candidate either enters with a fact inside the range or is
   * declared inside the region and written only there (definite assignment:
   * every read follows one of those writes). For each range, the greatest
   * fixpoint keeps candidates whose every write lands in it by construction
   * given the other candidates; the two closures are independent, so a local
   * written both ways (`x | 0` and `x >>> 0`) closes under neither. */
  function closedLocals(nodes: (IrExpr | IrStmt)[], entry: Facts): Map<string, IntegerRange> {
    const { values, declared } = regionWrites(nodes);
    const result = new Map<string, IntegerRange>();
    if (values.size === 0) return result;
    const within = (bound: IntegerRange, range: IntegerRange | null | undefined): boolean =>
      !!range && range.min >= bound.min && range.max <= bound.max;
    const closure = (bound: IntegerRange): Set<string> => {
      const signed = bound === SIGNED;
      const closed = new Set<string>();
      for (const [id, list] of values) {
        if (within(bound, entry.get(id))) closed.add(id);
        else if (declared.has(id)) {
          functionWrites ??= regionWrites(fn.body).values;
          if (functionWrites.get(id)?.length === list.length) closed.add(id);
        }
      }
      const member = (e: IrExpr): boolean => {
        if (e.type.kind !== "f64") return false;
        switch (e.kind) {
          case "numLit":
            return (
              Number.isInteger(e.value) &&
              within(bound, { min: e.value, max: e.value }) &&
              !Object.is(e.value, -0)
            );
          case "bin":
            return signed
              ? e.op === "&" || e.op === "|" || e.op === "^" || e.op === "<<" || e.op === ">>"
              : e.op === ">>>";
          case "unary":
            return signed && e.op === "~";
          case "libCall":
            return (signed && e.fn === "math.imul") || e.fn === "math.clz32";
          case "ternary":
            return member(e.then) && member(e.else_);
          case "logical":
            return member(e.left) && member(e.right);
          case "assignExpr":
            return member(e.value);
          case "seqExpr":
            return member(e.result);
          case "varRef":
            return (
              closed.has(e.localId) ||
              (!values.has(e.localId) && within(bound, entry.get(e.localId))) ||
              within(bound, boxedRange(e.localId))
            );
          case "fieldGet":
          case "call":
            return within(bound, slotRange(e));
          default:
            return false;
        }
      };
      for (let changed = true; changed;) {
        changed = false;
        for (const id of closed)
          if (values.get(id)!.some((value) => value === null || !member(value))) {
            closed.delete(id);
            changed = true;
          }
      }
      return closed;
    };
    const int32 = closure(SIGNED),
      uint32 = closure(UNSIGNED);
    for (const id of entry.keys()) {
      const signed = int32.has(id),
        unsigned = uint32.has(id);
      if (signed && unsigned) result.set(id, { min: 0, max: SIGNED.max });
      else if (signed) result.set(id, SIGNED);
      else if (unsigned) result.set(id, UNSIGNED);
    }
    return result;
  }

  function remember(e: IrExpr, range: IntegerRange | null): IntegerRange | null {
    // Shared IR objects have to satisfy the proof at every occurrence.
    const previous = ranges.get(e);
    ranges.set(
      e,
      previous === undefined ? range : previous && range ? union(previous, range) : null,
    );
    return range;
  }
  function set(facts: Facts, id: string, range: IntegerRange | null): void {
    if (range && eligible.has(id)) facts.set(id, range);
    else facts.delete(id);
  }
  function writes(node: IrExpr | IrStmt): Set<string> {
    const result = new Set<string>();
    const e = (value: IrExpr): boolean => {
      if (value.kind === "assignExpr" || value.kind === "incDec") result.add(value.localId);
      return true;
    };
    const s = (value: IrStmt): boolean => {
      if (value.kind === "assign" || value.kind === "varDecl" || value.kind === "forOf")
        result.add(value.localId);
      if (value.kind === "tryCatch" && value.catchLocalId) result.add(value.catchLocalId);
      return true;
    };
    const walkExpr = (value: IrExpr): boolean =>
      e(value) && everyExprChild(value, walkExpr, walkStmt);
    const walkStmt = (value: IrStmt): boolean =>
      s(value) && everyStmtChild(value, walkExpr, walkStmt);
    if ("type" in node) walkExpr(node as IrExpr);
    else walkStmt(node as IrStmt);
    return result;
  }
  function invalidate(facts: Facts, nodes: (IrExpr | IrStmt)[]): void {
    for (const node of nodes) for (const id of writes(node)) facts.delete(id);
  }
  /** Invalidate the region's writes, keeping int32- and uint32-closed
   * locals at their closed range. `entry` is the state before any of the
   * region's writes can run. */
  function havoc(facts: Facts, nodes: (IrExpr | IrStmt)[], entry: Facts): void {
    const closed = closedLocals(nodes, entry);
    invalidate(facts, nodes);
    for (const [id, range] of closed) facts.set(id, range);
  }
  function refine(condition: IrExpr, truth: boolean, facts: Facts): void {
    // A comparison constrains operand snapshots. If evaluating it writes a
    // binding, the current slot may no longer contain the compared value.
    if (writes(condition).size > 0) return;
    if (condition.kind === "toBool") return refine(condition.operand, truth, facts);
    if (condition.kind === "unary" && condition.op === "!")
      return refine(condition.operand, !truth, facts);
    if (
      condition.kind === "logical" &&
      ((condition.op === "&&" && truth) || (condition.op === "||" && !truth))
    ) {
      refine(condition.left, truth, facts);
      refine(condition.right, truth, facts);
      return;
    }
    if (condition.kind !== "bin") return;
    let ref = condition.left;
    let bound = condition.right;
    let op: string = condition.op;
    if (ref.kind !== "varRef" && bound.kind === "varRef") {
      [ref, bound] = [bound, ref];
      op =
        (
          { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" } as Record<
            string,
            string
          >
        )[op] ?? "";
    }
    if (ref.kind !== "varRef") return;
    const boundRange =
      bound.kind === "numLit" && Number.isFinite(bound.value)
        ? { min: bound.value, max: bound.value }
        : ranges.get(bound);
    if (!boundRange) return;
    // An Int32 contract local holds an int32 even where the dataflow has
    // no fact for it (loop headers, after unknown regions).
    const previous =
      facts.get(ref.localId) ??
      (eligible.has(ref.localId) ? (slots.locals?.(ref.localId) ?? undefined) : undefined);
    if (!previous) return;
    if (!truth)
      op =
        (
          { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===" } as Record<
            string,
            string
          >
        )[op] ?? "";
    let { min, max } = previous;
    if (op === "<") max = Math.min(max, Math.ceil(boundRange.max) - 1);
    else if (op === "<=") max = Math.min(max, Math.floor(boundRange.max));
    else if (op === ">") min = Math.max(min, Math.floor(boundRange.min) + 1);
    else if (op === ">=") min = Math.max(min, Math.ceil(boundRange.min));
    else if (op === "===") {
      min = Math.max(min, boundRange.min);
      max = Math.min(max, boundRange.max);
    }
    if (min <= max && Number.isInteger(min) && Number.isInteger(max))
      facts.set(ref.localId, { min, max });
  }
  function expr(e: IrExpr, facts: Facts): IntegerRange | null {
    let range: IntegerRange | null = null;
    switch (e.kind) {
      case "numLit":
        if (Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
          range = { min: e.value, max: e.value };
        break;
      case "varRef":
        range = facts.get(e.localId) ?? boxedRange(e.localId);
        break;
      case "assignExpr":
        range = expr(e.value, facts);
        set(facts, e.localId, range);
        break;
      case "incDec": {
        const before = facts.get(e.localId) ?? null;
        const after = before ? integerArithmeticRange(e.op, before, { min: 1, max: 1 }) : null;
        set(facts, e.localId, after);
        range = e.prefix ? after : before;
        break;
      }
      case "bin": {
        const left = expr(e.left, facts);
        const right = expr(e.right, facts);
        if (e.type.kind !== "f64") break;
        if (isBitwiseOp(e.op))
          range = bitwiseRange(e.op, operandView(e.left, left), operandView(e.right, right));
        else if (left && right) range = integerArithmeticRange(e.op, left, right);
        break;
      }
      case "unary": {
        const operand = expr(e.operand, facts);
        if (e.op === "~") {
          const value = int32View(operandView(e.operand, operand));
          range = { min: -value.max - 1, max: -value.min - 1 };
        } else if (e.op === "-" && operand && (operand.max < 0 || operand.min > 0))
          range = { min: -operand.max, max: -operand.min };
        break;
      }
      case "ternary": {
        expr(e.cond, facts);
        const yes = new Map(facts),
          no = new Map(facts);
        refine(e.cond, true, yes);
        refine(e.cond, false, no);
        const left = expr(e.then, yes),
          right = expr(e.else_, no);
        merge(facts, yes, no);
        if (left && right) range = union(left, right);
        break;
      }
      case "logical": {
        const left = expr(e.left, facts);
        const skipped = new Map(facts),
          evaluated = new Map(facts);
        refine(e.left, e.op === "&&", evaluated);
        const right = expr(e.right, evaluated);
        merge(facts, skipped, evaluated);
        if (left && right) range = union(left, right);
        break;
      }
      case "seqExpr":
        body(e.stmts, facts);
        range = expr(e.result, facts);
        break;
      case "libCall": {
        const args = e.args.map((a) => expr(a, facts));
        if (e.fn === "math.imul") range = SIGNED;
        else if (e.fn === "math.clz32") range = { min: 0, max: 32 };
        else if (
          (e.fn === "math.min" || e.fn === "math.max") &&
          args.length > 0 &&
          args.every((a) => a !== null)
        ) {
          const known = args as IntegerRange[];
          const mins = known.map((a) => a.min),
            maxes = known.map((a) => a.max);
          range =
            e.fn === "math.min"
              ? { min: Math.min(...mins), max: Math.min(...maxes) }
              : { min: Math.max(...mins), max: Math.max(...maxes) };
        }
        break;
      }
      case "bytesIntrinsic": {
        expr(e.receiver, facts);
        for (const arg of e.args) expr(arg, facts);
        const numeric = byteNumberAccess(e);
        if (numeric && !numeric.write) range = byteNumberRange(numeric);
        else if (e.method === "length" || e.method === "byteLength" || e.method === "byteOffset")
          range = { min: 0, max: Number.MAX_SAFE_INTEGER };
        else if (e.method === "get" && e.invalidNaN !== true && e.receiver.type.kind === "bytes") {
          const elem = e.receiver.type.elem;
          if (elem === "u8" || elem === "u8c") range = { min: 0, max: 255 };
          else if (elem === "i8") range = { min: -128, max: 127 };
          else if (elem === "u16") range = { min: 0, max: 65535 };
          else if (elem === "i16") range = { min: -32768, max: 32767 };
          else if (elem === "u32") range = UNSIGNED;
          else if (elem === "i32") range = SIGNED;
        }
        break;
      }
      case "arrIntrinsic":
        // Callbacks and arguments can have writes hidden in lazy lowering.
        havoc(facts, [e], facts);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        if (e.method === "length") range = UNSIGNED;
        break;
      case "strIntrinsic":
        // The conservative child handling of unknown forms; only the result
        // range is new: a length or a found index is an int32.
        havoc(facts, [e], facts);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        if (e.type.kind === "f64") {
          if (e.method === "length") range = { min: 0, max: STRING_MAX_UNITS };
          // An empty needle is found at the clamped position, up to the length.
          else if (e.method === "indexOf") range = { min: -1, max: STRING_MAX_UNITS };
        }
        break;
      case "fieldGet":
        expr(e.obj, facts);
        range = slotRange(e);
        break;
      default:
        // Do not assume the traversal order is an evaluation order for an
        // unknown node. Every child gets the same conservative entry state.
        havoc(facts, [e], facts);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        // A direct call's result carries its whole-program return proof.
        range = slotRange(e);
        break;
    }
    return remember(e, range);
  }
  function induction(
    s: IrStmt & { kind: "for" },
    facts: Facts,
  ): { id: string; range: IntegerRange } | null {
    if (s.init?.kind !== "varDecl" || !eligible.has(s.init.localId)) return null;
    const id = s.init.localId,
      start = facts.get(id);
    if (!start) return null;
    let step = 0;
    const update = s.update;
    if (
      update?.kind === "assign" &&
      update.localId === id &&
      update.value.kind === "bin" &&
      update.value.left.kind === "varRef" &&
      update.value.left.localId === id &&
      update.value.right.kind === "numLit" &&
      update.value.right.value === 1
    ) {
      step = update.value.op === "+" ? 1 : update.value.op === "-" ? -1 : 0;
    } else if (
      update?.kind === "exprStmt" &&
      update.expr.kind === "incDec" &&
      update.expr.localId === id
    )
      step = update.expr.op === "+" ? 1 : -1;
    if (!step || s.body.some((node) => writes(node).has(id)) || (s.cond && writes(s.cond).has(id)))
      return null;
    return {
      id,
      range:
        step > 0 ? { min: start.min, max: EXACT_LIMIT } : { min: -EXACT_LIMIT, max: start.max },
    };
  }
  function body(stmts: IrStmt[], facts: Facts): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "varDecl":
        case "assign": {
          const value = s.kind === "varDecl" ? s.init : s.value;
          set(facts, s.localId, value ? expr(value, facts) : null);
          break;
        }
        case "exprStmt":
          expr(s.expr, facts);
          break;
        case "return":
          if (s.value) expr(s.value, facts);
          facts.clear();
          break;
        case "block": {
          const before = new Map(facts);
          body(s.body, facts);
          // A labeled break can skip the tail of this block. We have no
          // exit-edge lattice here, so discard its written facts at a join.
          if (
            !everyStmtList(s.body, {
              expr: () => true,
              stmt: (node) => node.kind !== "break" && node.kind !== "continue",
            })
          )
            havoc(facts, s.body, before);
          break;
        }
        case "if": {
          expr(s.cond, facts);
          const yes = new Map(facts),
            no = new Map(facts);
          refine(s.cond, true, yes);
          refine(s.cond, false, no);
          body(s.then, yes);
          if (s.else_) body(s.else_, no);
          if (!integerPathFallsThrough(s.then)) {
            facts.clear();
            for (const [id, range] of no) facts.set(id, range);
          } else if (s.else_ && !integerPathFallsThrough(s.else_)) {
            facts.clear();
            for (const [id, range] of yes) facts.set(id, range);
          } else merge(facts, yes, no);
          break;
        }
        case "for": {
          if (s.init) body([s.init], facts);
          const counter = induction(s, facts);
          const bounded = boundedIntegerLoopFacts(s, loopLocals, facts);
          const loop = new Map(facts);
          havoc(
            loop,
            [...s.body, ...(s.cond ? [s.cond] : []), ...(s.update ? [s.update] : [])],
            loop,
          );
          if (counter) loop.set(counter.id, counter.range);
          for (const [id, range] of bounded) loop.set(id, range);
          if (s.cond) expr(s.cond, loop);
          const inside = new Map(loop);
          if (s.cond) refine(s.cond, true, inside);
          body(s.body, inside);
          // Continue can bypass any body assignment. The update therefore
          // starts from header invariants rather than the body's exit facts,
          // plus what the condition proved about bindings the body never
          // writes (they still hold the values the condition tested).
          if (s.update) {
            const entry = new Map(loop);
            if (s.cond) {
              const refined = new Map(loop);
              refine(s.cond, true, refined);
              const written = new Set<string>();
              for (const node of s.body) for (const id of writes(node)) written.add(id);
              for (const [id, range] of refined) if (!written.has(id)) entry.set(id, range);
            }
            body([s.update], entry);
          }
          havoc(facts, [s], facts);
          break;
        }
        case "while":
        case "doWhile": {
          const loop = new Map(facts);
          havoc(loop, [s], loop);
          const header = new Map(loop);
          expr(s.cond, header);
          if (s.kind === "while") {
            refine(s.cond, true, header);
            body(s.body, header);
          } else body(s.body, new Map(loop));
          havoc(facts, [s], facts);
          break;
        }
        case "forOf": {
          expr(s.iterable, facts);
          const loop = new Map(facts);
          havoc(loop, [s], loop);
          body(s.body, loop);
          havoc(facts, [s], facts);
          break;
        }
        case "tryCatch":
          // Catch/finally, fallthrough and nonlocal exits need their own
          // control-flow joins. Analyze each region from invariant facts.
          havoc(facts, [s], facts);
          body(s.tryBody, new Map(facts));
          if (s.catchBody) body(s.catchBody, new Map(facts));
          if (s.finallyBody) body(s.finallyBody, new Map(facts));
          break;
        case "switch":
          havoc(facts, [s], facts);
          expr(s.disc, new Map(facts));
          for (const region of s.cases) {
            if (region.test) expr(region.test, new Map(facts));
            body(region.body, new Map(facts));
          }
          break;
        case "break":
        case "continue":
          // An outer labeled jump can bypass following assignments. Clearing
          // the continuing path is conservative; loop exits discard writes.
          facts.clear();
          break;
        default:
          havoc(facts, [s], facts);
          everyStmtChild(
            s,
            (child) => {
              expr(child, new Map(facts));
              return true;
            },
            (child) => {
              body([child], new Map(facts));
              return true;
            },
          );
          break;
      }
    }
  }
  const entry: Facts = new Map();
  if (slots.params) for (const [id, range] of slots.params) set(entry, id, range);
  body(fn.body, entry);
  return ranges;
}
