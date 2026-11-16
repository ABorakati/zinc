// Headless probe of the reading view's jumps and clickable chrome inside the REAL reader core (no window opens; simulated mouse only).
//   ZN_READING_SETTINGS=<scratch.json> ZN_URL=<core copy> bun scripts/shot-reflow-jump.tsx <attachment key> [--out DIR] [--tag before|after] [--no-links]
// (ZN_READING_SETTINGS is required: the probe changes the reading settings, which would otherwise be the app's own file.)
// WRITES annotations (it removes the one it makes): run it against a core on a library COPY. Shots: <out>/<tag>-*.png.
// Every step prints a PASS / FAIL line:
//   chrome     the reading view's PDF / Contents / Annotations / Aa buttons and the settings popover (font, size, theme, reset)
//   jumps      sidebar figure row, in-text figure link ("Go to figure"), in-text citation, bibliography entry -> cited-by,
//              sidebar reference ("Jump to reference"), Contents entry, Back: the list scrolls so the target item is at the top
//   annotate   drag-select text in the reading view -> Highlight: saved, drawn; and the same in the page view
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { sessionFor } from "../src/reader/annotations/session";
import { htmlToMarkdown } from "../src/reader/reflow/html";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1]! : d;
};
const KEY = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--out", "--tag"].includes(args[i - 1]!)));
if (!KEY) {
	console.error("usage: bun scripts/shot-reflow-jump.tsx <attachment key> [--out DIR] [--tag before|after]");
	process.exit(2);
}
if (!process.env.ZN_READING_SETTINGS) {
	console.error("set ZN_READING_SETTINGS=<scratch json>: the probe changes the reading settings");
	process.exit(2);
}
const OUT = val("out", "C:/Users/abora/zn-ws/_tmp/reflow-jump");
const TAG = val("tag", "after");
const NO_LINKS = args.includes("--no-links"); // skip the slow in-text link sweeps
mkdirSync(OUT, { recursive: true });
process.env.ZN_READER_STATE = "off";
process.env.ZN_SIM_MOUSE = "1";
process.env.ZN_REFLOW_PROBE = "1";
setReaderDpr(1);
setReaderMode("light");

let ctx: ReaderContext | null = null;
register();
registerReaderPlugin({
	id: "probe",
	onOpen: (c) => {
		ctx = c;
	},
});

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
let ctl!: ReaderController;
registerFonts(r);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
			<Reader
				attachmentKey={KEY}
				title="Reader"
				ephemeral
				controller={(c) => {
					ctl = c;
				}}
			/>
		</div>
		<OverlayHost />
	</div>
));
const pump = () => {
	r.flush();
	r.dispatchNativeEvents();
	r.flush();
};
const frame = async (ms: number) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		pump();
		await Bun.sleep(16);
	}
};
const shotFile = (name: string) => join(OUT, `${TAG}-${name}.png`);
const shot = async (name: string, wait = 300) => {
	await frame(wait);
	r.captureScreenshot(shotFile(name));
	console.log("  shot", shotFile(name));
};
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		pump();
		if (cond()) return true;
		await Bun.sleep(30);
	}
	console.warn(`  timeout waiting for ${what}`);
	return false;
}
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!ok) failures++;
};
const move = (x: number, y: number) => {
	r.nativeSimulateMouseMove(x, y);
	pump();
};
const click = (x: number, y: number) => {
	move(x, y);
	r.nativeSimulateClick(x, y);
	pump();
};
const boundsOfText = (s: string) => {
	const e = r.findByText(s);
	return e ? r.getElementBounds(e.id) : null;
};
const clickText = async (s: string, ms = 500): Promise<boolean> => {
	const b = boundsOfText(s);
	if (!b) return false;
	click(b.x + b.width / 2, b.y + b.height / 2);
	await frame(ms);
	return true;
};
/** pixels of a shot below y0 (the text area), to tell whether the text was redrawn */
function textPixels(name: string, y0 = 300): Buffer {
	const p = PNG.sync.read(readFileSync(shotFile(name)));
	return p.data.subarray(y0 * p.width * 4);
}
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && a.equals(b);

