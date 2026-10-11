# scriptc

<p>
  <a href="https://vercel.com/labs#active-experiments"><img alt="Vercel Labs Experiment" src="https://img.shields.io/badge/LABS-EXPERIMENT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/scriptc"><img alt="npm version: scriptc" src="https://img.shields.io/npm/v/scriptc.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/scriptc/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/scriptc.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/scriptc"><img alt="npm downloads per month: scriptc" src="https://img.shields.io/npm/dm/scriptc.svg?style=for-the-badge&amp;labelColor=000000&amp;label=npm%20downloads" height="28"></a>
</p>

scriptc compiles TypeScript and JavaScript to native executables and WebAssembly. It uses TypeScript's type information to compile supported code to native instructions. Executables run without Node.js or a JavaScript engine.

Application code and eligible npm dependencies compile to native instructions. Unsupported operations produce diagnostics; there is no runtime JavaScript engine fallback.

scriptc is experimental and supports a subset of JavaScript, TypeScript, and Node.js APIs. See the [limitations](https://scriptc.dev/docs/limitations) and [Node.js compatibility reference](https://scriptc.dev/compatibility) before using it for an existing project.

## Installation

Install with Node.js 24 or later and npm:

```console
$ npm install -g scriptc
```

The installed compiler runs natively on supported macOS, Linux, and Windows hosts. Native compilation and execution do not require Node.js. Standalone compiler archives are also available from [GitHub Releases](https://github.com/vercel-labs/scriptc/releases).

Executable builds require a platform linker and SDK/sysroot. See the [quickstart](https://scriptc.dev/docs/quickstart) for prerequisites and [platform support](https://scriptc.dev/docs/platforms) for host requirements, cross-compilation, and WebAssembly.

## Build a program

Create `hello.ts`:

```ts
const who = process.argv.length > 2 ? process.argv[2] : "world";
console.log(`hello, ${who}`);
```

Compile and run it in one step:

```console
$ scriptc run hello.ts
hello, world
```

Or write a standalone executable:

```console
$ scriptc build hello.ts -o hello
$ ./hello scriptc
hello, scriptc
```

These examples use POSIX shell syntax. On Windows, build `hello.exe` and run it with `.\hello.exe`.

Use `scriptc coverage hello.ts` to check which operations compile statically and which operations are unsupported. See [coverage reports](https://scriptc.dev/docs/coverage) for details.

## Use Node APIs

Supported Node APIs compile to the native runtime. For example, `server.ts`:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url }));
});

server.listen(8080, () => {
  console.log("listening on http://localhost:8080");
});
```

```console
$ scriptc build server.ts -o server
$ ./server
listening on http://localhost:8080
```

## Use npm packages

Eligible npm packages compile to native code by default. The executable does not read `node_modules` at runtime.

Create `cli.ts`:

```ts
import pc from "picocolors";

console.log(pc.green("hello from scriptc"));
```

```console
$ npm install picocolors
$ scriptc build cli.ts -o cli
$ ./cli
hello from scriptc
```

Package support is partial. See [npm dependencies](https://scriptc.dev/docs/dependencies) for eligibility, package resolution, and compilation diagnostics.

## Documentation

- [Quickstart](https://scriptc.dev/docs/quickstart): installation and your first executable.
- [CLI reference](https://scriptc.dev/docs/cli): commands, options, and output formats.
- [Native program objects](https://scriptc.dev/docs/native-objects): use compiler output in external builds.
- [Native FFI](https://scriptc.dev/docs/ffi): call C ABI functions from compiled programs.
- [WebAssembly modules](https://scriptc.dev/docs/wasm): build and embed WASI modules.
- [Examples](./examples): programs and integration examples in this repository.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for source setup, testing, native artifact builds, and docs development.
