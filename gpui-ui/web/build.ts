// Build the browser demo of the app (web/main.tsx) into <out> (default gpui-ui/out/web-demo):
//   bun web/build.ts [--out <dir>] [--db <demo library.sqlite>] [--styles <collection-style.json>]
// Node and Bun built-ins map to the browser stand-ins in web/shims (an in-memory file system, path, os, url, a hash) and to
// web/sqlite.ts (bun:sqlite on SQLite WebAssembly); anything else Node-only becomes a stub that throws if it is ever called, with
// exactly the names the code imports (learned from the bundler's errors). The demo library is copied, never the real one.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import solidPlugin from "@gpuix/solid/bun-plugin";

const here = import.meta.dir;
const root = resolve(here, "..");
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = resolve(arg("out") ?? join(root, "out", "web-demo"));
const db = arg("db");
if (db && /zotero-next[\\/]data[\\/]library\.sqlite$/i.test(db)) throw new Error("refusing to publish the real library: pass a demo library");

const SHIMS: Record<string, string> = {
	"node:fs": "shims/fs.ts", fs: "shims/fs.ts",
	"node:fs/promises": "shims/fs-promises.ts", "fs/promises": "shims/fs-promises.ts",
	"node:path": "shims/path.ts", path: "shims/path.ts", "node:path/win32": "shims/path.ts", "node:path/posix": "shims/path.ts",
	"node:os": "shims/small.ts", os: "shims/small.ts", "node:url": "shims/small.ts", url: "shims/small.ts", "node:crypto": "shims/small.ts", crypto: "shims/small.ts",
	"bun:sqlite": "sqlite.ts",
};
// util, stream, events, buffer, assert, string_decoder, querystring and timers are left to Bun's own browser polyfills (its zlib
// polyfill lacks the *Sync functions the core imports, so zlib stays a stub)
const POLYFILLED = /^(node:)?(util|stream|events|buffer|assert|string_decoder|querystring|timers)$/;
const BUILTIN = /^(node:|bun:|bun$|child_process$|worker_threads$|http$|https$|net$|module$|readline$|tty$|v8$|perf_hooks$|dns$|tls$|process$|vm$|webview-bun$)/;
const names = new Map<string, Set<string>>();
const READER_PDF = join(root, "src", "reader", "pdf");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let result: Awaited<ReturnType<typeof Bun.build>> | undefined;
for (let pass = 0; pass < 80; pass++) {
	result = await Bun.build({
		// globals.ts as its own entry, run by the page before main.js: shared chunks would otherwise run before it sets `process`
		entrypoints: [join(here, "globals.ts"), join(here, "main.tsx")],
		outdir: out,
		target: "browser",
		format: "esm",
		splitting: true,
		minify: !process.argv.includes("--debug"),
		throw: false,
		naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [
			solidPlugin,
			{
				name: "web-demo-shims",
				setup(b) {
					b.onResolve({ filter: /.*/ }, (a) => (SHIMS[a.path] ? { path: join(here, SHIMS[a.path]!) } : undefined));
					// the reader's PDF engine: zn_pdf.dll over bun:ffi on the desktop, PDFium WebAssembly here (web/pdf.ts)
					b.onResolve({ filter: /(^|\/)pdf$/ }, (a) => (a.importer && resolve(dirname(a.importer), a.path) === READER_PDF ? { path: join(here, "pdf.ts") } : undefined));
					b.onResolve({ filter: BUILTIN }, (a) => (POLYFILLED.test(a.path) ? undefined : { path: a.path, namespace: "stub" }));
					b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => {
						const list = [...(names.get(a.path) ?? [])];
						const body = list.map((n) => `export const ${n} = __stub(${JSON.stringify(`${a.path} ${n}`)});`).join("\n");
						return {
							contents: `const __stub = (n) => new Proxy(function () { throw new Error("not available in the browser demo: " + n); }, { get: (t, k) => (k === "prototype" ? {} : undefined) });\n${body}\nexport default {};`,
							loader: "js",
						};
					});
				},
			},
		],
	});
	if (result.success) break;
	let learned = 0;
	for (const l of result.logs) {
		const m = /No matching export in "stub:([^"]+)" for import "([^"]+)"/.exec(String(l));
		if (!m) continue;
		const s = names.get(m[1]!) ?? new Set<string>();
		if (!s.has(m[2]!)) { s.add(m[2]!); learned++; }
		names.set(m[1]!, s);
	}
	if (!learned) break;
}
if (!result?.success) {
	for (const l of result?.logs ?? []) console.error(String(l).slice(0, 400));
	throw new Error("web demo build failed");
}

// what main.tsx fetches next to the bundle: the demo library, the Lucide icons (src/icons.tsx reads them from disk), the collection
// colours and icons
const iconDir = join(root, "node_modules", "lucide-static", "icons");
const icons: Record<string, string> = {};
for (const f of readdirSync(iconDir)) if (f.endsWith(".svg")) icons[f.slice(0, -4)] = readFileSync(join(iconDir, f), "utf8");
writeFileSync(join(out, "icons.json"), JSON.stringify(icons));
if (db) cpSync(db, join(out, "library.sqlite"));
// SQLite's WebAssembly binary: its loader fetches sqlite3.wasm next to the chunk that holds it (the output root)
cpSync(join(root, "node_modules", "@sqlite.org", "sqlite-wasm", "dist", "sqlite3.wasm"), join(out, "sqlite3.wasm"));
// PDFium's (web/pdf.ts fetches it the first time a PDF is opened)
cpSync(join(root, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"), join(out, "pdfium.wasm"));
// the demo library's stored attachments (<library folder>/storage), and a list of them for main.tsx to put in its file system
const storage = db ? join(dirname(db), "storage") : "";
const stored: string[] = [];
if (storage && existsSync(storage)) {
	cpSync(storage, join(out, "storage"), { recursive: true });
	const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else stored.push(relative(storage, p).replaceAll("\\", "/")); } };
	walk(storage);
}
writeFileSync(join(out, "storage.json"), JSON.stringify(stored));
const styles = arg("styles");
if (styles && existsSync(styles)) cpSync(styles, join(out, "collection-style.json"));
// the page: GPUI's canvas fills it (GPUIX appends the canvas to <body>)
writeFileSync(join(out, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Zotero Next demo</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; background: #F7F6F3; } @media (prefers-color-scheme: dark) { html, body { background: #141413; } }</style>
</head>
<body>
<script type="module" src="globals.js"></script>
<script type="module" src="main.js"></script>
</body>
</html>
`);
const size = result.outputs.reduce((n, o) => n + o.size, 0);
console.log(`web demo -> ${out} (${result.outputs.length} files, ${(size / 2 ** 20).toFixed(1)} MB; stubs: ${[...names.keys()].join(", ") || "none"})`);
