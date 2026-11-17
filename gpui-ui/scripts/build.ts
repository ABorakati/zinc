// Ahead-of-time compile the GPUI app to a single executable with Bun, for the OS and CPU it runs on: zotero-next-gpui-<variant>.exe on
// Windows, zotero-next-gpui-<variant> (no extension) on Linux and macOS. The exe icon and --hide-console are Windows only.
//
//   bun scripts/build.ts                         # all variants -> out/zotero-next-gpui-<variant>.exe, best copied to out/zotero-next-gpui.exe
//   bun scripts/build.ts --variant bytecode      # one (or comma list): plain | bytecode | bytecode-min [| bytecode-min-profile]
//   bun scripts/build.ts --icons all             # embed every lucide icon (default: only the names src/ mentions)
//   bun scripts/build.ts --hide-console          # --windows-hide-console (off by default so a startup error stays visible)
//   bun scripts/build.ts --entry src/main.tsx    # default entry
//   bun scripts/build.ts --bytecode-order a.txt  # adds the bytecode-min-profile variant (BUN_BYTECODE_ORDER_OUT profile)
//
// The CLI cannot do this build (`bun build --compile` has no way to run the Solid babel plugin), so it is Bun.build. Equivalent flags:
//   --compile --target=bun-windows-x64 --format=esm [--bytecode] [--minify] --no-compile-autoload-bunfig --asset <staged dirs>
//
// What the script solves without touching src/ (details in the final report):
//   1. Solid JSX: src/*.tsx is compiled by babel-preset-solid (universal) via @gpuix/solid/bun-plugin, normally registered at run time
//      by bunfig.toml `preload`. Bun.build gets the same plugin. The exe must not autoload bunfig.toml (autoloadBunfig:false), or it
//      would try to resolve "@gpuix/solid/preload" from the cwd.
//   2. @gpuix/native/index.js loads the addon with createRequire(import.meta.url)("@gpuix/native-win32-x64-msvc"), invisible to the
//      bundler. A resolve plugin points `@gpuix/native` at index.cjs, whose plain require() the bundler embeds (the .node is inside the exe).
//   3. Runtime file reads relative to import.meta.url (fonts.ts: ../assets/fonts, icons.tsx: ../node_modules/lucide-static/icons,
//      core: ../../core/vendor/...). In an exe every module reports the ENTRY's url (B:/~BUN/root/<exe>), so "../assets" would land
//      outside the embedded tree. A load plugin rewrites import.meta.url/dir/path/dirname/filename in repo sources to the module's
//      repo-relative virtual location under the embedded root; assets are staged in out/stage with the same repo-relative layout and
//      embedded with compile.assets.
//   4. src/core.ts imports the core with a variable specifier (import(dir + "server")), which the bundler cannot follow. The same load
//      plugin rewrites those three calls to literal specifiers so the core (and its wasm via `with { type: "file" }`, schema.json) is
//      bundled. Proper fix: make them literal in src/core.ts. The PDF text-extraction Worker (core/src/extract/pool.ts)
//      is not embedded in the bytecode build: package.ts ships pdf-worker.ts and the document-worker build next to the exe and src/services.ts points the pool at them.
//   5. aot variant only: the workers (PDF extraction, document structure, Zotero translators) ARE compiled in as extra entry points, with
//      the vendored code they load from disk made static (see "AOT: workers" below). package.ts --aot ships only data next to that exe.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import solidBunPlugin from "@gpuix/solid/bun-plugin";
import { fixExeIcon } from "./fix-exe-icon";
import { canaryBun } from "./_bun-canary";
import { BUILD_VERSION } from "./_version";
import { DEFAULT_UPDATE_URL, updatePubkey } from "./_update-key";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, ".."); // C:\Users\abora\zotero-next: the virtual embedded root mirrors this tree
const repoName = "gpui-ui";

