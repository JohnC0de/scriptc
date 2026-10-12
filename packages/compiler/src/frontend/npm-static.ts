/** Compile selected package implementations as program modules. The filesystem
 * shadow hides declaration-only entry points so lowering sees runtime source;
 * safe declaration contracts are projected onto that source before inference.
 * Eligibility failures and package preflight errors become explicit refusals. */
import { dirname } from "node:path";
import type { FrontendServices } from "./services.js";
import type {
  NpmStaticDeclarationOverloads,
  NpmStaticDeclarationProperties,
} from "./npm-static-declaration-syntax.js";
import {
  npmPackageNameOf,
  registerWorkspacePackage,
  workspacePackageOfPath,
} from "./workspace-registry.js";
import { trackedExists, trackedReadFile, trackedRealpath } from "./input-tracker.js";

let activePackages: ReadonlySet<string> = new Set();
let declarationOverloads: ReadonlyMap<string, NpmStaticDeclarationOverloads> = new Map();
let declarationProperties: ReadonlyMap<string, NpmStaticDeclarationProperties> = new Map();

/** Offender records of the CURRENT load attempt: packages whose static
 * compilation the preflight had to refuse, with the first reason. The
 * frontend's fallback loop consumes these and rebuilds without them. */
const offenders = new Map<string, string>();

/** Per-load cache of the bundler-CJS export rewrite (npm-static-rewrite.ts):
 * the host probes the same file many times, and the rewrite parses. */
const rewriteCache = new Map<string, string | null>();

export function setNpmStaticPackages<T extends Iterable<string>>(packages: T): void {
  activePackages = new Set(packages);
  declarationOverloads = new Map();
  declarationProperties = new Map();
  offenders.clear();
  rewriteCache.clear();
  untypedPkgCache.clear();
  realpathProbed.clear();
}

export function setNpmStaticDeclarationOverloads(
  overloads: ReadonlyMap<string, NpmStaticDeclarationOverloads>,
  properties: ReadonlyMap<string, NpmStaticDeclarationProperties> = new Map(),
): void {
  declarationOverloads = overloads;
  declarationProperties = properties;
  rewriteCache.clear();
}

export function npmStaticActive(): boolean {
  return activePackages.size > 0;
}

export function isNpmStaticPackage(name: string | null): boolean {
  return name !== null && activePackages.has(name);
}

/** The opted-in package a path belongs to, or null. Attribution uses the
 * INNERMOST node_modules segment (a nested install is its own package);
 * paths with NO node_modules segment consult the workspace registry — an
 * opted-in WORKSPACE package's files live at realpaths outside every
 * node_modules (the symlinked-install shape), and they are that package's
 * files for every consumer of this answer: the fallback loop's offender
 * attribution, the checker-error suppression, and the program-source
 * classification (unselectedPackageJsFile/userFiles) all agree the opt-in claims
 * them. */
export function npmStaticPackageOfPath(path: string): string | null {
  const pkg = npmPackageNameOf(path);
  if (pkg !== null) return activePackages.has(pkg) ? pkg : null;
  const ws = workspacePackageOfPath(path.split("\\").join("/"));
  return ws !== null && activePackages.has(ws) ? ws : null;
}

/** Records why a package cannot compile statically this attempt (first
 * reason wins — one line per package in the coverage note). */
export function reportNpmStaticOffender(pkg: string, reason: string): void {
  if (activePackages.has(pkg) && !offenders.has(pkg)) offenders.set(pkg, reason);
}

export function npmStaticOffenders(): ReadonlyMap<string, string> {
  return offenders;
}

/** The DefinitelyTyped name mangling ("@scope/pkg" → "scope__pkg") — the
 * @types twin that must hide alongside the package's own declarations. */
function mangledTypesName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
}

/** See shadowTargetOf: realpaths an opted-in package's node_modules dir
 * once per load and registers workspace-symlinked installs. */
const realpathProbed = new Set<string>();

function registerWorkspaceRealpath(pkg: string, nmDir: string): void {
  if (realpathProbed.has(nmDir)) return;
  realpathProbed.add(nmDir);
  const real = trackedRealpath(nmDir)?.split("\\").join("/");
  if (real !== undefined && real !== nmDir && !real.includes("/node_modules/")) {
    registerWorkspacePackage(pkg, real);
  }
}

