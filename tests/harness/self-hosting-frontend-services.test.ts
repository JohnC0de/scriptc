import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, compile } from "@scriptc/compiler";
import { expect, test } from "vitest";
import { ts7Executable } from "../../packages/compiler/src/frontend/ts7/rpc-api.js";

const root = join(import.meta.dirname, "../..");
const entry = join(root, "tests/fixtures/self-hosting/frontend-services.ts");
const oracle = join(root, "tests/fixtures/self-hosting/frontend-services-node.ts");
const nativeSources = join(root, "packages/compiler/native");
const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const sanitize = process.env["SCRIPTC_SAN"] === "1";

function input(directory: string) {
  const packageDirectory = join(directory, "node_modules/service-fetch");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "service-fetch", main: "index.js" }),
  );
  writeFileSync(
    join(packageDirectory, "index.js"),
    'exports.request = globalThis.fetch; exports.leaf = require("./leaf.js"); exports.later = () => require("./missing.js");',
  );
  writeFileSync(join(packageDirectory, "leaf.js"), "exports.local = 1;");
  return {
    directory,
    declarations:
      "export class Box { value(): string; value(next: string): this; peer: Box | null; }",
    source: `export class Box {
      peer = null;
      constructor() { this.peer = new Box(); this.values = []; }
      value(next) { return next; }
      reset() { this.peer = null; }
      /** @returns {Box} */
      find() { return this.values.find(() => true); }
    }`,
    bundled: readFileSync(
      join(root, "tests/fixtures/npm-static/node_modules/bundled-function/index.js"),
      "utf8",
    ),
  };
}

for (const backend of ["llvm"] as const) {
  test(`owned frontend services run without Node (${backend})`, async () => {
    const directory = realpathSync(
      mkdtempSync(join(tempRoot, "scriptc-frontend-services-native-")),
    );
    try {
      const object = join(directory, "process.o");
      execFileSync("clang", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        ...(sanitize ? ["-fsanitize=address"] : []),
        "-c",
        join(nativeSources, "ts7-process.c"),
        "-o",
        object,
      ]);
      const profile = join(directory, "ffi.json");
      writeFileSync(
        profile,
        JSON.stringify({
          ...JSON.parse(readFileSync(join(nativeSources, "ts7-process.ffi.json"), "utf8")),
          libraries: [object],
        }),
      );
      const { coverage } = analyze(entry, { ffiProfilePath: profile });
      expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
      expect(coverage.stats.functionsSkipped).toBe(0);
      const built = await compile(entry, {
        backend,
        optimization: "dev",
        sanitize,
        ffiProfilePath: profile,
        outDir: directory,
        outPath: join(directory, process.platform === "win32" ? "parser.exe" : "parser"),
      });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const request = join(directory, "request.json");
      writeFileSync(request, JSON.stringify(input(directory)));
      const expected = join(directory, "node.json");
      const node = spawnSync(
        process.execPath,
        ["--import", "tsx", oracle, ts7Executable(), request, expected],
        { encoding: "utf8", timeout: 45_000 },
      );
      expect(node.error, node.stderr).toBeUndefined();
      expect(node.status, node.stderr).toBe(0);
      expect(node.stdout).toBe("");
      expect(node.stderr).toBe("");
      const report = join(directory, "native.json");
      const run = spawnSync(built.binaryPath, [ts7Executable(), request, report], {
        encoding: "utf8",
        timeout: 45_000,
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe(node.stdout);
      expect(run.stderr).toBe(node.stderr);
      const result = JSON.parse(readFileSync(report, "utf8"));
      expect(result).toEqual(JSON.parse(readFileSync(expected, "utf8")));
      expect(result.closed).toBe(true);
      expect(result.nullable).not.toBeNull();
      expect(result.overloads).not.toBeNull();
      expect(result.widened).not.toBeNull();
      expect(typeof result.rewritten).toBe("string");
      expect(result.resolved).toBe(join(directory, "node_modules/service-fetch/index.js"));
      expect(result.versions).toEqual(["export const original = 1;", "export const changed = 2;"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
