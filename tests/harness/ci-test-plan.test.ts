import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  ciTestPlan,
  corpusFiles,
  darwinCorpusFiles,
  darwinFiles,
  effectFiles,
  fileExclusions,
} from "../../scripts/ci-test-plan.mjs";
import { runCiTestPlan } from "../../scripts/ci-test.mjs";

test.for([1, 3, 5, 10])(
  "CI retains every suite with %i shards without mixing partition axes",
  (count) => {
    for (const flavor of ["plain", "san"]) {
      const plans = Array.from({ length: count }, (_, index) =>
        ciTestPlan({ shard: `${index + 1}/${count}`, flavor }),
      );
      const sideFiles = plans.flatMap((plan) =>
        plan.side.filter((task) => task.args.length === 2).map((task) => task.args[1]),
      );
      for (const file of fileExclusions.filter(
        (file) =>
          !corpusFiles.includes(file) &&
          !effectFiles.includes(file) &&
          !file.includes("native-driver") &&
          !file.includes("coverage") &&
          !file.includes("native-toolchain"),
      )) {
        expect(
          sideFiles.filter((selected) => selected === file),
          file,
        ).toHaveLength(1);
      }
      for (const plan of plans) {
        expect(plan.corpus.args).toEqual(["test", ...corpusFiles]);
        expect(plan.side[0]!.args).toContain(`--shard=${plan.corpus.env.SCRIPTC_TEST_SHARD}`);
        for (const file of fileExclusions)
          expect(plan.side[0]!.args).toContain(`--exclude=${file}`);
        const cache = plan.side.find((task) => task.name === "native-cache correctness");
        expect(Boolean(cache)).toBe(flavor === "plain");
        if (cache) {
          expect(cache.env.SCRIPTC_CACHE_TEST_SHARD).toBe(plan.corpus.env.SCRIPTC_TEST_SHARD);
          expect(cache.env.SCRIPTC_TEST_STABLE_TOOLCHAIN).toBe("0");
        }
        expect(plan.side.some((task) => task.name === "coverage sweep")).toBe(flavor === "plain");
      }
    }
  },
);

test.for([1, 2, 4, 8])(
  "CI overlaps reserved lanes within a budget of %i workers",
  async (workers) => {
    const plan = ciTestPlan({ shard: "1/10", flavor: "plain", workers });
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    let finishCorpus!: () => void;
    const corpusWait = new Promise<void>((resolve) => {
      finishCorpus = resolve;
    });
    await runCiTestPlan(plan, async (task) => {
      const cost = Number(task.env.SCRIPTC_TEST_WORKERS);
      active += cost;
      peak = Math.max(peak, active);
      events.push(`start:${task.name}`);
      if (task === plan.corpus && workers > 1) await corpusWait;
      else await Promise.resolve();
      events.push(`end:${task.name}`);
      active -= cost;
      if (task === plan.side.at(-1)) finishCorpus();
    });
    expect(peak).toBeLessThanOrEqual(workers);
    expect(events.filter((event) => event.startsWith("start:")).sort()).toEqual(
      [plan.corpus, ...plan.side].map((task) => `start:${task.name}`).sort(),
    );
    for (let index = 1; index < plan.side.length; index++) {
      expect(events.indexOf(`start:${plan.side[index]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.side[index - 1]!.name}`),
      );
    }
    if (workers === 1)
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
    else
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeLessThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
  },
);

test("CI reports failures after running every scheduled suite", async () => {
  const plan = ciTestPlan({ shard: "1/10", flavor: "plain" });
  const seen: string[] = [];
  let failure: AggregateError | undefined;
  try {
    await runCiTestPlan(plan, async (task) => {
      seen.push(task.name);
      if (task === plan.corpus || task === plan.side[0]) throw new Error(task.name);
    });
  } catch (error) {
    failure = error as AggregateError;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure!.errors).toHaveLength(2);
  expect(seen.sort()).toEqual([plan.corpus, ...plan.side].map((task) => task.name).sort());
});

