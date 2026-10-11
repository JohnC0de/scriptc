/** Per-compilation conversion state. Recursive plans are scoped to the
 * active planning stack; only fully validated copy routes are memoized. */
export class CoercionState {
  // Re-entering a recursive pair assumes it is coercible while the outer
  // plan checks its other fields. Remove every assumption on unwind;
  // generated helpers must intern their names before building their bodies.
  readonly planning = new Set<string>();
  // Registry revisions invalidate only fully validated copy-only routes.
  readonly copyRetags = new Map<string, { name: string; shapes: number; unions: number }>();
  // Provenance for checked extraction; consumers must not infer it from names.
  readonly checkedNarrows = new Set<string>();
  readonly retags = new Map<string, string>();
  readonly narrows = new Map<string, string>();
}
