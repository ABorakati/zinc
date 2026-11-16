// Native PDF reader benchmark: render speed (hayro via bun:ffi) and process memory with 1 / 5 / 50 pages rendered.
//
//   bun scripts/reader-bench.ts                       # timing + memory (headless test renderer) on the default 4 PDFs
//   bun scripts/reader-bench.ts --timing              # only render/text-layer timings (pure FFI, no UI)
//   bun scripts/reader-bench.ts --memory              # only memory scenarios, each in a fresh child process
//   bun scripts/reader-bench.ts --memory --window     # same, but in a REAL (visible) GPUIX window; it autoplays, never touch it
//   ... --window --auto-dpr                            # let the reader detect the window's scale factor (prints detectedDpr) instead of forcing --dpr
//   bun scripts/reader-bench.ts --latency --window --dpr 2 [--modes slow,fast,jump] [--pages 8] [--start N]   # scroll latency in a REAL window: wheel events through GPUI,
//       per page the ms from its first visible pixel row to first pixels / no blank hole / fully sharp, from the list's TRUE scroll position (ReaderController.wheel / coverage)
//   bun scripts/reader-bench.ts --pdf key:SG6SKCRD --pdf C:/some/file.pdf --dpr 2 --out results.json
//
// PDFs are named "label=spec" with spec = a file path or key:<attachment key> (resolved read-only, see src/reader/library.ts).
// Defaults (from the user's library): a normal article, a 521-page document, a figure-heavy article (page 5 is the slowest of
// the sample), and a Type3-bitmap-font paper. Library files are only read; nothing is modified or moved.
//
// Memory scenarios (each its own process, so allocator high-water marks do not leak between them). The reader renders only
// tiles near the viewport (src/reader/core/Page.tsx), so what matters is a PDF being open and what scrolling / zooming adds:
//   open       the PDF open at fit width, idle                              -> "one open PDF"
//   scroll50   scroll through 50 pages one by one; tiles leave the margin and are freed
//   zoom4      400 % zoom (a 6 MP+ page: tiles only) after a short scroll
// Numbers are PrivateUsage and WorkingSet of the whole bun process (GetProcessMemoryInfo), after Bun.gc(true). GPU memory is
// not part of either; in --window mode the script also asks the Windows GPU perf counters for this process.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PdfDoc, nativeVersion } from "../src/reader/pdf";
import { fetchAttachment } from "../src/reader/library";
import type { ReaderController } from "../src/reader/Reader";

const args = process.argv.slice(2);
const val = (n: string, d?: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1]! : d;
};
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
const q = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};
const spread = (n: number, k: number) => Array.from({ length: Math.min(n, k) }, (_, i) => Math.floor((i * n) / Math.min(n, k)));
const bytesOf = async (spec: string): Promise<Uint8Array> =>
	spec.startsWith("key:") ? fetchAttachment(spec.slice(4)) : new Uint8Array(await Bun.file(spec).arrayBuffer());
const split = (spec: string): [string, string] =>
	spec.includes("=") ? [spec.split("=")[0]!, spec.slice(spec.indexOf("=") + 1)] : [spec, spec];

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
		const row: Record<string, unknown> = {
			pdf: label,
			MB: r1(bytes / 1e6),
			pages: doc2.pageCount,
			"open ms (1st)": r1(openMs),
			"open ms (warm)": r1(warmOpenMs),
		};
		// "1x first" is the first touch of each page (decodes images, parses fonts, fills hayro's caches); "1x" repeats it warm
		for (const [name, scale] of [
			["1x first", 1],
			["1x", 1],
			["2x", 2],
			["4x", 4],
		] as const) {
			const ms: number[] = [],
				px: number[] = [];
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
		const tx: number[] = [],
			nw: number[] = [];
		for (const p of pages) {
			const t0 = performance.now();
			const l = doc2.textLayer(p);
			tx.push(performance.now() - t0);
			nw.push(l.words.length);
		}
		row["text med ms"] = r1(q(tx, 0.5));
		row["words/page"] = Math.round(q(nw, 0.5));
		rows.push(row);
		doc2.close();
	}
	console.log(
		"Render time per page in ms, measured inside the worker thread (hayro rasterization + BGRA conversion), over 12 evenly spaced pages.",
	);
	console.log("1x = 1 device px per PDF point (about a 600x800 bitmap for A4/Letter); 2x/4x are 4x/16x the pixels.\n");
	console.table(rows);
	return rows;
}