test.for([1, 2, 3])("the darwin suite retains every darwin file with %i shards", (count) => {
  for (const flavor of ["plain", "san"]) {
    const plans = Array.from({ length: count }, (_, index) =>
      ciTestPlan({ shard: `${index + 1}/${count}`, flavor, suite: "darwin" }),
    );
    for (const plan of plans) {
      expect(plan.corpus.args).toEqual(["test", ...darwinCorpusFiles]);
      expect(plan.corpus.env.SCRIPTC_SAN).toBe(flavor === "san" ? "1" : "");
      expect(plan.side).toHaveLength(1);
      expect(plan.side[0]!.args).toEqual([
        "test",
        "--passWithNoTests",
        `--shard=${plan.corpus.env.SCRIPTC_TEST_SHARD}`,
        ...darwinFiles,
      ]);
    }
  }
  // The full suite still runs every darwin file through its file shards.
  for (const file of [...darwinCorpusFiles, ...darwinFiles]) {
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
    if (!darwinCorpusFiles.includes(file)) expect(fileExclusions).not.toContain(file);
  }
  expect(corpusFiles).toEqual(expect.arrayContaining(darwinCorpusFiles));
});

test("pull requests run the full suite on Linux and the darwin suite on macOS", () => {
  type Job = {
    "runs-on": string;
    needs: string[];
    strategy: { matrix: { flavor: string[]; shard: number[] | string } };
    env: Record<string, string>;
    steps: { run?: string; uses?: string; with?: { name?: string } }[];
  };
  const { jobs } = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, Job> };
  const linux = jobs["tests"]!;
  const macos = jobs["tests_macos"]!;
  expect(linux["runs-on"]).toBe("ubuntu-24.04");
  expect(linux.needs).toContain("native_linux");
  expect(linux.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(linux.env["SCRIPTC_TEST_SHARD"]).toBe("${{ matrix.shard }}/10");
  expect(linux.env["SCRIPTC_CI_SUITE"]).toBeUndefined();
  expect(linux.steps.some((step) => step.uses === "./.github/actions/llvm-linux")).toBe(true);
  expect(
    linux.steps.find((step) => step.uses?.startsWith("actions/download-artifact"))!.with!.name,
  ).toBe("native-linux-x64-gnu");
  expect(macos["runs-on"]).toBe("macos-15");
  expect(macos.needs).toContain("native_macos");
  expect(macos.strategy.matrix.shard).toBe(
    "${{ fromJSON(github.event_name == 'pull_request' && '[1, 2, 3]' || '[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]') }}",
  );
  expect(macos.env["SCRIPTC_TEST_SHARD"]).toBe(
    "${{ matrix.shard }}/${{ github.event_name == 'pull_request' && '3' || '10' }}",
  );
  expect(macos.env["SCRIPTC_CI_SUITE"]).toBe(
    "${{ github.event_name == 'pull_request' && 'darwin' || 'full' }}",
  );
  for (const job of [linux, macos]) {
    expect(job.strategy.matrix.flavor).toEqual(["plain", "san"]);
    expect(job.steps.at(-1)!.run).toBe("node scripts/ci-test.mjs");
  }
});

test("CI rejects malformed scheduling inputs", () => {
  for (const shard of [undefined, "", "0/10", "11/10", "2/x"])
    expect(() => ciTestPlan({ shard, flavor: "plain" })).toThrow();
  for (const workers of [0, -1, 1.5, NaN, Infinity])
    expect(() => ciTestPlan({ shard: "1/10", flavor: "plain", workers })).toThrow();
  expect(() => ciTestPlan({ shard: "1/10", flavor: "unknown" })).toThrow();
  expect(() => ciTestPlan({ shard: "1/10", flavor: "plain", suite: "unknown" })).toThrow();
});
