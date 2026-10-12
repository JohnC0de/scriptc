import { lowerBuiltinByteInput, errorFirstBytesCallback } from "./arguments.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import { CRYPTO_CIPHERS, CRYPTO_CURVES, CRYPTO_HASHES } from "../crypto-tables.js";
import {
  BOOL,
  BYTES_U8,
  CRYPTOHASH_T,
  CRYPTOHMAC_T,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
} from "../../../ir/ir.js";

/** The composed crypto pattern: `randomBytes(n).toString(enc)` lowers
 * as ONE string-producing libCall — the Buffer between the two calls
 * never exists at runtime. Only literal "hex"/"base64" encodings lower
 * (the runtime implements exactly those); wider forms fall through to
 * the ordinary Buffer lowering. Null when this is not a toString on a
 * crypto.randomBytes call. */
export function lowerCryptoComposedCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text === "digest") return lowerHashDigestChain(lowerer, call, access);
  if (access.name.text !== "toString") return null;
  const recv = access.expression;
  if (!ts.isCallExpression(recv) || recv.questionDotToken) return null;
  if (!ts.isIdentifier(recv.expression)) return null;
  const bi = lowerer.builtinImportOf(recv.expression);
  if (!bi || bi.module !== "crypto" || bi.member !== "randomBytes") return null;
  const loc = locOf(call);
  // Only the exact composed shape fuses — one size argument, one literal
  // "hex"/"base64" encoding. Anything else falls through (null): bare
  // randomBytes lowers to a real Buffer through the crypto table, and
  // the .toString rides the ordinary Buffer method lowering.
  if (recv.arguments.length !== 1) return null;
  const encNode = call.arguments[0];
  const encT = encNode ? lowerer.typeOf(encNode) : undefined;
  if (
    call.arguments.length !== 1 ||
    !encT?.isStringLiteralType() ||
    (encT.value !== "hex" && encT.value !== "base64")
  ) {
    return null;
  }
  const size = lowerer.lowerExprExpecting(recv.arguments[0]!, F64);
  const enc = lowerer.lowerExprExpecting(encNode!, STRING);
  return {
    kind: "libCall",
    fn: "crypto.randomBytesToString",
    args: [size, enc],
    type: STRING,
    loc,
  };
}

/** Fast path for the exact single-update hash chain. Wider algorithms,
 * stored handles, multiple updates, Buffer digests, and input encodings
 * fall through to the first-class Hash lowering below. */
function lowerHashDigestChain(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const updateCall = access.expression;
  if (!ts.isCallExpression(updateCall) || updateCall.questionDotToken) return null;
  const updAccess = updateCall.expression;
  if (
    !ts.isPropertyAccessExpression(updAccess) ||
    updAccess.questionDotToken ||
    updAccess.name.text !== "update"
  ) {
    return null;
  }
  const chCall = updAccess.expression;
  if (!ts.isCallExpression(chCall) || chCall.questionDotToken) return null;
  const callee = chCall.expression;
  const bi = ts.isIdentifier(callee)
    ? lowerer.builtinImportOf(callee)
    : ts.isPropertyAccessExpression(callee)
      ? lowerer.builtinMemberOf(callee)
      : null;
  if (!bi || bi.module !== "crypto" || bi.member !== "createHash") return null;
  const loc = locOf(call);
  const algT = chCall.arguments.length === 1 ? lowerer.typeOf(chCall.arguments[0]!) : undefined;
  if (!algT?.isStringLiteralType() || (algT.value !== "sha256" && algT.value !== "sha1"))
    return null;
  if (updateCall.arguments.length !== 1) {
    return null;
  }
  const encT = call.arguments.length === 1 ? lowerer.typeOf(call.arguments[0]!) : undefined;
  if (!encT?.isStringLiteralType() || (encT.value !== "hex" && encT.value !== "base64")) {
    return null;
  }
  // alg and enc are proven literals (fenced above), so lowering them
  // out of source position observes nothing; the data lowers between
  // them in its own source order.
  const alg = lowerer.lowerExprExpecting(chCall.arguments[0]!, STRING);
  // The data picks the runtime entry by its static type, the
  // fileURLToPath convention: strings hash their UTF-8 bytes (Node's
  // default input encoding), Buffers/typed arrays hash their bytes.
  const dataNode = updateCall.arguments[0]!;
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  if (dataIr?.kind === "bytes") {
    const data = lowerer.lowerExpr(dataNode);
    const enc = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    return {
      kind: "libCall",
      fn: "crypto.hashDigestBytes",
      args: [alg, data, enc],
      type: STRING,
      loc,
    };
  }
  if (dataIr?.kind === "string") {
    const data = lowerer.lowerExprExpecting(dataNode, STRING);
    const enc = lowerer.lowerExprExpecting(call.arguments[0]!, STRING);
    return {
      kind: "libCall",
      fn: "crypto.hashDigestStr",
      args: [alg, data, enc],
      type: STRING,
      loc,
    };
  }
  return null;
}

