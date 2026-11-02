// Native PDF reader benchmark: render speed (hayro via bun:ffi) and process memory with 1 / 5 / 50 pages rendered.
//
//   bun scripts/reader-bench.ts                       # timing + memory (headless test renderer) on the default 4 PDFs
//   bun scripts/reader-bench.ts --timing              # only render/text-layer timings (pure FFI, no UI)
//   bun scripts/reader-bench.ts --memory              # only memory scenarios, each in a fresh child process
//   bun scripts/reader-bench.ts --memory --window     # same, but in a REAL (visible) GPUIX window; it autoplays, never touch it
//   ... --window --auto-dpr                            # let the reader detect the window's scale factor (prints detectedDpr) instead of forcing --dpr
//   bun scripts/reader-bench.ts --pdf key:SG6SKCRD --pdf C:/some/file.pdf --dpr 2 --out results.json
//
// PDFs are named "label=spec" with spec = a file path or key:<attachment key> (resolved read-only, see src/reader/library.ts).
// Defaults (from the user's library): a normal article, a 521-page document, a figure-heavy article (page 5 is the slowest of
// the sample), and a Type3-bitmap-font paper. Library files are only read; nothing is modified or moved.
//
// Memory scenarios (each its own process, so allocator high-water marks do not leak between them):
//   retain1    window=1   one page alive                                  -> "1 page rendered"
//   retain5    window=5   five pages alive (all five kept in memory)      -> "5 pages rendered"
//   scroll50   window=7   scroll through 50 pages one by one; pages leave the window and are freed  -> windowed behaviour
//   retain50   window=50  all 50 pages alive at once                      -> "50 pages rendered", worst case
// Numbers are PrivateUsage and WorkingSet of the whole bun process (GetProcessMemoryInfo), after Bun.gc(true). GPU memory is
// not part of either; in --window mode the script also asks the Windows GPU perf counters for this process.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PdfDoc, nativeVersion } from "../src/reader/pdf";
import { fetchAttachment } from "../src/reader/library";
import type { ReaderController } from "../src/reader/Reader";

const args = process.argv.slice(2);
const val = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const vals = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]!] : []));
const has = (n: string) => args.includes(`--${n}`);

const DEFAULT_PDFS = [
	"normal=key:SG6SKCRD", // Zare 2017, 10 pages, 0.7 MB: an ordinary journal article
	"long=key:5RRK4RNU", // Arun 2010, 521 pages, 11.6 MB
	"figures=key:KHJEVRID", // Prats-Uribe 2021, 12 pages, 9.9 MB, page 5 = dense vector scatter plots
	"type3=key:UKKC2SMQ", // Platt 1999, 11 pages: Type3 bitmap fonts (what an old LaTeX PDF looks like to the renderer)
];
const SCRATCH = "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad";
const dpr = Number(val("dpr", "1"));

// ---------------------------------------------------------------------------------------------------------------- memory
const k32 = dlopen("kernel32.dll", {
	GetCurrentProcess: { args: [], returns: FFIType.ptr },
	K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
});
const pmc = new Uint8Array(80); // PROCESS_MEMORY_COUNTERS_EX (x64): WorkingSetSize @16, PrivateUsage @72
const pmcView = new DataView(pmc.buffer);
function mem(): { privMB: number; wsMB: number } {
	pmcView.setUint32(0, 80, true);
	k32.symbols.K32GetProcessMemoryInfo(k32.symbols.GetCurrentProcess(), ptr(pmc), 80);
	return { wsMB: Number(pmcView.getBigUint64(16, true)) / 1048576, privMB: Number(pmcView.getBigUint64(72, true)) / 1048576 };
}
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------------------------------------------- stats
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const spread = (n: number, k: number) => Array.from({ length: Math.min(n, k) }, (_, i) => Math.floor((i * n) / Math.min(n, k)));
const bytesOf = async (spec: string): Promise<Uint8Array> => (spec.startsWith("key:") ? fetchAttachment(spec.slice(4)) : new Uint8Array(await Bun.file(spec).arrayBuffer()));
const split = (spec: string): [string, string] => (spec.includes("=") ? [spec.split("=")[0]!, spec.slice(spec.indexOf("=") + 1)] : [spec, spec]);

