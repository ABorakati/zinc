// Copies what the site shows from outside website/ into public/ (run by the docs:* scripts before dev and build).
//   docs/screenshots/**  -> public/screenshots/**   (generated copy, git-ignored)
//   the app icon         -> public/icon.svg, icon.png (gpui-ui/assets, else app/assets)
//   the Word sidebar     -> public/word-demo/**      (live demo build, generated, git-ignored)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");

const shots = join(repo, "docs", "screenshots");
const out = join(site, "public", "screenshots");
rmSync(out, { recursive: true, force: true });
if (existsSync(shots)) cpSync(shots, out, { recursive: true });
else mkdirSync(out, { recursive: true });

for (const dir of [join(repo, "gpui-ui", "assets"), join(repo, "app", "assets")]) {
	let copied = false;
	for (const f of ["icon.svg", "icon.png"]) {
		if (existsSync(join(dir, f))) { cpSync(join(dir, f), join(site, "public", f)); copied = true; }
	}
	if (copied) break;
}
// The live Word sidebar demo (pages/demo.astro): the sidebar's own code with the demo host (word/sidebar/src/demo.ts), its
// stylesheet, an index.html that loads demo.js, and the styles and locales in word-demo/.
{
	const side = join(repo, "word", "sidebar");
	const demo = join(site, "public", "word-demo");
	rmSync(demo, { recursive: true, force: true });
	mkdirSync(demo, { recursive: true });
	const r = await Bun.build({ entrypoints: [join(side, "src", "demo.ts")], outdir: demo, target: "browser", format: "esm", minify: true });
	if (!r.success) { for (const l of r.logs) console.error(l); throw new Error("word demo build failed"); }
	cpSync(join(side, "style.css"), join(demo, "style.css"));
	const html = readFileSync(join(side, "index.html"), "utf8").replace('src="main.js"', 'src="demo.js"');
	if (!html.includes('src="demo.js"')) throw new Error("word demo: index.html no longer loads main.js");
	writeFileSync(join(demo, "index.html"), html);
	cpSync(join(site, "word-demo", "styles"), join(demo, "styles"), { recursive: true });
	cpSync(join(site, "word-demo", "locales"), join(demo, "locales"), { recursive: true });
}
// The app demo (pages/demo.astro, "The app"): the GPUI app built for the browser by gpui-ui/web/build.ts on a demo library made by
// gpui-ui/web/demo-library.ts. Needs gpui-ui's dependencies (bun install there); skipped with a note when they are missing, or
// when ZN_SKIP_APP_DEMO=1 (it takes a minute and is ~24 MB).
{
	const gpui = join(repo, "gpui-ui");
	const demo = join(site, "public", "app-demo");
	if (process.env.ZN_SKIP_APP_DEMO === "1") console.log("[docs] app demo skipped (ZN_SKIP_APP_DEMO=1)");
	else if (!existsSync(join(gpui, "node_modules", "@gpuix", "native", "wasm"))) console.log("[docs] app demo skipped: run `bun install` in gpui-ui first");
	else {
		const lib = join(gpui, "out", "demo-library");
		const run = (args: string[]) => {
			const p = Bun.spawnSync(["bun", ...args], { cwd: gpui, stdout: "inherit", stderr: "inherit" });
			if (p.exitCode !== 0) throw new Error(`app demo: bun ${args.join(" ")} failed`);
		};
		run(["web/demo-library.ts", lib]);
		run(["web/build.ts", "--out", demo, "--db", join(lib, "library.sqlite"), "--styles", join(lib, "collection-style.json")]);
	}
}
console.log("[docs] assets synced");