/** node_modules path classification for the fs shadow: which opted-in
 * package (if any) the path is inside, and whether it is inside that
 * package's @types twin instead. A path with no node_modules segment can
 * still be an opted-in WORKSPACE package's real home (the symlinked
 * install's realpath — loadProgram registers those before the host is
 * created, so probes along the package's internal relative edges hide the
 * declaration twins too). */
function shadowTargetOf(path: string): { pkg: string; viaTypes: boolean } | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) {
    const ws = workspacePackageOfPath(norm);
    return ws !== null && activePackages.has(ws) ? { pkg: ws, viaTypes: false } : null;
  }
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  if (activePackages.has(dirName)) {
    /* An opted-in package first seen through a node_modules path may be a
     * WORKSPACE SYMLINK whose realpath escapes node_modules — and the
     * host reads file CONTENT at realpaths, where nothing path-shaped
     * marks the package. The entry-anchored probe in loadProgram misses
     * nested realms (a monorepo driver outside every package realm), so
     * the shadow registers the realpath the moment resolution touches the
     * symlink — always before any content read along it. */
    registerWorkspaceRealpath(dirName, `${norm.slice(0, idx)}/node_modules/${dirName}`);
    return { pkg: dirName, viaTypes: false };
  }
  if (first === "@types") {
    const mangled = parts[1] ?? "";
    for (const pkg of activePackages) {
      if (mangledTypesName(pkg) === mangled) return { pkg, viaTypes: true };
    }
  }
  return null;
}

/** The opted-in package.json transform, applied identically in BOTH
 * resolution worlds (the tsgo host's fs shadow and resolve.ts):
 *   1. every types claim goes — the top-level "types"/"typings" fields
 *      and every "types"/"typings" condition key inside "exports"
 *      (recursively; condition objects nest) — so resolution lands on
 *      runtime JS;
 *   2. preserve distinct import and require targets. Static compilation
 *      must execute the same module Node selects, including packages that
 *      ship separate ESM and CommonJS builds. */
export function npmStaticTransformPkgJson(pkg: Record<string, unknown>): void {
  delete pkg["types"];
  delete pkg["typings"];
  const transform = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) transform(item);
      return;
    }
    const obj = v as Record<string, unknown>;
    delete obj["types"];
    delete obj["typings"];
    // 0. The "node" condition HOISTS: Node's runtime resolution matches it
    //    (yaml's `{ types, node: "./dist/index.js", default: "./browser/
    //    index.js" }` runs the node dist; the browser dist is a DIFFERENT
    //    artifact), while the bundler condition set both resolution worlds
    //    use ({types, import, default}) would fall through to "default".
    //    The node target splices in AT ITS KEY POSITION — a string emits
    //    under import+require (either matcher finds it there), an object's
    //    entries splice inline — earlier real keys keep winning, exactly
    //    Node's first-match-in-key-order rule.
    if (obj["node"] !== undefined) {
      const entries = Object.entries(obj);
      for (const k of Object.keys(obj)) delete obj[k];
      for (const [k, val] of entries) {
        if (k !== "node") {
          if (!(k in obj)) obj[k] = val;
          continue;
        }
        const inner: Record<string, unknown> =
          typeof val === "string"
            ? { import: val, require: val }
            : val !== null && typeof val === "object" && !Array.isArray(val)
              ? (val as Record<string, unknown>)
              : {};
        for (const [ik, iv] of Object.entries(inner)) {
          if (!(ik in obj)) obj[ik] = iv;
        }
      }
    }
    for (const value of Object.values(obj)) transform(value);
  };
  if (pkg["exports"] !== undefined) transform(pkg["exports"]);
}

/** npmStaticTransformPkgJson over a package.json TEXT (the fs shadow's
 * form). Malformed documents pass through untouched — resolution reports
 * them exactly as it always did. */
function npmStaticTransformPkgJsonText(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return text;
  npmStaticTransformPkgJson(doc as Record<string, unknown>);
  return JSON.stringify(doc);
}

/** True for declaration-file names (the claims the opted-in resolution
 * must not see). */