// ---------------------------------------------------------------------------------------------------------------- timing
async function timing(pdfs: string[]) {
	const rows: Record<string, unknown>[] = [];
	console.log(`native: ${nativeVersion()}\n`);
	for (const spec of pdfs) {
		const [label, src] = split(spec);
		// the bytes come from the core (key:) or the file system; they are fetched once, so "open" is the parse + measure cost
		const data = await bytesOf(src);
		const bytes = data.byteLength;
		let t = performance.now();
		const doc = PdfDoc.openBytes(data);
		const openMs = performance.now() - t;
		doc.close();
		t = performance.now();
		const doc2 = PdfDoc.openBytes(data);
		const warmOpenMs = performance.now() - t;
		const pages = spread(doc2.pageCount, 12);
		const row: Record<string, unknown> = { pdf: label, MB: r1(bytes / 1e6), pages: doc2.pageCount, "open ms (1st)": r1(openMs), "open ms (warm)": r1(warmOpenMs) };
		// "1x first" is the first touch of each page (decodes images, parses fonts, fills hayro's caches); "1x" repeats it warm
		for (const [name, scale] of [["1x first", 1], ["1x", 1], ["2x", 2], ["4x", 4]] as const) {
			const ms: number[] = [], px: number[] = [];
			for (const p of pages) {
				const r = doc2.renderSync(p, scale);
				ms.push(r.renderMs);
				px.push(r.width * r.height);
				r.release();
			}
			row[`${name} med/p95/max`] = `${r1(q(ms, 0.5))} / ${r1(q(ms, 0.95))} / ${r1(Math.max(...ms))}`;
			if (name === "2x") row["2x bitmap MB"] = r1((q(px, 0.5) * 4) / 1048576);
		}
		// page 1 on a document whose caches were just cleared: the time to first pixels after opening
		doc2.clearCache();
		{
			const r = doc2.renderSync(pages[0]!, 1);
			row["p1 cold"] = r1(r.renderMs);
			r.release();
		}
		const tx: number[] = [], nw: number[] = [];
		for (const p of pages) { const t0 = performance.now(); const l = doc2.textLayer(p); tx.push(performance.now() - t0); nw.push(l.words.length); }
		row["text med ms"] = r1(q(tx, 0.5));
		row["words/page"] = Math.round(q(nw, 0.5));
		rows.push(row);
		doc2.close();
	}
	console.log("Render time per page in ms, measured inside the worker thread (hayro rasterization + BGRA conversion), over 12 evenly spaced pages.");
	console.log("1x = 1 device px per PDF point (about a 600x800 bitmap for A4/Letter); 2x/4x are 4x/16x the pixels.\n");
	console.table(rows);
	return rows;
}

// ---------------------------------------------------------------------------------------------------------------- scenario (child process)
async function scenario(name: string, spec: string, windowMode: boolean) {
	const WIN: Record<string, number> = { retain1: 1, retain5: 5, scroll50: 7, retain50: 50 };
	const win = WIN[name];
	if (!win) throw new Error(`unknown scenario ${name}`);
	const { Reader } = await import("../src/reader/Reader");
	(await import("../src/reader/env")).setReaderMode("dark"); // do not pull the app store (and its library requests) into the measurement
	let ctl!: ReaderController;
	let pump: (ms: number) => Promise<void>;
	const { createComponent, createSignal } = await import("solid-js");
	// no JSX here (this is a .ts file). The window starts empty (baseline sample), then the Reader (which fills its parent) is shown.
	const [go, setGo] = createSignal(false);
	const tree = () => (() => (go() ? createComponent(Reader, { attachmentKey: spec.replace(/^key:/, ""), path: spec.startsWith("key:") ? undefined : spec, title: "reader-bench", dpr: has("auto-dpr") ? undefined : dpr, window: win, controller: (c: ReaderController) => { ctl = c; } }) : null)) as never;
	const base0 = mem();
	if (windowMode) {
		const { render } = await import("@gpuix/solid");
		render(tree, { title: "reader-bench", width: 1000, height: 880 });
		pump = (ms) => Bun.sleep(ms);
	} else {
		const { createTestRoot } = await import("@gpuix/solid/testing");
		const t = createTestRoot({ width: 1000, height: 880 });
		t.render(tree);
		pump = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { t.renderer.flush(); t.renderer.dispatchNativeEvents(); await Bun.sleep(16); } };
	}
	await pump(windowMode ? 1500 : 300);
	Bun.gc(true);
	await Bun.sleep(100);
	const base = mem(); // empty window / empty test root: the cost of the UI runtime itself
	setGo(true);
	while (!ctl) await pump(20);
	await Promise.race([ctl.ready(), Bun.sleep(30000)]);
	await pump(200);
	const settle = async (minRenders: number) => {
		const t0 = performance.now();
		while (performance.now() - t0 < 60000) {
			await pump(40);
			await ctl.idle();
			if (ctl.stats.renders >= minRenders) break;
		}
		await pump(300);
	};
	let peak = mem();
	const sample = () => { const m = mem(); if (m.privMB > peak.privMB) peak = m; return m; };
	await settle(Math.min(win, ctl.doc()!.pageCount));
	Bun.gc(true);
	const afterFirst = sample();
	const out: Record<string, unknown> = { scenario: name, pdf: spec, dpr, window: win, windowMode, pages: ctl.doc()!.pageCount, startPrivMB: r1(base0.privMB), emptyPrivMB: r1(base.privMB), emptyWsMB: r1(base.wsMB) };
	out.firstPageMs = r1(ctl.stats.lastRenderMs);
	out.detectedDpr = ctl.dpr(); // with --auto-dpr: the real window's scale factor (src/reader/env.ts)
	const t0 = performance.now();
	if (name === "scroll50") {
		const N = Math.min(50, ctl.doc()!.pageCount);
		const at: Record<number, { privMB: number; wsMB: number }> = {};
		for (let i = 1; i < N; i++) {
			// pages already inside the window need no render, so do not wait for one: let the scroll land, then until idle
			ctl.scrollToPage(i);
			await pump(120);
			await ctl.idle();
			await pump(150);
			sample();
			if (i === 4 || i === 9 || i === 24) { Bun.gc(true); at[i + 1] = sample(); }
		}
		out.sampledAtPage = Object.fromEntries(Object.entries(at).map(([k, v]) => [k, { privMB: r1(v.privMB), wsMB: r1(v.wsMB) }]));
		out.scrollSeconds = r1((performance.now() - t0) / 1000);
	}
	await pump(500);
	Bun.gc(true);
	await Bun.sleep(100);
	const end = sample();
	out.privMB = r1(end.privMB);
	out.wsMB = r1(end.wsMB);
	out.peakPrivMB = r1(peak.privMB);
	out.afterFirstPrivMB = r1(afterFirst.privMB);
	out.deltaPrivMB = r1(end.privMB - base.privMB);
	out.deltaWsMB = r1(end.wsMB - base.wsMB);
	out.mountedNow = ctl.mounted();
	out.peakMounted = ctl.stats.peakMounted;
	out.renders = ctl.stats.renders;
	out.cancelled = ctl.stats.cancelled;
	out.avgRenderMs = r1(ctl.stats.totalRenderMs / Math.max(1, ctl.stats.renders));
	out.lastUploadMs = r1(ctl.stats.lastUploadMs);
	if (windowMode) out.gpu = await gpuMemory();
	console.log("RESULT " + JSON.stringify(out));
	process.exit(0);
}