// BUILD_VERSION is "0.1.0+<commit>-<yyyymmdd>": the release number, the repo commit it was built from and the build date (logs, crash
// reports). It lives in scripts/_version.ts so package.ts and installer.ts stamp the same value.
process.chdir(root);

function arg(name: string, fallback: string | null = null): string | null {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = process.argv[i + 1];
	return v && !v.startsWith("--") ? v : "true";
}

const entry = arg("entry", "src/main.tsx")!;
const outDir = resolve(root, arg("out", "out")!);
const iconMode = arg("icons", "used")!; // used | all
const hideConsole = arg("hide-console") === "true";
const bytecodeOrder = arg("bytecode-order");

interface Variant {
	id: string;
	bytecode: boolean;
	minify: boolean;
	bytecodeOrder?: string[];
	aot?: boolean;
}
const VARIANTS: Variant[] = [
	{ id: "plain", bytecode: false, minify: false },
	{ id: "bytecode", bytecode: true, minify: false },
	{ id: "bytecode-min", bytecode: true, minify: true },
];
if (bytecodeOrder) VARIANTS.push({ id: "bytecode-min-profile", bytecode: true, minify: true, bytecodeOrder: bytecodeOrder.split(",") });
const best = arg("best", "bytecode")!; // which variant is copied to out/zotero-next-gpui.exe

// --aot: an extra `aot` variant (compile.aot: true), which only Bun's canary can build (stable 1.4.4 has no AOT compiler). Run under
// stable Bun, the other variants build in-process and the aot variant is then built by a child run under the canary (scripts/_bun-canary.ts:
// env ZN_BUN_CANARY, else on Windows the local 1.4.5-canary.1+5f3f8fe48, else the pinned npm canary, downloaded once into out/tools; the
// global bun is never touched). The child is this same script with --aot-only, so it can also be started by hand with the canary:
// `<canary>/bun scripts/build.ts --aot-only`. Windows, Linux and macOS all build it.
// --explain[=report] adds compile.aotExplain (default report "text": the slow-path list). --aot-trim adds compile.trim.
const aotOnly = process.argv.includes("--aot-only");
const wantAot = aotOnly || process.argv.includes("--aot");
const AOT: Variant = { id: "aot", bytecode: false, minify: false, aot: true };
const wanted = arg("variant");
const known = wantAot ? [...VARIANTS, AOT] : VARIANTS;
let todo = wanted && wanted !== "true" ? known.filter((v) => wanted.split(",").includes(v.id)) : [...VARIANTS, ...(wantAot ? [AOT] : [])];
if (aotOnly) todo = todo.filter((v) => v.aot);
if (!todo.length) throw new Error(`unknown --variant ${wanted}; have ${known.map((v) => v.id).join(", ")}`);
const runAotInChild = !aotOnly && todo.some((v) => v.aot);
if (runAotInChild) todo = todo.filter((v) => !v.aot);

// ---- staged assets (mirrors the repo tree, so import.meta-relative reads resolve inside the exe) --------------------------------
function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

/** lucide icons whose kebab name occurs as a word in src/ (superset of what icons.tsx will ask for), plus the fallback. */
function usedIcons(): string[] {
	const dir = join(root, "node_modules/lucide-static/icons");
	const all = readdirSync(dir).filter((f) => f.endsWith(".svg"));
	if (iconMode === "all") return all;
	const text = walk(join(root, "src"))
		.filter((f) => /\.(tsx?|json)$/.test(f))
		.map((f) => readFileSync(f, "utf8"))
		.join("\n");
	const words = new Set(text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []);
	// icons.tsx also accepts lucide-solid component names (FileText -> file-text, Table2 -> table-2)
	const kebab = (w: string) =>
		w
			.replace(/([a-z\d])([A-Z])/g, "$1-$2")
			.replace(/([A-Za-z])(\d)/g, "$1-$2")
			.toLowerCase();
	for (const w of [...words]) words.add(kebab(w));
	words.add("circle-help"); // icons.tsx FALLBACK
	return all.filter((f) => words.has(f.slice(0, -4)));
}

