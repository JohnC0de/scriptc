import { InternalCompilerError } from "../../errors.js";
import * as ts from "../ts7/adapter.js";
import { bodyReadsArguments } from "../arguments-usage.js";
import type { Lowerer } from "./lowerer.js";
import {
  DYN,
  type IrExpr,
  type IrFunction,
  type IrType,
  UNDEFINED_T,
  VOID,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { isJsSourceFile, isNodeEsmFile } from "../program.js";
import { genResultRecord, jsOpenObjectType } from "../type-mapper.js";
import { dynFallbackType } from "./lowerer.js";
import { builtinModuleFnOf } from "./surfaces.js";
import { mixinFnShapeOf } from "./lower-mixins.js";
import { isStreamUndefCallExpr } from "./lower-server.js";
import { nsPathPrefix } from "./lower-namespaces.js";
import { declSymbolOf } from "./lower-modules.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { implicitMonoFile, implicitAnyParamSymbolsOf } from "./generic-functions.js";

/** How a parameter participates in CALL-SITE COMPLETION (the frontend
 * completes every call to the one full signature, so the IR and backends
 * stay count-exact — see docs/ir.md). `required` params must be passed;
 * `omittable` params (declared `x?: T` or `x: T = e`) may be omitted by a
 * trailing-suffix call, and the frontend appends the interned undefined arm;
 * `rest` (always last) receives the surplus arguments packed into one array
 * literal at each call site. `arguments` is a hidden slot containing every
 * actual argument, including those bound to named parameters. */
export type ParamMode = "required" | "omittable" | "rest" | "dynRest" | "arguments";

/** One parameter of a signature, as call sites and callee prologues see it.
 * `type` is the ABI type — what the emitted LLVM parameter carries: the
 * checker's `T | undefined` union for `x?: T`, a synthesized `T | undefined`
 * union for `x: T = e`, `T[]` for `...xs: T[]`, the plain declared type
 * otherwise. `bodyType` is present exactly for DEFAULTED program params:
 * the plain T the body sees after the prologue applies the default (see
 * declareParams). `callDefault` is the compile-time default value for a
 * table-backed builtin's omittable slot. */
export interface ParamShape {
  type: IrType;
  mode: ParamMode;
  bodyType?: IrType;
  callDefault?: IrExpr;
}

export interface FnSig {
  name: string;
  params: ParamShape[];
  /** Call-site result type — Promise<inner> for async functions, the
   * generator type for generator functions. */
  returnType: IrType;
  /** Async: the IrFunction's returnType is the promise's INNER type, or
   * the generator's TReturn when generator is also present. */
  isAsync?: boolean;
  /** Generator: the IrFunction's returnType is the TReturn channel; the
   * yield/next channels ride here (IrFunction.generator's exact shape). */
  generator?: { yieldT: IrType; nextT: IrType; resultType: IrType & { kind: "record" } };
}

export function funcTypeFromParamShapes(
  shapes: readonly ParamShape[],
  ret: IrType,
): IrType & { kind: "func" } {
  const typedRest = shapes.some((shape) => shape.mode === "rest");
  const dynRest = shapes.some((shape) => shape.mode === "dynRest");
  const argumentsAll = shapes.some((shape) => shape.mode === "arguments");
  return {
    kind: "func",
    params: shapes
      .filter((shape) => shape.mode !== "dynRest" && shape.mode !== "arguments")
      .map((shape) => shape.type),
    ret,
    ...(typedRest || dynRest || argumentsAll ? { rest: true as const } : {}),
    ...(argumentsAll ? { argumentsAll: true as const } : {}),
    ...(typedRest ? { restAbi: "typed" as const } : {}),
  };
}

/** Registers `const alias = overloadedDeclaration` as a compile-time
 * callable projection. The source function's one implementation ABI is
 * already collected in fnSigsBySymbol; each direct call still uses the
 * TS7-resolved overload result bridge. The alias owns no storage, and a
 * value read materializes the source function's interned closure, so JS
 * identity (`alias === source`) is preserved. */
export function registerOverloadedCallableAlias(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return false;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isIdentifier(init)) return false;
  const aliasType = lowerer.typeOf(decl.name);
  if (lowerer.checker.getCallSignatures(aliasType).length < 2) return false;
  const sourceSymbol = lowerer.resolveValueSymbol(init);
  if (!sourceSymbol) return false;
  const sourceProjection = lowerer.staticCallables.get(sourceSymbol);
  const signature =
    lowerer.fnSigsBySymbol.get(sourceSymbol) ??
    (sourceProjection?.kind === "declared-function" ? sourceProjection.signature : undefined);
  if (!signature) return false;
  const aliasSymbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (!aliasSymbol) return false;
  lowerer.staticCallables.set(aliasSymbol, { kind: "declared-function", signature });
  return true;
}

