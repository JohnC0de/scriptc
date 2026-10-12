/* Contract types (@scriptc/types): written annotations scriptc checks as
 * extra contracts. The package is types only (`export type` aliases that
 * TypeScript erases), so Node.js never loads it; scriptc recognizes the
 * aliases by import provenance, like threads-import.ts recognizes the
 * @scriptc/threads exports. TypeScript drops alias identity from inferred
 * types, so only annotations the program WRITES count: parameter, return,
 * variable and class field types. The IR-side checks live in
 * ir/contract-check.ts. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { locOf } from "./program.js";
import * as ts from "./ts7/adapter.js";

export const CONTRACT_TYPES_MODULE = "@scriptc/types";

export type ContractMarker = "Int32" | "NoThrow" | "Immutable";
const MARKERS: ReadonlySet<string> = new Set(["Int32", "NoThrow", "Immutable"]);

/** One written contract: what it promises and where the annotation is. */
export interface ContractNote {
  marker: ContractMarker;
  /** The annotation (the marker's type reference). */
  loc: SrcLoc;
  /** The annotated declaration's name, for messages. */
  name: string;
}

/** Contracts keyed by the declaration they annotate. Keys are SrcLoc keys
 * (contractLocKey) of the nodes the lowering stamps on the IR: function
 * declarations (IrFunction.loc), binding names (IrLocal/IrGlobal
 * source.loc), and classes (IrClassDef.loc) plus the field name. */
export interface ContractAnnotations {
  /** NoThrow and result markers (Int32, Immutable) by function. */
  functions: Map<string, ContractNote[]>;
  /** Parameters and variables by their name's location. */
  bindings: Map<string, ContractNote>;
  /** Instance fields by `${class key}\0${field name}`. */
  fields: Map<string, ContractNote>;
  diagnostics: ScrDiagnostic[];
  /** Number of annotations found (for timing and tests). */
  count: number;
}

export function contractLocKey(loc: SrcLoc): string {
  return `${loc.file}\0${loc.start}\0${loc.end}`;
}

/** The marker a type reference names when its name is a named or namespace
 * import binding of @scriptc/types (`import type { Int32 } from
 * "@scriptc/types"`, `import type * as sc from "@scriptc/types"`). */
function markerOf(checker: ts.TypeChecker, ref: ts.TypeReferenceNode): ContractMarker | null {
  const name = ref.typeName;
  let ident: ts.Identifier;
  let member: string;
  if (ts.isIdentifier(name)) {
    if (!MARKERS.has(name.text)) return null;
    ident = name;
    member = name.text;
  } else if (ts.isQualifiedName(name) && ts.isIdentifier(name.left)) {
    if (!MARKERS.has(name.right.text)) return null;
    ident = name.left;
    member = name.right.text;
  } else return null;
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? checker.declarationsOf(symbol)[0] : undefined;
  if (decl === undefined) return null;
  let importDecl: ts.Node | undefined;
  if (ts.isImportSpecifier(decl) && ident === name) {
    importDecl = decl.parent?.parent?.parent;
    member = decl.propertyName?.text ?? decl.name.text;
  } else if (ts.isNamespaceImport(decl) && ident !== name) importDecl = decl.parent?.parent;
  else return null;
  if (
    importDecl === undefined ||
    !ts.isImportDeclaration(importDecl) ||
    !ts.isStringLiteral(importDecl.moduleSpecifier) ||
    importDecl.moduleSpecifier.text !== CONTRACT_TYPES_MODULE
  )
    return null;
  return MARKERS.has(member) ? (member as ContractMarker) : null;
}

function nameText(node: ts.Node | undefined): string {
  if (node === undefined) return "<anonymous>";
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  return node.getText();
}

function contractDiag(
  code: `SC${number}`,
  loc: SrcLoc,
  message: string,
  hint: string,
): ScrDiagnostic {
  return { code, loc, message, hint };
}

/** Collect every contract annotation in the program's own TypeScript
 * modules. Files that do not mention the package cannot import a marker
 * (re-exports are not followed), so they are skipped without a walk. */
export function collectContractAnnotations(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
): ContractAnnotations {
  const out: ContractAnnotations = {
    functions: new Map(),
    bindings: new Map(),
    fields: new Map(),
    diagnostics: [],
    count: 0,
  };
  const kinds = new Set<ts.SyntaxKind>([ts.SyntaxKind.TypeReference]);
  for (const sf of files) {
    if (sf.isDeclarationFile || !sf.text.includes(CONTRACT_TYPES_MODULE)) continue;
    ts.walkPreorder(
      sf,
      (node) => {
        if (!ts.isTypeReferenceNode(node)) return;
        const marker = markerOf(checker, node);
        if (marker === null) return;
        out.count++;
        place(out, checker, node, marker);
      },
      kinds,
    );
  }
  return out;
}

function unsupported(out: ContractAnnotations, node: ts.Node, marker: ContractMarker): void {
  const where =
    marker === "NoThrow"
      ? "NoThrow wraps a function's written return type"
      : marker === "Int32"
        ? "Int32 is checked on parameters, variables, class instance fields and function results"
        : "Immutable is checked on parameters, variables, class instance fields and function results";
  out.diagnostics.push(
    contractDiag(
      "SC7006",
      locOf(node),
      `the ${marker} contract is not checked in this position (${where})`,
      marker === "NoThrow"
        ? "write it as the function's return type annotation: function f(): NoThrow<T>"
        : `write ${marker} directly as the annotation of the declaration; type aliases, interface members and types nested in other types (arrays, unions, type arguments) are not followed`,
    ),
  );
}

function place(
  out: ContractAnnotations,
  checker: ts.TypeChecker,
  ref: ts.TypeReferenceNode,
  marker: ContractMarker,
): void {
  let node: ts.Node = ref;
  let parent = ref.parent;
  // NoThrow<Int32> / NoThrow<Immutable<T>>: the inner marker is the result
  // contract of the function the NoThrow annotates.
  if (marker !== "NoThrow" && parent !== undefined && ts.isTypeReferenceNode(parent)) {
    const wrapper = markerOf(checker, parent);
    if (wrapper === "NoThrow" && parent.typeArguments?.[0] === ref) {
      node = parent;
      parent = parent.parent;
    }
  }
  const note = (name: string): ContractNote => ({ marker, loc: locOf(ref), name });
  if (parent === undefined) return unsupported(out, ref, marker);
  if (ts.isFunctionLike(parent) && parent.type === node) {
    if (!ts.isFunctionLikeDeclaration(parent)) return unsupported(out, ref, marker);
    const key = contractLocKey(locOf(parent));
    const list = out.functions.get(key) ?? [];
    list.push(note(ts.isConstructorDeclaration(parent) ? "constructor" : nameText(parent.name)));
    out.functions.set(key, list);
    return;
  }
  if (marker === "NoThrow") return unsupported(out, ref, marker);
  if (
    (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) &&
    parent.type === node &&
    ts.isIdentifier(parent.name)
  ) {
    out.bindings.set(contractLocKey(locOf(parent.name)), note(parent.name.text));
    return;
  }
  if (ts.isPropertyDeclaration(parent) && parent.type === node) {
    const cls = parent.parent;
    const isStatic =
      ts.getModifiers(parent)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
    if (
      !isStatic &&
      cls !== undefined &&
      (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) &&
      (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
    ) {
      out.fields.set(
        `${contractLocKey(locOf(cls))}\0${parent.name.text}`,
        note(`${nameText(cls.name)}.${parent.name.text}`),
      );
      return;
    }
  }
  unsupported(out, ref, marker);
}
