// Headless scroll test: drives the CardList through all rows of the real library (12,434 items + year headers) in the test
// renderer and reports frame / commit timings and whether pages load and paint correctly. Never opens a window.
//   bun scripts/scroll-test.tsx [--step ROWS (default 8 = about a viewport)] [--wheel TICKS]
//
// Phase 1 "jump": scrollToItem() to every STEP-th row (a fast scrollbar drag). Per step: JS commit (flushSync-equivalent
//   Solid update + mutation batch), native frame (renderer.flush = build + layout + paint), and the time until the expected
//   item's title is painted (page fetch latency included).
// Phase 2 "wheel": nativeSimulateScrollWheel over the first rows (continuous trackpad-like scrolling), per-frame timings.
import { createTestRoot } from "@gpuix/solid/testing";
import { CardList } from "../src/cards/CardList";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";

const arg = (n: string, d: number) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const STEP = arg("step", 8); // ~ one viewport of cards
const WHEEL = arg("wheel", 300);

const t = createTestRoot({ width: 758, height: 880 });
(registerFonts as (r?: unknown) => void)(t.renderer);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "column", width: 758, height: "100%" }}>
		<CardList />
	</div>
));
const r = t.renderer;
const list = () => r.findByType("virtual-list")[0]!;
const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
	return {
		n: s.length,
		mean: +(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(2),
		p50: +q(0.5).toFixed(2),
		p95: +q(0.95).toFixed(2),
		max: +s[s.length - 1]!.toFixed(2),
	};
};

// ---- startup
const t0 = performance.now();
while (performance.now() - t0 < 20000 && !(store.itemAt(0) && store.groups().length)) {
	r.flush();
	await Bun.sleep(20);
}
r.flush();
console.log(
	`startup: first page + groups in ${Math.round(performance.now() - t0)} ms, total=${store.total()}, groups=${store.groups().length}`,
);
const totalRows = store.total() + store.groups().length;
console.log(`logical rows: ${totalRows} (${store.total()} items + ${store.groups().length} headers)`);
console.log(`mounted children: ${list().children.length}`);

/** Item index of the row at `row` (headers interleaved: group g starts at row sum(count_j + 1)). */
function rowToItem(row: number): number | null {
	let r0 = 0,
		start = 0;
	for (const g of store.groups()) {
		if (row === r0) return null; // header
		if (row < r0 + 1 + g.count) return start + (row - r0 - 1);
		r0 += 1 + g.count;
		start += g.count;
	}
	return null;
}

// ---- phase 1: jump through every STEP-th row
const commit: number[] = [],
	frame: number[] = [],
	toPaint: number[] = [];
let unpainted = 0,
	skeletonAfterSettle = 0,
	steps = 0;
const failed: string[] = [];
const requestsBefore = store.pagesLoaded();
const tAll = performance.now();
for (let row = 0; row < totalRows; row += STEP) {
	steps++;
	const a = performance.now();
	r.scrollToItem(list().id, row);
	const b = performance.now();
	r.flush(); // layout + paint, fires onVisibleRange -> Solid commit
	const c = performance.now();
	r.flush();
	const d = performance.now();
	commit.push(c - b);
	frame.push(d - c);
	// wait for the page of the first item row at/after `row` and check it is painted
	const item = rowToItem(row) ?? rowToItem(row + 1);
	const it0 = performance.now();
	if (item !== null) {
		const deadline = it0 + 5000;
		let ok = false;
		while (performance.now() < deadline) {
			const rowData = store.itemAt(item);
			r.flush();
			if (
				rowData &&
				r
					.getPaintedText()
					.some(
						(x) => x === (rowData.title || "(untitled)") || (x.length > 10 && (rowData.title || "").startsWith(x.slice(0, 20))),
					)
			) {
				ok = true;
				break;
			}
			await Bun.sleep(5);
		}
		toPaint.push(performance.now() - it0);
		if (!ok) {
			unpainted++;
			failed.push(`row ${row} item ${item} (${JSON.stringify(store.itemAt(item)?.title?.slice(0, 40))})`);
		}
	}
	void a;
}
const jumpTotal = performance.now() - tAll;
// after the last jump: everything visible must be real content, not skeleton bars
r.flush();
const lastPaint = r.getPaintedText();
if (!lastPaint.some((x) => x.length > 15)) skeletonAfterSettle++;

console.log(`\n== jump: ${steps} jumps (every ${STEP} rows) in ${(jumpTotal / 1000).toFixed(1)} s ==`);
console.log("scrollToItem->frame commit ms :", JSON.stringify(stats(commit)));
console.log("frame (flush) ms              :", JSON.stringify(stats(frame)));
console.log("jump -> painted content ms    :", JSON.stringify(stats(toPaint)));
if (failed.length) console.log("unpainted rows:", failed.join("; "));
console.log(
	`unpainted after 5 s: ${unpainted}/${toPaint.length}; pages fetched during jumps: ${store.pagesLoaded() - requestsBefore}; mounted children now: ${list().children.length}`,
);

// ---- phase 2: wheel scrolling from the top (hover over the list)
r.scrollToItem(list().id, 0);
for (let i = 0; i < 5; i++) {
	r.flush();
	await Bun.sleep(30);
}
const wheelDispatch: number[] = [],
	wheelFrame: number[] = [];
let lastTop = r.getListScrollTop(list().id)?.[0] ?? 0,
	maxJump = 0,
	backwards = 0;
for (let i = 0; i < WHEEL; i++) {
	const a = performance.now();
	r.dispatchScrollWheel(230, 400, 0, -120);
	const b = performance.now();
	r.flush();
	const c = performance.now();
	wheelDispatch.push(b - a);
	wheelFrame.push(c - b);
	const top = r.getListScrollTop(list().id)?.[0] ?? 0;
	if (top < lastTop) backwards++;
	maxJump = Math.max(maxJump, top - lastTop);
	lastTop = top;
	if (i % 20 === 0) await Bun.sleep(1);
}
console.log(`\n== wheel: ${WHEEL} ticks of 120 px ==`);
console.log("wheel dispatch (JS commit) ms:", JSON.stringify(stats(wheelDispatch)));
console.log("frame (flush) ms             :", JSON.stringify(stats(wheelFrame)));
console.log(
	`anchor row now ${lastTop}, backwards steps ${backwards}, max anchor jump ${maxJump} rows (window ${list().children.length} mounted)`,
);
const lateFill = performance.now();
while (performance.now() - lateFill < 3000) {
	r.flush();
	await Bun.sleep(25);
}
const painted = r.getPaintedText();
console.log(`painted strings after settle: ${painted.length}; sample: ${JSON.stringify(painted.slice(0, 4))}`);

t.unmount();
process.exit(0);