function cryptoEncoding(lowerer: Lowerer, node: ts.Expression, use: string): IrExpr {
  const type = lowerer.typeOf(node);
  if (!type.isStringLiteralType() || (type.value !== "hex" && type.value !== "base64")) {
    lowerer.noLowering(
      `${use} with this encoding`,
      node,
      'the lowered output encodings are "hex" and "base64"',
    );
  }
  return lowerer.lowerExprExpecting(node, STRING);
}

function cryptoAlgorithm(lowerer: Lowerer, node: ts.Expression, use: string): IrExpr {
  const type = lowerer.typeOf(node);
  if (
    type.isStringLiteralType() &&
    !["md5", "sha1", "sha224", "sha256", "sha384", "sha512"].includes(type.value.toLowerCase())
  ) {
    lowerer.noLowering(
      `${use} with algorithm '${type.value}'`,
      node,
      "md5, sha1, sha224, sha256, sha384, and sha512 are the lowered digest algorithms",
    );
  }
  return lowerer.lowerExprExpecting(node, STRING);
}

function cryptoKdfInput(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  const type = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (type?.kind === "string" || (type?.kind === "bytes" && type.elem === "u8"))
    return lowerBuiltinByteInput(lowerer, node, loc, "crypto");
  const symbol = lowerer.typeOf(node).getSymbol();
  if (
    type?.kind === "bytes" ||
    (symbol?.name === "ArrayBuffer" && lowerer.isStdlibSymbol(symbol))
  ) {
    const value = lowerer.coerceInto(node, lowerer.lowerExpr(node), DYN);
    return { kind: "libCall", fn: "bytes.bufferSource", args: [value], type: BYTES_U8, loc };
  }
  lowerer.noLowering(
    "crypto key derivation with this input",
    node,
    "strings, Buffers, numeric typed arrays, DataViews, and fixed-length ArrayBuffers are supported; KeyObjects are not yet lowered",
  );
}