export function generatorMeta(
  lowerer: Lowerer,
  type: IrType & { kind: "generator" },
): NonNullable<IrFunction["generator"]> {
  const resultType = genResultRecord(type.yieldT, type.retT, lowerer.shapes, lowerer.unions);
  if (resultType === null) {
    throw new InternalCompilerError(
      "lowerer bug: mapped generator without an IteratorResult record",
    );
  }
  return { yieldT: type.yieldT, nextT: type.nextT, resultType };
}

/** One parameter's ParamShape — the shared signature-shaped collection
 * point for function declarations, methods, constructors, and lambdas
 * (generic declarations defer to their call sites, where the resolved
 * types exist; see lowerGenericCall).
 *
 * - `x?: T`: the checker already types the param `T | undefined` under
 *   strictNullChecks, so the ABI type IS that union and the body narrows
 *   with `!== undefined` like any union local.
 * - `x: T = e`: the ABI type is a synthesized `T | undefined` union (the
 *   caller may omit the arg or pass undefined — both trigger the default,
 *   JS-exact); the body sees plain T through the two-local prologue
 *   (declareParams). A single-arm T narrows in the prologue; a UNION T
 *   re-tags through the interned retag helper (the undefined arm is the
 *   one stranded case, unreachable from the else-branch by construction).
 * - `...xs: T[]`: the ABI type is the array; call sites pack the surplus.
 */