function isDeclarationFileName(path: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(path) || path.endsWith(".d.json.ts");
}

function isNodeModulesPathNorm(path: string): boolean {
  return path.split("\\").join("/").includes("/node_modules/");
}

/** Whether the package owning `path` is UNTYPED for the checker: no
 * "types"/"typings" claim, no root .d.ts entry, and no installed @types
 * twin along the walk-up — the packages whose flagless import surface is
 * `any` (see the any-surface stub in the fs shadow). Cached per package
 * directory for the load's lifetime. */
const untypedPkgCache = new Map<string, boolean>();

function packageIsUntyped(path: string): boolean {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return false;
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  if (first.startsWith("@types")) return false; // a twin IS the types
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  const pkgDir = `${norm.slice(0, idx)}/node_modules/${dirName}`;
  const hit = untypedPkgCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let untyped = true;
  try {
    const pkgText = trackedReadFile(`${pkgDir}/package.json`);
    if (pkgText !== null) {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      if (pkg["types"] !== undefined || pkg["typings"] !== undefined) untyped = false;
      if (untyped && typeof pkg["exports"] === "object" && pkg["exports"] !== null) {
        // a "types" condition anywhere inside exports is a claim too
        untyped = !JSON.stringify(pkg["exports"]).includes('"types"');
      }
    }
  } catch {
    /* no package.json — keep probing */
  }
  if (untyped && trackedExists(`${pkgDir}/index.d.ts`)) untyped = false;
  if (untyped) {
    // the @types twin, hoisted anywhere up the realm chain
    const mangled = mangledTypesName(dirName);
    for (let dir = dirname(pkgDir); ;) {
      const parent = dirname(dir);
      if (
        trackedExists(`${dir}/node_modules/@types/${mangled}/package.json`) ||
        trackedExists(`${dir}/@types/${mangled}/package.json`)
      ) {
        untyped = false;
        break;
      }
      if (parent === dir) break;
      dir = parent;
    }
  }
  untypedPkgCache.set(pkgDir, untyped);
  return untyped;
}

export interface NpmStaticFsShadow {
  /** Shadowed CONTENT for a real path (the types-stripped package.json),
   * or undefined (no shadow — fall through). */
  readFile: (path: string) => string | undefined;
  /** True when the path must not exist for the type-checker's resolution
   * (an opted-in package's shipped .d.ts, or its @types twin whole). */
  hideFile: (path: string) => boolean;
}

/** The virtual-FS shadow loadProgram hands the tsgo host — null when the
 * flag is off, so flagless compiles keep the exact host behavior. */