const stage = join(outDir, "stage");
function stageAssets(): { roots: string[]; note: string } {
	rmSync(stage, { recursive: true, force: true });
	const g = join(stage, repoName);
	cpSync(join(root, "assets"), join(g, "assets"), { recursive: true });
	const icons = usedIcons();
	mkdirSync(join(g, "node_modules/lucide-static/icons"), { recursive: true });
	for (const f of icons) cpSync(join(root, "node_modules/lucide-static/icons", f), join(g, "node_modules/lucide-static/icons", f));
	const roots = [g];
	const note = `${icons.length} icons`;
	// The in-process core needs no staged files: its wasm is a `with { type: "file" }` import (embedded by Bun) and schema.json is a JSON import.
	return { roots, note };
}

// ---- plugins --------------------------------------------------------------------------------------------------------------
const nativeCjs = resolve(root, "node_modules/@gpuix/native/index.cjs");
const nativePlugin: Bun.BunPlugin = {
	name: "gpuix-native-static-require",
	setup(build) {
		build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({ path: nativeCjs }));
	},
};

// Set per variant in the build loop. In an AOT exe every module's import.meta.* is its own (compiled-in) location, NOT the entry's, and
// the embedded tree is laid out differently: its root is the common ancestor of the entry points (the repo, since the aot variant's
// workers include core/ ones; without them it was gpui-ui), and compile.assets keep their path relative to it (gpui-ui/out/stage/gpui-ui/...).
// So the rewrite below maps a repo path to the staged assets' location, not to the entry's import.meta.dir (aot variant only).
// EMBED is where the exe embeds its tree: B:/~BUN/root on Windows, /$bunfs/root on Linux and macOS (file:///B:/~BUN/root/x and
// file:///$bunfs/root/x as URLs).
let currentAot = false;
const isWin = process.platform === "win32";
const EMBED = isWin ? "B:/~BUN/root" : "/$bunfs/root";
const fileUrl = (p: string) => (isWin ? `file:///${p}` : `file://${p}`);
const AOT_ROOT = `${EMBED}/${relative(repo, join(outDir, "stage")).split(sep).join("/")}`;

// ---- AOT: workers and code that used to load from disk ----------------------------------------------------------------------------
// An AOT exe refuses import()/require()/new Worker() of code that is not in it. The three worker families (PDF text extraction, the
// document-structure worker, the Zotero translators) and the code they load from disk are therefore compiled in: each worker is an extra
// entry point, and the sources below are patched (aot variant only; sources and the bytecode build are untouched) so that
//   * `new Worker(...)` gets the worker's embedded path (an entry point sits at <EMBED>/<path relative to the repo>),
//   * the runtime import()/createRequire() of vendored code gets a literal specifier the bundler can follow.
// Data (cmaps, fonts, wasm, models, translators text, schema.json) is read with fs from the package folder as before.
const AOT_WORKERS = {
	pdf: "../core/src/extract/pdf-worker.ts",
	doc: "src/reader/structure/docworker-entry.ts",
	translate: "../core/src/translate/worker.ts",
} as const;
const embeddedPath = (rel: string) => `${EMBED}/${relative(repo, resolve(root, rel)).split(sep).join("/")}`;
const abs = (rel: string) => join(root, rel);

// Zotero translate framework + utilities: modules the translation runtime require()s by computed path (runtime/zotero.ts rt()/ut()).
const TRANSLATE_RT = [
	"promise",
	"debug",
	"utilities_translate",
	"translators",
	"translator",
	"translation/translate",
	"tlds",
	"proxy",
	"rdf/init",
];
const TRANSLATE_UT = [
	"openurl",
	"date",
	"utilities",
	"xregexp-all",
	"utilities_item",
	"xregexp-unicode-zotero",
	"schema.js",
	"resource/dateFormats.json",
	"cachedTypes",
	"resource/zoteroTypeSchemaData",
];
const staticRequires = (fn: string, kind: "translate/src" | "utilities", names: string[]) => {
	const cases = names
		.map((n) => `\t\tcase ${JSON.stringify(n)}: return require(${JSON.stringify(`../../../vendor/zotero/${kind}/${n}`)});`)
		.join("\n");
	return `const ${fn} = (p: string): any => { switch (p) {\n${cases}\n\t\tdefault: throw new Error("zotero module not compiled in: " + p); } };`;
};