export function lowerCryptoModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "crypto") return null;
  const args = expr.arguments;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`crypto.${bi.member} with spread arguments`, expr);
  }
  if (bi.member === "randomBytes") {
    if (args.length === 1) return null;
    if (args.length !== 2) {
      lowerer.noLowering(
        `crypto.randomBytes with ${args.length} arguments`,
        expr,
        "randomBytes(size) and randomBytes(size, callback) are supported",
      );
    }
    return {
      kind: "libCall",
      fn: "crypto.randomBytesCb",
      args: [
        lowerer.lowerExprExpecting(args[0]!, F64),
        errorFirstBytesCallback(lowerer, args[1]!, "crypto"),
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "pbkdf2") {
    if (args.length !== 6) {
      lowerer.noLowering(
        `crypto.pbkdf2 with ${args.length} arguments`,
        expr,
        "pbkdf2(password, salt, iterations, keylen, digest, callback) is supported",
      );
    }
    return {
      kind: "libCall",
      fn: "crypto.pbkdf2Cb",
      args: [
        lowerBuiltinByteInput(lowerer, args[0]!, locOf(args[0]!), "crypto"),
        lowerBuiltinByteInput(lowerer, args[1]!, locOf(args[1]!), "crypto"),
        lowerer.lowerExprExpecting(args[2]!, F64),
        lowerer.lowerExprExpecting(args[3]!, F64),
        cryptoAlgorithm(lowerer, args[4]!, "crypto.pbkdf2"),
        errorFirstBytesCallback(lowerer, args[5]!, "crypto"),
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "hkdf" || bi.member === "hkdfSync") {
    const async = bi.member === "hkdf";
    if (args.length !== (async ? 6 : 5))
      lowerer.noLowering(`crypto.${bi.member} with ${args.length} arguments`, expr);
    const values = [
      cryptoAlgorithm(lowerer, args[0]!, `crypto.${bi.member}`),
      cryptoKdfInput(lowerer, args[1]!),
      cryptoKdfInput(lowerer, args[2]!),
      cryptoKdfInput(lowerer, args[3]!),
      lowerer.lowerExprExpecting(args[4]!, F64),
    ];
    if (async) values.push(errorFirstBytesCallback(lowerer, args[5]!, "crypto.hkdf", true));
    return {
      kind: "libCall",
      fn: async ? "crypto.hkdfCb" : "crypto.hkdf",
      args: values,
      type: async ? VOID : DYN,
      loc,
    };
  }
  if (bi.member === "scrypt" || bi.member === "scryptSync") {
    const async = bi.member === "scrypt";
    const minimum = async ? 4 : 3;
    if (args.length < minimum || args.length > minimum + 1)
      lowerer.noLowering(`crypto.${bi.member} with ${args.length} arguments`, expr);
    const values = [
      cryptoKdfInput(lowerer, args[0]!),
      cryptoKdfInput(lowerer, args[1]!),
      lowerer.lowerExprExpecting(args[2]!, F64),
    ];
    const options = args.length > minimum ? args[3]! : undefined;
    values.push(
      options
        ? lowerer.coerceInto(options, lowerer.lowerExpr(options), DYN)
        : dynUndefinedExpr(loc),
    );
    if (async)
      values.push(errorFirstBytesCallback(lowerer, args[args.length - 1]!, "crypto.scrypt"));
    return {
      kind: "libCall",
      fn: async ? "crypto.scryptCb" : "crypto.scrypt",
      args: values,
      type: async ? VOID : BYTES_U8,
      loc,
    };
  }
  if (bi.member === "createHash") {
    if (args.length !== 1) {
      lowerer.noLowering(
        `crypto.createHash with ${args.length} arguments`,
        expr,
        "createHash(algorithm) is supported; options are not yet lowered",
      );
    }
    return {
      kind: "libCall",
      fn: "crypto.hashNew",
      args: [cryptoAlgorithm(lowerer, args[0]!, "crypto.createHash")],
      type: CRYPTOHASH_T,
      loc,
    };
  }
  if (bi.member === "createHmac") {
    if (args.length !== 2) {
      lowerer.noLowering(
        `crypto.createHmac with ${args.length} arguments`,
        expr,
        "createHmac(algorithm, stringOrBufferKey) is supported; options and KeyObject keys are not yet lowered",
      );
    }
    const algorithm = cryptoAlgorithm(lowerer, args[0]!, "crypto.createHmac");
    const key = lowerer.lowerExpr(args[1]!);
    if (key.type.kind === "string") {
      return {
        kind: "libCall",
        fn: "crypto.hmacNewStr",
        args: [algorithm, key],
        type: CRYPTOHMAC_T,
        loc,
      };
    }
    if (key.type.kind === "bytes" && key.type.elem === "u8") {
      return {
        kind: "libCall",
        fn: "crypto.hmacNewBytes",
        args: [algorithm, key],
        type: CRYPTOHMAC_T,
        loc,
      };
    }
    lowerer.noLowering(
      `crypto.createHmac with a '${lowerer.fmt(key.type)}' key`,
      args[1]!,
      "string and Buffer/Uint8Array keys are supported",
    );
  }
  if (bi.member === "hash") {
    if (args.length < 2 || args.length > 3) {
      lowerer.noLowering(
        `crypto.hash with ${args.length} arguments`,
        expr,
        'hash(algorithm, stringOrBuffer[, "hex" | "base64"]) is supported',
      );
    }
    const algorithm = cryptoAlgorithm(lowerer, args[0]!, "crypto.hash");
    const data = lowerer.lowerExpr(args[1]!);
    const encoding = args[2]
      ? cryptoEncoding(lowerer, args[2]!, "crypto.hash")
      : ({ kind: "strLit", value: "hex", type: STRING, loc } satisfies IrExpr);
    if (data.type.kind === "string") {
      return {
        kind: "libCall",
        fn: "crypto.hashDigestStr",
        args: [algorithm, data, encoding],
        type: STRING,
        loc,
      };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      return {
        kind: "libCall",
        fn: "crypto.hashDigestBytes",
        args: [algorithm, data, encoding],
        type: STRING,
        loc,
      };
    }
    lowerer.noLowering(
      `crypto.hash of '${lowerer.fmt(data.type)}' data`,
      args[1]!,
      "string and Buffer/Uint8Array data are supported",
    );
  }
  if (bi.member === "timingSafeEqual") {
    if (args.length !== 2)
      lowerer.noLowering(`crypto.timingSafeEqual with ${args.length} arguments`, expr);
    return {
      kind: "libCall",
      fn: "crypto.timingSafeEqual",
      args: [
        lowerer.lowerExprExpecting(args[0]!, BYTES_U8),
        lowerer.lowerExprExpecting(args[1]!, BYTES_U8),
      ],
      type: BOOL,
      loc,
    };
  }
  if (bi.member === "randomFillSync") {
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `crypto.randomFillSync with ${args.length} arguments`,
        expr,
        "randomFillSync(buffer[, offset[, size]]) is supported",
      );
    }
    const buffer = lowerer.lowerExprExpecting(args[0]!, BYTES_U8);
    const offset = args[1]
      ? lowerer.lowerExprExpecting(args[1]!, F64)
      : ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr);
    if (args[2]) {
      const size = lowerer.lowerExprExpecting(args[2]!, F64);
      return {
        kind: "libCall",
        fn: "crypto.randomFill",
        args: [buffer, offset, size],
        type: BYTES_U8,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "crypto.randomFillRest",
      args: [buffer, offset],
      type: BYTES_U8,
      loc,
    };
  }
  if (bi.member === "randomInt") {
    if (args.length !== 1 && args.length !== 2) {
      lowerer.noLowering(
        `crypto.randomInt with ${args.length} arguments`,
        expr,
        "the synchronous randomInt(max) and randomInt(min, max) forms are supported",
      );
    }
    const min =
      args.length === 1
        ? ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr)
        : lowerer.lowerExprExpecting(args[0]!, F64);
    const max = lowerer.lowerExprExpecting(args[args.length - 1]!, F64);
    return { kind: "libCall", fn: "crypto.randomInt", args: [min, max], type: F64, loc };
  }
  if (bi.member === "pbkdf2Sync") {
    if (args.length !== 5) {
      lowerer.noLowering(
        `crypto.pbkdf2Sync with ${args.length} arguments`,
        expr,
        "pbkdf2Sync(password, salt, iterations, keylen, digest) is supported",
      );
    }
    const password = lowerBuiltinByteInput(lowerer, args[0]!, locOf(args[0]!), "crypto");
    const salt = lowerBuiltinByteInput(lowerer, args[1]!, locOf(args[1]!), "crypto");
    return {
      kind: "libCall",
      fn: "crypto.pbkdf2",
      args: [
        password,
        salt,
        lowerer.lowerExprExpecting(args[2]!, F64),
        lowerer.lowerExprExpecting(args[3]!, F64),
        cryptoAlgorithm(lowerer, args[4]!, "crypto.pbkdf2Sync"),
      ],
      type: BYTES_U8,
      loc,
    };
  }
  const LISTS: Record<string, readonly string[] | undefined> = {
    getCiphers: CRYPTO_CIPHERS,
    getHashes: CRYPTO_HASHES,
    getCurves: CRYPTO_CURVES,
  };
  const list = own(LISTS, bi.member);
  if (bi.member !== "getFips" && list === undefined) return null;
  if (expr.arguments.length !== 0) {
    lowerer.noLowering(`crypto.${bi.member} with ${expr.arguments.length} arguments`, expr);
  }
  if (bi.member === "getFips") {
    return { kind: "numLit", value: 0, type: F64, loc };
  }
  return {
    kind: "arrayLit",
    elems: list!.map((s): IrExpr => ({ kind: "strLit", value: s, type: STRING, loc })),
    type: arrayOf(STRING),
    loc,
  };
}

