// Ahead-of-time compile the GPUI app to a single Windows executable with Bun.
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
//      is not embedded: package.ts ships pdf-worker.ts and the document-worker build next to the exe and src/services.ts points the pool at them.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import solidBunPlugin from "@gpuix/solid/bun-plugin";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, ".."); // C:\Users\abora\zotero-next: the virtual embedded root mirrors this tree
const repoName = "gpui-ui";
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

interface Variant { id: string; bytecode: boolean; minify: boolean; bytecodeOrder?: string[] }
const VARIANTS: Variant[] = [
	{ id: "plain", bytecode: false, minify: false },
	{ id: "bytecode", bytecode: true, minify: false },
	{ id: "bytecode-min", bytecode: true, minify: true },
];
if (bytecodeOrder) VARIANTS.push({ id: "bytecode-min-profile", bytecode: true, minify: true, bytecodeOrder: bytecodeOrder.split(",") });
const best = arg("best", "bytecode")!; // which variant is copied to out/zotero-next-gpui.exe

const wanted = arg("variant");
const todo = wanted && wanted !== "true" ? VARIANTS.filter((v) => wanted.split(",").includes(v.id)) : VARIANTS;
if (!todo.length) throw new Error(`unknown --variant ${wanted}; have ${VARIANTS.map((v) => v.id).join(", ")}`);

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
	const text = walk(join(root, "src")).filter((f) => /\.(tsx?|json)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
	const words = new Set(text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []);
	// icons.tsx also accepts lucide-solid component names (FileText -> file-text, Table2 -> table-2)
	const kebab = (w: string) => w.replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/([A-Za-z])(\d)/g, "$1-$2").toLowerCase();
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
			if (path === join(root, "src", "core.ts")) {
				src = src.replace(/import\(\s*dir\s*\+\s*"([\w./-]+)"\s*\)/g, (_m, n: string) => (shimmed++, `import("../../core/src/${n}")`));
				if (shimmed) console.log(`[zn-core-shim] src/core.ts: ${shimmed} variable import(dir + ...) -> literal`);
			}
			META.lastIndex = 0;
			if (!META.test(src)) {
				if (!shimmed) return undefined; // fall through to the default loader / the Solid plugin
				return { contents: src, loader: "ts" };
			}
			const rel = relative(repo, path).split(sep).join("/");
			const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
			// `import.meta.url` inside the replacement is the ENTRY's url at run time (file:///B:/~BUN/root/<exe>)
			const out = src.replace(META, (_m, k: string) => {
				switch (k) {
					case "url": return `new URL(${JSON.stringify(rel)}, import.meta.url).href`;
					case "dir":
					case "dirname": return `(import.meta.dir + ${JSON.stringify("/" + relDir)})`;
					default: return `(import.meta.dir + ${JSON.stringify("/" + rel)})`; // path, filename
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

// ---- build ----------------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const staged = stageAssets();
const sizeMB = (p: string) => (statSync(p).size / 1048576).toFixed(1);

for (const v of todo) {
	const outfile = join(outDir, `zotero-next-gpui-${v.id}.exe`);
	rmSync(outfile, { force: true });
	const t0 = performance.now();
	const result = await Bun.build({
		entrypoints: [entry],
		target: "bun",
		format: "esm",
		minify: v.minify,
		bytecode: v.bytecode,
		sourcemap: "none",
		plugins: [nativePlugin, metaPlugin, solidBunPlugin],
		compile: {
			target: "bun-windows-x64",
			outfile,
			assets: staged.roots,
			autoloadBunfig: false,
			autoloadDotenv: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
			...(v.bytecodeOrder ? { bytecodeOrder: v.bytecodeOrder } : {}),
			windows: { hideConsole, icon: join(root, "..", "app", "assets", "icon.ico"), title: "zotero-next", description: "zotero-next (GPUI)", version: "0.0.1.0" },
		},
	});
	if (!result.success) {
		for (const m of result.logs) console.error(m);
		throw new Error(`build ${v.id} failed`);
	}
	for (const m of result.logs) console.warn(`[${v.id}] ${m.message ?? m}`);
	console.log(`[${v.id}] ${relative(root, outfile)}  ${sizeMB(outfile)} MB  (${((performance.now() - t0) / 1000).toFixed(1)} s; assets: ${staged.note})`);
}

const pick = join(outDir, `zotero-next-gpui-${best}.exe`);
if (existsSync(pick)) {
	cpSync(pick, join(outDir, "zotero-next-gpui.exe"));
	console.log(`out/zotero-next-gpui.exe <- ${best}`);
}
