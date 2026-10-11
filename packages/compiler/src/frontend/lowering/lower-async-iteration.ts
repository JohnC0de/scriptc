import { dynUndefinedExpr } from "../../ir/build.js";
/* Static async-iterator consumers shared by Node Readable and Web
 * ReadableStream. Both lower through one completion discipline: an
 * `active` flag is set only while user loop-body code owns a yielded value,
 * and a try/finally performs IteratorClose on every abrupt completion while
 * leaving normal exhaustion alone. */
import * as ts from "../ts7/adapter.js";
import { InternalCompilerError } from "../../errors.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, DYN, type IrExpr, type IrStmt, type IrType, VOID } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { extractIteratorValue } from "./lower-generators.js";
import { streamSidesOf } from "./lower-stream.js";
import { staticReadableStreamElementType } from "./lower-stdlib.js";
import { genResultRecord } from "../type-mapper.js";
import { sideEffectFreeOptionValue } from "./surfaces.js";

interface NodeReadablePlan {
  source: ts.Expression;
  type: IrType & { kind: "object" };
  destroyOnReturn: boolean;
}

interface WebReadablePlan {
  source: ts.Expression;
  element: IrType;
  preventCancel: boolean;
}

interface ClassAsyncIteratorPlan {
  source: ts.Expression;
  sourceType: IrType & { kind: "object" };
  iteratorType: IrType & { kind: "object" };
  resultType: IrType & { kind: "record" };
  valueType: IrType;
  hasDone: boolean;
  closeResult: IrType | null;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertion(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) {
    return null;
  }
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

/** The iterator options are deliberately static: a literal boolean decides
 * which cleanup graph is emitted. Unknown keys follow Node/WebIDL's ignore
 * rule only when dropping their value is observably safe. */
function literalBooleanOption(
  lowerer: Lowerer,
  call: ts.CallExpression,
  option: string,
  fallback: boolean,
  api: string,
): boolean {
  if (call.arguments.length === 0) return fallback;
  const argumentNode = call.arguments[0];
  if (
    call.arguments.length !== 1 ||
    argumentNode === undefined ||
    ts.isSpreadElement(argumentNode)
  ) {
    lowerer.unsupported("SC1090", call, `${api} with this argument shape`);
    return fallback;
  }
  const argument = unwrapExpression(argumentNode);
  if (!ts.isObjectLiteralExpression(argument)) {
    lowerer.unsupported(
      "SC1090",
      argumentNode,
      `${api} with runtime-computed options (use an object literal with a boolean '${option}')`,
    );
    return fallback;
  }
  let answer = fallback;
  for (const member of argument.properties) {
    const name = propertyName(member);
    if (name !== option) {
      const value = ts.isPropertyAssignment(member) ? member.initializer : null;
      if (value === null || !sideEffectFreeOptionValue(value)) {
        lowerer.unsupported(
          "SC1090",
          member,
          `${api} option entries outside the static '${option}' boolean`,
        );
      }
      continue;
    }
    if (!ts.isPropertyAssignment(member)) {
      lowerer.unsupported(
        "SC1090",
        member,
        `${api} with a runtime '${option}' value (write '${option}: true' or '${option}: false')`,
      );
    }
    const value = unwrapExpression(member.initializer);
    if (value.kind === ts.SyntaxKind.TrueKeyword) answer = true;
    else if (value.kind === ts.SyntaxKind.FalseKeyword) answer = false;
    else {
      lowerer.unsupported(
        "SC1090",
        member.initializer,
        `${api} with a runtime '${option}' value (use a boolean literal)`,
      );
    }
  }
  return answer;
}

function nodeReadablePlan(lowerer: Lowerer, expression: ts.Expression): NodeReadablePlan | null {
  const direct = lowerer.mapTypeOf(lowerer.typeOf(expression));
  if (direct?.kind === "object") {
    const sides = streamSidesOf(lowerer, lowerer.classes.get(direct.className));
    if (sides === "r" || sides === "rw") {
      return { source: expression, type: direct, destroyOnReturn: true };
    }
  }
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call) || call.questionDotToken) return null;
  const iteratorCall =
    ts.isPropertyAccessExpression(call.expression) &&
    !call.expression.questionDotToken &&
    call.expression.name.text === "iterator";
  const asyncIteratorCall = symbolAsyncIteratorCall(lowerer, expression) !== null;
  if (!iteratorCall && !asyncIteratorCall) return null;
  const source = (call.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression)
    .expression;
  const type = lowerer.mapTypeOf(lowerer.typeOf(source));
  if (type?.kind !== "object") return null;
  const sides = streamSidesOf(lowerer, lowerer.classes.get(type.className));
  if (sides !== "r" && sides !== "rw") return null;
  return {
    source,
    type,
    destroyOnReturn: iteratorCall
      ? literalBooleanOption(lowerer, call, "destroyOnReturn", true, "readable.iterator")
      : true,
  };
}