/** Calls on native crypto.Hash/Hmac handles. The handle survives locals,
 * aliases, loops, and returns; update() retains and returns the receiver,
 * digest() finalizes it, and Hash.copy() snapshots the incremental state. */
export function lowerCryptoHashMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverType?.kind !== "cryptoHash" && receiverType?.kind !== "cryptoHmac") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, receiverType);
  if (name === "update") {
    if (
      call.arguments.length < 1 ||
      call.arguments.length > 2 ||
      call.arguments.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `${receiverType.kind === "cryptoHash" ? "Hash" : "Hmac"}.update with ${call.arguments.length} arguments`,
        call,
        "update(stringOrBuffer[, inputEncoding]) is supported",
      );
    }
    const dataNode = call.arguments[0]!;
    const dataType = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
    // Indexed reads can retain optional storage after a nullish fallback
    // or narrowing. Use the proven argument type through a checked coercion.
    const data =
      dataType?.kind === "string" || dataType?.kind === "bytes"
        ? lowerer.lowerExprExpecting(dataNode, dataType)
        : lowerer.lowerExpr(dataNode);
    const prefix = receiverType.kind === "cryptoHash" ? "crypto.hashUpdate" : "crypto.hmacUpdate";
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      if (call.arguments.length !== 1) {
        lowerer.noLowering(
          "Hash/Hmac.update with an encoding for Buffer data",
          call.arguments[1]!,
          "input encodings apply only to string data",
        );
      }
      return {
        kind: "libCall",
        fn: `${prefix}Bytes` as IrLibFn,
        args: [receiver(), data],
        type: receiverType,
        loc,
      };
    }
    if (data.type.kind === "string") {
      const encodingNode = call.arguments[1];
      if (encodingNode === undefined) {
        return {
          kind: "libCall",
          fn: `${prefix}Str` as IrLibFn,
          args: [receiver(), data],
          type: receiverType,
          loc,
        };
      }
      const encodingType = lowerer.typeOf(encodingNode);
      if (
        !encodingType.isStringLiteralType() ||
        !["utf8", "utf-8", "hex", "base64"].includes(encodingType.value)
      ) {
        lowerer.noLowering(
          "Hash/Hmac.update with this input encoding",
          encodingNode,
          "utf8, hex, and base64 string inputs are supported",
        );
      }
      if (encodingType.value === "utf8" || encodingType.value === "utf-8") {
        lowerer.lowerExprExpecting(encodingNode, STRING);
        return {
          kind: "libCall",
          fn: `${prefix}Str` as IrLibFn,
          args: [receiver(), data],
          type: receiverType,
          loc,
        };
      }
      const encoded: IrExpr = {
        kind: "libCall",
        fn: "buffer.fromStr",
        args: [data, lowerer.lowerExprExpecting(encodingNode, STRING)],
        type: BYTES_U8,
        loc,
      };
      return {
        kind: "libCall",
        fn: `${prefix}Bytes` as IrLibFn,
        args: [receiver(), encoded],
        type: receiverType,
        loc,
      };
    }
    lowerer.noLowering(
      `Hash/Hmac.update of '${lowerer.fmt(data.type)}' values`,
      dataNode,
      "string and Buffer/Uint8Array inputs are supported",
    );
  }
  if (name === "digest") {
    if (call.arguments.length > 1 || call.arguments.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `${receiverType.kind === "cryptoHash" ? "Hash" : "Hmac"}.digest with ${call.arguments.length} arguments`,
        call,
        'digest() and digest("hex" | "base64") are supported',
      );
    }
    if (call.arguments.length === 0) {
      return {
        kind: "libCall",
        fn:
          receiverType.kind === "cryptoHash"
            ? "crypto.hashDigestBuffer"
            : "crypto.hmacDigestBuffer",
        args: [receiver()],
        type: BYTES_U8,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn:
        receiverType.kind === "cryptoHash" ? "crypto.hashDigestString" : "crypto.hmacDigestString",
      args: [
        receiver(),
        cryptoEncoding(
          lowerer,
          call.arguments[0]!,
          `${receiverType.kind === "cryptoHash" ? "Hash" : "Hmac"}.digest`,
        ),
      ],
      type: STRING,
      loc,
    };
  }
  if (name === "copy" && receiverType.kind === "cryptoHash") {
    if (call.arguments.length !== 0)
      lowerer.noLowering(
        `Hash.copy with ${call.arguments.length} arguments`,
        call,
        "copy() without options is supported",
      );
    return { kind: "libCall", fn: "crypto.hashCopy", args: [receiver()], type: CRYPTOHASH_T, loc };
  }
  lowerer.noLowering(
    `${receiverType.kind === "cryptoHash" ? "Hash" : "Hmac"}.${name}`,
    call,
    receiverType.kind === "cryptoHash"
      ? "update(), digest(), and copy() are supported"
      : "update() and digest() are supported",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}
