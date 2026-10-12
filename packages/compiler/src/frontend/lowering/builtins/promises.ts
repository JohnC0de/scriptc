import { checkedPromiseAll } from "../checked-promise-all.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  DYN,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  VOID,
  arrayOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";

/** `Promise.race([...])` on THE Promise global: the entries lower
 * individually (the array never materializes — promise-element arrays
 * have no representation) into a promise.race intrinsic; the result
 * type is the checker's combined promise, and each entry's inner type
 * must be that inner type, one of its union arms, or a sub-union of it
 * (the backend's interned adapters wrap/re-tag fulfillments; a wider
 * entry would need machinery that doesn't exist and fences).
 * Promise.all/allSettled/any fence with the sequential-await hint;
 * resolve/reject and the rest fall to the member fence. Null for
 * non-Promise receivers. */
export function lowerPromiseStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const member = lowerer.stdlibGlobalMember(access, "Promise");
  if (member === null) return null;
  const loc = locOf(call);
  if (member === "race") {
    const argNode = call.arguments.length === 1 ? call.arguments[0]! : null;
    if (
      !argNode ||
      !ts.isArrayLiteralExpression(argNode) ||
      argNode.elements.some(ts.isSpreadElement) ||
      argNode.elements.length === 0
    ) {
      lowerer.noLowering(
        "Promise.race over this argument shape",
        call,
        "a non-empty array LITERAL of promises is the supported form: Promise.race([p, q])",
      );
    }
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "Promise.race with this combined result type",
        call,
        "the entries' value types must combine into a representable union",
      );
    }
    const resultArms =
      resultT.inner.kind === "union"
        ? (lowerer.unions.get(resultT.inner.unionId)?.arms ?? [])
        : null;
    const compatible = (inner: IrType): boolean => {
      if (typeEquals(inner, resultT.inner)) return true;
      if (!resultArms) return false;
      if (inner.kind === "union") {
        const arms = lowerer.unions.get(inner.unionId)?.arms ?? [];
        return arms.every((a) => resultArms.some((b) => typeEquals(a, b)));
      }
      return resultArms.some((a) => typeEquals(a, inner));
    };
    const entries = argNode.elements.map((el) => {
      const entry = lowerer.lowerExpr(el);
      if (entry.type.kind !== "promise") {
        lowerer.noLowering(
          "Promise.race over non-promise entries",
          el,
          "JS would resolve plain values — wrap them: new Promise((r) => r(v))",
        );
      }
      if (!compatible(entry.type.inner)) {
        lowerer.unsupported(
          "SC1090",
          el,
          `Promise.race entries of inner type '${lowerer.fmt(entry.type.inner)}' under a ` +
            `'${lowerer.fmt(resultT.inner)}' result (every entry must be the result type, one ` +
            `of its arms, or a sub-union of it)`,
        );
      }
      return entry;
    });
    return { kind: "intrinsic", name: "promise.race", args: entries, type: resultT, loc };
  }
  // `Promise.all(ps)` over ONE promise type: the argument is any
  // expression of type Promise<T>[] (promise-element arrays are real —
  // `refs.map(loadAsync)`, an annotated literal) and the result is the
  // checker's Promise<T[]>. Node-exact through the runtime's countdown
  // combinator: the values array is filled per INPUT index regardless of
  // settlement order, the first rejection (in settlement order) wins and
  // later ones count as handled, the empty array resolves immediately,
  // and already-settled entries settle inline. Promise<void> entries
  // collapse to a `Promise<void>` result (a void[] value has no
  // representation; `await Promise.all(voids)` is the supported shape).
  // Heterogeneous ARRAY LITERALS land on the tuple overload
  // (Promise<[A, B]>) and fence here — one promise type is the bound.
  if (member === "all") {
    const argNode = call.arguments.length === 1 ? call.arguments[0]! : null;
    if (!argNode) {
      lowerer.noLowering(
        "Promise.all with this argument shape",
        call,
        "one array of promises is the supported form: Promise.all(ps) with ps: Promise<T>[]",
      );
    }
    // A UNIFORM array literal — `Promise.all([readFile(a), readFile(b)])`
    // where every entry is the SAME Promise<T> (the portless
    // generateHostCertAsync pair): the checker's tuple overload types
    // the literal as [Promise<T>, Promise<T>], but with one shared T
    // the tuple IS an array — the entries lower into a Promise<T>[]
    // and the result is Promise<T[]> (destructuring reads it exactly
    // like the tuple; the elements are the same T either way).
    if (
      ts.isArrayLiteralExpression(argNode) &&
      !argNode.elements.some(ts.isSpreadElement) &&
      argNode.elements.length > 0
    ) {
      const elems = argNode.elements.map((el) => lowerer.lowerExpr(el));
      const first = elems[0]!.type;
      if (
        first.kind === "promise" &&
        elems.every((e) => e.type.kind === "promise" && typeEquals(e.type, first))
      ) {
        const entriesArr: IrExpr = { kind: "arrayLit", elems, type: arrayOf(first), loc };
        const resultT: IrType = {
          kind: "promise",
          inner: first.inner.kind === "void" ? VOID : arrayOf(first.inner),
        };
        return { kind: "intrinsic", name: "promise.all", args: [entriesArr], type: resultT, loc };
      }

      if (
        isJsSourceFile(call.getSourceFile()) &&
        elems.every((entry) => lowerer.dynConvertible(entry.type))
      ) {
        return checkedPromiseAll(
          lowerer,
          {
            kind: "arrayLit",
            elems: elems.map((entry) => lowerer.coerceToExpected(entry, DYN)),
            type: arrayOf(DYN),
            loc,
          },
          loc,
        );
      }
      lowerer.noLowering(
        "Promise.all over this argument shape",
        argNode,
        "the entries must share ONE promise type — Promise.all([p, q]) lowers when p and q are the same Promise<T>",
      );
    }
    const entries = lowerer.lowerExpr(argNode);
    if (isJsSourceFile(call.getSourceFile()) && entries.type.kind === "dyn")
      return checkedPromiseAll(lowerer, entries, loc);

    // loadPlugin(p)))` — the loadPlugins shape, where the checker
    // spells `any[]`): the ENGINE's own Promise.all runs over the
    // marshaled array (an 'any' value passes through; an `any[]` value

    if (entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
      // The heterogeneous-literal case: the checker's tuple overload
      // types the literal as a TUPLE of promises (a tuple-flagged record
      // here), or a union-of-promises element survives as the array's
      // elem — either way the fix is one shared promise type, so say
      // that.
      const tupleFields =
        entries.type.kind === "record" ? lowerer.shapes.get(entries.type.shapeId) : undefined;
      const mixedPromises =
        (entries.type.kind === "array" &&
          entries.type.elem.kind === "union" &&
          (lowerer.unions.get(entries.type.elem.unionId)?.arms ?? []).every(
            (a) => a.kind === "promise",
          )) ||
        (tupleFields?.tuple === true && tupleFields.fields.every((f) => f.type.kind === "promise"));
      lowerer.noLowering(
        "Promise.all over this argument shape",
        argNode,
        mixedPromises
          ? "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
              "so the result is Promise<T[]>, not a tuple"
          : "an array of promises (Promise<T>[]) is the supported form",
      );
    }
    const inner = entries.type.elem.inner;
    const resultT: IrType | null =
      inner.kind === "void"
        ? { kind: "promise", inner: VOID }
        : lowerer.mapTypeOf(lowerer.typeOf(call));
    if (
      resultT?.kind !== "promise" ||
      (inner.kind !== "void" &&
        (resultT.inner.kind !== "array" || !typeEquals(resultT.inner.elem, inner)))
    ) {
      lowerer.noLowering(
        "Promise.all with this combined result type",
        call,
        "the entries must share ONE promise type — annotate the array (const ps: Promise<T>[] = [...]) " +
          "so the result is Promise<T[]>, not a tuple",
      );
    }
    return { kind: "intrinsic", name: "promise.all", args: [entries], type: resultT, loc };
  }
  if (member === "allSettled" || member === "any") {
    lowerer.noLowering(
      `Promise.${member}`,
      call,
      "await each element in a loop (Promise.all compiles over a Promise<T>[] array, " +
        "Promise.race over an array literal)",
    );
  }
  // Promise.withResolvers<T>(): the executor pieces without an
  // executor — a pending promise plus its runtime resolve/reject
  // closures in the `{ promise, resolve, reject }` record. The
  // overrides declaration shapes the record so its fields map exactly
  // (plain-value resolve, Error-pinned reject); the emitter assembles
  // the record from the newPromise machinery.
  if (member === "withResolvers") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`Promise.withResolvers with arguments`, call);
    }
    // The type mapper owns the record shape (its withResolvers
    // special-case — the anonymous ambient literal fails the record
    // provenance gate, so the mapper interns the shape manually).
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "record") {
      lowerer.noLowering(
        "Promise.withResolvers at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.withResolvers<T>()",
      );
    }
    return { kind: "promiseWithResolvers", type: resultT, loc };
  }
  // Promise.try(f) — call f SYNCHRONOUSLY, fulfill with its plain
  // result, adopt a returned promise, and turn a synchronous throw
  // into a rejection. That is observably `(async () => f())()` —
  // tick-for-tick in Node for plain results (probed), with the
  // promise-returning form riding the async return-adoption machinery
  // (its one-tick residue is SEMANTICS.md 358) — so the lowering IS
  // that wrapper: one interned async helper per callback type. The
  // ...args form fences (close over the values instead).
  if (member === "try") {
    const fNode = call.arguments[0];
    if (call.arguments.length !== 1 || fNode === undefined || ts.isSpreadElement(fNode)) {
      lowerer.noLowering(
        `Promise.try with ${call.arguments.length} arguments`,
        call,
        "the ...args form has no lowering — close over the values: Promise.try(() => f(a, b))",
      );
    }
    const f = lowerer.lowerExpr(fNode);
    if (f.type.kind !== "func" || f.type.params.length !== 0) {
      lowerer.noLowering(
        `Promise.try over a callback of type '${lowerer.checker.typeToString(lowerer.typeOf(fNode))}'`,
        fNode,
        "a zero-parameter function is the supported form",
      );
    }
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "Promise.try at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.try<T>(f)",
      );
    }
    const inner = resultT.inner;
    const ret = f.type.ret;
    // The helper's return must BE the callback's result (fulfillment)
    // or its adopted settlement (promise results) — anything the
    // checker widened past that has no adapter here.
    const settled = ret.kind === "promise" ? ret.inner : ret;
    if (
      !typeEquals(settled, inner) &&
      !(isUnitType(settled) && inner.kind === "void") &&
      !(settled.kind === "void" && inner.kind === "void")
    ) {
      lowerer.noLowering(
        "Promise.try where the callback's result type differs from the promised type",
        call,
        "annotate both to one T: Promise.try<T>(f) with f returning T or Promise<T>",
      );
    }
    const key = `promise.try:${typeKey(f.type)}`;
    let helper = lowerer.arrHofHelpers.get(key);
    if (!helper) {
      helper = `%promise.try.${lowerer.arrHofHelpers.size}`;
      lowerer.arrHofHelpers.set(key, helper);
      const fRef: IrExpr = { kind: "varRef", localId: "f.0", type: f.type, loc };
      const callF: IrExpr = { kind: "callValue", callee: fRef, args: [], type: ret, loc };
      // Adopt a promise result before either returning its value or completing void.
      const value: IrExpr =
        ret.kind === "promise" ? { kind: "awaitExpr", value: callF, type: ret.inner, loc } : callF;
      const body: IrStmt[] =
        inner.kind === "void"
          ? [
              { kind: "exprStmt", expr: value, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value, loc }];
      const lifted: IrFunction = {
        name: helper,
        params: [{ localId: "f.0", name: "f", type: f.type }],
        returnType: inner,
        locals: [{ id: "f.0", name: "f", type: f.type, mutable: true }],
        body,
        loc,
        async: true,
      };
      lowerer.liftedFns.push(lifted);
    }
    return { kind: "call", callee: helper, args: [f], type: resultT, loc };
  }
  // Promise.resolve — the already-settled promise. Zero arguments is
  // Promise<void>; a PROMISE argument is returned as-is (the spec's
  // native-promise identity — every scriptc promise is native, so
  // Promise.resolve(p) === p exactly); a plain representable value
  // fulfills a fresh promise immediately. Thenables (a `then`-carrying
  // object would be ADOPTED in JS, not wrapped) and promise-armed
  // unions (wrap-or-identity depends on the runtime arm) fence.
  if (member === "resolve") {
    if (call.arguments.length > 1 || call.arguments.some((a) => ts.isSpreadElement(a))) {
      lowerer.noLowering(`Promise.resolve with ${call.arguments.length} arguments`, call);
    }
    const argNode = call.arguments[0];
    if (argNode !== undefined) {
      const argT = lowerer.typeOf(argNode);
      const argIr = lowerer.mapTypeOf(argT);
      if (argIr?.kind === "promise") {
        const v = lowerer.lowerExpr(argNode);
        if (v.type.kind !== "promise") lowerer.badType(argNode, argT);
        return v;
      }
      if (
        argIr?.kind === "union" &&
        (lowerer.unions.get(argIr.unionId)?.arms ?? []).some((a) => a.kind === "promise")
      ) {
        lowerer.noLowering(
          "Promise.resolve over a value that may already be a promise",
          argNode,
          "narrow first: a plain value wraps, a promise passes through identically — the union hides which",
        );
      }
      if (argIr?.kind === "record" || argIr?.kind === "object") {
        const thenSym = lowerer.checker.getPropertyOfType(argT, "then");
        if (thenSym !== undefined) {
          lowerer.noLowering(
            "Promise.resolve of a thenable",
            argNode,
            "JS would ADOPT the then method, not wrap the object — await the thenable's settlement explicitly",
          );
        }
      }
    }
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "Promise.resolve at this type",
        call,
        "the promised value's type must be representable — annotate it: Promise.resolve<T>(v)",
      );
    }
    if (argNode === undefined) {
      return {
        kind: "intrinsic",
        name: "promise.resolve",
        args: [],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    if (resultT.inner.kind === "void") {
      return {
        kind: "seqExpr",
        stmts: [lowerer.lowerExprStatement(argNode)],
        result: { kind: "intrinsic", name: "promise.resolve", args: [], type: resultT, loc },
        type: resultT,
        loc,
      };
    }
    if (isUnitType(resultT.inner)) {
      // A unit payload (Promise<undefined>/Promise<null>) has no
      // fulfill adapter — await it as the void promise instead.
      lowerer.noLowering("Promise.resolve at a unit-typed promise", call);
    }
    const value = lowerer.lowerExprExpecting(argNode, resultT.inner);
    return { kind: "intrinsic", name: "promise.resolve", args: [value], type: resultT, loc };
  }
  return null; // reject lands on lowerPromiseRejectCall / the member fence
}