export function paramShape(lowerer: Lowerer, param: ts.ParameterDeclaration): ParamShape {
  if (isJsSourceFile(param.getSourceFile()) && ts.isSetAccessorDeclaration(param.parent))
    return { type: DYN, mode: "required" };
  if (
    isJsSourceFile(param.getSourceFile()) &&
    ts.isConstructorDeclaration(param.parent) &&
    !param.dotDotDotToken
  ) {
    // Reflective JavaScript construction can supply values outside the
    // constructor's documented usual types. Retain the actual arguments
    // and apply checked conversions only at operations that need them.
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: param.questionToken ? "omittable" : "required" };
  }
  const executor = param.parent;
  const construction = executor?.parent;
  const nativeExecutor =
    executor &&
    (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) &&
    ts.isNewExpression(construction) &&
    construction.arguments?.[0] === executor &&
    lowerer.isStdlibGlobal(construction.expression, "Promise");
  if (
    !nativeExecutor &&
    isJsSourceFile(param.getSourceFile()) &&
    !param.type &&
    !param.dotDotDotToken &&
    !ts.isSetAccessorDeclaration(param.parent) &&
    !/@(?:param|type)\b/.test(
      param.getSourceFile().text.slice(param.parent?.pos ?? param.pos, param.getStart()),
    )
  ) {
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  if (
    param.initializer &&
    isJsSourceFile(param.getSourceFile()) &&
    !param.type &&
    !/@(?:param|type)\b/.test(
      param.getSourceFile().text.slice(param.parent?.pos ?? param.pos, param.getStart()),
    )
  ) {
    return { type: DYN, mode: "omittable", bodyType: DYN };
  }
  // Inferred JS array patterns describe the bindings, not an exact tuple
  // contract. Consume the actual iterable, including surplus elements.
  if (
    ts.isArrayBindingPattern(param.name) &&
    isJsSourceFile(param.getSourceFile()) &&
    !param.type &&
    !/@(?:param|type)\b/.test(
      param.getSourceFile().text.slice(param.parent?.pos ?? param.pos, param.getStart()),
    )
  ) {
    if (param.dotDotDotToken) return { type: DYN, mode: "dynRest" };
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  if (lowerer.checkedCallbackParams.has(param)) {
    if (param.dotDotDotToken) return { type: DYN, mode: "dynRest" };
    return param.initializer
      ? { type: DYN, mode: "omittable", bodyType: DYN }
      : { type: DYN, mode: "required" };
  }
  const moduleNs = lowerer.moduleNsParamOverrides.get(param);
  if (moduleNs !== undefined) {
    return { type: moduleNs, mode: param.questionToken ? "omittable" : "required" };
  }
  if (!ts.isIdentifier(param.name)) {
    // A destructuring pattern parameter — `([label, value]) => ...`,
    // `({ x }) => ...`. The ABI slot carries the SOURCE value (the
    // tuple/array/record itself); the callee prologue desugars the reads
    // through the declaration-destructuring machinery (declareParams →
    // lowerBindingPattern), so the fences inside patterns (computed
    // keys, class-instance sources, union sources) are the declaration
    // fences verbatim. A rest parameter bound to a pattern would need
    // the packing machinery on top — fenced.
    if (param.questionToken) {
      lowerer.unsupported("SC1031", param, "optional destructuring pattern parameters");
    }
    if (param.dotDotDotToken) {
      // A REST parameter bound to a pattern (`(...[[k1, v1]]: [string,
      // number][])`): the ABI packs the surplus arguments into one
      // array exactly like an identifier rest param; the prologue then
      // destructures the packed array through the declaration
      // machinery (declareParams → lowerBindingPattern).
      const type = lowerer.irTypeOf(param.name);
      const tupleRest = type.kind === "record" && lowerer.shapes.get(type.shapeId)?.tuple === true;
      if (type.kind !== "array" && !tupleRest)
        lowerer.badType(param.name, lowerer.typeOf(param.name));
      return { type, mode: "rest" };
    }
    if (param.initializer) {
      // A WHOLE-PATTERN default (`({ x } = { x: 1 }) => ...`): the ABI
      // slot arms the pattern's type with undefined, exactly the
      // identifier-param default below; the callee prologue picks the
      // default when the argument was omitted or undefined, then the
      // pattern destructures the picked value (declareParams).
      const raw = lowerer.irTypeOf(param.name);
      return defaultParameterShape(lowerer, param, raw);
    }
    return {
      type: lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name)),
      mode: "required",
    };
  }
  if (param.dotDotDotToken) {
    // A JS rest param with no static element type (`(...args)` — any[]):
    // the VARIADIC dyn form. The lifted function takes one trailing dyn
    // ARRAY param the dyn call thunk fills with the call's surplus
    // arguments; the binding is that array (dynRest — funcType marks
    // `rest`, and the value only ever calls through the boxed thunk).
    if (isJsSourceFile(param.getSourceFile())) {
      const restMapped = lowerer.mapTypeOf(lowerer.typeOf(param.name));

      // Unmapped JS rest parameters use the native variadic checked-value ABI.
      if (restMapped?.kind !== "array") {
        return { type: DYN, mode: "dynRest" };
      }
    }
    const type = lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name));
    // Tuple-typed rest params don't map to an array; generic rest is the
    // generic path's business. Anything non-array here is unmappable.
    if (type.kind !== "array") lowerer.badType(param.name, lowerer.typeOf(param.name));
    return { type, mode: "rest" };
  }
  if (param.initializer) {
    const raw = lowerer.irTypeOf(param.name);
    // An optional JS array parameter is a live caller-owned buffer,
    // including typed arrays passed through checked callbacks. Extracting
    // a native array here would copy it and discard element writes.
    if (
      isJsSourceFile(param.getSourceFile()) &&
      !param.type &&
      (raw.kind === "array" ||
        (raw.kind === "union" &&
          lowerer.unions.get(raw.unionId)?.arms.some((arm) => arm.kind === "array")))
    ) {
      return { type: DYN, mode: "omittable", bodyType: DYN };
    }
    return defaultParameterShape(lowerer, param, raw);
  }
  let type = lowerer.runtimeOptionalBindingType(param.name, lowerer.irTypeOf(param.name));
  const body = param.parent?.body;
  if (isJsSourceFile(param.getSourceFile()) && body && type.kind !== "dyn") {
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    let acceptsUndefined = false;
    ts.walkPreorder(body, (node) => {
      if (acceptsUndefined || !ts.isBinaryExpression(node)) return;
      const op = node.operatorToken.kind;
      if (
        op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
        op !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        op !== ts.SyntaxKind.EqualsEqualsToken &&
        op !== ts.SyntaxKind.ExclamationEqualsToken
      )
        return;
      const checks = (value: ts.Expression, absent: ts.Expression): boolean =>
        ts.isIdentifier(value) &&
        ts.isIdentifier(absent) &&
        absent.text === "undefined" &&
        (lowerer.typeOf(absent).flags & ts.TypeFlags.Undefined) !== 0 &&
        lowerer.checker.getSymbolAtLocation(value) === symbol;
      acceptsUndefined = checks(node.left, node.right) || checks(node.right, node.left);
    });
    // A JavaScript body that handles an absent argument defines a wider
    // contract than its JSDoc's usual value. Checked callers must deliver
    // undefined to that branch rather than reject it at the ABI boundary.
    if (acceptsUndefined) type = lowerer.promoteRuntimeOptionalParameter(param.name, type);
  }
  if (type.kind === "void") {
    return { type: DYN, mode: param.questionToken ? "omittable" : "required" };
  }
  if (param.questionToken && !lowerer.bareUndefinedArmedUnion(type) && type.kind !== "dyn") {
    // An omitted argument requires an undefined union arm or a native
    // checked-value slot that can hold undefined directly.
    lowerer.unsupported("SC1090", param, `optional parameters of type '${lowerer.fmt(type)}'`);
  }
  return { type, mode: param.questionToken ? "omittable" : "required" };
}

