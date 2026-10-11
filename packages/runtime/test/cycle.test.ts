import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;

async function buildTestCycle(name: string, flags: string[]): Promise<string> {
  const buildDir = join(testDir, "build");
  await mkdir(buildDir, { recursive: true });
  const bin = join(buildDir, name);
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    ...flags,
    "-o",
    bin,
    join(testDir, "test_cycle.c"),
    join(testDir, "../src/scr_cycle.c"),
    join(testDir, "../src/scr_alloc.c"),
  ]);
  return bin;
}

function cycleEnv(settings: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
    UBSAN_OPTIONS: "halt_on_error=1",
    TSAN_OPTIONS: "halt_on_error=1",
  };
  for (const name of [
    "SCR_CYCLE_THRESHOLD",
    "SCR_CYCLE_GROWTH_CAP",
    "SCR_CYCLE_PARALLEL",
    "SCR_CYCLE_PARALLEL_MIN",
  ]) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(settings)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// Speed-flavor executables (SCR_SPEED) run large full passes on helper
// threads; these builds force every full pass parallel with
// SCR_CYCLE_PARALLEL_MIN=1, so the whole suite (random graphs included)
// checks the parallel phases against the sequential collector's answers.
// Helpers come from idle CPUs, so a single-CPU host walks sequentially.
const plainFlags = ["-pthread", ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : [])];
const parallelFlags = ["-DSCR_SPEED", ...plainFlags];
const workerFlags = ["-DSCR_WORKERS", ...parallelFlags];

test("cycle traversal preserves counts, deep graphs, configured thresholds and growth caps", async () => {
  const bin = await buildTestCycle("test_cycle", ["-fsanitize=address,undefined", ...plainFlags]);
  for (const [threshold, cap, expected] of [
    [undefined, undefined, "threshold=256 growth_cap=16"],
    ["1", undefined, "threshold=1 growth_cap=16"],
    ["2", undefined, "threshold=2 growth_cap=16"],
    ["7", undefined, "threshold=7 growth_cap=16"],
    [undefined, "1", "threshold=256 growth_cap=1"],
    ["1", "1", "threshold=1 growth_cap=1"],
    [undefined, "3", "threshold=256 growth_cap=2"],
    [undefined, "8", "threshold=256 growth_cap=8"],
    [undefined, "64", "threshold=256 growth_cap=16"],
  ] as const) {
    const env = cycleEnv({ SCR_CYCLE_THRESHOLD: threshold, SCR_CYCLE_GROWTH_CAP: cap });
    const run = await execFileAsync(bin, [], { env });
    expect(run.stdout).toBe(`cycle collection checks passed: ${expected}\n`);
  }
});

test("parallel full passes reach the sequential collector's results", async () => {
  // Speed executables carry the parallel walk with or without workers.
  const plain = await buildTestCycle("test_cycle_parallel", [
    "-fsanitize=address,undefined",
    ...parallelFlags,
  ]);
  const plainRun = await execFileAsync(plain, [], {
    env: cycleEnv({ SCR_CYCLE_PARALLEL: "3", SCR_CYCLE_PARALLEL_MIN: "1" }),
  });
  expect(plainRun.stdout).toBe("cycle collection checks passed: threshold=256 growth_cap=16\n");
  const bin = await buildTestCycle("test_cycle_workers", [
    "-fsanitize=address,undefined",
    ...workerFlags,
  ]);
  for (const [helpers, threshold] of [
    ["1", undefined],
    ["3", undefined],
    ["7", "1"],
    ["0", undefined],
  ] as const) {
    const env = cycleEnv({
      SCR_CYCLE_PARALLEL: helpers,
      SCR_CYCLE_PARALLEL_MIN: "1",
      SCR_CYCLE_THRESHOLD: threshold,
    });
    const run = await execFileAsync(bin, [], { env });
    expect(run.stdout).toBe(
      `cycle collection checks passed: threshold=${threshold ?? 256} growth_cap=16\n`,
    );
  }
}, 120_000);

test.skipIf(process.platform === "win32")(
  "parallel full passes are free of data races under ThreadSanitizer",
  async () => {
    const bin = await buildTestCycle("test_cycle_tsan", [
      "-g",
      "-fsanitize=thread",
      ...workerFlags,
    ]);
    for (const helpers of ["1", "3", "7"]) {
      const env = cycleEnv({ SCR_CYCLE_PARALLEL: helpers, SCR_CYCLE_PARALLEL_MIN: "1" });
      const run = await execFileAsync(bin, [], { env });
      expect(run.stderr).not.toContain("ThreadSanitizer");
      expect(run.stdout).toBe("cycle collection checks passed: threshold=256 growth_cap=16\n");
    }
  },
  300_000,
);
