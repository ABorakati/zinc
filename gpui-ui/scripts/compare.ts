// Side-by-side + pixel diff of the web UI vs the GPUI UI at the same size and theme.
//
//   bun scripts/compare.ts [--mode dark|light] [--out <dir>] [--url <web url>] [--wait <ms>] [--gpui-png <file>]
//
// 1. GPUI: headless capture of <App/> (scripts/shot-app.tsx <png> if present, else createTestRoot() in-process) -> gpui.png.
//    Its size (~1440x881 whatever size is asked of the test renderer) decides the web viewport.
// 2. Web: `agent-browser` (headless Chrome, own session; never the user's browser) opens the web UI at that viewport with the
//    theme forced through localStorage "zn.theme" + prefers-color-scheme, -> web.png.
// 3. Writes side-by-side.png (web | gpui | diff), diff.png (pixelmatch heatmap) and prints the % of differing pixels.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DEFAULT_OUT =
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots/compare";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const mode = arg("mode", "dark") === "light" ? "light" : "dark";
const outDir = resolve(arg("out", DEFAULT_OUT));
const webUrl = arg("url", "http://127.0.0.1:23160/app/");
const settleMs = Number(arg("wait", "2500"));
const session = "zn-gpui-compare";
const useGpuiPng = arg("gpui-png", ""); // reuse an existing GPUI screenshot instead of capturing
mkdirSync(outDir, { recursive: true });
const P = (f: string) => join(outDir, f);

/** Run a command, capturing output via temp files (not pipes: agent-browser starts a daemon that inherits pipes and would hold them open). */
async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<{ code: number; out: string }> {
	const tag = join(tmpdir(), `zn-compare-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: Bun.file(`${tag}.out`), stderr: Bun.file(`${tag}.err`) });
	const code = await p.exited;
	const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
	const out = (read(`${tag}.out`) + read(`${tag}.err`)).trim();
	for (const e of ["out", "err"]) rmSync(`${tag}.${e}`, { force: true });
	return { code, out };
}

// ---- 1. GPUI capture -----------------------------------------------------------------------------------------------------
async function captureGpui(png: string): Promise<boolean> {
	const script = join(here, "shot-app.tsx");
	if (existsSync(script)) {
		const r = await run(["bun", script, png], { cwd: root });
		console.log(`[gpui] shot-app.tsx -> exit ${r.code}${r.out ? `\n${r.out}` : ""}`);
		return r.code === 0 && existsSync(png);
	}
	const appPath = join(root, "src", "App.tsx");
	if (!existsSync(appPath)) {
		console.warn("[gpui] neither scripts/shot-app.tsx nor src/App.tsx exists yet; the GPUI side cannot be captured.");
		return false;
	}
	const { createTestRoot } = await import("@gpuix/solid/testing");
	const { App } = (await import(appPath)) as { App: () => unknown };
	const t = createTestRoot({ width: 1440, height: 880 });
	t.render(App as never);
	await Bun.sleep(settleMs); // let the store fetch + render
	t.renderer.captureScreenshot(png);
	t.unmount();
	return existsSync(png);
}

// ---- 2. Web capture ------------------------------------------------------------------------------------------------------
async function ab(...args: string[]): Promise<string> {
	const r = await run(["agent-browser", "--session", session, ...args]);
	if (r.code !== 0) throw new Error(`agent-browser ${args.join(" ")} failed: ${r.out}`);
	return r.out;
}
/** eval via base64: agent-browser is a .cmd shim, so quotes/specials in a raw script argument are rejected on Windows. */
const abEval = (js: string) => ab("eval", "-b", Buffer.from(js, "utf8").toString("base64"));

async function captureWeb(png: string, w: number, h: number): Promise<void> {
	try {
		await ab("set", "viewport", String(w), String(h));
		await ab("set", "media", mode);
		await ab("open", webUrl);
		// Force the theme the way ui/src/settings/appearance.ts / index.html do ("zn.theme" = {mode}); reload so the pre-paint
		// script in index.html applies it (it also honours prefers-color-scheme for the default "system" mode).
		await abEval(`localStorage.setItem("zn.theme", JSON.stringify({ mode: ${JSON.stringify(mode)} }))`);
		await ab("reload");
		await ab("wait", String(settleMs));
		const cls = await abEval("document.documentElement.className + ' | ' + innerWidth + 'x' + innerHeight");
		console.log(`[web] <html> class / viewport: ${cls}`);
		await ab("screenshot", png);
	} finally {
		await run(["agent-browser", "--session", session, "close"]);
	}
}

// ---- 3. Diff -------------------------------------------------------------------------------------------------------------
function readPng(f: string): PNG {
	return PNG.sync.read(readFileSync(f));
}

/** Copy `src` onto a w x h canvas filled with `fill` (so differently-sized images can still be diffed). */
function pad(src: PNG, w: number, h: number, fill: [number, number, number, number]): PNG {
	const out = new PNG({ width: w, height: h });
	for (let i = 0; i < w * h; i++) out.data.set(fill, i * 4);
	PNG.bitblt(src, out, 0, 0, Math.min(src.width, w), Math.min(src.height, h), 0, 0);
	return out;
}

function sideBySide(imgs: PNG[], gutter = 12): PNG {
	const h = Math.max(...imgs.map((i) => i.height));
	const w = imgs.reduce((s, i) => s + i.width, 0) + gutter * (imgs.length - 1);
	const out = new PNG({ width: w, height: h });
	for (let i = 0; i < w * h; i++) out.data.set([128, 128, 128, 255], i * 4);
	let x = 0;
	for (const im of imgs) {
		PNG.bitblt(im, out, 0, 0, im.width, im.height, x, 0);
		x += im.width + gutter;
	}
	return out;
}

async function main() {
	const gpuiPng = P("gpui.png");
	const webPng = P("web.png");
	if (useGpuiPng) copyFileSync(resolve(useGpuiPng), gpuiPng);
	const gotGpui = useGpuiPng ? true : await captureGpui(gpuiPng);
	if (!gotGpui) {
		console.error("No GPUI screenshot; aborting before the web capture (nothing to compare against).");
		process.exit(2);
	}
	const g = readPng(gpuiPng);
	console.log(`[gpui] ${g.width}x${g.height}`);
	await captureWeb(webPng, g.width, g.height);
	const w = readPng(webPng);
	console.log(`[web]  ${w.width}x${w.height}`);

	const W = Math.max(g.width, w.width);
	const H = Math.max(g.height, w.height);
	const a = pad(w, W, H, [128, 128, 128, 255]);
	const b = pad(g, W, H, [128, 128, 128, 255]);
	const diff = new PNG({ width: W, height: H });
	const bad = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.1, includeAA: false, diffColor: [255, 0, 80] });
	const pct = (bad / (W * H)) * 100;

	writeFileSync(P("diff.png"), PNG.sync.write(diff));
	writeFileSync(P("side-by-side.png"), PNG.sync.write(sideBySide([a, b, diff])));
	const summary = { mode, web: [w.width, w.height], gpui: [g.width, g.height], compared: [W, H], differingPixels: bad, percentDifferent: +pct.toFixed(2) };
	writeFileSync(P("summary.json"), JSON.stringify(summary, null, 2));
	console.log(`\nweb.png / gpui.png / side-by-side.png / diff.png -> ${outDir}`);
	console.log(`pixel difference (${mode}, threshold 0.1): ${bad} of ${W * H} px = ${pct.toFixed(2)} %`);
}

await main();