// ---------------------------------------------------------------------------------------------------------------- scenario (child process)
async function scenario(name: string, spec: string, windowMode: boolean) {
	if (!["open", "scroll50", "zoom4"].includes(name) && !name.startsWith("lat-")) throw new Error(`unknown scenario ${name}`);
	process.env.ZN_READER_STATE = "off";
	const { Reader } = await import("../src/reader/Reader");
	(await import("../src/reader/env")).setReaderMode("dark"); // do not pull the app store (and its library requests) into the measurement
	let ctl!: ReaderController;
	let pump: (ms: number) => Promise<void>;
	const { createComponent, createSignal } = await import("solid-js");
	// no JSX here (this is a .ts file). The window starts empty (baseline sample), then the Reader (which fills its parent) is shown.
	const [go, setGo] = createSignal(false);
	const tree = () =>
		(() =>
			go()
				? createComponent(Reader, {
						attachmentKey: spec.replace(/^key:/, ""),
						path: spec.startsWith("key:") ? undefined : spec,
						title: "reader-bench",
						dpr: has("auto-dpr") ? undefined : dpr,
						ephemeral: true,
						itemKey: "",
						zoom: name === "zoom4" ? 4 : undefined,
						controller: (c: ReaderController) => {
							ctl = c;
						},
					})
				: null) as never;
	const base0 = mem();
	if (windowMode) {
		const { render } = await import("@gpuix/solid");
		render(tree, { title: "reader-bench", width: 1000, height: 880 });
		pump = (ms) => Bun.sleep(ms);
	} else {
		const { createTestRoot } = await import("@gpuix/solid/testing");
		const t = createTestRoot({ width: 1000, height: 880 });
		t.render(tree);
		pump = async (ms) => {
			const t0 = performance.now();
			while (performance.now() - t0 < ms) {
				t.renderer.flush();
				t.renderer.dispatchNativeEvents();
				await Bun.sleep(16);
			}
		};
	}
	await pump(windowMode ? 1500 : 300);
	Bun.gc(true);
	await Bun.sleep(100);
	const base = mem(); // empty window / empty test root: the cost of the UI runtime itself
	setGo(true);
	while (!ctl) await pump(20);
	await Promise.race([ctl.ready(), Bun.sleep(30000)]);
	const openedMem = mem(); // the document is open, no tile has been drawn yet (the UI chrome is up)
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
	const sample = () => {
		const m = mem();
		if (m.privMB > peak.privMB) peak = m;
		return m;
	};
	await settle(1);
	Bun.gc(true);
	const afterFirst = sample();
	const out: Record<string, unknown> = {
		scenario: name,
		pdf: spec,
		dpr,
		windowMode,
		pages: ctl.doc()!.pageCount,
		startPrivMB: r1(base0.privMB),
		emptyPrivMB: r1(base.privMB),
		emptyWsMB: r1(base.wsMB),
	};
	out.firstPageMs = r1(ctl.stats.lastRenderMs);
	out.openedDeltaMB = r1(openedMem.privMB - base.privMB); // doc open + reader chrome, before any tile
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
			if (i === 4 || i === 9 || i === 24) {
				Bun.gc(true);
				at[i + 1] = sample();
			}
		}
		out.sampledAtPage = Object.fromEntries(Object.entries(at).map(([k, v]) => [k, { privMB: r1(v.privMB), wsMB: r1(v.wsMB) }]));
		out.scrollSeconds = r1((performance.now() - t0) / 1000);
	}
	if (name.startsWith("lat-")) Object.assign(out, await latency(ctl, name.slice(4), pump, sample));
	if (name === "zoom4") {
		const N = Math.min(6, ctl.doc()!.pageCount);
		for (let i = 1; i < N; i++) {
			ctl.scrollToPage(i);
			await pump(150);
			await ctl.idle();
			await pump(150);
			sample();
		}
		out.zoom = ctl.zoom();
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
	{
		// what hayro's per-document caches (fonts, glyphs, decoded images) hold: clear them and look again
		ctl.doc()!.clearCache();
		await pump(600);
		Bun.gc(true);
		await Bun.sleep(150);
		out.afterClearPrivMB = r1(mem().privMB);
		out.cacheMB = r1(end.privMB - mem().privMB);
	}
	out.mountedNow = ctl.mounted();
	{
		const d = ctl.debug() as { win: number[]; vis: number[]; sp: unknown; vp: unknown; view: { i: number; h: number }[] };
		out.dbg = { win: d.win, vis: d.vis, sp: d.sp, vp: d.vp, hs: d.view.map((v) => `${v.i}:${v.h}`) };
	}
	out.peakTiles = ctl.stats.peakTiles;
	out.tilesNow = ctl.tiles();
	out.renders = ctl.stats.renders;
	out.cancelled = ctl.stats.cancelled;
	out.avgRenderMs = r1(ctl.stats.totalRenderMs / Math.max(1, ctl.stats.renders));
	out.lastUploadMs = r1(ctl.stats.lastUploadMs);
	{
		const st = ctl.stats,
			j = Math.max(1, st.jobs ?? 0);
		out.jobs = st.jobs ?? 0;
		out.avgQueueMs = r1((st.queueMs ?? 0) / j);
		out.avgMountMs = r1((st.mountWaitMs ?? 0) / j);
		out.avgUploadMs = r1((st.uploadMs ?? 0) / j);
	}
	if (windowMode) out.gpu = await gpuMemory();
	console.log("RESULT " + JSON.stringify(out));
	process.exit(0);
}

