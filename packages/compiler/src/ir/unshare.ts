import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { reparseExpr, reparseStmt } from "./serialize.js";
import { everyExprChild, everyStmtChild, mapExprChildren, mapStmtChildren } from "./traverse.js";

/** Give every occurrence of an executable node its own object.
 *
 * Lowering helpers may place one node at several sites (a binding's varRef
 * read in a loop condition and in its body, a shared `break`). Analyses key
 * their facts by node identity (integer ranges, int32 write proofs, borrow
 * and lifetime facts), so a shared node carries one fact for all of its
 * sites: integer ranges keep the join, which loses what one site proves. A
 * serialized module gives every occurrence its own node; this makes the
 * in-memory module equivalent, so analyses and emission behave the same on
 * a module lowered in memory and on one read back from its artifact.
 * Functions without a repeated node are kept as they are; the input is
 * never mutated. */
export function unshareNodes(mod: IrModule): IrModule {
  const seen = new Set<IrExpr | IrStmt>();
  const repeated = new Set<IrExpr | IrStmt>();
  const affected = new Set<IrFunction>();
  let current: IrFunction | null = null;
  // A repeated node marks the function holding the later occurrence. Its
  // subtree is walked again, so every node under it is repeated as well.
  const visit = (node: IrExpr | IrStmt): void => {
    if (!seen.has(node)) seen.add(node);
    else {
      repeated.add(node);
      affected.add(current!);
    }
  };
  const findExpr = (node: IrExpr): boolean => {
    visit(node);
    return everyExprChild(node, findExpr, findStmt);
  };
  const findStmt = (node: IrStmt): boolean => {
    visit(node);
    return everyStmtChild(node, findExpr, findStmt);
  };
  for (const fn of mod.functions) {
    current = fn;
    for (const node of fn.body) findStmt(node);
  }
  if (affected.size === 0) return mod;
  // Rebuilding a function copies every node that has children; a repeated
  // childless node reads back as a fresh object at each of its sites there.
  const expr = (node: IrExpr): IrExpr => {
    const copy = mapExprChildren(node, expr, stmt);
    return copy !== node || !repeated.has(node) ? copy : reparseExpr(node);
  };
  const stmt = (node: IrStmt): IrStmt => {
    const copy = mapStmtChildren(node, expr, stmt);
    return copy !== node || !repeated.has(node) ? copy : reparseStmt(node);
  };
  return {
    ...mod,
    functions: mod.functions.map((fn) =>
      affected.has(fn) ? { ...fn, body: fn.body.map(stmt) } : fn,
    ),
  };
}