export function npmStaticFsShadow(services: FrontendServices): NpmStaticFsShadow | null {
  if (!npmStaticActive()) return null;
  return {
    readFile: (path) => {
      const target = shadowTargetOf(path);
      /* NON-OPTED node_modules JS: maxNodeModuleJsDepth (set only on
       * --npm-static loads) admits third-party JS the flagless build never
       * types, and an UNTYPED package's inferred surface would then
       * replace the `any` its imports contribute flagless — changing the
       * PROGRAM's own types under a flag that promised to touch only the
       * opted-in packages (the jaro-winkler shape: an @ts-ignore'd import
       * whose result feeds program arithmetic). Serve those files as the
       * any-surface stub instead: the import types exactly what the
       * flagless build typed. Typed packages (own .d.ts or an installed
       * @types twin) resolve types-first and never reach here. */
      if (!target) {
        if (
          (path.endsWith(".js") || path.endsWith(".cjs")) &&
          isNodeModulesPathNorm(path) &&
          !trackedExists(path.replace(/\.(js|cjs)$/, ".d.ts")) && // a sibling .d.ts types this very file
          packageIsUntyped(path)
        ) {
          return "module.exports = (() => { let u; return u; })();\n";
        }
        return undefined;
      }
      if (target.viaTypes) return undefined;
      if (path.endsWith("/package.json") || path.endsWith("\\package.json")) {
        try {
          const source = trackedReadFile(path);
          return source === null ? undefined : npmStaticTransformPkgJsonText(source);
        } catch {
          return undefined;
        }
      }
      // Bundler-emitted CJS files get their export surface respelled in
      // the plain CJS both worlds model (npm-static-rewrite.ts) — the ONE
      // program serves checker and lowering, so the rewrite is the text
      // everywhere downstream (statement walks, the CJS lexer link check,
      // diagnostics rendering; original line offsets survive by
      // construction). A `degrade` answer (a __toESM interop construct the
      // recognizers cannot finish) marks the PACKAGE an offender with the
      // reason — the selection loop records a package refusal — and
      // the file serves untouched for the doomed load.
      if (path.endsWith(".js") || path.endsWith(".cjs")) {
        const hit = rewriteCache.get(path);
        if (hit !== undefined) return hit ?? undefined;
        let rewritten: string | null = null;
        try {
          const original = trackedReadFile(path);
          if (original !== null) {
            const namepaths = services.jsDocNamepaths(path, original);
            const source = namepaths ?? original;
            const classFields = services.nullableClassFields(path, source);
            const findWidened = services.findReturnWidening(path, classFields?.text ?? source);
            const propertyProjected = services.declarationProperties(
              path,
              findWidened?.text ?? classFields?.text ?? source,
              declarationProperties.get(path.split("\\").join("/")) ?? new Map(),
            );
            const projected = services.declarationOverloads(
              path,
              propertyProjected?.text ?? findWidened?.text ?? classFields?.text ?? source,
              declarationOverloads.get(path.split("\\").join("/")) ?? new Map(),
            );
            const answer = services.rewriteCjs(
              projected?.text ??
                propertyProjected?.text ??
                findWidened?.text ??
                classFields?.text ??
                source,
              path,
            );
            if (answer !== null && typeof answer === "object") {
              reportNpmStaticOffender(target.pkg, answer.degrade);
            } else {
              rewritten =
                answer ??
                projected?.text ??
                propertyProjected?.text ??
                findWidened?.text ??
                classFields?.text ??
                namepaths;
            }
          }
        } catch {
          rewritten = null; // unreadable/unparseable: fall through untouched
        }
        rewriteCache.set(path, rewritten);
        return rewritten ?? undefined;
      }
      return undefined;
    },
    hideFile: (path) => {
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path);
    },
  };
}

/* Only a bundler RUNTIME disqualifies now: webpack's module registry has
 * no static story (the graph lives in numbered closures). The tsc/babel
 * __esModule stamp and esbuild's helper preambles used to disqualify too,
 * but the bundler-emitted CJS export rewrite (npm-static-rewrite.ts)
 * types the getter-table shapes and the offender attribution degrades a
 * package whose surface still breaks its consumers — so those bundles are
 * worth ATTEMPTING: eligible when the .d.ts and unminified criteria hold,
 * gracefully per-package-degraded when the attempt fails. */
const TRANSFORM_MARKERS = ["__webpack_require__"];

/** Unminified-JS heuristic over an entry source: at least two lines and
 * an average line length under 200 characters (minified dists are one
 * enormous line; readable code averages well under 100). */
function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2) return false;
  return source.length / lines.length <= 200;
}

function hasTransformMarkers(source: string): boolean {
  return TRANSFORM_MARKERS.some((m) => source.includes(m));
}

/** Auto-mode eligibility for one candidate package: `typesFile` is what
 * the ordinary (types-first) resolution answered for the import,
 * `jsEntry` what the js-only resolution answers. Returns null when
 * eligible, else the human-readable reason it is not. */
export function npmStaticIneligibleReason(
  pkgName: string,
  typesFile: string,
  jsEntry: string | null,
): string | null {
  if (npmPackageNameOf(typesFile) !== pkgName) {
    return "its declared types come from a third-party @types package, not the package itself";
  }
  if (!/\.d\.(ts|mts|cts)$/.test(typesFile)) {
    return "it ships no own .d.ts declaration surface";
  }
  if (jsEntry === null) return "no runtime JS entry resolves";
  const source = trackedReadFile(jsEntry);
  if (source === null) return `its runtime entry ${jsEntry} cannot be read`;
  if (!looksUnminified(source)) return "its shipped JS looks minified";
  if (hasTransformMarkers(source)) {
    return "its shipped JS carries build-transform markers (bundled/transpiled dist)";
  }
  return null;
}
