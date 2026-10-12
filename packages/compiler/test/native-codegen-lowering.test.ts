import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function diagnostics(source: string) {
  const dir = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-native-lowering-"),
  );
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed).toBe(false);
    return coverage.diagnostics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const options of [
  "{ level: 10 }",
  "{ level: -2 }",
  "{ level: 1.5 }",
  "{ level: Number.NaN }",
  "{ level }",
  "{ level: 9, strategy: 1 }",
  "{ level: 9, windowBits: 15 }",
  "{ ...{ level: 9 } }",
  "{ ['level']: 9 }",
]) {
  test(`static zlib refuses unmodeled options ${options}`, () => {
    const diags = diagnostics(`
      import { deflateRawSync } from "node:zlib";
      const level = 9;
      console.log(deflateRawSync("payload", ${options}).length);
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("SC2020");
    expect(diags[0]!.message).toContain("deflateRawSync with these options");
    expect(diags[0]!.hint).toContain("integer literal from -1 through 9");
  });
}

test("compression-level support does not silently accept decompression options", () => {
  const diags = diagnostics(`
    import { inflateRawSync } from "node:zlib";
    console.log(inflateRawSync(Buffer.from([3, 0]), { windowBits: 15 }).length);
  `);
  expect(diags).toHaveLength(1);
  expect(diags[0]!.code).toBe("SC2020");
  expect(diags[0]!.message).toContain("inflateRawSync with explicit options");
});

test("union writes keep the refusal for incompatible field storage", () => {
  const diags = diagnostics(`
    type Value = { kind: "text"; value: string } | { kind: "number"; value: number };
    function write(value: Value): void { value.value = "changed"; }
    write({ kind: "number", value: 1 });
  `);
  expect(diags).toHaveLength(1);
  expect(diags[0]!.code).toBe("SC1090");
  expect(diags[0]!.message).toContain("assignment to non-variables");
});

test("ordinary scalar union switches stay static", () => {
  const diags = diagnostics(`
    function choose(value: string | number): void {
      switch (value) {
        case "text": break;
        case 1: break;
      }
    }
    choose("text");
  `);
  // Ordinary scalar unions remain entirely static after control-flow changes.
  expect(diags).toEqual([]);
});
