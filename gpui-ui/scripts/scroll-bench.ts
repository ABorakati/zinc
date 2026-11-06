// Real-window scroll benchmark: boots the real app (src/main.tsx, same code path as the installed exe) in a visible GPUI window on a
// COPY of the library, then wheel-scrolls the list in-process with the live renderer's simulateScrollWheel (no OS mouse/keyboard)
// at slow / fast / fling speeds, in the cards view and the Classic table, and reports:
//   * frame draw times from GPUI's debug frame overlay stats (p50/p90/p99/max of the last 1000 draws) and frames drawn per second
//   * JS event-loop lag while scrolling (a stalled JS thread = a choppy list) and the time simulateScrollWheel blocks for
//   * mutation batches / ops sent to the native tree per wheel step (what the Solid commit changes)
//   * row evaluations per step (store.itemAt runs: rows that re-render), skeleton evaluations, page fetches, backwards jumps
//
//   bun scripts/scroll-bench.ts --db C:/path/to/library-COPY.sqlite [--view cards|table|both] [--profile slow,fast,fling,updown]
//                               [--secs 3] [--json out.json] [--step 16]
//   --step ms: one wheel step every <ms> (default 16) at the same px/s. GPUI draws one frame per input, so at 16 ms fps can't pass
//              ~62; use --step 8 to see whether the app can keep up at 120 fps.
// ZN_DB must be a VACUUM INTO copy (the core writes to it). Never point it at data/library.sqlite.
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DB = arg("db", process.env.ZN_DB);
if (!DB) { console.error("usage: bun scripts/scroll-bench.ts --db <library COPY .sqlite>"); process.exit(2); }
if (/zotero-next[\\/]data[\\/]library\.sqlite$/i.test(DB.replaceAll("\\", "/"))) { console.error("refusing to use the real library"); process.exit(2); }
const VIEWS = (arg("view", "both") === "both" ? ["cards", "table"] : [arg("view", "cards")!]) as ("cards" | "table")[];
const PROFILES = (arg("profile", "slow,fast,fling,updown") ?? "").split(",").filter(Boolean);
const SECS = Number(arg("secs", "3"));
const TRACE = arg("trace");
const STEP = Number(arg("step", "16"));

process.env.ZN_DB = DB;
process.env.ZN_UI_STATE = "off"; // never read or write the user's ui-state.json
process.env.ZN_PORT ??= "23187";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const r2 = (x: number) => Math.round(x * 100) / 100;

// ZN_BENCH_BOOT=<module>: boot something other than the whole app (experiments, e.g. the list alone in a window)
// (a literal specifier on the default path lets build.ts compile this script into an exe: --entry scripts/scroll-bench.ts [--aot])
if (process.env.ZN_BENCH_BOOT) await import(process.env.ZN_BENCH_BOOT);
else await import("../src/main");
const { store, stats } = await import("../src/store");
type Native = {
	getAutomationTree(): string;
	getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null;
	getListScrollTop(id: number): number[] | null;
	simulateScrollWheel(x: number, y: number, dx: number, dy: number): void;
	scrollToItem(id: number, index: number, offset?: number): void;
	applyBatch(json: string): number[];
	setDebugFrameOverlay(mode: string): string;
	resetDebugFrameOverlayStats(): void;
	getDebugFrameOverlayStats(): { currentMs?: number; p90Ms?: number; p99Ms?: number; maxMs?: number; frames: number; samples: number };
	getPaintedText(): string[];
	getWindowSize(): { width: number; height: number };
	zoomWindow(): void;
	activateWindow(): void;
};
const host = (globalThis as Record<symbol, { renderer?: Native }>)[Symbol.for("@gpuix/solid/render-host")];
const R = host!.renderer!;

