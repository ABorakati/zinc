# Building from source

This page covers building and running Zinc from a checkout, and producing the Windows installer, the Linux AppImage and the macOS disk image. To run the same checks as CI, see [Testing](testing.md). For publishing a build, see [Releasing](releasing.md). Linux and macOS have their own section, [Linux and macOS](#linux-and-macos). The rest of the page describes Windows unless it says otherwise.

## Requirements

- Windows 10 or 11 (x64), Linux (x64) or macOS 13 or later on Apple Silicon (arm64). The app runs from source on all three. Only Windows has the installer, the Word add-in, the connector host and auto-update.
- Bun 1.4.4. Use Bun for everything: no Node, npm or npx.
- The Rust toolchain (`cargo`) for the PDF library.
- Windows only: the .NET SDK (`dotnet`) with .NET Framework 4.8 targeting, for the Word add-in. The project pulls `Microsoft.NETFramework.ReferenceAssemblies` from NuGet.
- Windows only: PowerShell 7 (`pwsh`): `word/build.ps1` and `package.ts --zip` are run through it.
- Windows only, for the installer: Inno Setup 7.
- For `--aot` builds: a Bun canary build, which the build downloads itself (see below).
- Linux and macOS: the system libraries and tools in [Linux and macOS](#linux-and-macos).

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

For the PDF reader from source you need the native PDF library: `zn_pdf.dll` on Windows, `libzn_pdf.so` on Linux, `libzn_pdf.dylib` on macOS (next section).

## The native PDF library

`gpui-ui/native/pdf` is a Rust crate (`zn_pdf`, crate type `cdylib`). Build it with:

```
cd gpui-ui/native/pdf && cargo build --release
```

`gpui-ui/scripts/package.ts` runs this command itself, so a packaged build needs nothing extra. At run time the app (`gpui-ui/src/reader/pdf.ts`) looks for the library in this order: `ZN_PDF_DLL`, `%CARGO_TARGET_DIR%\release\zn_pdf.dll` (`$CARGO_TARGET_DIR/release/libzn_pdf.so` or `.dylib` elsewhere), a fixed shared-target path (Windows only), then `gpui-ui/native/pdf/target/release/<library>`. If you use a shared cargo target directory, set `CARGO_TARGET_DIR` and both `package.ts` and the app find the library there.

PDFium is not built. `bun gpui-ui/native/pdf/vendor/fetch-pdfium.ts` downloads a pinned archive from bblanchon/pdfium-binaries (release `chromium/8125`) for the OS and CPU it runs on, checks its SHA-256, and extracts the library into `gpui-ui/native/pdf/vendor/pdfium/`:

| Platform | Archive | Library |
| --- | --- | --- |
| Windows x64 | `pdfium-win-x64.tgz` | `bin/pdfium.dll` |
| Linux x64 or arm64 | `pdfium-linux-<cpu>.tgz` | `lib/libpdfium.so` |
| macOS arm64 or x64 | `pdfium-mac-<cpu>.tgz` | `lib/libpdfium.dylib` |

`package.ts` calls the script if the library is missing; `--force` fetches again. The PDF library loads PDFium from its own folder, so the two ship together; without PDFium it renders with `hayro`.

## The custom GPUIX addon

Windows only. The app uses a locally built `@gpuix/native` addon with cache regions. On Linux and macOS the npm binary is used as it is and the app works with whole-window redraws. On Windows, after every `bun install` in `gpui-ui` you must copy the custom addon over the npm binary again:

1. Build it from `ABorakati/gpuix`, branch `zn-cache` (private): in `packages/native` run `bun run build` (a napi release build with `test-support`).
2. Copy `packages/native/gpuix-native.win32-x64-msvc.node` over `gpui-ui/node_modules/@gpuix/native-win32-x64-msvc/gpuix-native.win32-x64-msvc.node`. The npm original is kept beside it as `.orig`.
3. Run `bun gpui-ui/scripts/build.ts` or `package.ts` after that, not before, so the custom file is the one embedded.

Without the custom addon, `cacheRegion` is ignored and the app works with whole-window redraws. The details, and how the fork's Zed submodule patches are kept, are in `gpui-ui/scripts/README.md`.

## Compiling the executable

`bun gpui-ui/scripts/build.ts` compiles the app to a single executable with `Bun.build`, for the OS and CPU it runs on (target `bun-windows-x64`, `bun-linux-x64` or `bun-darwin-arm64`). (The `bun build --compile` command cannot run the Solid Babel plugin, hence the script.) It writes into `gpui-ui/out/`. The names below are the Windows ones; on Linux and macOS the files have no `.exe`.

| Variant | Output | Notes |
| --- | --- | --- |
| `plain` | `zotero-next-gpui-plain.exe` | No bytecode, no minify |
| `bytecode` | `zotero-next-gpui-bytecode.exe` | Copied to `out/zotero-next-gpui.exe` as the default |
| `bytecode-min` | `zotero-next-gpui-bytecode-min.exe` | Bytecode plus minify |
| `aot` | `zotero-next-gpui-aot.exe` | Only with `--aot`; needs the canary (downloaded by the build) |

Options: `--variant <list>`, `--icons all` (embed every lucide icon instead of the ones `src/` mentions), `--hide-console` (Windows only), `--entry`, `--out`. The exe icon fix and `--hide-console` are Windows only. The version stamp and the update public key are baked in (see [Releasing](releasing.md)).

### The AOT canary

Stable Bun 1.4.4 has no ahead-of-time compiler. The `aot` variant uses the `compile.aot` option, which exists only in Bun canary builds. `build.ts` runs the other variants in the current Bun and then re-runs itself as `<canary>/bun scripts/build.ts --aot-only` to build the AOT variant. The global Bun is never touched. `gpui-ui/scripts/_bun-canary.ts` finds the canary, first match wins:

1. `ZN_BUN_CANARY`, the path of a canary `bun` (or `bun.exe`) you already have.
2. On Windows, the canary the Windows release has been built with, `1.4.5-canary.1+5f3f8fe48`, if it is at its usual path on the build machine.
3. The pinned daily canary from npm, `@oven/bun-<os>-<arch>@1.4.4-canary.20261116.1`. It reports itself as `1.4.5-canary.1+237bba51e`: the Windows canary's commit plus one AOT fix (oven-sh/bun#49081). npm keeps every daily canary, unlike GitHub's `canary` tag, which moves every day. The script downloads it once into `gpui-ui/out/tools/bun-<version>-<os>-<arch>/` and checks it against a SHA-512 in the script. `ZN_BUN_CANARY_DIR` puts that folder elsewhere. Packages are pinned for Linux x64 and arm64, macOS arm64 and x64, and Windows x64.

`bun gpui-ui/scripts/_bun-canary.ts` prints the path it would use, downloading first if needed. To move to a newer canary, change `CANARY_VERSION` and the five SHA-512 values (npm's `dist.integrity` for each package) together.

The compiled program is embedded under `B:/~BUN/root` on Windows and `/$bunfs/root` on Linux and macOS. `build.ts` picks the right one for the OS it runs on, for the worker paths and the `import.meta` rewrites below.

**Linux: memory-deny-write-execute.** On Linux, an executable built with `compile.aot` turns on `prctl(PR_SET_MDWE)` when it starts. It does not run without it, and there is no option to turn it off. After that, no code in the process can make memory executable. Mesa's software Vulkan driver (lavapipe) needs exactly that: it compiles shaders to CPU code while the app runs. So the Linux AOT build crashes at its first frame wherever Vulkan is software-rendered: virtual machines, WSL, machines without a GPU driver, and CI runners. A hardware Vulkan driver compiles shaders for the GPU instead, so the AOT build should run there, but this has not been tested. The Linux AOT build was tested in WSL with the setting held off by a debugger. With that, start-up, PDF extraction, the document-structure worker and the Zotero translators all worked. For this reason the AppImage is still built from bytecode by default (see [Releasing](releasing.md#linux-and-macos-packages)). macOS has no such setting.

In an AOT executable the workers (PDF extraction, document structure, Zotero translators) and the vendored code they load are compiled in. `build.ts` applies a list of source patches for this in the AOT variant only and fails if one no longer matches, so a change to those worker entry points can break the AOT build while leaving the others working. `gpui-ui/scripts/aot-bench.ts` is not part of the build: it benchmarks start-up and memory of running from sources against the compiled variants (`bun gpui-ui/scripts/aot-bench.ts --variants bytecode,aot`).

## Packaging

```
bun gpui-ui/scripts/package.ts --aot     # gpui-ui/out/package-aot/zotero-next-gpui/
bun gpui-ui/scripts/package.ts           # bytecode build into gpui-ui/out/package/zotero-next-gpui/
```

Add `--zip` to also write a zip (through `pwsh` on Windows, through `zip` elsewhere). `package.ts` runs the steps in order: `cargo build --release` for the PDF library, the PDFium fetch if needed, `scripts/build.ts` (with `--hide-console` on Windows), the pre-bundled translate worker (non-AOT only, `scripts/translate-worker.ts`), then assembles the folder: the exe, the PDF library, PDFium with its licences, the icon, `vendor/zotero` (translators, schema, and for non-AOT the framework), `vendor/document-worker/build`, `reader-host/dist` and `note-host/dist` when built (otherwise it warns that web tabs will be off), `README.txt` and `version.txt`. On Windows it then calls the signing hook, which does nothing unless configured (see [Releasing](releasing.md)).

Per OS, the files differ:

| | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Executable | `zotero-next-gpui.exe` | `zotero-next-gpui` | `zotero-next-gpui` |
| PDF library | `zn_pdf.dll` | `libzn_pdf.so` | `libzn_pdf.dylib` |
| PDFium | `pdfium.dll` | `libpdfium.so` | `libpdfium.dylib` |
| Icon | `icon.ico` | `icon.png` | `icon.png` |
| `--aot` | yes | yes (see [the Linux note](#the-aot-canary)) | yes |
| Signing | yes | no | no |

`bun gpui-ui/scripts/start-check.ts <package folder>` starts a packaged app on a throwaway library and exits 0 once the first items are loaded, or 1 if the app exits or 60 seconds pass first (`--seconds` changes that). It needs a display, as the app does.

The folder is self-contained: the exe finds its files next to itself (`gpui-ui/src/packaged.ts`). Inside a macOS app bundle the code sits in `Contents/MacOS` and the data in `Contents/Resources`; `packageDataDir()` in `packaged.ts` finds it there.

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

The connector component needs the extension sources in a sibling checkout `zotero-next-connector` (branch `zotero-next`), built with its own Bun build. Clone it with `git clone -b zotero-next https://github.com/ABorakati/zinc-connector.git zotero-next-connector` next to this repository; set `ZN_CONNECTOR_DIR` if it is elsewhere, or pass `--no-connector`. What the installer does and its command lines are in `gpui-ui/installer/README.md` and [Releasing](releasing.md).

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

## Linux and macOS

Linux (x64) and macOS (Apple Silicon) run Zinc from source and have a packaged build. The Word add-in (.NET), the installer (Inno Setup), the connector host and the sign-in helper (WebView2) are Windows only, and so is auto-update: the AppImage and the disk image are replaced by downloading a new release.

### Requirements

Both: Bun 1.4.4, `cargo`, and the one-time setup above (the document worker, reader and note editor builds use `bash`). The custom GPUIX addon is not used; the npm binary is.

Linux:

- `libxkbcommon-x11-0` and `libxcb-xkb1`. Without them the GPUIX addon does not load. Minimal systems such as WSL2 often lack them.
- For snapshots, EPUBs and the note editor: GTK 4 and WebKitGTK 6 (`libwebkitgtk-6.0-4`). Without them those open in the default app; the library, the PDF reader and sync do not need them.
- For printing: the GTK print dialog and CUPS (`gpui-ui/src/reader/printGtk.ts`).
- The web view is a GTK window over the app window, so the app runs on X11. On a Wayland desktop it runs under XWayland (`gpui-ui/src/shell/linuxDisplay.ts` switches it before GPUIX loads). `ZN_WAYLAND=1` keeps native Wayland, with no web view.

macOS:

- Apple Silicon only, because the GPUIX addon ships for arm64.
- The web view is a `WKWebView` placed into GPUI's view (`gpui-ui/src/webview/cocoa.ts`). Printing goes through PDFKit (`gpui-ui/src/reader/printMac.ts`).
- Xcode command line tools (for `cargo` and the system tools below).

### Running from source

The steps are the ones in [Running from source](#running-from-source), with `cargo build --release` in `gpui-ui/native/pdf` and `bun gpui-ui/native/pdf/vendor/fetch-pdfium.ts` for the PDF reader (the script picks the archive for your OS and CPU):

```
cd gpui-ui
ZN_DB=/path/to/library-COPY.sqlite bun src/main.tsx
```

Settings, state files and logs go in per-OS folders (`core/src/platform-dirs.ts`):

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Settings, logs | `%APPDATA%` | `~/Library/Application Support` | `$XDG_CONFIG_HOME` (`~/.config`) |
| Default library | `%APPDATA%` | `~/Library/Application Support` | `$XDG_DATA_HOME` (`~/.local/share`) |

An explicit `APPDATA` in the environment wins on every OS. Tests use that to point a run at a scratch folder.

### Packaging

```
bun gpui-ui/scripts/package.ts           # gpui-ui/out/package/zotero-next-gpui/
bun gpui-ui/scripts/appimage.ts          # Linux x64: gpui-ui/out/appimage/Zinc-<version>-x86_64.AppImage
bun gpui-ui/scripts/dmg.ts               # macOS: gpui-ui/out/dmg/Zinc-<version>-<arch>.dmg
```

`appimage.ts` and `dmg.ts` run `package.ts` first. With `--aot` they wrap the AOT build instead (`package.ts --aot`, `out/package-aot/zotero-next-gpui`); the file names and layout stay the same. Pass `--no-package` to reuse the existing folder, `--package <dir>` to wrap another folder, and `--out <dir>` to write elsewhere. The web parts (document worker, reader host, note host) must be built before either script, as for any package.

**AppImage** (`appimage.ts`, Linux x64 only):

- It builds an AppDir (`AppRun`, a `.desktop` file, the icon, and the package folder under `usr/lib/zinc/`) and runs appimagetool 1.9.1 with the type2-runtime 20251108.
- Both tools are pinned, checked against SHA-256 and downloaded once into `out/appimage/tools`. `ZN_APPIMAGETOOL` points at another appimagetool.
- appimagetool runs with `--appimage-extract-and-run`, so building needs no FUSE (WSL2 and containers work).
- It bundles `libxkbcommon-x11.so.0` and `libxcb-xkb.so.1` as a fallback in `usr/lib/zinc/lib`. `AppRun` puts that folder after the system's, so a system copy wins. The script finds the libraries with `ldconfig`, or in the folders of `ZN_APPIMAGE_LIB_DIRS` (a colon-separated list). It warns if it finds neither.
- It does not bundle glibc, X11, Vulkan, fontconfig, GTK 4 or WebKitGTK. It does not add itself to the desktop menu; AppImageLauncher or Gear Lever do that.
- Output: `Zinc-<version>-x86_64.AppImage` and a `.sha256` file. It has been built and smoke-tested in WSL2 (Ubuntu 26.04).

**Disk image** (`dmg.ts`, macOS only):

- It builds `Zinc.app`: code (the exe and the two dylibs) in `Contents/MacOS`, everything else in `Contents/Resources`, an `Info.plist`, and `Zinc.icns` made from `assets/icon.png` with `sips` and `iconutil`.
- It signs the bundle ad hoc (`codesign --sign -`), because Apple Silicon runs no unsigned code. With `ZN_MAC_SIGN_IDENTITY` set to a "Developer ID Application: ..." identity, it signs with that identity and the hardened runtime instead. It does not notarise. An ad-hoc signed app needs right-click, Open (or System Settings, Privacy and Security, Open Anyway) on first start.
- It writes a compressed UDZO image with `hdiutil`, holding `Zinc.app` and a link to Applications.
- Output: `Zinc-<version>-<arm64|x64>.dmg` and a `.sha256` file. It has not been run on a Mac yet; the first run will be the CI job (see [Releasing](releasing.md)).

`<version>` is the release part of the version stamp (see [Releasing](releasing.md)), so set `ZN_RELEASE` to name a release build.

## Windows notes

- `package.ts` uses your normal cargo setup, including a shared `CARGO_TARGET_DIR` if you have one; it does not override the target directory.
- A running `zotero-next-host.exe` is locked by the browser and cannot be overwritten; the installer builds the host straight into its staging folder for this reason.