function symbolAsyncIteratorCall(
  lowerer: Lowerer,
  expression: ts.Expression,
): ts.CallExpression | null {
  const call = unwrapExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    !ts.isElementAccessExpression(call.expression) ||
    call.expression.questionDotToken
  ) {
    return null;
  }
  const key = unwrapExpression(call.expression.argumentExpression);
  if (
    !ts.isPropertyAccessExpression(key) ||
    key.name.text !== "asyncIterator" ||
    !lowerer.isStdlibGlobal(key.expression, "Symbol")
  ) {
    return null;
  }
  return call;
}

function webReadablePlan(lowerer: Lowerer, expression: ts.Expression): WebReadablePlan | null {
  const directElement = staticReadableStreamElementType(lowerer, expression);
  if (directElement) {
    return { source: expression, element: directElement, preventCancel: false };
  }
  const unwrapped = unwrapExpression(expression);
  const propertyCall =
    ts.isCallExpression(unwrapped) &&
    !unwrapped.questionDotToken &&
    ts.isPropertyAccessExpression(unwrapped.expression) &&
    !unwrapped.expression.questionDotToken &&
    unwrapped.expression.name.text === "values"
      ? unwrapped
      : null;
  const symbolCall = symbolAsyncIteratorCall(lowerer, expression);
  const call = propertyCall ?? symbolCall;
  if (!call) return null;
  const access = call.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression;
  const source = access.expression;
  const element = staticReadableStreamElementType(lowerer, source);
  if (!element) return null;
  return {
    source,
    element,
    preventCancel: literalBooleanOption(
      lowerer,
      call,
      "preventCancel",
      false,
      propertyCall ? "ReadableStream.values" : "ReadableStream[Symbol.asyncIterator]",
    ),
  };
}

function classAsyncIteratorPlan(
  lowerer: Lowerer,
  expression: ts.Expression,
): ClassAsyncIteratorPlan | null {
  const sourceType = lowerer.mapTypeOf(lowerer.typeOf(expression));
  if (sourceType?.kind !== "object") return null;
  const sourceInfo = lowerer.classes.get(sourceType.className);
  const open = sourceInfo ? lowerer.findMethodOn(sourceInfo, "sym:asyncIterator") : null;
  if (
    !open ||
    open.sig.abstract === true ||
    open.sig.params.length !== 0 ||
    open.sig.ret.kind !== "object"
  ) {
    return null;
  }
  const iteratorType = open.sig.ret;
  const iteratorInfo = lowerer.classes.get(iteratorType.className);
  const next = iteratorInfo ? lowerer.findMethodOn(iteratorInfo, "next") : null;
  if (
    !next ||
    next.sig.abstract === true ||
    next.sig.params.length !== 0 ||
    next.sig.ret.kind !== "promise" ||
    next.sig.ret.inner.kind !== "record"
  ) {
    return null;
  }
  const resultType = next.sig.ret.inner;
  const resultShape = lowerer.shapes.get(resultType.shapeId);
  const value = resultShape?.fields.find((field) => field.name === "value");
  const done = resultShape?.fields.find((field) => field.name === "done");
  if (!resultShape || !value || (done && done.type.kind !== "bool")) return null;
  const close = iteratorInfo ? lowerer.findMethodOn(iteratorInfo, "return") : null;
  let closeResult: IrType | null = null;
  if (close) {
    if (
      close.sig.abstract === true ||
      close.sig.params.length !== 0 ||
      close.sig.ret.kind !== "promise" ||
      close.sig.ret.inner.kind !== "record"
    ) {
      return null;
    }
    closeResult = close.sig.ret.inner;
  }
  return {
    source: expression,
    sourceType,
    iteratorType,
    resultType,
    valueType: value.type,
    hasDone: done !== undefined,
    closeResult,
  };
}