/**
 * Scroll latency. Scrolls the page list with wheel events through GPUI's own hit test (the path a mouse wheel takes), samples the
 * list's TRUE scroll position every few ms and asks each mounted page how much of its visible part is blank / soft / sharp.
 *   first  ms from a page's first visible pixel row to any pixels at all on its visible part (even a stretched preview)
 *   full   ms to no paper-white hole left on the visible part
 *   sharp  ms until the whole visible part is at full resolution (only counted while the page is still visible)
 *   blank% / soft%  area-time share of everything that was visible during the run
 * modes: slow (500 css px/s), fast (4000 px/s), jump (PageDown every 900 ms)
 */
async function latency(
	ctl: ReaderController,
	mode: string,
	pump: (ms: number) => Promise<void>,
	sample: () => unknown,
): Promise<Record<string, unknown>> {
	const n = ctl.doc()!.pageCount;
	const start = Math.max(0, Number(val("start", String(n > 100 ? 200 : 0))));
	const pagesToScroll = Math.max(1, Math.min(Number(val("pages", "8")), n - start - 2));
	ctl.scrollToPage(Math.max(0, start));
	await pump(300);
	await ctl.idle();
	await pump(600);
	const speed = mode === "slow" ? Number(val("slow", "500")) : mode === "fast" ? Number(val("fast", "4000")) : 0;
	type PS = { enter: number; first?: number; full?: number; sharp?: number; lastSoft: number; last: number; fullPre: boolean };
	const ps = new Map<number, PS>();
	let blankT = 0,
		softT = 0,
		visT = 0,
		noSrcT = 0,
		noSrcTicks = 0,
		ticks = 0,
		noSrcMax = 0;
	const seen0 = new Set(ctl.coverage().map((c) => c.page)); // visible when the run starts: not an "entry"
	let tPrev = performance.now();
	const t0 = tPrev;
	const obs = () => {
		const now = performance.now(),
			dt = now - tPrev;
		tPrev = now;
		let ns = 0;
		ticks++;
		for (const c of ctl.coverage()) {
			ns += c.noSrc;
			let s = ps.get(c.page);
			if (!s) {
				s = { enter: now, lastSoft: now, last: now, fullPre: seen0.has(c.page) };
				ps.set(c.page, s);
			}
			s.last = now;
			const px = c.blank + c.soft + c.sharp;
			if (s.first === undefined && c.soft + c.sharp > 0 && px > 0) s.first = now - s.enter;
			if (s.full === undefined && c.blank === 0) s.full = now - s.enter;
			if (c.sharp < 1) s.lastSoft = now;
			if (s.sharp === undefined && c.sharp === 1) s.sharp = now - s.enter;
			visT += c.vis * dt;
			blankT += c.vis * c.blank * dt;
			softT += c.vis * c.soft * dt;
		}
		if (ns > 0) {
			noSrcT += dt;
			noSrcTicks++;
			noSrcMax = Math.max(noSrcMax, ns);
		}
	};
	const a0 = ctl.debug() as { raw: number[] | null };
	let moved = 0;
	if (mode === "jump") {
		for (let j = 0; j < pagesToScroll; j++) {
			ctl.key({ key: "pagedown" });
			ctl.key({ key: "pagedown" });
			const end = performance.now() + 900;
			while (performance.now() < end) {
				obs();
				sample();
				await Bun.sleep(4);
			}
		}
	} else {
		const rowH = (ctl.debug() as { view: { h: number }[] }).view[0]?.h ?? 900;
		const total = pagesToScroll * (rowH + 12);
		let last = performance.now();
		while (moved < total) {
			const now = performance.now(),
				dy = (speed * (now - last)) / 1000;
			last = now;
			if (dy > 0) {
				ctl.wheel(dy);
				moved += dy;
			}
			obs();
			sample();
			await Bun.sleep(4);
		}
	}
	const tScroll = performance.now() - t0;
	const end = performance.now() + 2500;
	while (performance.now() < end) {
		obs();
		sample();
		await Bun.sleep(4);
	}
	const a1 = ctl.debug() as { raw: number[] | null };
	const rows = [...ps.entries()].filter(([, s]) => !s.fullPre);
	const col = (f: (s: PS) => number | undefined) => rows.map(([, s]) => f(s)).filter((x): x is number => x !== undefined);
	const stat = (xs: number[]) =>
		xs.length ? { n: xs.length, med: r1(q(xs, 0.5)), p95: r1(q(xs, 0.95)), max: r1(Math.max(...xs)) } : { n: 0 };
	return {
		mode,
		speed,
		start,
		pagesEntered: rows.length,
		scrollMs: Math.round(tScroll),
		raw0: a0.raw,
		raw1: a1.raw,
		first: stat(col((s) => s.first)),
		full: stat(col((s) => s.full)),
		sharp: stat(col((s) => s.sharp)),
		neverFull: rows.filter(([, s]) => s.full === undefined).length,
		neverSharp: rows.filter(([, s]) => s.sharp === undefined).length,
		blankPct: r1((100 * blankT) / Math.max(1, visT)),
		softPct: r1((100 * softT) / Math.max(1, visT)),
		noSrcMs: Math.round(noSrcT),
		noSrcPct: r1((100 * noSrcTicks) / Math.max(1, ticks)),
		noSrcMax,
		backend: ctl.doc()!.backend(),
		previews: ctl.previews().made,
	};
}

