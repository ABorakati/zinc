# Building from source

This page covers building and running Zinc from a checkout, and producing the installer. To run the same checks as CI, see [Testing](testing.md). For publishing a build, see [Releasing](releasing.md).

## Requirements

- Windows 10 or 11, x64.
- Bun 1.4.4. Use Bun for everything: no Node, npm or npx.
- The Rust toolchain (`cargo`) for the PDF library.
- The .NET SDK (`dotnet`) with .NET Framework 4.8 targeting, for the Word add-in. The project pulls `Microsoft.NETFramework.ReferenceAssemblies` from NuGet.
- PowerShell 7 (`pwsh`): `word/build.ps1` and `package.ts --zip` are run through it.
- For the installer: Inno Setup 7.
- For `--aot` builds: a Bun canary build (see below).

## One-time setup

Install the packages of each project. The lock files are committed, so use `--frozen-lockfile`:

```
cd core         && bun install --frozen-lockfile
cd word/sidebar && bun install --frozen-lockfile
cd gpui-ui      && bun install --frozen-lockfile
```

`word/sidebar` is needed even if you do not touch Word, because a core fuzz test imports `word/sidebar/src`.

### Vendored Zotero code

`core/vendor/` and the root `vendor/` are git-ignored. Fetch Zotero's translation code (pinned commits, no build step):

```
bun core/scripts/fetch-zotero-vendor.ts
```

It skips the download if `core/vendor/zotero/translators` already exists; pass `--force` to fetch again. What it fetches is described in [Translators](translators.md).

### The fulltext WebAssembly placeholder

`core/src/fulltext/wasm.ts` imports `core/vendor/fulltext-wasm/fulltext.wasm` when the module loads. The real file is built in a separate private repository (the zotero-fulltext engine) and cannot be fetched. Without a file at that path most of the core suite fails to load, so create an empty placeholder:

```
mkdir -p core/vendor/fulltext-wasm && : > core/vendor/fulltext-wasm/fulltext.wasm
```

With an empty file, Find Full Text does not work and its tests skip (`core/test/needs.ts` treats a file smaller than 1 KiB as absent). A real build is over 1 MB. For a working Find Full Text, copy the engine build to that path.

### Zotero's document worker, reader and note editor

These build with Bun from upstream Zotero repositories cloned into `vendor/`. They are only needed to run or package the parts of the app that use them (PDF text extraction and the reading view; snapshot and EPUB tabs; the note editor). The unit tests do not need them, apart from the extraction tests, which skip without the document worker.

| Output | Command | Notes |
| --- | --- | --- |
| `vendor/document-worker/build/` | `bash scripts/build-docworker.sh` | Clones `zotero/document-worker` if absent, then runs `bun install` and webpack |
| `reader-host/dist/` | `bash reader-host/build.sh` | Builds the Zotero reader (`web` target) in `vendor/reader`, then the host page. Needs the document worker build. `--skip-reader` reuses a previous reader build |
| `note-host/dist/` | `bash note-host/build.sh` | Clones `zotero/note-editor` if absent, builds it, then the host page. `--skip-editor` reuses a previous build |

The reader build expects `vendor/reader` to exist already; this repository has no script that clones it (not verified where it comes from).

## Running from source

The app runs a core that writes to its database. Run it against a copy of a library, never the real one:

```
bun -e 'import {Database} from "bun:sqlite"; new Database("src.sqlite",{readonly:true}).run("VACUUM INTO \"copy.sqlite\"")'
cd gpui-ui
ZN_DB=C:/path/to/library-COPY.sqlite bun src/main.tsx
```

Useful variables (from `gpui-ui/scripts/README.md` and `gpui-ui/src/core.ts`):

| Variable | Effect |
| --- | --- |
| `ZN_DB` | Run the core in-process on this database |
| `ZN_CORE_DIRECT=1` | In-process core with no HTTP (also turns off web tabs and the web note editor) |
| `ZN_PORT` | Loopback port of the in-process server (default 23161 unpackaged) |
| `ZN_URL` | Use an external core instead (default `http://127.0.0.1:23160`) |
| `ZN_TRACE=1` | Print start-up milestones |
| `ZN_SERVICES=1` | Run the services (Zotero port, sync, extract pool) in an unpackaged run |
| `ZN_ALLOW_REAL_DB=1` | Allow `ZN_DB` to point at the saved library (avoid) |
| `ZN_RESOLVE_LIBRARY=1` | Choose the library like the packaged app (used to test the first-run screen) |