function checkForAwaitBinding(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
): { declaration: ts.VariableDeclaration & { name: ts.Identifier }; mutable: boolean } {
  if (!lowerer.ctx.isAsync) {
    lowerer.unsupported("SC1090", stmt, "top-level 'for await' (await outside async functions)");
  }
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    lowerer.unsupported(
      "SC1090",
      stmt.initializer,
      "for-await over a pre-declared variable (declare the loop variable in the loop: for await (const value of ...))",
    );
  }
  const list = stmt.initializer;
  if ((list.flags & ts.NodeFlags.Using) !== 0) {
    lowerer.unsupported("SC1090", list, "'await using' loop bindings over async iterators");
  }
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0;
  if (!isConst && !isLet) {
    lowerer.unsupported("SC1030", list, "'var' loop bindings in 'for await' (use const)");
  }
  const declaration = list.declarations[0];
  if (!declaration) throw new InternalCompilerError("for-await declaration list has no binding");
  if (!ts.isIdentifier(declaration.name)) lowerer.unsupported("SC1031", declaration.name);
  return {
    declaration: declaration as ts.VariableDeclaration & { name: ts.Identifier },
    mutable: isLet,
  };
}

function boolRef(localId: string, loc: ReturnType<typeof locOf>): IrExpr {
  return { kind: "varRef", localId, type: BOOL, loc };
}