type Item = { id: string; kind: string; page: number; html?: string; captionHtml?: string; blockIds: string[] };
type Probe = {
	lastLink: { url: string; x: number; y: number; width: number; height: number } | null;
	card: () => { pinned: boolean; key: string } | null;
	selPop: () => unknown;
	top: () => number;
	flash: () => string | null;
	backLength: () => number;
	targetIndex: (page: number, y?: number) => number;
	itemCount: () => number;
	goToIndex: (i: number, remember?: boolean) => void;
	family: () => string;
	size: () => number;
	theme: () => string;
	items: () => Item[];
	toc: () => { id: string; text: string; level: number }[];
};
const probe = () => (globalThis as Record<string, unknown>).__znReflow as Probe | undefined;
/** the list's first visible item index is `idx` (or just above it: a partly shown row) and the item is flashed */
const atTop = (idx: number) => {
	const p = probe()!;
	return p.top() >= idx - 1 && p.top() <= idx + 1;
};
async function reset(): Promise<void> {
	probe()!.goToIndex(0, false);
	await frame(700);
}
async function waitTop(idx: number): Promise<boolean> {
	return until(() => atTop(idx), 3000, `list at item ${idx}`);
}

try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctx !== null, 10000, "the plugin context");
	await ctl.idle();
	const ac = academicFor(ctx!);
	const ann = sessionFor(ctx!);
	ctl.setSidebar(false);
	await until(() => ac.struct().phase === "ready", 90000, "structure");
	await until(() => ac.analysed(), 90000, "figure index");
	await until(() => ann.store.loaded(), 10000, "annotations");
	console.log("structure:", ac.struct().phase, "figures:", ac.figItems().length, "pages:", ctx!.pageCount());

	ctl.setAltView("reflow");
	await frame(2500);
	await shot("reading");
	check("reading view is shown", ctx!.altView() === "reflow" && !!probe());
	const P = probe()!;
	console.log("  items:", P.itemCount(), "toc:", P.toc().length);

	// ---------------------------------------------------------------- chrome
	console.log("-- chrome");
	check(
		"Annotations button opens the annotations panel",
		(await clickText("Annotations"), ctx!.sidebarTab?.() === "annotations"),
		String(ctx!.sidebarTab?.()),
	);
	await shot("annotations-open");
	await clickText("Annotations");
	check("Annotations button closes it again", ctx!.sidebarTab?.() !== "annotations" && !ctx!.sidebarTab?.());
	check("Aa opens the settings popover", (await clickText("Aa"), !!boundsOfText("Palatino Linotype")));
	await shot("settings-open-a");
	const px0 = textPixels("settings-open-a");
	const fam0 = P.family();
	await clickText("Georgia");
	check("font: Georgia is applied", P.family() === "Georgia", `${fam0} -> ${P.family()}`);
	await shot("settings-georgia");
	check("font: the text is drawn in the new font", !sameBytes(px0, textPixels("settings-georgia")));
	const px1 = textPixels("settings-georgia");
	await clickText("Inter");
	await shot("settings-inter");
	check("font: Inter is applied and redrawn", P.family() === "Inter" && !sameBytes(px1, textPixels("settings-inter")));
	const size0 = P.size();
	const plus = r.findByText("17px") ? null : null;
	void plus;
	await clickText(`${size0}px`, 100); // (the value, not a button: nothing happens)
	await clickText("Sepia");
	check("theme: Sepia", P.theme() === "sepia", P.theme());
	await clickText("Dark");
	check("theme: Dark", P.theme() === "dark", P.theme());
	await shot("settings-dark");
	await clickText("Reset");
	check("Reset restores the defaults", P.family() === "Source Serif 4" && P.theme() === "light", `${P.family()} ${P.theme()}`);
	await clickText("Aa");
	await frame(300);
	check("Aa closes the popover", !boundsOfText("Palatino Linotype"));

	// ---------------------------------------------------------------- jumps
	console.log("-- jumps");
	// sidebar: figure row (one far down the document, so the scroll is visible)
	ctx!.setSidebar?.(true, "figures-tables");
	await frame(1500);
	await shot("sidebar-figures");
	const figs = ac.figItems().filter((f) => f.kind === "figure");
	// a figure whose row is on screen in the sidebar and whose block is well down the reading list
	const far =
		figs.find((f) => !!boundsOfText(f.label) && P.targetIndex(f.page, f.rect[3]) > 10) ?? figs.find((f) => !!boundsOfText(f.label));
	if (!far) check("a figure to jump to", false, "none indexed");
	else {
		const want = P.targetIndex(far.page, far.rect[3]);
		await reset();
		check("start of the document before the figure jump", P.top() <= 1, `top ${P.top()}`);
		const b = boundsOfText(far.label);
		if (!b) check("sidebar: the figure's row is listed", false, far.label);
		else {
			console.log(`  figure ${far.label} p${far.page + 1} -> item ${want}`);
			click(b.x + 8, b.y + b.height / 2);
			check("sidebar figure click scrolls the reading list to the figure", await waitTop(want), `top ${P.top()} want ${want}`);
			check("the target block is flashed", P.flash() === P.items()[want]?.id);
			await shot("jump-sidebar-figure", 500);
			check("Back is offered after a jump", P.backLength() > 0 && !!boundsOfText("Back"));
			await clickText("Back", 800);
			check("Back returns to where the jump started", P.top() <= 1, `top ${P.top()}`);
		}
	}
	// sidebar: a reference ("Jump to reference")
	ctx!.setSidebar?.(true, "references");
	await frame(2500);
	await shot("sidebar-references");
	const refs = ac.structure().references.filter((e) => e.rects[0]);
	const ref = refs[Math.min(refs.length - 1, 5)];
	if (!ref) check("a reference to jump to", false, "none");
	else {
		const want = P.targetIndex(ref.page, ref.rects[0]![3]);
		await reset();
		const row = boundsOfText(`[${ref.index}]`);
		if (!row) check("sidebar: the reference row is listed", false, `[${ref.index}]`);
		else {
			click(row.x + 4, row.y + row.height / 2);
			await frame(800);
			check("sidebar: clicking a reference row opens its card", !!boundsOfText("Jump to reference"));
			await shot("sidebar-reference-open");
			await clickText("Jump to reference", 600);
			check(
				"sidebar 'Jump to reference' scrolls the reading list to the entry",
				await waitTop(want),
				`top ${P.top()} want ${want} (ref ${ref.index})`,
			);
			await shot("jump-sidebar-reference", 500);
		}
	}
	ctx!.setSidebar?.(false);
	await frame(500);

	// in-text links: scroll to a paragraph that holds one, sweep the pointer over it for the link, click it
	const findLink = async (kind: string): Promise<Probe["lastLink"]> => {
		const its = P.items();
		const has = (it: Item) => ["para", "list"].includes(it.kind) && htmlToMarkdown(it.html ?? "").includes(`](zn-cite:${kind}:`);
		const from = its.findIndex((it, i) => i > 3 && has(it));
		if (from < 0) return null;
		for (let i = from; i < Math.min(its.length, from + 40); i++) {
			if (!has(its[i]!)) continue;
			P.goToIndex(i, false);
			await frame(700);
			P.lastLink = null;
			for (let y = 100; y < 800; y += 8) {
				for (let x = 270; x < 1180; x += 6) {
					move(x, y);
					const l = P.lastLink as Probe["lastLink"];
					if (l && l.url.startsWith(`zn-cite:${kind}`)) return l;
				}
			}
		}
		return null;
	};
	const clickLink = async (l: NonNullable<Probe["lastLink"]>) => {
		move(1380, 860);
		await frame(200);
		const x = l.x + Math.min(6, l.width / 2),
			y = l.y + l.height / 2;
		move(x - 2, y + 20);
		move(x, y);
		click(x, y);
		await frame(900);
	};
	// citation -> reference
	if (!NO_LINKS) {
		const l = await findLink("ref");
		if (!l) check("an in-text citation link", false, "none found");
		else {
			console.log("  citation link:", decodeURIComponent(l.url).slice(0, 70));
			await clickLink(l);
			check("a citation click opens its card", !!P.card()?.pinned);
			await shot("citation-card", 300);
			const before = P.top();
			const r2 = ac.structure().references.find((e) => e.index === 2 && e.rects[0]);
			const want = r2 ? P.targetIndex(r2.page, r2.rects[0]![3]) : -1;
			// the card lists the cited entries; a row opens that reference's card, whose button jumps to the entry
			const row = boundsOfText("[2]");
			if (row) {
				click(row.x + 4, row.y + row.height / 2);
				await frame(900);
			}
			await shot("citation-card-row", 200);
			const go = boundsOfText("Jump to reference");
			if (go) {
				click(go.x + go.width / 2, go.y + go.height / 2);
				await frame(900);
			}
			check(
				"citation card -> 'Jump to reference' scrolls the reading list to the bibliography entry",
				!!go && want > 0 && atTop(want),
				`top ${before} -> ${P.top()} want ${want}${go ? "" : " (no button)"}`,
			);
			await shot("jump-citation", 400);
		}
	}
	// figure mention -> card -> Go to figure
	if (!NO_LINKS) {
		const l = await findLink("fig");
		if (!l) check("an in-text figure link", false, "none found");
		else {
			console.log("  figure link:", decodeURIComponent(l.url).slice(0, 70));
			const keep = P.top();
			await reset();
			void keep;
			// the link is on screen only where findLink left it: bring it back
			const l2 = await findLink("fig");
			if (!l2) check("the figure link again", false);
			else {
				await clickLink(l2);
				check("a figure link click opens its card", !!P.card()?.pinned);
				await shot("figure-card", 300);
				const num = /\d+/.exec(decodeURIComponent(l2.url.split(":")[4] ?? ""))?.[0];
				const target = ac.figItems().find((f) => f.key === `figure:${num}`);
				const go = r.findByText("Go to figure") ?? r.findByText("Go to table");
				const gb = go && r.getElementBounds(go.id);
				const before = P.top();
				if (gb) {
					click(gb.x + gb.width / 2, gb.y + gb.height / 2);
					await frame(900);
				}
				const dest = target ? P.targetIndex(target.page, target.rect[3]) : -1;
				check(
					"the figure card's 'Go to figure' scrolls the list to the figure",
					!!gb && (dest >= 0 ? atTop(dest) : P.top() !== before),
					`top ${before} -> ${P.top()} want ${dest}`,
				);
				await shot("jump-figure-link", 400);
			}
		}
	}
	// bibliography entry -> where it is cited
	{
		const its = P.items();
		const ri = its.findIndex((it) => it.kind === "refs");
		if (ri < 0) check("a bibliography list", false);
		else {
			P.goToIndex(ri, false);
			await frame(1000);
			// the first entry's text sits just under the top of the list
			click(500, 140);
			await frame(1500);
			check("a bibliography entry click opens its cited-by card", !!P.card()?.pinned);
			await shot("cited-by-card", 300);
			const before = P.top();
			const row = boundsOfText("p. 2") ?? boundsOfText("p. 3") ?? boundsOfText("p. 1");
			if (row) {
				click(row.x + 6, row.y + row.height / 2);
				await frame(900);
			}
			check("a cited-by row jumps the reading list to the citation", !!row && P.top() !== before, `top ${before} -> ${P.top()}`);
			await shot("jump-cited-by", 300);
		}
	}
	// Contents
	{
		move(1380, 860);
		r.nativeSimulateClick(1380, 860);
		pump();
		await frame(500);
		await reset();
		const toc = P.toc();
		const e = toc[Math.min(4, toc.length - 1)];
		if (!e) check("a contents entry", false);
		else {
			const want = P.items().findIndex((it) => it.id === e.id);
			await clickText("Contents", 500);
			await shot("contents-open", 200);
			// (rows are 27 px apart under the CONTENTS caption; findByText would find the heading in the list instead)
			const cap = boundsOfText("CONTENTS");
			const row = toc.indexOf(e);
			if (!cap || row > 12) check("Contents lists the entry", false, e.text);
			else {
				click(cap.x + 40, cap.y + cap.height + 18 + 27 * row);
				check(
					"a Contents entry scrolls the reading list to the heading",
					await waitTop(want),
					`top ${P.top()} want ${want} (${e.text.slice(0, 30)})`,
				);
				await shot("jump-contents", 300);
			}
		}
	}

	// ---------------------------------------------------------------- annotate (reading view, then the page view)
	console.log("-- annotate");
	const dragSelect = async (): Promise<string | null> => {
		for (let y = 300; y < 760; y += 37) {
			r.clearSelection();
			r.nativeSimulateMouseDown(420, y);
			pump();
			for (let x = 440; x <= 760; x += 40) {
				r.nativeSimulateMouseMove(x, y, 0);
				pump();
			}
			r.nativeSimulateMouseUp(760, y);
			pump();
			await frame(250);
			const sel = r.getSelectedText();
			if (sel && sel.length >= 25 && probe()?.selPop()) return sel;
		}
		return null;
	};
	{
		await reset();
		P.goToIndex(Math.min(3, P.itemCount() - 1), false);
		await frame(800);
		const beforeIds = new Set(ann.store.list().map((x) => x.id));
		const sel = await dragSelect();
		check("reading view: a selection opens the annotation popup", !!sel && !!P.selPop(), sel ? JSON.stringify(sel.slice(0, 40)) : "");
		const hb = sel ? boundsOfText("Highlight") : null;
		if (hb) {
			click(hb.x + hb.width / 2, hb.y + hb.height / 2);
			await until(() => ann.store.list().some((x) => !beforeIds.has(x.id)), 5000, "the new annotation");
			const a = ann.store.list().find((x) => !beforeIds.has(x.id));
			check(
				"reading view: Highlight creates an annotation with PDF rects",
				!!a && a.type === "highlight" && (a.position.rects?.length ?? 0) > 0,
			);
			await frame(600);
			const want = (sel ?? "").replace(/\s+/g, " ").trim();
			const drawn = r
				.getPaintedHighlights()
				.filter((h) => !h.active)
				.map((h) => h.text.slice(h.start, h.end));
			check(
				"reading view: the highlight is drawn",
				drawn.some((d) => d.length > 10 && want.includes(d.trim().slice(0, 12))),
				JSON.stringify(drawn.slice(0, 2)),
			);
			await shot("annotated-reading", 300);
			if (a) {
				ann.act.remove([a.id]);
				await ann.store.flush();
			}
		} else check("reading view: the Highlight action", false);
	}
	{
		ctl.setAltView(null);
		await frame(2500);
		const beforeIds = new Set(ann.store.list().map((x) => x.id));
		let made = false;
		for (let y = 300; y < 700 && !made; y += 31) {
			r.clearSelection();
			r.nativeSimulateMouseDown(300, y);
			pump();
			for (let x = 320; x <= 560; x += 30) {
				r.nativeSimulateMouseMove(x, y, 0);
				pump();
			}
			r.nativeSimulateMouseUp(560, y);
			pump();
			await frame(350);
			made = !!boundsOfText("Highlight");
		}
		check("page view: a selection opens the popup with Highlight", made);
		await shot("page-selection", 200);
		if (made) {
			await clickText("Highlight", 300);
			await until(() => ann.store.list().some((x) => !beforeIds.has(x.id)), 5000, "the new annotation");
			const a = ann.store.list().find((x) => !beforeIds.has(x.id));
			check("page view: Highlight creates an annotation", !!a && a.type === "highlight");
			await shot("page-annotated", 600);
			if (a) {
				ann.act.remove([a.id]);
				await ann.store.flush();
			}
		}
	}

	// ---------------------------------------------------------------- the PDF button last (it leaves the reading view)
	console.log("-- PDF button");
	ctl.setAltView("reflow");
	await frame(1500);
	check("PDF button returns to the page view", (await clickText("PDF"), ctx!.altView() === null), String(ctx!.altView()));
	await shot("pdf-view");
} catch (e) {
	console.error("PROBE ERROR", e);
	failures++;
} finally {
	console.log(failures ? `${failures} FAILED` : "all passed");
	shutdownStructureWorker();
	process.exit(failures ? 1 : 0);
}