`bun --hot src/main.tsx` (`bun run dev`) reloads on change. Typecheck with `bun check`, not `tsc`.

For the PDF reader from source you need `zn_pdf.dll` (next section).

## The native PDF library

`gpui-ui/native/pdf` is a Rust crate (`zn_pdf`, crate type `cdylib`). Build it with:

```
cd gpui-ui/native/pdf && cargo build --release
```

`gpui-ui/scripts/package.ts` runs this command itself, so a packaged build needs nothing extra. At run time the app (`gpui-ui/src/reader/pdf.ts`) looks for the DLL in this order: `ZN_PDF_DLL`, `%CARGO_TARGET_DIR%\release\zn_pdf.dll`, a fixed shared-target path, then `gpui-ui/native/pdf/target/release/zn_pdf.dll`. If you use a shared cargo target directory, set `CARGO_TARGET_DIR` and both `package.ts` and the app find the DLL there.

PDFium is not built. `bun gpui-ui/native/pdf/vendor/fetch-pdfium.ts` downloads a pinned `pdfium-win-x64.tgz` from bblanchon/pdfium-binaries (release `chromium/8125`), checks its SHA-256, and extracts `pdfium.dll` into `gpui-ui/native/pdf/vendor/pdfium/bin/`. `package.ts` calls it if the DLL is missing. `zn_pdf.dll` loads `pdfium.dll` from its own folder, so the two ship together; without PDFium the library renders with `hayro`.

## The custom GPUIX addon

The app uses a locally built `@gpuix/native` addon with cache regions. After every `bun install` in `gpui-ui` you must copy it over the npm binary again:

1. Build it from `ABorakati/gpuix`, branch `zn-cache` (private): in `packages/native` run `bun run build` (a napi release build with `test-support`).
2. Copy `packages/native/gpuix-native.win32-x64-msvc.node` over `gpui-ui/node_modules/@gpuix/native-win32-x64-msvc/gpuix-native.win32-x64-msvc.node`. The npm original is kept beside it as `.orig`.
3. Run `bun gpui-ui/scripts/build.ts` or `package.ts` after that, not before, so the custom file is the one embedded.

Without the custom addon, `cacheRegion` is ignored and the app works with whole-window redraws. The details, and how the fork's Zed submodule patches are kept, are in `gpui-ui/scripts/README.md`.

## Compiling the executable

`bun gpui-ui/scripts/build.ts` compiles the app to a single Windows executable with `Bun.build`. (The `bun build --compile` command cannot run the Solid Babel plugin, hence the script.) It writes into `gpui-ui/out/`:

| Variant | Output | Notes |
| --- | --- | --- |
| `plain` | `zotero-next-gpui-plain.exe` | No bytecode, no minify |
| `bytecode` | `zotero-next-gpui-bytecode.exe` | Copied to `out/zotero-next-gpui.exe` as the default |
| `bytecode-min` | `zotero-next-gpui-bytecode-min.exe` | Bytecode plus minify |
| `aot` | `zotero-next-gpui-aot.exe` | Only with `--aot`; needs the canary |

Options: `--variant <list>`, `--icons all` (embed every lucide icon instead of the ones `src/` mentions), `--hide-console`, `--entry`, `--out`. The version stamp and the update public key are baked in (see [Releasing](releasing.md)).

### The AOT canary

Stable Bun 1.4.4 has no ahead-of-time compiler. The `aot` variant uses the `compile.aot` option, which exists only in a Bun canary build. `build.ts` runs the other variants in the current Bun and then re-runs itself as `<canary>/bun.exe scripts/build.ts --aot-only` to build the AOT variant. Point it at the canary with `ZN_BUN_CANARY=<path to the canary bun.exe>`; the global Bun is never touched. How to obtain the canary is not documented in the repository.

In an AOT executable the workers (PDF extraction, document structure, Zotero translators) and the vendored code they load are compiled in. `build.ts` applies a list of source patches for this in the AOT variant only and fails if one no longer matches, so a change to those worker entry points can break the AOT build while leaving the others working. `gpui-ui/scripts/aot-bench.ts` is not part of the build: it benchmarks start-up and memory of running from sources against the compiled variants (`bun gpui-ui/scripts/aot-bench.ts --variants bytecode,aot`).

