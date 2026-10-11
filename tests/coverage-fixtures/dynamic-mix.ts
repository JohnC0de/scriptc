// Native checked values and loose equality share this program with
// island-backed APIs (SC2012) with native compilation refusals.
const v: any = 21;
const doubled = v * 2;
const root = Math.cbrt(81);
const up = (19.99).toPrecision(3);
const parsed = Number.parseFloat("1.5"); // the global's string form is static now; the Number static keeps the island
const unknownScore: unknown = 81;
const flags = unknownScore == 81;
console.log("done");