/** A `this` PARAMETER declaration (`function f(this: void, x: {}) ...`)
 * — type-world only: tsc types the receiver with it, callers never pass
 * it, and signature.getParameters() excludes it. The syntactic walks
 * (paramShapes, declareParams) skip it with this predicate so ABI slots
 * and call completion stay aligned with what JS actually passes. */
export function isThisParameter(param: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(param.name) && param.name.text === "this";
}

/** ParamShapes for a whole parameter list. */
export function paramShapes(
  lowerer: Lowerer,
  params: readonly ts.ParameterDeclaration[],
  signature?: ts.Signature,
  blameOf?: (param: ts.ParameterDeclaration, index: number) => ts.Node,
): ParamShape[] {
  if (!signature)
    return params.filter((p) => !isThisParameter(p)).map((param) => lowerer.paramShape(param));
  const symbols = signature.getParameters();
  return params.map((declParam, i) => {
    const symbol = symbols[i];
    const tsType = symbol
      ? lowerer.checker.getTypeOfSymbol(symbol)
      : lowerer.typeOf(declParam.name);
    const mapped = jsOpenObjectType(
      declParam,
      lowerer.runtimeOptionalBindingType(
        declParam.name,
        lowerer.mapTypeOf(tsType) ?? lowerer.irTypeOf(declParam.name),
      ),
      lowerer.shapes,
      lowerer.unions,
    );
    if (!mapped || mapped.kind === "void")
      lowerer.badType(blameOf?.(declParam, i) ?? declParam.name, tsType);
    if (declParam.dotDotDotToken) {
      if (mapped.kind !== "array")
        lowerer.badType(blameOf?.(declParam, i) ?? declParam.name, tsType);
      return { type: mapped, mode: "rest" };
    }
    if (declParam.initializer) return defaultParameterShape(lowerer, declParam, mapped);
    if (declParam.questionToken && !lowerer.bareUndefinedArmedUnion(mapped)) {
      lowerer.unsupported(
        "SC1090",
        declParam,
        `optional parameters of type '${lowerer.fmt(mapped)}'`,
      );
    }
    return { type: mapped, mode: declParam.questionToken ? "omittable" : "required" };
  });
}

/** A default expression may itself yield undefined. Keep that arm in the
 * body and parameter-property storage, including for literal `undefined`
 * and void expressions: the general type mapper represents those as VOID,
 * so checking only a mapped undefinedT silently erased a valid value.
 * Shared by declared and instantiated signatures, including destructuring. */