## Packaging

```
bun gpui-ui/scripts/package.ts --aot     # gpui-ui/out/package-aot/zotero-next-gpui/
bun gpui-ui/scripts/package.ts           # bytecode build into gpui-ui/out/package/zotero-next-gpui/
```

Add `--zip` to also write a zip. `package.ts` runs the steps in order: `cargo build --release` for `zn_pdf.dll`, the PDFium fetch if needed, `scripts/build.ts` (with `--hide-console`), the pre-bundled translate worker (non-AOT only, `scripts/translate-worker.ts`), then assembles the folder: the exe, `zn_pdf.dll`, `pdfium.dll` with its licences, `icon.ico`, `vendor/zotero` (translators, schema, and for non-AOT the framework), `vendor/document-worker/build`, `reader-host/dist` and `note-host/dist` when built (otherwise it warns that web tabs will be off), `README.txt` and `version.txt`. It then calls the signing hook, which does nothing unless configured (see [Releasing](releasing.md)).

The folder is self-contained: the exe finds its files next to itself (`gpui-ui/src/packaged.ts`).

## The installer

```
bun gpui-ui/scripts/installer.ts
```

This builds `gpui-ui/out/installer/Zinc-Setup-<version>.exe` and a `.json` with version, size and SHA-256 from the packaged AOT folder; it does not rebuild the package. Inno Setup 7 is found through `ZN_ISCC`, then known install folders and `PATH`. To get it without admin rights, download the Inno Setup 7 installer from the `jrsoftware/issrc` releases and run it with `/VERYSILENT /CURRENTUSER /PORTABLE=1 /NOICONS /DIR=<folder>`, then set `ZN_ISCC=<folder>\ISCC.exe`.

By default `installer.ts` also builds the Word add-in into `out/installer/word-stage` and the browser connector into `out/installer/connector-stage`. Options:

| Option | Effect |
| --- | --- |
| `--package <dir>` | Install this folder instead of `out/package-aot/zotero-next-gpui` |
| `--no-word`, `--reuse-word` | Leave the add-in out, or reuse the staged build |
| `--no-connector`, `--reuse-connector` | Leave the connector out, or reuse the staged build |
| `--test` | A differently identified installer (own AppId, file name ending `-TEST`) for sandbox runs |

The connector component needs the extension sources in a sibling checkout `zotero-next-connector` (branch `zotero-next`), built with its own Bun build; set `ZN_CONNECTOR_DIR` if it is elsewhere, or pass `--no-connector`. What the installer does and its command lines are in `gpui-ui/installer/README.md` and [Releasing](releasing.md).

## The Word add-in

```
pwsh word/build.ps1                  # add-in and sidebar into word/dist/addin
pwsh word/build.ps1 -Harness         # also the test harness into word/dist/harness
pwsh word/build.ps1 -OutDir <dir>    # build into <dir>/addin instead (what the installer uses)
```

The script runs `dotnet build word/addin/ZoteroNextWord.csproj -c Release` (target `net48`), then `bun install` and `bun build.ts` in `word/sidebar`. `word/dist/addin` is the installed add-in on a developer machine, so for tests and scratch builds use `-OutDir`, or set `ZN_WORD_DIST` for the sidebar bundle alone. `word/install.ps1` registers the add-in for the current user (HKCU, no admin) and `word/uninstall.ps1` removes it; close Word first.

## The connector host

```
cd connector-host
bun install
bun run build           # bun build --compile src/main.ts --outfile dist/zotero-next-host.exe
```

The executable embeds `core/src/connector` and `core/src/db.ts`, so rebuild it after changing them. `install.ps1` and `uninstall.ps1` register and remove the native-messaging manifest in HKCU for Chrome and Edge. Do not run the development registration and the installed component together: they use the same registry keys.

## Windows notes

- `package.ts` uses your normal cargo setup, including a shared `CARGO_TARGET_DIR` if you have one; it does not override the target directory.
- A running `zotero-next-host.exe` is locked by the browser and cannot be overwritten; the installer builds the host straight into its staging folder for this reason.
