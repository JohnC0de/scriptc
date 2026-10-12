// Object/array literals in `any` slots build natively in the island;
// property reads/writes, computed keys, and method calls go through the
// engine (this-binding and coercions JS-exact).
const o: any = { a: 1, b: "x", nested: { deep: true } };
o.a = o.a + 10;
o["c"] = 2.5;
console.log(`${o.a} ${o.b} ${o.c}`, `${o.nested.deep}`, typeof o);
const arr: any = [1, "two", true];
arr[3] = o.a;
console.log(`${arr.length}`, `${arr[1]}`, `${arr[3]}`);
console.log(`${arr.join("|")}`);
const s: any = "hello world";
console.log(`${s.toUpperCase()}`, `${s.split(" ").length}`, `${s.charAt(4)}`);
const num: any = 3.14159;
console.log(`${num.toFixed(2)}`);