// wait for the first page + groups
{
	const t0 = performance.now();
	while (performance.now() - t0 < 60_000 && !(store.pagesLoaded() > 0 && store.groups().length)) await sleep(50);
	console.log(`ready: total=${store.total()} groups=${store.groups().length} after ${Math.round(performance.now() - t0)} ms`);
}
// --left 0|1 / --right 0|1: show or hide the sidebar / item pane (frame-cost breakdown of the rest of the window)
{
	const layout = await import("../src/shell/layout");
	if (arg("left")) layout.setLeftOpen(arg("left") === "1");
	if (arg("right")) layout.setRightOpen(arg("right") === "1");
	const sb = await import("../src/sidebar/state");
	if (arg("coll")) sb.setCollectionsOpen(arg("coll") === "1");
	if (arg("lib")) sb.setLibraryOpen(arg("lib") === "1");
	if (arg("tags")) sb.setTagsOpen(arg("tags") === "1");
}
// --win WxH: resize this process's own window (logical px; SetWindowPos on the top-level window owned by this pid, never another
// window); --max 1 maximises it (zoomWindow). DPR is the display's (this machine: 200%), so 1920x1080 logical = 3840x2160 physical.
if (arg("win") && process.platform === "win32") {
	const [w, h] = arg("win")!.split("x").map(Number) as [number, number];
	const { dlopen, FFIType, JSCallback } = await import("bun:ffi");
	const u = dlopen("user32.dll", {
		EnumWindows: { args: [FFIType.function, FFIType.i64], returns: FFIType.i32 },
		GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
		SetWindowPos: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
		GetDpiForWindow: { args: [FFIType.ptr], returns: FFIType.u32 },
	});
	const pid = new Uint32Array(1);
	let hwnd: bigint | null = null;
	const cb = new JSCallback((h: bigint) => {
		u.symbols.GetWindowThreadProcessId(h as never, pid);
		if (pid[0] === process.pid && u.symbols.IsWindowVisible(h as never)) { hwnd = h; return 0; }
		return 1;
	}, { args: [FFIType.ptr], returns: FFIType.i32 });
	u.symbols.EnumWindows(cb.ptr as never, 0 as never);
	if (hwnd) {
		const dpi = u.symbols.GetDpiForWindow(hwnd as never) || 96;
		const s = dpi / 96;
		u.symbols.SetWindowPos(hwnd as never, 0 as never, 0, 0, Math.round(w * s), Math.round(h * s), 0x0002 | 0x0004 | 0x0010); // NOMOVE | NOZORDER | NOACTIVATE
		console.log(`window ${w}x${h} logical at dpi ${dpi} (x${s})`);
	} else console.error("--win: no window found for this process");
}
if (arg("max") === "1") R.zoomWindow();
await sleep(1500);
console.log("window", JSON.stringify(R.getWindowSize()));

// --select N: select item N (fills the item pane)
if (arg("select")) {
	const n = Number(arg("select"));
	for (let i = 0; i < 100 && !store.itemAt(n); i++) await sleep(50);
	const it = store.itemAt(n);
	if (it) store.selectOnly(it.key, n);
	await sleep(1500);
}
/** The automation tree as JSON; the native side answers on its next drawn frame, so retry (and wake the window) when it times out. */
const treeJson = async (): Promise<string> => {
	for (let k = 0; ; k++) {
		try { return R.getAutomationTree(); } catch (e) { if (k >= 6) throw e; R.activateWindow(); await sleep(500); }
	}
};
type TN = { type: string; children?: TN[] };
const countNodes = (n: TN, acc: Record<string, number> = {}) => { acc[n.type] = (acc[n.type] ?? 0) + 1; for (const c of n.children ?? []) countNodes(c, acc); return acc; };
const nodeReport = async (label: string) => {
	const a = countNodes(JSON.parse(await treeJson()) as TN);
	console.log(`nodes[${label}] total=${Object.values(a).reduce((x, y) => x + y, 0)} ${JSON.stringify(a)}`);
};
if (arg("nodes") === "1") await nodeReport("window");
if (arg("dump")) await Bun.write(arg("dump")!, await treeJson());

// count + time the mutation batches the Solid commit sends to the native tree
let batches = 0, ops = 0, batchMs = 0, maxBatchMs = 0;
const origApply = R.applyBatch.bind(R);
R.applyBatch = (json: string) => {
	const t0 = performance.now();
	const out = origApply(json);
	const d = performance.now() - t0;
	batches++; batchMs += d; maxBatchMs = Math.max(maxBatchMs, d);
	try { ops += JSON.parse(json).length; } catch { /* ignore */ }
	return out;
};