function defaultParameterShape(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
  raw: IrType,
): ParamShape {
  if (raw.kind === "dyn") {
    return { type: raw, mode: "omittable", bodyType: raw };
  }
  if (lowerer.bareUndefinedArmedUnion(raw) && param.initializer) {
    const initializer = lowerer.typeOf(param.initializer);
    const parts = initializer.isUnionType() ? ts.constituentTypes(initializer) : [initializer];
    if (parts.some((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0)) {
      return { type: raw, mode: "omittable", bodyType: raw };
    }
  }
  const bodyType = lowerer.stripUndefinedArm(raw);
  lowerer.checkDefaultParamBodyType(param, bodyType);
  const abi =
    bodyType.kind === "union"
      ? lowerer.withUndefinedArmOf(bodyType)
      : lowerer.withUndefinedArm(bodyType);
  if (!abi) lowerer.badType(param.name, lowerer.typeOf(param.name));
  return { type: abi, mode: "omittable", bodyType };
}

/** The fences on a defaulted parameter's body type: it becomes the value
 * arm of the synthesized `T | undefined` ABI union, so it must be a valid
 * single arm. Functions, Maps and Sets are valid: the ABI union's test is
 * the prologue's own undefined-tag check (never a user narrowing, which
 * is what keeps containers out of unions with data siblings), so `runner: Runner =
 * defaultRunner` and `skip: Set<string> = new Set()` arm like any ref
 * kind — the nullable-callback union shape, built by the compiler. */
export function checkDefaultParamBodyType(
  lowerer: Lowerer,
  param: ts.ParameterDeclaration,
  bodyType: IrType,
): void {
  if (
    bodyType.kind === "void" ||
    bodyType.kind === "regex" ||
    bodyType.kind === "date" ||
    bodyType.kind === "dyn" ||
    isUnitType(bodyType)
  ) {
    lowerer.unsupported(
      "SC1090",
      param,
      `parameter default values on '${lowerer.fmt(bodyType)}'-typed parameters`,
    );
  }
}

/** DECISION (docs/ir.md): function VALUES carry one completed native ABI.
 * Optional/default parameters appear as literal `T | undefined` slots;
 * typed rest parameters appear as one trailing typed-array slot plus the
 * typed-rest marker that makes indirect call sites pack source arguments.
 * A value is admitted only where its target type projects to that same
 * completed signature. */
export function requireExactArityValue(
  lowerer: Lowerer,
  blame: ts.Node,
  contextual: ts.Expression | null,
  shapes: readonly ParamShape[],
  funcType: IrType,
): void {
  // dynRest params ride the boxed thunk (JS arity — no completed-ABI
  // spelling exists or is needed); they don't gate the value form.

  // Omittable checked-value slots also keep their declared param type (no
  // synthesized union), so every func-type spelling of the signature
  // already matches and short calls through the value complete with the
  // native undefined value (omittedArgFor).
  if (
    shapes.every(
      (s) =>
        s.mode === "required" ||
        s.mode === "dynRest" ||
        s.mode === "arguments" ||
        (s.mode === "omittable" && s.type.kind === "dyn"),
    )
  ) {
    return;
  }
  // The type the value FLOWS under must spell the completed ABI: the
  // contextual (target) type when one exists, otherwise the expression's
  // OWN inferred type — the unannotated-const case (`const f = (x = 5) =>
  // ...`), where every later read types the value by that inference and
  // optional/defaulted params spell their `T | undefined` slots (mapType's
  // completed-signature contract), so omitted trailing args complete with
  // the undefined arm like any direct call.
  const target = contextual ? lowerer.checker.getContextualType(contextual) : undefined;
  const mapped = target
    ? lowerer.mapTypeOf(target)
    : contextual
      ? lowerer.mapTypeOf(lowerer.typeOf(contextual))
      : null;
  if (mapped && typeEquals(mapped, funcType)) return;
  // A union-typed slot (`runner || defaultRunner` under a
  // `CommandRunner | undefined` context): the value can only inhabit
  // the union's one func arm — judge by it.
  let mappedFn: IrType | null =
    mapped?.kind === "union"
      ? (() => {
          const arms =
            lowerer.unions.get(mapped.unionId)?.arms.filter((a) => a.kind === "func") ?? [];
          return arms.length === 1 ? arms[0]! : null;
        })()
      : mapped;
  // A contextual type that maps to something non-functional (`picked ||
  // defaultRunner` — tsc's contextual answer for the rhs is not the
  // slot): judge by the expression's OWN completed type; the slot's
  // coercion still enforces (or adapts) the flow it lands in.
  if (mappedFn?.kind !== "func" && contextual) {
    const ownType = lowerer.typeOf(contextual);
    mappedFn =
      lowerer.mapTypeOf(ownType) ??
      (isJsSourceFile(contextual.getSourceFile())
        ? dynFallbackType(lowerer, contextual, ownType)
        : null);
  }
  if (mappedFn && typeEquals(mappedFn, funcType)) return;
  // A target signature that agrees on the completed parameters and
  // differs only by RETURNING the structural spawnSync-result record
  // (the CommandRunner shape): the slot coercion bridges with the
  // interned runner-value adapter, so the value passes here.
  if (
    mappedFn?.kind === "func" &&
    funcType.kind === "func" &&
    lowerer.spawnResFnAdapterPlan(funcType, mappedFn) !== null
  ) {
    return;
  }
  // An uncontextualized npm-static implementation function can still
  // have a declaration-backed completed ABI: the package's .d.ts
  // projection supplies the body-facing parameter/return types while
  // the shipped JavaScript's own inferred type remains wider (`any`
  // callback fields are the common case). lambdaSignature has already
  // constructed and validated that concrete ABI, and every eventual
  // storage/call site independently checks it. Admit the value at birth;
  // do not make the unprojected JS inference veto its authored surface.
  if (
    target === undefined &&
    contextual !== null &&
    (ts.isArrowFunction(contextual) || ts.isFunctionExpression(contextual)) &&
    npmStaticPackageOfPath(contextual.getSourceFile().fileName) !== null
  ) {
    return;
  }

  lowerer.unsupported(
    "SC1090",
    blame,
    "functions with optional or defaulted parameters as values, except where the " +
      "target type spells the completed signature with required parameters " +
      "(a '(x?: T) => R' function flows into a '(x: T | undefined) => R' slot, " +
      "and a package/'any' slot takes any natively representable signature; " +
      "otherwise call the function directly)",
  );
}

export function collectSignature(lowerer: Lowerer, decl: ts.FunctionDeclaration): void {
  lowerer.collectDeferring(
    () => declSymbolOf(lowerer, decl),
    () => lowerer.collectSignatureInner(decl),
  );
}

export function collectSignatureInner(lowerer: Lowerer, decl: ts.FunctionDeclaration): void {
  // The one legal nameless declaration form is `export default function
  // () {}` — its symbol is the module's default export (declSymbolOf)
  // and it registers under the synthetic "%default" spelling.
  if (!decl.name && declSymbolOf(lowerer, decl) === undefined) {
    lowerer.unsupported("SC1090", decl, "anonymous function declarations");
  }
  // A body-less declaration is type-world and lowers to NOTHING: an
  // OVERLOAD SIGNATURE when an implementation shares the symbol (the
  // implementation's own collection registers the one real ABI — tsc
  // resolved every call site against the signatures, and the
  // implementation's parameter types are supersets by the
  // overload-compatibility rules, so calls flow through that ABI), or an
  // AMBIENT `declare function` nothing defines (references compile to
  // Node's ReferenceError at the use site — the `declare const` /
  // ambient-namespace undefRead stance, ambientUndefinedFnSymbolOf).
  if (!decl.body) return;
  // A MIXIN function (`function M(Base: T) { return class extends Base
  // {…} }`) has no callable signature of its own — its return type is a
  // per-call class, so calls instantiate per site (lower-mixins.ts) and
  // nothing ever dispatches through an ABI. Recognized here so the
  // declaration neither registers a broken signature nor lowers as a
  // body (run()/discover() skip by the same test). Generic mixins still
  // register their generic signature below: non-mixin-shaped calls
  // degrade to the generic machinery's own per-site fences.
  if (!decl.typeParameters && mixinFnShapeOf(lowerer, decl)) return;
  const isAsync = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = decl.asteriskToken !== undefined;
  if (decl.typeParameters) {
    // Generic async composes: each monomorphized instance is an async
    // IrFunction like any other — its own spawn wrapper, its body
    // returning the resolved promise's inner (lowerGenericInstance).
    lowerer.collectGenericSignature(decl);
    return;
  }
  // IMPLICIT-ANY monomorphization (npm-static JS): a function whose
  // signature carries bindable untyped params registers like a generic
  // declaration — no ABI of its own, one instance per call-site type
  // tuple (generic-functions.ts). Everything that
  // routes generic declarations (direct calls, namespace/CJS member
  // calls, value references) resolves it through genericFnsBySymbol
  // unchanged.
  if (implicitMonoFile(decl.getSourceFile()) && !isAsync && !isGenerator) {
    const implicit = implicitAnyParamSymbolsOf(lowerer, decl);
    if (implicit) {
      const nameText = decl.name?.text ?? "%default";
      const symbol = declSymbolOf(lowerer, decl);
      if (!symbol) lowerer.unsupported("SC1090", decl, "this function form");
      lowerer.genericFnsBySymbol.set(symbol, {
        decl,
        baseName: nameText,
        qualifiedName: lowerer.qualify(decl.getSourceFile(), nsPathPrefix(decl) + nameText),
        typeParams: [],
        instances: new Map(),
        implicitParams: implicit,
      });
      return;
    }
  }

  const params = lowerer.paramShapes(decl.parameters);
  // The zero-parameter declaration retains its dynRest ABI; value
  // functions use the full arguments slot even with no named parameters.
  appendArgumentsParameter(
    lowerer,
    decl,
    params,
    decl.parameters.length > 0 ? "arguments" : "dynRest",
  );
  const nameBlame: ts.Node = decl.name ?? decl;
  const returnType = lowerer.declaredReturnType(decl, nameBlame);
  if (isAsync && !isGenerator && returnType.kind !== "promise") {
    lowerer.badType(nameBlame, lowerer.typeOf(nameBlame));
  }
  if (isGenerator && (returnType.kind !== "generator" || (returnType.async === true) !== isAsync)) {
    lowerer.badType(nameBlame, lowerer.typeOf(nameBlame));
  }

  const symbol = declSymbolOf(lowerer, decl);
  if (!symbol) lowerer.unsupported("SC1090", decl, "this function form");
  lowerer.fnSigsBySymbol.set(symbol, {
    // Namespace-nested functions carry the namespace path (nsPathPrefix)
    // so `namespace A { export function f }` and a top-level `f` never
    // collide. The anonymous default export takes the synthetic
    // "%default" spelling ('%' cannot appear in a user identifier).
    name: lowerer.qualify(
      decl.getSourceFile(),
      nsPathPrefix(decl) + (decl.name?.text ?? "%default"),
    ),
    params,
    returnType,
    isAsync,
    ...(isGenerator && returnType.kind === "generator"
      ? { generator: generatorMeta(lowerer, returnType) }
      : {}),
  });
}

/** Arrows inherit arguments. Ordinary JS functions receive a hidden
 * array unless a declared rest parameter already owns that contract.
 * Class methods are strict; other parameterized forms require ES modules
 * because sloppy-mode arguments alias named parameters. */
function appendArgumentsParameter(
  lowerer: Lowerer,
  node: ts.SignatureDeclaration,
  shapes: ParamShape[],
  mode: "arguments" | "dynRest",
): void {
  if (
    shapes.some((s) => s.mode === "rest" || s.mode === "dynRest") ||
    !(
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) ||
    !isJsSourceFile(node.getSourceFile()) ||
    !bodyReadsArguments(node)
  )
    return;
  if (node.parameters.length > 0 || ts.isMethodDeclaration(node)) {
    const classMethod =
      ts.isMethodDeclaration(node) &&
      (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent));
    if (!classMethod && !isNodeEsmFile(node.getSourceFile(), lowerer.program)) {
      lowerer.unsupported(
        "SC1090",
        node,
        "parameterized 'arguments' outside an ES module (sloppy-mode parameter aliases)",
      );
    }
  }
  shapes.push({ type: DYN, mode });
}