/** GPU memory of this process from the Windows perf counters (dedicated = VRAM, shared = system memory used by the GPU). */
async function gpuMemory(): Promise<unknown> {
	const ps = `$p=${process.pid}; $o=@{}; foreach($k in 'Dedicated Usage','Shared Usage','Local Usage'){ try{ $s=(Get-Counter "\\GPU Process Memory(pid_$($p)*)\\$k" -ErrorAction Stop).CounterSamples; $o[$k]=[math]::Round(($s|Measure-Object CookedValue -Sum).Sum/1MB,1)}catch{} }; $o|ConvertTo-Json -Compress`;
	try {
		const r = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", ps]);
		return JSON.parse(r.stdout.toString().trim() || "{}");
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------------------------------------------- orchestrator
async function memory(pdfs: string[], windowMode: boolean, scenarios = ["open", "scroll50", "zoom4"]) {
	const results: Record<string, unknown>[] = [];
	for (const spec of pdfs) {
		const [label, src] = split(spec);
		for (const sc of scenarios) {
			const t0 = performance.now();
			const p = Bun.spawnSync(
				[
					process.execPath,
					import.meta.path,
					"--scenario",
					sc,
					"--pdf",
					src,
					"--dpr",
					String(dpr),
					...(windowMode ? ["--window"] : []),
					...(has("auto-dpr") ? ["--auto-dpr"] : []),
					...["start", "pages", "slow", "fast"].flatMap((n) => (val(n) ? [`--${n}`, val(n)!] : [])),
				],
				{ stdout: "pipe", stderr: "pipe", timeout: 180000 },
			);
			const line = p.stdout
				.toString()
				.split("\n")
				.find((l) => l.startsWith("RESULT "));
			if (!line) {
				console.error(`[${label}/${sc}] failed:\n${p.stdout.toString().slice(-600)}\n${p.stderr.toString().slice(-600)}`);
				continue;
			}
			const r = JSON.parse(line.slice(7)) as Record<string, unknown>;
			r.label = label;
			results.push(r);
			console.error(`[${label}/${sc}] ${Math.round(performance.now() - t0)} ms`);
		}
	}
	if (scenarios.some((x) => x.startsWith("lat-"))) {
		console.log(`\nScroll latency (ms after a page's first visible pixel row), real window=${windowMode}, dpr=${dpr}`);
		const f = (o: unknown) => {
			const x = o as { n: number; med?: number; p95?: number; max?: number };
			return x.n ? `${x.med} / ${x.p95} / ${x.max} (n=${x.n})` : "-";
		};
		console.table(
			results.map((r) => ({
				pdf: r.label,
				mode: r.mode,
				pages: r.pagesEntered,
				"first med/p95/max": f(r.first),
				"full med/p95/max": f(r.full),
				"sharp med/p95/max": f(r.sharp),
				neverFull: r.neverFull,
				neverSharp: r.neverSharp,
				"blank%": r.blankPct,
				"soft%": r.softPct,
				"noSrc ms": r.noSrcMs,
				"noSrc ticks%": r.noSrcPct,
				be: r.backend,
				pv: r.previews,
				jobs: r.jobs,
				"render/queue/mount/upload ms": `${r.avgRenderMs}/${r.avgQueueMs}/${r.avgMountMs}/${r.avgUploadMs}`,
				"delta priv": r.deltaPrivMB,
				"peak priv": r.peakPrivMB,
			})),
		);
		return results;
	}
	console.log(
		`\nProcess memory of the whole bun process (MB), mode=${windowMode ? "real window" : "headless test renderer"}, dpr=${dpr}. "empty" = the same window/test root before the reader is shown; delta = end - empty.`,
	);
	console.table(
		results.map((r) => ({
			pdf: r.label,
			scenario: r.scenario,
			pagesAlive: r.mountedNow,
			"empty priv": r.emptyPrivMB,
			"end priv": r.privMB,
			"end ws": r.wsMB,
			"peak priv": r.peakPrivMB,
			"delta priv": r.deltaPrivMB,
			"delta ws": r.deltaWsMB,
			"doc open MB": r.openedDeltaMB,
			"hayro cache MB": r.cacheMB,
			renders: r.renders,
			"avg render ms": r.avgRenderMs,
			...(windowMode ? { gpu: JSON.stringify(r.gpu) } : {}),
		})),
	);
	for (const r of results)
		if (r.sampledAtPage)
			console.log(`${r.label} scroll50 samples (priv/ws MB at page N):`, JSON.stringify(r.sampledAtPage), `in ${r.scrollSeconds}s`);
	return results;
}

// ---------------------------------------------------------------------------------------------------------------- main
const scen = val("scenario");
if (scen) {
	await scenario(scen, val("pdf")!, has("window"));
} else {
	const pdfs = vals("pdf").length ? vals("pdf") : DEFAULT_PDFS;
	const onlyT = has("timing"),
		onlyM = has("memory") || has("latency");
	const result: Record<string, unknown> = { when: new Date().toISOString(), dpr, native: nativeVersion() };
	if (!onlyM) result.timing = await timing(pdfs);
	if (has("latency"))
		result.latency = await memory(
			pdfs,
			has("window"),
			val("modes", "slow,fast,jump")!
				.split(",")
				.map((m) => `lat-${m}`),
		);
	else if (!onlyT) result.memory = await memory(pdfs, has("window"));
	const out = val("out", `${SCRATCH}/reader-bench.json`)!;
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, 1));
	console.log("\nwrote", out);
	process.exit(0);
}