/** GPU memory of this process from the Windows perf counters (dedicated = VRAM, shared = system memory used by the GPU). */
async function gpuMemory(): Promise<unknown> {
	const ps = `$p=${process.pid}; $o=@{}; foreach($k in 'Dedicated Usage','Shared Usage','Local Usage'){ try{ $s=(Get-Counter "\\GPU Process Memory(pid_$($p)*)\\$k" -ErrorAction Stop).CounterSamples; $o[$k]=[math]::Round(($s|Measure-Object CookedValue -Sum).Sum/1MB,1)}catch{} }; $o|ConvertTo-Json -Compress`;
	try {
		const r = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", ps]);
		return JSON.parse(r.stdout.toString().trim() || "{}");
	} catch { return {}; }
}

// ---------------------------------------------------------------------------------------------------------------- orchestrator
async function memory(pdfs: string[], windowMode: boolean) {
	const results: Record<string, unknown>[] = [];
	for (const spec of pdfs) {
		const [label, src] = split(spec);
		for (const sc of ["retain1", "retain5", "scroll50", "retain50"]) {
			const t0 = performance.now();
			const p = Bun.spawnSync([process.execPath, import.meta.path, "--scenario", sc, "--pdf", src, "--dpr", String(dpr), ...(windowMode ? ["--window"] : []), ...(has("auto-dpr") ? ["--auto-dpr"] : [])], { stdout: "pipe", stderr: "pipe", timeout: 180000 });
			const line = p.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
			if (!line) { console.error(`[${label}/${sc}] failed:\n${p.stdout.toString().slice(-600)}\n${p.stderr.toString().slice(-600)}`); continue; }
			const r = JSON.parse(line.slice(7)) as Record<string, unknown>;
			r.label = label;
			results.push(r);
			console.error(`[${label}/${sc}] ${Math.round(performance.now() - t0)} ms`);
		}
	}
	console.log(`\nProcess memory of the whole bun process (MB), mode=${windowMode ? "real window" : "headless test renderer"}, dpr=${dpr}. "empty" = the same window/test root before the reader is shown; delta = end - empty.`);
	console.table(results.map((r) => ({
		pdf: r.label, scenario: r.scenario, pagesAlive: r.mountedNow, "empty priv": r.emptyPrivMB, "end priv": r.privMB, "end ws": r.wsMB, "peak priv": r.peakPrivMB, "delta priv": r.deltaPrivMB, "delta ws": r.deltaWsMB,
		renders: r.renders, "avg render ms": r.avgRenderMs, ...(windowMode ? { gpu: JSON.stringify(r.gpu) } : {}),
	})));
	for (const r of results) if (r.sampledAtPage) console.log(`${r.label} scroll50 samples (priv/ws MB at page N):`, JSON.stringify(r.sampledAtPage), `in ${r.scrollSeconds}s`);
	return results;
}

// ---------------------------------------------------------------------------------------------------------------- main
const scen = val("scenario");
if (scen) {
	await scenario(scen, val("pdf")!, has("window"));
} else {
	const pdfs = vals("pdf").length ? vals("pdf") : DEFAULT_PDFS;
	const onlyT = has("timing"), onlyM = has("memory");
	const result: Record<string, unknown> = { when: new Date().toISOString(), dpr, native: nativeVersion() };
	if (!onlyM) result.timing = await timing(pdfs);
	if (!onlyT) result.memory = await memory(pdfs, has("window"));
	const out = val("out", `${SCRATCH}/reader-bench.json`)!;
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, 1));
	console.log("\nwrote", out);
	process.exit(0);
}
