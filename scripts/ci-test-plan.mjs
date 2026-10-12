// Case-sharded harnesses run in every job without Vitest file sharding.
export const effectFiles = ["tests/harness/effect.test.ts", "tests/harness/effect4.test.ts"];
export const corpusFiles = [
  "tests/harness/differential.test.ts",
  "tests/harness/llvm-differential.test.ts",
  "tests/harness/server.test.ts",
  "tests/harness/test262.test.ts",
  "tests/harness/three.test.ts",
];
const coverageFile = "tests/harness/coverage.test.ts";
const cacheFile = "packages/compiler/src/backend/native-toolchain.test.ts";
// Expensive integration suites keep their existing owners and run serially
// beside the corpus, avoiding worker contention between large compilations.
const isolatedFiles = [
  ["self-hosting serialization", "tests/harness/self-hosting-serialization.test.ts", 5],
  ["self-hosting", "tests/harness/self-hosting.test.ts", 1],
  ["self-hosting LLVM emitter", "tests/harness/self-hosting-llvm-emitter.test.ts", 2],
  ["fetch", "tests/harness/fetch.test.ts", 3],
  ["npm static", "tests/harness/npm-static.test.ts", 4],
  ["surface manifest", "tests/harness/surface-manifest.test.ts", 5],
];
export const fileExclusions = [
  ...corpusFiles,
  ...effectFiles,
  coverageFile,
  cacheFile,
  ...isolatedFiles.map(([, file]) => file),
  "tests/harness/self-hosting-native-driver.test.ts",
];

// Pull requests run the full suite on Linux. Their macOS lane keeps the
// darwin clang/libc/kqueue oracles: the Node differential corpus, plus every
// file whose assertions run only on darwin or take darwin-specific branches.
// Pushes to main and the nightly schedule still run the full suite on macOS.
export const darwinCorpusFiles = ["tests/harness/differential.test.ts"];
export const darwinFiles = [
  "packages/cli/test/bootstrap.test.ts",
  "packages/cli/test/native-link-info.test.ts",
  "packages/cli/test/native-output.test.ts",
  "packages/cli/test/runtime-pack.test.ts",
  "packages/compiler/test/debug-variables.test.ts",
  "packages/compiler/test/native-codegen-integration.test.ts",
  "packages/compiler/test/source-debugging.test.ts",
  "packages/runtime-darwin-arm64/test/archive.test.ts",
  "tests/harness/ffi-callback-pool.test.ts",
  "tests/harness/ffi-catalog.test.ts",
  "tests/harness/ffi-frameworks.test.ts",
  "tests/harness/native-object-example.test.ts",
  "tests/harness/runtime-tree-shaking.test.ts",
  "tests/harness/terminal-geometry.test.ts",
];

export function ciTestPlan({ shard, flavor, workers = 4, suite = "full" }) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !Number.isSafeInteger(Number(match[2])) ||
    Number(match[1]) > Number(match[2])
  )
    throw new Error("invalid CI shard");
  if (flavor !== "plain" && flavor !== "san") throw new Error("invalid CI flavor");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("invalid CI worker budget");
  if (suite !== "full" && suite !== "darwin") throw new Error("invalid CI suite");
  const index = Number(match[1]),
    count = Number(match[2]);
  const sideWorkers = workers === 1 ? 0 : 1;
  const env = { SCRIPTC_TEST_SHARD: shard, SCRIPTC_SAN: flavor === "san" ? "1" : "" };
  if (suite === "darwin")
    return {
      sideWorkers,
      corpus: {
        name: "case-sharded differential corpus",
        args: ["test", ...darwinCorpusFiles],
        env: { ...env, SCRIPTC_TEST_WORKERS: String(workers - sideWorkers) },
      },
      side: [
        {
          name: "darwin contracts",
          args: ["test", "--passWithNoTests", "--shard=" + shard, ...darwinFiles],
          env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
        },
      ],
    };
  const side = [
    {
      name: "file-sharded tests",
      args: [
        "test",
        "--passWithNoTests",
        "--shard=" + shard,
        ...fileExclusions.map((file) => "--exclude=" + file),
      ],
      env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
    },
  ];
  for (const [name, file, owner] of isolatedFiles) {
    if (((owner - 1) % count) + 1 === index)
      side.push({ name, args: ["test", file], env: { ...env, SCRIPTC_TEST_WORKERS: "1" } });
  }
  // Frontend coverage and cache invalidation do not consume sanitizer state.
  if (flavor === "plain") {
    side.push({
      name: "native-cache correctness",
      args: ["test", cacheFile],
      env: {
        ...env,
        SCRIPTC_TEST_WORKERS: "1",
        SCRIPTC_CACHE_TEST_SHARD: shard,
        SCRIPTC_TEST_STABLE_TOOLCHAIN: "0",
      },
    });
    side.push({
      name: "coverage sweep",
      args: ["test", coverageFile],
      env: { ...env, SCRIPTC_TEST_WORKERS: "1" },
    });
  }
  return {
    sideWorkers,
    corpus: {
      name: "case-sharded corpus",
      args: ["test", ...corpusFiles],
      env: {
        ...env,
        SCRIPTC_TEST_WORKERS: String(workers - sideWorkers),
        SCRIPTC_LLVM_TEST_MODE: "dev",
      },
    },
    side,
  };
}
