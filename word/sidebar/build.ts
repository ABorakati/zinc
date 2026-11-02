// Bundle the sidebar into word/dist/addin/sidebar (what the add-in's WebView2 serves). Bun only.
//   bun build.ts          build
//   bun build.ts --dev    build and serve the preview at http://127.0.0.1:5173/index.html?mock
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const out = join(here, "..", "dist", "addin", "sidebar");
mkdirSync(out, { recursive: true });

const result = await Bun.build({
	entrypoints: [join(here, "src", "main.ts"), join(here, "src", "popup.ts")],
	outdir: out,
	target: "browser",
	format: "esm",
	minify: !process.argv.includes("--dev"),
	sourcemap: "none",
});
if (!result.success) {
	for (const l of result.logs) console.error(l);
	process.exit(1);
}
cpSync(join(here, "index.html"), join(out, "index.html"));
cpSync(join(here, "style.css"), join(out, "style.css"));
cpSync(join(here, "popup.html"), join(out, "popup.html"));
cpSync(join(here, "popup.css"), join(out, "popup.css"));
console.log(`sidebar built -> ${out}`);

if (process.argv.includes("--dev")) {
	const repo = join(here, "..", "..");
	Bun.serve({
		hostname: "127.0.0.1",
		port: 5173,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			if (p.startsWith("/mock/")) {
				// preview only: styles and locales from the repo's data folder
				const f = Bun.file(join(repo, "data", p.slice("/mock/".length)));
				return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
			}
			const f = Bun.file(join(out, p === "/" ? "index.html" : p));
			return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
		},
	});
	console.log("preview: http://127.0.0.1:5173/index.html?mock  and  http://127.0.0.1:5173/popup.html?mock");
}