// JS event-loop lag: a 2 ms timer; its overshoot is the time the JS thread was busy elsewhere
let lagSamples: number[] = [];
// per-frame draw time (ms) and the interval between drawn frames (ms), sampled every ~2 ms from the overlay stats: the frame counter
// moves when a frame is drawn and currentMs is that frame's draw time
let drawSamples: number[] = [], frameGaps: number[] = [];
const frameLog: string[] = []; // --trace <file>: "tMs,drawMs,gapMs" per drawn frame of every profile
let traceT0 = performance.now();
{
	let last = performance.now(), lastFrames = R.getDebugFrameOverlayStats().frames, lastFrameAt = last;
	setInterval(() => {
		const now = performance.now();
		lagSamples.push(Math.max(0, now - last - 2));
		last = now;
		const s = R.getDebugFrameOverlayStats();
		if (s.frames !== lastFrames) {
			const n = s.frames - lastFrames;
			drawSamples.push(s.currentMs ?? 0);
			frameGaps.push((now - lastFrameAt) / n);
			if (TRACE) frameLog.push(`${(now - traceT0).toFixed(1)},${(s.currentMs ?? 0).toFixed(2)},${((now - lastFrameAt) / n).toFixed(1)}`);
			lastFrames = s.frames; lastFrameAt = now;
		}
	}, 2);
}

undefined
type Box = { x: number; y: number; width: number; height: number };
type TreeNode = { id: number; testId?: string; bounds?: Box; children?: TreeNode[] };
/** The list element and the painted bounds of its nearest ancestor (the virtual-list itself reports none). */
async function findList(testId: string): Promise<{ id: number; b: Box } | null> {
	const walk = (n: TreeNode, anc: Box | undefined): { id: number; b: Box } | null => {
		if (n.testId === testId) return anc ? { id: n.id, b: anc } : null;
		for (const c of n.children ?? []) { const f = walk(c, n.bounds ?? anc); if (f) return f; }
		return null;
	};
	return walk(JSON.parse(await treeJson()) as TreeNode, undefined);
}

type Result = Record<string, number | string>;
const results: Result[] = [];

async function settle(listId: number, to = 0) {
	R.scrollToItem(listId, to);
	await sleep(800);
}

/** Wheel deltas (px, positive = scroll down) per 16 ms frame for a profile. */
function* deltas(profile: string): Generator<{ dy: number; gap?: number }> {
	const frames = Math.round((SECS * 1000) / STEP);
	if (profile === "slow") for (let i = 0; i < frames; i++) yield { dy: 24 * STEP / 16 };
	else if (profile === "fast") for (let i = 0; i < frames; i++) yield { dy: 100 * STEP / 16 };
	else if (profile === "blast") for (let i = 0; i < frames; i++) yield { dy: 400 * STEP / 16 }; // ~25 000 px/s
	else if (profile === "longback") { for (let i = 0; i < frames; i++) yield { dy: 600 * STEP / 16 }; for (let i = 0; i < frames; i++) yield { dy: -600 }; }
	else if (profile === "updown") { for (let i = 0; i < frames; i++) yield { dy: 60 * STEP / 16 }; for (let i = 0; i < frames; i++) yield { dy: -60 }; }
	else if (profile === "fling") {
		for (let k = 0; k < 3; k++) {
			let v = 500;
			while (v > 1) { yield { dy: v }; v *= 0.94; }
			yield { dy: 0, gap: 600 };
		}
	}
}

