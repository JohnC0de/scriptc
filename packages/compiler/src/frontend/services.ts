import { Ts7SourceParser, type Ts7SourceKind } from "./ts7/source-parser.js";
import { Ts7Host, type Ts7ApiFactory, type Ts7HostOptions } from "./ts7/program-host.js";
import { rewriteBundlerCjsWithParser } from "./npm-static-rewrite-host.js";
import { isBundlerCjsCandidate } from "./npm-static-rewrite-syntax.js";
import * as syntax from "./npm-static-declaration-syntax.js";
import type { SourceFile } from "./ts7/ast-types.js";

/** Evaluate an isolated, self-contained TypeScript callback under a finite
 * budget. Hosts supply execution; shared lowering owns capture checks and
 * verifies the returned value before baking it into the program. */
export type ComptimeEvaluator = (source: string, timeoutMs: number) => unknown;

/** A Node host keeps its process-specific resolver settings and hooks. Native
 * clients use the filesystem resolver when no host adapter is supplied. */
export interface RuntimeModuleResolver {
  resolve: (fromFile: string, specifier: string, paths: readonly string[] | undefined) => string;
  lookupPaths: (fromFile: string, specifier: string) => readonly string[] | null;
}

/** Own the syntax and semantic services for a compiler client. The supplied
 * connection factory and optional evaluator provide host operations;
 * parsing, projection and filesystem resolution share their implementation
 * across native and Node clients. Program hosts belong to their callers. */
export class FrontendServices {
  private parser: Ts7SourceParser | undefined;
  private closed = false;

  constructor(
    private readonly createApi: Ts7ApiFactory,
    private readonly cwd = process.cwd(),
    private readonly comptimeEvaluator: ComptimeEvaluator | undefined = undefined,
    readonly runtimeModuleResolver: RuntimeModuleResolver | undefined = undefined,
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new Error("frontend services are closed");
  }
  private sourceParser(): Ts7SourceParser {
    this.ensureOpen();
    return (this.parser ??= new Ts7SourceParser(
      (options) => this.createApi({ ...options, collectTiming: false }),
      this.cwd,
    ));
  }
  parse(path: string, source: string, kind: Ts7SourceKind): SourceFile {
    return this.sourceParser().parse(path, source, kind);
  }
  evaluateComptime(source: string, timeoutMs: number): unknown {
    this.ensureOpen();
    if (this.comptimeEvaluator === undefined)
      throw new Error("this compiler host does not provide compile-time evaluation");
    return this.comptimeEvaluator(source, timeoutMs);
  }
  createProgramHost(options?: Ts7HostOptions): Ts7Host {
    this.ensureOpen();
    return new Ts7Host(this.createApi, { ...options, cwd: options?.cwd ?? this.cwd });
  }
  rewriteCjs(source: string, path: string): string | { degrade: string } | null {
    this.ensureOpen();
    if (!isBundlerCjsCandidate(source)) return null;
    return rewriteBundlerCjsWithParser(this.sourceParser(), source, path);
  }
  nullableClassFields(path: string, source: string): syntax.NpmStaticOverloadRewrite | null {
    return syntax.applyNpmStaticNullableClassFields(this.parse(path, source, "js"), source);
  }
  jsDocNamepaths(path: string, source: string): string | null {
    if (!source.includes("~") && !source.includes("#")) return null;
    return syntax.applyNpmStaticJsDocNamepaths(this.parse(path, source, "js"), source);
  }
  findReturnWidening(path: string, source: string): syntax.NpmStaticOverloadRewrite | null {
    return syntax.applyNpmStaticFindReturnWidening(this.parse(path, source, "js"), source);
  }
  declarationProperties(
    path: string,
    source: string,
    declarations: syntax.NpmStaticDeclarationProperties,
  ): syntax.NpmStaticOverloadRewrite | null {
    this.ensureOpen();
    if (declarations.size === 0) return null;
    return syntax.applyNpmStaticDeclarationProperties(
      this.parse(path, source, "js"),
      source,
      declarations,
    );
  }
  declarationOverloads(
    path: string,
    source: string,
    declarations: syntax.NpmStaticDeclarationOverloads,
  ): syntax.NpmStaticOverloadRewrite | null {
    this.ensureOpen();
    if (declarations.size === 0) return null;
    return syntax.applyNpmStaticDeclarationOverloads(
      this.parse(path, source, "js"),
      source,
      declarations,
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const parser = this.parser;
    this.parser = undefined;
    parser?.close();
  }
}
