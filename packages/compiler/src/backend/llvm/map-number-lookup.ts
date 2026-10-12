/* Inline number-key Map/Set reads.
 *
 * Number-keyed collections whose keys are small non-negative integers keep a
 * direct index in the runtime (scr_map.c). Reads go through the internal
 * sc_map_entry_f64 helper (emitter.ts helperDefs), which LLVM inlines: it
 * resolves directly indexed maps without a call and defers to
 * scr_map_entry_f64 otherwise. The generated code then reads the entry's
 * value slot itself and retains a reference value with the value type's own
 * retain, which is the adapter the collection was constructed with.
 * String-keyed reads use the same entry contract through the internal
 * sc_map_entry_str helper, which rejects keys outside the map's absent-key
 * filter inline and defers to scr_map_entry_str otherwise: reference reads
 * retain inline rather than through the runtime's indirect adapter call,
 * and scalar reads and has() share the one lookup.
 */
import type { IrType } from "../../ir/ir.js";
import type { LlvmEmitterContext } from "./expr-context.js";

export const NUMBER_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_f64(ptr, double)";

/** The entry for `key`, or null when absent. Valid until the next mutation. */
export function emitNumberMapEntry(host: LlvmEmitterContext, map: string, key: string): string {
  host.declare(NUMBER_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_entry_f64(ptr ${map}, double ${key})`);
  return entry;
}

/** Load a found entry's value slot as `type` (double, i64 or ptr). */
export function emitNumberMapSlot(host: LlvmEmitterContext, entry: string, type: string): string {
  const B = host.B;
  const slot = B.tmp(),
    value = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrMapEntry, ptr ${entry}, i32 0, i32 1`);
  B.line(`${value} = load ${type}, ptr ${slot}`);
  return value;
}

export const STRING_MAP_ENTRY_DECL = "declare ptr @scr_map_entry_str(ptr, ptr)";

/** The entry for a string `key`, or null when absent. Valid until the next mutation. */
export function emitStringMapEntry(host: LlvmEmitterContext, map: string, key: string): string {
  host.declare(STRING_MAP_ENTRY_DECL);
  const entry = host.B.tmp();
  host.B.line(`${entry} = call ptr @sc_map_entry_str(ptr ${map}, ptr ${key})`);
  return entry;
}

/** Map.has / Set.has under a string key. */
export function emitStringMapHas(host: LlvmEmitterContext, map: string, key: string): string {
  const entry = emitStringMapEntry(host, map, key);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}

/** Map.get of a scalar value under a string key; see emitNumberMapGetScalar. */
export function emitStringMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string } {
  return emitMapEntryGetScalar(host, emitStringMapEntry(host, map, key));
}

/** Map.get of a reference value: a +1 value, or null when absent — the
 * contract of scr_map_get_f64_ref. */
export function emitNumberMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
): string {
  return emitMapEntryGetRef(host, emitNumberMapEntry(host, map, key), value);
}

/** Map.get of a reference value under a string key, with scr_map_get_str_ref's
 * contract. The value type's own retain replaces the collection's adapter, so
 * the retain is inline instead of an indirect call in the runtime. */
export function emitStringMapGetRef(
  host: LlvmEmitterContext,
  map: string,
  key: string,
  value: IrType,
): string {
  return emitMapEntryGetRef(host, emitStringMapEntry(host, map, key), value);
}

/** The +1 value of a found entry, or null for a missing (null) entry. */
function emitMapEntryGetRef(host: LlvmEmitterContext, entry: string, value: IrType): string {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const retained = host.retainValue(emitNumberMapSlot(host, entry, "ptr"), value);
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ptr [ ${retained}, %${hit} ], [ null, %${miss} ]`);
  return result;
}

/** Map.get of a scalar value: the found flag, and the raw 64-bit slot
 * (zero when absent). Booleans are stored as 0/1. */
export function emitNumberMapGetScalar(
  host: LlvmEmitterContext,
  map: string,
  key: string,
): { found: string; bits: string } {
  return emitMapEntryGetScalar(host, emitNumberMapEntry(host, map, key));
}

/** The found flag and raw 64-bit slot (zero when absent) of an entry. */
function emitMapEntryGetScalar(
  host: LlvmEmitterContext,
  entry: string,
): { found: string; bits: string } {
  const B = host.B;
  const found = B.tmp();
  B.line(`${found} = icmp ne ptr ${entry}, null`);
  const hit = B.newLabel("mapn.hit"),
    miss = B.newLabel("mapn.miss"),
    join = B.newLabel("mapn.join");
  B.condBr(found, hit, miss);
  B.startBlock(hit);
  const loaded = emitNumberMapSlot(host, entry, "i64");
  B.br(join);
  B.startBlock(miss);
  B.br(join);
  B.startBlock(join);
  const bits = B.tmp();
  B.line(`${bits} = phi i64 [ ${loaded}, %${hit} ], [ 0, %${miss} ]`);
  return { found, bits };
}

/** Map.has / Set.has. */
export function emitNumberMapHas(host: LlvmEmitterContext, map: string, key: string): string {
  const entry = emitNumberMapEntry(host, map, key);
  const found = host.B.tmp();
  host.B.line(`${found} = icmp ne ptr ${entry}, null`);
  return found;
}