/**
 * [file, from (string or regexp), to] edits applied to repo sources in the aot variant. A miss is an error: the shim has gone stale.
 * Where `bun fmt` may wrap the code differently as it changes, `from` is a regexp that allows any whitespace between the tokens.
 */
const AOT_PATCHES: [string, string | RegExp, string][] = [
	// PDF text extraction
	[
		abs("../core/src/extract/pool.ts"),
		/this\.worker = new Worker\(\s*WORKER_ENTRY\.href,\s*docWorkerDir \?/,
		`this.worker = new Worker(${JSON.stringify(embeddedPath(AOT_WORKERS.pdf))}, false ?`,
	],
	[
		abs("../core/src/extract/pdf-worker.ts"),
		"await import(workerPath);",
		'// @ts-ignore: an untyped JS bundle\nawait import("../../../vendor/document-worker/build/worker.js");',
	],
	// document structure (reading layout)
	[
		abs("src/reader/structure/worker.ts"),
		'const bundle = join(WORKER_DIR, "worker.js");',
		'const bundle = join(WORKER_DIR, "metadata.json"); // the engine itself is compiled in; this only proves the data folder is there',
	],
	[
		abs("src/reader/structure/worker.ts"),
		'new Worker(entry ? pathToFileURL(entry).href : new URL("./docworker-entry.ts", import.meta.url).href)',
		`new Worker(${JSON.stringify(embeddedPath(AOT_WORKERS.doc))})`,
	],
	[abs("src/reader/structure/worker.ts"), /if \(entry && !existsSync\(entry\)\)\s*throw/, "if (false) throw"],
	[
		abs("src/reader/structure/docworker-entry.ts"),
		"await import(`${root}/vendor/document-worker/build/worker.js`);",
		'// @ts-ignore: an untyped JS bundle\nawait import("../../../../vendor/document-worker/build/worker.js");',
	],
	[
		abs("src/reader/structure/load.ts"),
		'import(pathToFileURL(join(SDT_DIR, "pack", "reader.js")).href)',
		'import("../../../../vendor/reader/structured-document-text/src/pack/reader.js")',
	],
	[
		abs("src/reader/structure/load.ts"),
		'import(pathToFileURL(join(SDT_DIR, "version.js")).href)',
		'import("../../../../vendor/reader/structured-document-text/src/version.js")',
	],
	[abs("src/services.ts"), 'join(buildDir, "worker.js")', 'join(buildDir, "metadata.json")'],
	// WebAssembly. An AOT exe has no JIT, so a module it builds from bytes at run time is interpreted (Find Full Text's fx_inspect ran ~70x
	// slower, the structure worker's ONNX model ~4x). Only a `.wasm` the build has seen is compiled to machine code, and `with { type: "file" }`
	// hides it from the compiler (file loader): the same import without the attribute gives the same path string, plus a compiled copy that
	// the runtime finds by content, whether the module is later built from Bun.file(path), readFileSync(path) or bytes posted from another
	// thread. The source keeps the attribute (stable Bun, tests and the bytecode build need it). Skipped when fulltext.wasm is the empty
	// placeholder CI builds use (the file then stays a plain embedded file, as in the bytecode build; Find Full Text is not in those builds).
	...((statSync(abs("../core/vendor/fulltext-wasm/fulltext.wasm"), { throwIfNoEntry: false })?.size
		? [[abs("../core/src/fulltext/wasm.ts"), 'fulltext.wasm" with { type: "file" };', 'fulltext.wasm";']]
		: []) as [string, string, string][]),
	// The document worker's wasm (onnxruntime-web, pdf.js's openjpeg and jbig2) reaches it as bytes read from vendor/document-worker/build by
	// the host (worker.ts FetchWasm/FetchData). Importing the same files here makes the build compile them; those bytes then match at run time.
	// The files stay on disk (the host still reads them), so the package folder keeps its copy.
	[
		abs("src/reader/structure/docworker-entry.ts"),
		"const g = globalThis as Record<string, unknown>;",
		["onnx/ort-wasm-simd-threaded", "wasm/openjpeg", "wasm/jbig2"]
			.map(
				(n) =>
					`// @ts-ignore: a wasm file, imported only so the AOT build compiles it\nimport "../../../../vendor/document-worker/build/${n}.wasm";`,
			)
			.join("\n") + "\nconst g = globalThis as Record<string, unknown>;",
	],
	// Zotero translators
	[
		abs("../core/src/translate/pool.ts"),
		"new Worker(WORKER_ENTRY.href, {",
		`new Worker(${JSON.stringify(embeddedPath(AOT_WORKERS.translate))}, {`,
	],
	[
		abs("../core/src/translate/runtime/zotero.ts"),
		'const rt = (p: string) => req(join(VENDOR_DIR, "translate", "src", p));',
		staticRequires("rt", "translate/src", TRANSLATE_RT),
	],
	[
		abs("../core/src/translate/runtime/zotero.ts"),
		'const ut = (p: string) => req(join(VENDOR_DIR, "utilities", p));',
		staticRequires("ut", "utilities", TRANSLATE_UT),
	],
	[abs("../core/src/translate/runtime/dom.ts"), /\breq\(("jsdom"|"wicked-good-xpath"|"w3c-xmlserializer")\)/g, "require($1)"],
];

const META = /import\.meta\.(url|dir|path|dirname|filename)\b/g;
const inRepo = (p: string) => p.startsWith(repo + sep) && !p.includes(`${sep}node_modules${sep}`) && !p.startsWith(join(root, "out") + sep);

/** Rewrites import.meta.* in repo sources (not node_modules) to the module's repo-relative virtual path under the exe's embedded root. */
const metaPlugin: Bun.BunPlugin = {
	name: "zn-import-meta",
	setup(build) {
		build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
			if (!inRepo(path)) return undefined;
			let src = await Bun.file(path).text();
			// src/core.ts imports the core with a VARIABLE specifier (import(dir + "server")); the bundler cannot follow that, so the
			// core would not be in the exe (and at run time it would load the loose sources from disk, where bare packages fail to
			// resolve). Turn each into a literal specifier so it is bundled (still a lazy dynamic import).
			let shimmed = 0;
			if (currentAot) {
				for (const [file, from, to] of AOT_PATCHES) {
					if (file !== path) continue;
					const before = src;
					// a function replacement keeps "$" literal ("/$bunfs/root/..."); only the require($1) patch uses a group reference
					src = /\$\d/.test(to) ? src.replace(from, to) : src.replace(from, () => to);
					if (src === before)
						throw new Error(`[zn-aot-patch] ${relative(repo, path)}: pattern not found: ${String(from).slice(0, 70)}`);
					shimmed++;
				}
				if (shimmed) console.log(`[zn-aot-patch] ${relative(repo, path)}: ${shimmed} edit(s)`);
			}
			if (path === join(root, "src", "core.ts")) {
				src = src.replace(
					/import\(\s*dir\s*\+\s*"([\w./-]+)"\s*\)/g,
					(_m, n: string) => (shimmed++, `import("../../core/src/${n}")`),
				);
				if (shimmed) console.log(`[zn-core-shim] src/core.ts: ${shimmed} variable import(dir + ...) -> literal`);
			}
			// src/prefetch.ts: the worker is started from a hard-coded embedded path ("<EMBED>/prefetch-worker.js", where the bytecode
			// build puts its second entry point). In an AOT exe the relative forms (`"./x.ts"`, `new URL("./x.ts", import.meta.url)`) did not resolve at run time; the absolute embedded path does (the file is the second entry point).
			// Proper fix: do that in src/prefetch.ts for compiled and source runs alike.
			if (currentAot && path === join(root, "src", "prefetch.ts")) {
				const before = src;
				const from = /new Worker\(\s*compiled \? embedded : new URL\("\.\/prefetch-worker\.ts", import\.meta\.url\)\.href\s*\)/;
				src = src.replace(from, () => `new Worker(${JSON.stringify(`${EMBED}/gpui-ui/src/prefetch-worker.ts`)})`);
				if (src === before) throw new Error("[zn-aot-shim] src/prefetch.ts: pattern not found (the worker start changed)");
				shimmed++;
				console.log("[zn-aot-shim] src/prefetch.ts: embedded worker path");
			}
			META.lastIndex = 0;
			if (!META.test(src)) {
				if (!shimmed) return undefined; // fall through to the default loader / the Solid plugin
				return { contents: src, loader: "ts" };
			}
			const rel = relative(repo, path).split(sep).join("/");
			const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
			// `import.meta.url` inside the replacement is the ENTRY's url at run time (file:///B:/~BUN/root/<exe> on Windows)
			const out = src.replace(META, (_m, k: string) => {
				if (currentAot) {
					switch (k) {
						case "url":
							return `new URL(${JSON.stringify(rel)}, ${JSON.stringify(fileUrl(`${AOT_ROOT}/`))}).href`;
						case "dir":
						case "dirname":
							return JSON.stringify(`${AOT_ROOT}/${relDir}`);
						default:
							return JSON.stringify(`${AOT_ROOT}/${rel}`); // path, filename
					}
				}
				switch (k) {
					case "url":
						return `new URL(${JSON.stringify(rel)}, import.meta.url).href`;
					case "dir":
					case "dirname":
						return `(import.meta.dir + ${JSON.stringify("/" + relDir)})`;
					default:
						return `(import.meta.dir + ${JSON.stringify("/" + rel)})`; // path, filename
				}
			});
			const jsx = /\.[cm]?[jt]sx$/.test(path);
			const ts = /\.[cm]?tsx?$/.test(path);
			if (!jsx) return { contents: out, loader: ts ? "ts" : "js" };
			// same babel setup as @gpuix/solid/bun-plugin (which would otherwise have loaded this file)
			const res = await transformAsync(out, {
				filename: path,
				configFile: false,
				babelrc: false,
				presets: [[solidPreset, { generate: "universal", moduleName: "@gpuix/solid" }], ...(ts ? [[typescript]] : [])] as never,
			});
			return { contents: res?.code ?? out, loader: "js" };
		});
	},
};