function lowerNodeReadable(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  plan: NodeReadablePlan,
): IrStmt {
  const binding = checkForAwaitBinding(lowerer, stmt);
  const loc = locOf(stmt);
  lowerer.scopes.push(new Map());
  try {
    const stream = lowerer.declareHiddenLocal("%faStream", plan.type);
    const active = lowerer.declareHiddenLocal("%faActive", BOOL);
    active.mutable = true;
    const promiseT: IrType = { kind: "promise", inner: DYN };
    const promise = lowerer.declareHiddenLocal("%streamNext", promiseT);
    const chunk = lowerer.declareLocal(
      binding.declaration.name,
      binding.declaration.name.text,
      DYN,
      binding.mutable,
    );
    const streamRef = (): IrExpr => ({ kind: "varRef", localId: stream.id, type: plan.type, loc });
    const chunkRef: IrExpr = { kind: "varRef", localId: chunk.id, type: DYN, loc };
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loop: IrStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      body: [
        {
          kind: "assign",
          localId: active.id,
          value: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: promise.id,
          init: {
            kind: "libCall",
            fn: "readable.nextChunkDyn",
            args: [streamRef()],
            type: promiseT,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: chunk.id,
          init: {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: promise.id, type: promiseT, loc },
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: { kind: "dynTest", test: "undefined", value: chunkRef, type: BOOL, loc },
          then: [{ kind: "break", loc }],
          else_: null,
          loc,
        },
        {
          kind: "assign",
          localId: active.id,
          value: { kind: "boolLit", value: true, type: BOOL, loc },
          loc,
        },
        ...body,
      ],
      loc,
    };
    const guarded: IrStmt = plan.destroyOnReturn
      ? {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [
            {
              kind: "if",
              cond: boolRef(active.id, loc),
              then: [
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "libCall",
                    fn: "stream.iteratorClose",
                    args: [streamRef()],
                    type: plan.type,
                    loc,
                  },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
          loc,
        }
      : loop;
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: stream.id, init: lowerer.lowerExpr(plan.source), loc },
        {
          kind: "varDecl",
          localId: active.id,
          init: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        guarded,
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

function lowerWebReadable(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  plan: WebReadablePlan,
): IrStmt {
  const binding = checkForAwaitBinding(lowerer, stmt);
  const loc = locOf(stmt);
  const resultT = genResultRecord(plan.element, VOID, lowerer.shapes, lowerer.unions);
  if (!resultT) {
    lowerer.unsupported(
      "SC1090",
      stmt.expression,
      `for-await over a ReadableStream yielding '${lowerer.fmt(plan.element)}' (no IteratorResult representation exists)`,
    );
    throw new InternalCompilerError("ReadableStream iteration has no result record");
  }
  const shape = lowerer.shapes.get(resultT.shapeId);
  if (!shape) throw new InternalCompilerError("ReadableStream iteration result shape is missing");
  const valueField = shape.fields.find((field) => field.name === "value");
  if (!valueField)
    throw new InternalCompilerError("ReadableStream iteration result has no value field");
  const valueT = valueField.type;
  const promiseT: IrType = { kind: "promise", inner: resultT };
  lowerer.scopes.push(new Map());
  try {
    const stream = lowerer.declareHiddenLocal("%faWebStream", DYN);
    const reader = lowerer.declareHiddenLocal("%faWebReader", DYN);
    const active = lowerer.declareHiddenLocal("%faActive", BOOL);
    active.mutable = true;
    const promise = lowerer.declareHiddenLocal("%webStreamNext", promiseT);
    const result = lowerer.declareHiddenLocal("%webStreamResult", resultT);
    const value = lowerer.declareLocal(
      binding.declaration.name,
      binding.declaration.name.text,
      plan.element,
      binding.mutable,
    );
    const streamRef = (): IrExpr => ({ kind: "varRef", localId: stream.id, type: DYN, loc });
    const readerRef = (): IrExpr => ({ kind: "varRef", localId: reader.id, type: DYN, loc });
    const resultRef = (): IrExpr => ({ kind: "varRef", localId: result.id, type: resultT, loc });
    const rawValue: IrExpr = {
      kind: "recordGet",
      obj: resultRef(),
      shapeId: resultT.shapeId,
      field: "value",
      type: valueT,
      loc,
    };
    const extracted = extractIteratorValue(lowerer, plan.element, valueT, rawValue, loc);
    if (!extracted) {
      lowerer.unsupported(
        "SC1090",
        stmt.expression,
        `for-await over a ReadableStream yielding '${lowerer.fmt(plan.element)}' (no per-element extraction exists)`,
      );
      throw new InternalCompilerError("ReadableStream iteration cannot extract its value");
    }
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loop: IrStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      body: [
        {
          kind: "assign",
          localId: active.id,
          value: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: promise.id,
          init: {
            kind: "libCall",
            fn: "fetch.readerRead",
            args: [readerRef()],
            type: promiseT,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: result.id,
          init: {
            kind: "awaitExpr",
            value: { kind: "varRef", localId: promise.id, type: promiseT, loc },
            type: resultT,
            loc,
          },
          loc,
        },
        {
          kind: "if",
          cond: {
            kind: "recordGet",
            obj: resultRef(),
            shapeId: resultT.shapeId,
            field: "done",
            type: BOOL,
            loc,
          },
          then: [{ kind: "break", loc }],
          else_: null,
          loc,
        },
        { kind: "varDecl", localId: value.id, init: extracted, loc },
        {
          kind: "assign",
          localId: active.id,
          value: { kind: "boolLit", value: true, type: BOOL, loc },
          loc,
        },
        ...body,
      ],
      loc,
    };
    const cancel: IrStmt = {
      kind: "if",
      cond: boolRef(active.id, loc),
      then: [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "async.awaitDyn",
            args: [
              {
                kind: "dynInvoke",
                recv: readerRef(),
                method: "cancel",
                calleeName: "ReadableStream async iterator return",
                args: [dynUndefinedExpr(loc)],
                type: DYN,
                loc,
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      else_: null,
      loc,
    };
    const release: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "dynInvoke",
        recv: readerRef(),
        method: "releaseLock",
        calleeName: "ReadableStream async iterator releaseLock",
        args: [],
        type: DYN,
        loc,
      },
      loc,
    };
    const cleanup: IrStmt = plan.preventCancel
      ? release
      : {
          kind: "tryCatch",
          tryBody: [cancel],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [release],
          loc,
        };
    return {
      kind: "block",
      body: [
        {
          kind: "varDecl",
          localId: stream.id,
          init: lowerer.lowerExprExpecting(plan.source, DYN),
          loc,
        },
        {
          kind: "varDecl",
          localId: reader.id,
          init: {
            kind: "dynInvoke",
            recv: streamRef(),
            method: "getReader",
            calleeName: "ReadableStream async iterator",
            args: [],
            type: DYN,
            loc,
          },
          loc,
        },
        {
          kind: "varDecl",
          localId: active.id,
          init: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [cleanup],
          loc,
        },
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

function lowerClassAsyncIterator(
  lowerer: Lowerer,
  stmt: ts.ForOfStatement,
  plan: ClassAsyncIteratorPlan,
): IrStmt {
  const binding = checkForAwaitBinding(lowerer, stmt);
  const loc = locOf(stmt);
  const nextPromiseT: IrType = { kind: "promise", inner: plan.resultType };
  lowerer.scopes.push(new Map());
  try {
    const source = lowerer.declareHiddenLocal("%faSource", plan.sourceType);
    const iterator = lowerer.declareHiddenLocal("%faIterator", plan.iteratorType);
    const active = lowerer.declareHiddenLocal("%faActive", BOOL);
    active.mutable = true;
    const promise = lowerer.declareHiddenLocal("%faNext", nextPromiseT);
    const result = lowerer.declareHiddenLocal("%faResult", plan.resultType);
    const value = lowerer.declareLocal(
      binding.declaration.name,
      binding.declaration.name.text,
      plan.valueType,
      binding.mutable,
    );
    const sourceRef = (): IrExpr => ({
      kind: "varRef",
      localId: source.id,
      type: plan.sourceType,
      loc,
    });
    const iteratorRef = (): IrExpr => ({
      kind: "varRef",
      localId: iterator.id,
      type: plan.iteratorType,
      loc,
    });
    const resultRef = (): IrExpr => ({
      kind: "varRef",
      localId: result.id,
      type: plan.resultType,
      loc,
    });
    const body = lowerer.inCtl("loop", () => lowerer.lowerScopedBlock(stmt.statement));
    const loopBody: IrStmt[] = [
      {
        kind: "assign",
        localId: active.id,
        value: { kind: "boolLit", value: false, type: BOOL, loc },
        loc,
      },
      {
        kind: "varDecl",
        localId: promise.id,
        init: lowerer.accessorCall(
          plan.iteratorType.className,
          "next",
          iteratorRef(),
          [],
          nextPromiseT,
          loc,
        ),
        loc,
      },
      {
        kind: "varDecl",
        localId: result.id,
        init: {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: promise.id, type: nextPromiseT, loc },
          type: plan.resultType,
          loc,
        },
        loc,
      },
      ...(plan.hasDone
        ? [
            {
              kind: "if",
              cond: {
                kind: "recordGet",
                obj: resultRef(),
                shapeId: plan.resultType.shapeId,
                field: "done",
                type: BOOL,
                loc,
              },
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            } satisfies IrStmt,
          ]
        : []),
      {
        kind: "varDecl",
        localId: value.id,
        init: {
          kind: "recordGet",
          obj: resultRef(),
          shapeId: plan.resultType.shapeId,
          field: "value",
          type: plan.valueType,
          loc,
        },
        loc,
      },
      {
        kind: "assign",
        localId: active.id,
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
      ...body,
    ];
    const loop: IrStmt = {
      kind: "while",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      body: loopBody,
      loc,
    };
    const guarded: IrStmt = plan.closeResult
      ? {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [
            {
              kind: "if",
              cond: boolRef(active.id, loc),
              then: [
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "awaitExpr",
                    value: lowerer.accessorCall(
                      plan.iteratorType.className,
                      "return",
                      iteratorRef(),
                      [],
                      { kind: "promise", inner: plan.closeResult },
                      loc,
                    ),
                    type: plan.closeResult,
                    loc,
                  },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
          loc,
        }
      : loop;
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: source.id, init: lowerer.lowerExpr(plan.source), loc },
        {
          kind: "varDecl",
          localId: iterator.id,
          init: lowerer.accessorCall(
            plan.sourceType.className,
            "sym:asyncIterator",
            sourceRef(),
            [],
            plan.iteratorType,
            loc,
          ),
          loc,
        },
        {
          kind: "varDecl",
          localId: active.id,
          init: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        },
        guarded,
      ],
      loc,
    };
  } finally {
    lowerer.scopes.pop();
  }
}

/** Claims the built-in static async-iterator families. Typed async
 * generators and process.stdin retain their specialized drivers; this is
 * the common stream protocol path. */
export function lowerForAwaitBuiltin(lowerer: Lowerer, stmt: ts.ForOfStatement): IrStmt | null {
  const node = nodeReadablePlan(lowerer, stmt.expression);
  if (node) return lowerNodeReadable(lowerer, stmt, node);
  const web = webReadablePlan(lowerer, stmt.expression);
  if (web) return lowerWebReadable(lowerer, stmt, web);
  const classIterator = classAsyncIteratorPlan(lowerer, stmt.expression);
  if (classIterator) return lowerClassAsyncIterator(lowerer, stmt, classIterator);
  return null;
}
