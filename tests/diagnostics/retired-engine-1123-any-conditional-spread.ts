// The conditional-spread idiom inside `any`-typed object literals:
// `{ a, ...(c ? { k: v } : {}) }` builds one of two engine literals behind
// the test, so the key is truly ABSENT when the empty arm is taken —
// engine-exact (`typeof o.k` answers "undefined", JSON drops it), with the
// shared properties evaluating exactly once.

function opts(aspect: string | undefined): any {
  const o: any = {
    mode: "M",
    ...(aspect ? { cfg: { aspect } } : {}),
  };
  return o;
}
const a = opts("1:1");
console.log(`${a.mode} ${a.cfg.aspect} ${typeof a.cfg}`);
const b = opts(undefined);
console.log(`${b.mode} ${typeof b.cfg}`);

// Multi-property carrier arms are fine in the island form.
function multi(on: boolean): any {
  return { base: 1, ...(on ? { x: "X", y: "Y" } : {}) };
}
const m1 = multi(true);
const m2 = multi(false);
console.log(`${m1.base} ${m1.x} ${m1.y}`);
console.log(`${m2.base} ${typeof m2.x} ${typeof m2.y}`);

// Reversed orientation and string-literal keys.
function rev(quiet: boolean): any {
  return { kind: "r", ...(quiet ? {} : { "log-level": "loud" }) };
}
console.log(`${rev(false)["log-level"]}`);
console.log(`${typeof rev(true)["log-level"]}`);

// The spread mid-literal: properties around it evaluate exactly once and
// land in engine key order.
let sides = 0;
function side(v: number): number {
  sides++;
  return v;
}
function ordered(flag: boolean): any {
  const o: any = { first: side(1), ...(flag ? { mid: 2 } : {}), last: side(3) };
  return o;
}
const o1 = ordered(true);
const o2 = ordered(false);
console.log(`${o1.first} ${o1.mid} ${o1.last}`);
console.log(`${o2.first} ${typeof o2.mid} ${o2.last} ${sides}`);