const explainArg = process.argv.find((a) => a === "--explain" || a.startsWith("--explain="));
const aotOptions = {
	aot: true,
	...(explainArg ? { aotExplain: [explainArg.includes("=") ? explainArg.split("=")[1]! : "text"] } : {}),
	...(process.argv.includes("--aot-trim") ? { trim: true } : {}),
} as Record<string, unknown>; // not yet in bun-types

// ---- build ----------------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const staged = stageAssets();
const sizeMB = (p: string) => (statSync(p).size / 1048576).toFixed(1);

const EXE = isWin ? ".exe" : "";
const compileTarget = `bun-${isWin ? "windows" : process.platform}-${process.arch}`; // bun-windows-x64, bun-linux-x64, bun-darwin-arm64

for (const v of todo) {
	const outfile = join(outDir, `zotero-next-gpui-${v.id}${EXE}`);
	rmSync(outfile, { force: true });
	const t0 = performance.now();
	currentAot = !!v.aot;
	const result = await Bun.build({
		entrypoints: [entry, "src/prefetch-worker.ts", ...(v.aot ? Object.values(AOT_WORKERS) : [])], // the worker of src/prefetch.ts is a second entry point: Bun embeds it and `new Worker("./prefetch-worker.ts")` finds it
		target: "bun",
		format: "esm",
		minify: v.minify,
		// stamp the build into the logs and crash reports (core/src/log.ts reads these; the packaged exe has no env for them)
		// ZN_UPDATE_PUBKEY / ZN_UPDATE_URL: the auto-update public key and default feed (src/update/config.ts, scripts/_update-key.ts)
		define: {
			"process.env.ZN_VERSION": JSON.stringify(BUILD_VERSION),
			"process.env.ZN_BUILD_VARIANT": JSON.stringify(v.aot ? "aot" : "bytecode"),
			"process.env.ZN_UPDATE_PUBKEY": JSON.stringify(updatePubkey()),
			// an empty ZN_UPDATE_URL (an unset CI variable) counts as unset: the latest release's feed (Linux/macOS read latest-<platform>.json next to it)
			"process.env.ZN_UPDATE_URL": JSON.stringify(process.env.ZN_UPDATE_URL || DEFAULT_UPDATE_URL),
		},
		bytecode: v.bytecode && !v.aot, // AOT replaces bytecode
		sourcemap: "none",
		external: v.aot ? ["canvas"] : [], // jsdom's optional native peer (try { require("canvas") }): left out, jsdom runs without canvas support
		plugins: [nativePlugin, metaPlugin, solidBunPlugin],
		compile: {
			target: compileTarget as "bun-windows-x64",
			outfile,
			assets: staged.roots,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
			...(v.bytecodeOrder ? { bytecodeOrder: v.bytecodeOrder } : {}),
			...(v.aot ? aotOptions : {}),
			...(isWin
				? {
						windows: {
							hideConsole,
							icon: join(root, "assets", "icon.ico"),
							title: "Zinc",
							description: "Zinc",
							version: "0.0.1.0",
						},
					}
				: {}),
		},
	});
	if (!result.success) {
		for (const m of result.logs) console.error(m);
		throw new Error(`build ${v.id} failed`);
	}
	for (const m of result.logs) console.warn(`[${v.id}] ${m.message ?? m}`);
	// Bun leaves its template's one-image icon group first, pointing at our 16 px image: re-point it (scripts/fix-exe-icon.ts)
	if (isWin) console.log(`[${v.id}] exe icon: ${fixExeIcon(outfile)}`);
	console.log(
		`[${v.id}] ${relative(root, outfile)}  ${sizeMB(outfile)} MB  (${((performance.now() - t0) / 1000).toFixed(1)} s; assets: ${staged.note})`,
	);
}

const pick = join(outDir, `zotero-next-gpui-${best}${EXE}`);
if (!aotOnly && existsSync(pick)) {
	cpSync(pick, join(outDir, `zotero-next-gpui${EXE}`));
	console.log(`out/zotero-next-gpui${EXE} <- ${best}`);
}

if (runAotInChild) {
	// the aot variant needs the canary: re-run this script under it (--aot-only), forwarding the options that matter
	const fwd: string[] = [];
	for (const f of ["entry", "out", "icons", "best"]) {
		const v = arg(f);
		if (v) fwd.push(`--${f}`, v);
	}
	if (hideConsole) fwd.push("--hide-console");
	for (const a of process.argv.slice(2)) if (a.startsWith("--explain") || a === "--aot-trim") fwd.push(a);
	const bun = await canaryBun();
	console.log(`[aot] building under the canary: ${bun}`);
	const r = Bun.spawnSync([bun, join(root, "scripts", "build.ts"), "--aot-only", ...fwd], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (r.exitCode !== 0) throw new Error(`aot build failed (exit ${r.exitCode})`);
}