async function runProfile(view: string, profile: string, listId: number, cx: number, cy: number) {
	await settle(listId, 0);
	const f0 = R.getDebugFrameOverlayStats().frames;
	R.resetDebugFrameOverlayStats();
	lagSamples = []; drawSamples = []; frameGaps = [];
	batches = ops = 0; batchMs = maxBatchMs = 0;
	const s0 = { ...stats };
	stats.visMaxMs = 0; stats.fetchMaxMs = 0;
	const callMs: number[] = [], anchorHist: number[] = [];
	let backwards = 0, steps = 0, lastIdx = 0, maxJump = 0;
	const lastDy: number[] = [];
	const t0 = performance.now();
	let next = t0;
	for (const { dy, gap } of deltas(profile)) {
		if (gap) { await sleep(gap); next = performance.now(); continue; }
		const a = performance.now();
		R.simulateScrollWheel(cx, cy, 0, -dy); // negative deltaY scrolls down
		callMs.push(performance.now() - a);
		steps++;
		lastDy.push(dy);
		const anchor = R.getListScrollTop(listId);
		if (anchor) {
			const idx = anchor[0]! + (anchor[1]! / 100);
			const moved = idx - lastIdx;
			if (dy > 0 && moved < -0.5) backwards++;
			if (dy < 0 && moved > 0.5) backwards++;
			maxJump = Math.max(maxJump, Math.abs(moved));
			lastIdx = idx;
			anchorHist.push(anchor[0]!);
		}
		next += STEP;
		const wait = next - performance.now();
		await sleep(Math.max(0, wait));
	}
	const wall = performance.now() - t0;
	await sleep(400);
	const ov = R.getDebugFrameOverlayStats();
	const framesDrawn = ov.frames - f0;
	const lag = lagSamples;
	const row: Result = {
		view, profile, steps, wallSec: r2(wall / 1000),
		framesDrawn, fps: r2(framesDrawn / (wall / 1000)),
		drawP10: r2(q(drawSamples, 0.1)), drawP25: r2(q(drawSamples, 0.25)), drawP50: r2(q(drawSamples, 0.5)), drawP95: r2(q(drawSamples, 0.95)), drawP99s: r2(q(drawSamples, 0.99)), gapP99: r2(q(frameGaps, 0.99)), gapP50: r2(q(frameGaps, 0.5)), gapP95: r2(q(frameGaps, 0.95)),
		slowFrames25: frameGaps.filter((x) => x > 25).length, slowFrames40: frameGaps.filter((x) => x > 40).length, drawCur: r2(ov.currentMs ?? 0), drawP90: r2(ov.p90Ms ?? 0), drawP99: r2(ov.p99Ms ?? 0), drawMax: r2(ov.maxMs ?? 0),
		lagP50: r2(q(lag, 0.5)), lagP95: r2(q(lag, 0.95)), lagP99: r2(q(lag, 0.99)), lagMax: r2(Math.max(0, ...lag)),
		lagOver16: lag.filter((x) => x > 16).length, lagOver33: lag.filter((x) => x > 33).length,
		wheelCallP50: r2(q(callMs, 0.5)), wheelCallP95: r2(q(callMs, 0.95)), wheelCallMax: r2(Math.max(0, ...callMs)),
		batches, batchOpsPerStep: r2(ops / Math.max(1, steps)), batchMsTotal: r2(batchMs), batchMsMax: r2(maxBatchMs),
		visCalls: stats.visCalls - s0.visCalls, visMsPerCall: r2((stats.visMs - s0.visMs) / Math.max(1, stats.visCalls - s0.visCalls)), visMsMax: r2(stats.visMaxMs),
		rowEvalsPerStep: r2((stats.itemAt - s0.itemAt) / Math.max(1, steps)), rowEvals: stats.itemAt - s0.itemAt,
		skeletonEvals: stats.skeleton - s0.skeleton, fetches: stats.fetches - s0.fetches, prefetches: stats.prefetches - s0.prefetches,
		evictions: stats.evictions - s0.evictions, fetchMsAvg: r2((stats.fetchMs - s0.fetchMs) / Math.max(1, stats.fetches - s0.fetches)), fetchMsMax: r2(stats.fetchMaxMs), pageTouches: stats.pageTouches - s0.pageTouches,
		backwards, maxAnchorJump: r2(maxJump), endRow: anchorHist.at(-1) ?? 0,
	};
	results.push(row);
	console.log(JSON.stringify(row));
}

for (const view of VIEWS) {
	store.setViewMode(view);
	await sleep(1500);
	const testId = view === "cards" ? "card-list" : "table-list";
	const l = await findList(testId);
	if (!l) { console.error(`no ${testId} in the tree`); continue; }
	const b = l.b;
	const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
	if (arg("nodes") === "1") await nodeReport(view);
	console.log(`-- ${view}: list ${l.id} at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
	for (const p of PROFILES) await runProfile(view, p, l.id, cx, cy);
}

if (TRACE) await Bun.write(TRACE, "t,draw,gap\n" + frameLog.join("\n"));
const out = arg("json");
if (out) await Bun.write(out, JSON.stringify(results, null, 1));
console.log("done");
process.exit(0);