/** Signature checks + param shapes + IR func type for any lambda-like
 * node. The func type's params are the ABI types: optional/default params
 * become `T | undefined`, and typed rest becomes one packed-array slot.
 * requireExactArityValue decides whether that completed ABI may escape. */
export function lambdaSignature(
  lowerer: Lowerer,
  node:
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): { shapes: ParamShape[]; funcType: IrType & { kind: "func" } } {
  if (!node.body) lowerer.unsupported("SC1090", node, "function overload signatures");
  // A JS replacement of a native stream's write method receives the
  // actual call tuple, including overloads and omitted arguments. Node's
  // contextual overload signature cannot define this closure's ABI.
  if (
    isJsSourceFile(node.getSourceFile()) &&
    !node.type &&
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    node.parameters.every((param) => !param.type && !param.dotDotDotToken && !param.initializer) &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.right === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.parent.left) &&
    node.parent.left.name.text === "write" &&
    lowerer.isStdlibMember(node.parent.left)
  ) {
    const receiver = lowerer.lowerExpr(node.parent.left.expression);
    if (receiver.type.kind === "dyn") {
      const shapes: ParamShape[] = node.parameters.map(() => ({ type: DYN, mode: "required" }));
      return { shapes, funcType: funcTypeFromParamShapes(shapes, DYN) };
    }
  }
  if (node.typeParameters) {
    // Generic function-like forms monomorphize only where a static home
    // exists: top-level generic function declarations, generic methods
    // (class and object-literal), and module-scope never-reassigned
    // bindings initialized with a generic arrow/function expression —
    // all collected before this path. Everything else lambda-shaped
    // (arguments, IIFEs, default exports, nested declarations) has no
    // per-instantiation story and stays out.
    lowerer.unsupported(
      "SC1090",
      node,
      ts.isMethodDeclaration(node)
        ? "generic methods"
        : ts.isFunctionDeclaration(node)
          ? "generic nested functions (only top-level generic function declarations are supported)"
          : "generic arrow/function expressions outside a never-reassigned module-scope binding (only `const f = <T>(x: T) => ...` bindings and top-level generic function declarations monomorphize)",
    );
  }
  const shapes = lowerer.paramShapes(node.parameters);
  // Error-first callbacks captured by native filesystem adapters receive
  // the selected runtime overload. Ambient contextual inference can pick
  // the string overload even when options request a Buffer.
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.at(-1) === node
  ) {
    const builtin = ts.isPropertyAccessExpression(node.parent.expression)
      ? lowerer.builtinMemberOf(node.parent.expression)
      : ts.isIdentifier(node.parent.expression)
        ? lowerer.builtinImportOf(node.parent.expression)
        : null;
    if (
      builtin?.module === "fs" &&
      builtin.member !== "rename" &&
      builtinModuleFnOf(lowerer, builtin.module, builtin.member)?.fn === "fs.callbackCall"
    ) {
      for (let index = 0; index < shapes.length; index++) {
        if (!node.parameters[index]?.type) {
          shapes[index]!.type = DYN;
          if (shapes[index]!.bodyType) shapes[index]!.bodyType = DYN;
        }
      }
    }
  }
  // A concise arrow over an h2-only stream/session call (`() =>
  // req.stream.destroy()`): the call ALWAYS throws on this lowering
  // (stream is undefined — the streamUndefCall precedent), so the body
  // is throw-only and the declared return type (ServerHttp2Stream,
  // unmappable) must not decide the ABI — void, the `never` stance.
  let ret =
    ts.isArrowFunction(node) && !ts.isBlock(node.body) && isStreamUndefCallExpr(lowerer, node.body)
      ? VOID
      : lowerer.declaredReturnType(node, node);
  ret = lowerer.runtimeOptionalFunctionReturnType(node, ret);
  // A contextually-typed arrow/function EXPRESSION whose slot signature
  // returns a composite type the inferred return doesn't spell adopts
  // the slot's return as its ABI: `(n) => work()` (inferring Promise<void>) against
  // an `(n) => Promise<void> | void` field must RETURN that union — the
  // body's returns coerce into it per return site (arm values wrap;
  // width-coercible records rebuild into their arm — the runJobs
  // `{ data, id }` literal against `Buffer | string | GeneratedOutput`),
  // a void body's implicit completion becomes the undefined arm, and the
  // closure VALUE matches the slot exactly (no runtime re-tag exists for
  // func returns). tsc vetted the assignability — a return the coercion
  // path can't carry fences per site with its own actionable message.
  // ASYNC lambdas adopt through the promise: an inferred Promise<record>
  // against a Promise<union> slot returns the union promise (the fiber's
  // returns coerce; the spawn-wrapper ABI still returns a promise).

  // Array and record returns also need the destination during literal
  // construction: a callback building IrStmt[] must wrap each element at
  // that recursive layout instead of first inferring narrower arrays.
  const isAsyncLike =
    !ts.isMethodDeclaration(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const innerRet = isAsyncLike && ret.kind === "promise" ? ret.inner : ret;
  // Union-inferred returns adopt too (a mixed-return body inferring a
  // SUB-union of the slot's union — adopting is a no-op when the two

  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (!isAsyncLike || ret.kind === "promise")
  ) {
    // The slot's signature: the contextual type stripped of its nullish
    // parts (an OPTIONAL callback field's context is the whole
    // `(...) | undefined` union) with exactly one call signature — and
    // declared in USER code: stdlib callback slots (flatMap's
    // `U | readonly U[]`, sort comparators) have intrinsic lowerings
    // that inspect the INFERRED type, so they must not widen.
    const ctxType = lowerer.checker.getContextualType(node);
    const ctxSigs = ctxType
      ? lowerer.checker.getCallSignatures(lowerer.checker.getNonNullableType(ctxType))
      : [];
    const ctxDecl =
      ctxSigs.length === 1 ? lowerer.checker.signatureDeclaration(ctxSigs[0]!) : undefined;
    const ctxRetRaw =
      ctxDecl && !ctxDecl.getSourceFile().isDeclarationFile
        ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(ctxSigs[0]!))
        : null;
    const ctxRet = isAsyncLike && ctxRetRaw?.kind === "promise" ? ctxRetRaw.inner : ctxRetRaw;
    if (
      (ctxRet?.kind === "union" || ctxRet?.kind === "array" || ctxRet?.kind === "record") &&
      (innerRet.kind !== "void" ||
        (ctxRet.kind === "union" && lowerer.armTag(ctxRet.unionId, UNDEFINED_T) >= 0))
    ) {
      ret = isAsyncLike ? { kind: "promise", inner: ctxRet } : ctxRet;
    }
    // A VOID slot discards the callback's result (TS's void-returning
    // assignability rule; JS ignores the value), so an UNANNOTATED
    // sync lambda adopts void regardless of what its body infers —
    // `() => socket.destroy()` infers Socket (destroy returns `this`
    // for chaining) but the error-listener slot never looks. Stdlib
    // slots included: no intrinsic lowering inspects an inferred
    // return where its own declared slot is void. Async lambdas stay
    // out (the spawn-wrapper ABI must still return a promise), and an
    // explicit return annotation keeps its word.
    if (
      !isAsyncLike &&
      !node.type &&
      ret.kind !== "void" &&
      ctxSigs.length === 1 &&
      !!(lowerer.checker.getReturnTypeOfSignature(ctxSigs[0]!).flags & ts.TypeFlags.Void)
    ) {
      ret = VOID;
    }
  }
  ret = lowerer.contextualFunctionReturns.get(node) ?? ret;
  appendArgumentsParameter(lowerer, node, shapes, "arguments");
  const funcType = funcTypeFromParamShapes(shapes, ret);
  return { shapes, funcType };
}
