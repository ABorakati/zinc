// Headless probe of the reading view's links, hover cards and annotations, and of the page view's card closing, inside the REAL
// reader core (no window opens; simulated mouse only). WRITES annotations: run it against a core on a library COPY.
//   ZN_URL=<core copy> bun scripts/shot-reflow-annot.tsx <attachment key> [--page N] [--out DIR] [--light] [--keep]
// Steps (each prints a PASS / FAIL line, shots go to <out>/rv-*.png):
//   pdf-card     page view: hover a citation -> card; a press elsewhere closes it; Escape closes it; a pinned card closes on a press
//   rv-links     reading view: links are painted in the link colour (screenshot), hovering one opens its card after a delay,
//                moving into the card keeps it, leaving closes it; a click pins it and a press elsewhere closes it
//   rv-existing  the document's highlights / underlines are drawn as marks over their words in the reading view
//   rv-create    a drag-selection in the reading view -> Highlight: saved with PDF rects; shown in the page view too
// --keep leaves the created annotation in the copy (default: it is deleted again at the end).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import type { KeyEvent } from "@gpuix/native/host";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { sessionFor } from "../src/reader/annotations/session";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { handleWindowKeyDown } from "../src/shell/shortcuts";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const KEY = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && ["out", "page"].includes(args[i - 1]!.slice(2))));
if (!KEY) { console.error("usage: bun scripts/shot-reflow-annot.tsx <attachment key> [--page N] [--out DIR]"); process.exit(2); }
const OUT = val("out", "C:/Users/abora/AppData/Local/Temp/claude/f0fa428ec9c4b270/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/rv-shots");
mkdirSync(OUT, { recursive: true });
process.env.ZN_READER_STATE = "off";
process.env.ZN_SIM_MOUSE = "1";
process.env.ZN_REFLOW_PROBE = "1";
setReaderDpr(1);
setReaderMode(has("light") ? "light" : "dark");

let ctx: ReaderContext | null = null;
register();
registerReaderPlugin({ id: "probe", onOpen: (c) => { ctx = c; } });

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
let ctl!: ReaderController;
registerFonts(r);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
			<Reader attachmentKey={KEY} title="Reader" ephemeral controller={(c) => { ctl = c; }} />
		</div>
		<OverlayHost />
	</div>
));
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const shot = async (name: string, wait = 400) => { await frame(wait); const f = join(OUT, `rv-${name}.png`); r.captureScreenshot(f); console.log("  shot", f); };
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) { pump(); if (cond()) return true; await Bun.sleep(30); }
	console.warn(`  timeout waiting for ${what}`);
	return false;
}
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const move = (x: number, y: number) => r.nativeSimulateMouseMove(x, y);
const press = (x: number, y: number) => { r.nativeSimulateMouseDown(x, y); pump(); r.nativeSimulateMouseUp(x, y); pump(); };
const escape = () => handleWindowKeyDown({ key: "escape", modifiers: {}, preventDefault() {} } as unknown as KeyEvent);
type Probe = { lastLink: { url: string; x: number; y: number; width: number; height: number } | null; card: () => { pinned: boolean; key: string } | null; selPop: () => unknown };
const probe = () => (globalThis as Record<string, unknown>).__znReflow as Probe | undefined;

try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctx !== null, 10000, "the plugin context");
	await ctl.idle();
	const ac = academicFor(ctx!);
	const ann = sessionFor(ctx!);
	ctl.setSidebar(false);
	await until(() => ac.struct().phase !== "loading", 90000, "structure");
	await until(() => ann.store.loaded(), 10000, "annotations");
	console.log("structure:", ac.struct().phase, " annotations:", ann.store.list().length);

	// ---------------------------------------------------------------- page view: the card closes on a press elsewhere / Escape
	{
		let page = Number(val("page", "-1"));
		if (page < 0) {
			for (let i = 0; i < ctx!.pageCount() && page < 0; i++) {
				const ls = await ctx!.pageLinks!(i).catch(() => []);
				if (ls.some((l) => l.target.kind === "page")) page = i;
			}
		}
		ctx!.scrollTo(Math.max(0, page), 0);
		await frame(2500);
		const cite = (await ctx!.pageLinks!(page)).find((l) => l.target.kind === "page");
		const w = cite && ctx!.rectToWindow?.(page, cite.rect);
		if (!w) check("pdf-card: a citation link on a mounted page", false, `page ${page + 1}`);
		else {
			const cx = w.x + w.width / 2, cy = w.y + w.height / 2;
			const away = { x: Math.max(20, w.x - 120), y: Math.min(840, cy + 260) };
			move(cx - 30, cy + 30); await frame(100); move(cx, cy); await frame(1200);
			check("pdf-card: hover opens the card", !!ac.popup() && !ac.popup()!.pinned);
			await shot("pdf-card-hover");
			move(cx + 2, cy); await frame(100);
			press(away.x, away.y); await frame(400);
			check("pdf-card: a press elsewhere closes the hover card", !ac.popup());
			await shot("pdf-card-clickoff");
			move(cx - 30, cy + 30); await frame(100); move(cx, cy); await frame(1200);
			const reopened = !!ac.popup();
			escape(); await frame(300);
			check("pdf-card: Escape closes the card", reopened && !ac.popup());
			press(cx, cy); await frame(800);
			const pinned = !!ac.popup()?.pinned || ctx!.currentPage() !== page; // a citation click may jump instead (the page view's own rule)
			press(away.x, away.y); await frame(400);
			check("pdf-card: a pinned card closes on a press elsewhere", pinned && !ac.popup(), ac.popup() ? "still open" : "");
		}
	}

	// ---------------------------------------------------------------- reading view: blue links, hover cards
	const existing = ann.store.list().find((a) => a.type === "highlight" || a.type === "underline");
	ctl.setAltView("reflow");
	await frame(2500);
	if (existing) { ann.act.jump(existing); await frame(1500); }
	await shot("reading-view", 600);
	// find a link by sweeping the pointer over the text column (the view reports link enters through the probe)
	let link: Probe["lastLink"] = null;
	const sweep = async (): Promise<Probe["lastLink"]> => {
		for (let y = 110; y < 860 && !link; y += 9) {
			for (let x = 300; x < 1200 && !link; x += 7) {
				move(x, y);
				r.dispatchNativeEvents();
				const l = probe()?.lastLink;
				if (l && l.url.startsWith("zn-cite:ref")) link = l;
			}
		}
		return link;
	};
	await sweep();
	for (let k = 0; k < 6 && !link; k++) { r.nativeSimulateScrollWheel(800, 500, 0, -500); await frame(500); await sweep(); }
	if (!link) check("rv-links: a citation link in the reading view", false, "none found");
	else {
		const L = link as NonNullable<Probe["lastLink"]>;
		console.log("  link:", L.url.slice(0, 60), JSON.stringify([L.x, L.y, L.width, L.height]));
		const lx = L.x + Math.min(6, L.width / 2), ly = L.y + L.height / 2;
		move(lx - 40, ly + 60); await frame(700);
		check("rv-links: no card while the pointer is off links", !probe()?.card());
		move(lx, ly); await frame(150);
		check("rv-links: the card waits for the hover delay", !probe()?.card());
		await frame(500);
		check("rv-links: hovering a link opens its card", !!probe()?.card() && !probe()!.card()!.pinned);
		await shot("link-hover", 1200);
		// into the card (it opens just under the link line)
		// (placeAt puts it under the link when there is room for ~320 px, else above)
		const below = L.y + L.height + 4 + 320 <= 872;
		move(lx + 20, below ? L.y + L.height + 30 : L.y - 30); await frame(900);
		check("rv-links: moving into the card keeps it open", !!probe()?.card());
		move(1380, 860); await frame(1200);
		check("rv-links: leaving closes the card", !probe()?.card());
		move(lx, ly); await frame(100);
		press(lx, ly); await frame(600);
		check("rv-links: a click opens it pinned", !!probe()?.card()?.pinned);
		await shot("link-pinned", 800);
		move(1380, 860); await frame(900);
		check("rv-links: a pinned card stays when the pointer leaves", !!probe()?.card()?.pinned);
		press(1380, 860); await frame(400);
		check("rv-links: a press elsewhere closes the pinned card", !probe()?.card());
		move(lx, ly); await frame(800);
		escape(); await frame(300);
		check("rv-links: Escape closes the card", !probe()?.card());
		move(1380, 860); await frame(300);
	}

	// ---------------------------------------------------------------- reading view: the document's annotations as marks
	if (existing) {
		ann.act.jump(existing);
		await frame(2000);
		const marks = r.getPaintedHighlights().filter((h) => !h.active);
		const texts = marks.map((m) => m.text.slice(m.start, m.end));
		console.log("  existing:", existing.type, JSON.stringify(existing.text), "-> marks:", JSON.stringify(texts.slice(0, 6)));
		const want = (existing.text ?? "").replace(/\s+/g, "").toLowerCase();
		check("rv-existing: the annotation is drawn over its words", texts.some((x) => x.replace(/\s+/g, "").toLowerCase().includes(want.slice(0, 20))));
		await shot("existing-annotation", 400);
	} else console.log("  (no highlight / underline in this document to show)");

	// ---------------------------------------------------------------- reading view: highlight a selection
	{
		// a line of body text: the first painted run long enough, found by dragging over a band in the middle of the view
		const before = ann.store.list().length;
		const beforeIds = new Set(ann.store.list().map((x) => x.id));
		let made: string | null = null;
		for (let y = 300; y < 760 && !made; y += 37) {
			r.clearSelection();
			// a real drag: press, move with the button held, release (each step flushes, so the selection registers)
			r.nativeSimulateMouseDown(420, y); pump();
			for (let x = 440; x <= 760; x += 40) { r.nativeSimulateMouseMove(x, y, 0); pump(); }
			r.nativeSimulateMouseUp(760, y); pump();
			const sel = r.getSelectedText();
			pump();
			await frame(200);
			const spans = (r as unknown as { native: { getSelectionSpans(): { elementId: number; start: number; end: number }[] } }).native.getSelectionSpans();
			if (has("debug")) console.log("  drag y", y, JSON.stringify(sel?.slice(0, 40)), "spans", JSON.stringify(spans.map((x) => [x.elementId, x.start, x.end])), "popup", !!probe()?.selPop());
			if (!sel || sel.length < 25 || !probe()?.selPop()) continue;
			made = sel;
		}
		check("rv-create: a selection opens the annotation popup", !!made, made ? JSON.stringify(made.slice(0, 50)) : "");
		if (made) {
			await shot("selection-popup", 300);
			const hl = r.findByText("Highlight");
			const b = hl && r.getElementBounds(hl.id);
			if (!b) check("rv-create: the Highlight action", false);
			else {
				move(b.x + b.width / 2 - 3, b.y + b.height / 2); pump();
				move(b.x + b.width / 2, b.y + b.height / 2); pump();
				press(b.x + b.width / 2, b.y + b.height / 2);
				await until(() => ann.store.list().length > before, 5000, "the new annotation");
				// only ever the annotation this probe made (the copy's own annotations are left alone)
				const a = ann.store.list().find((x) => !beforeIds.has(x.id));
				const ok = !!a && a.type === "highlight" && (a.position.rects?.length ?? 0) > 0;
				check("rv-create: saved with PDF rects", ok, a ? `${a.id} p${a.position.pageIndex + 1} rects=${JSON.stringify(a.position.rects)} text=${JSON.stringify(a.text?.slice(0, 60))}` : "");
				const want = made.replace(/\s+/g, " ").trim();
				check("rv-create: its text is the selected text", !!a && a.text === want, a ? `${JSON.stringify(a.text?.slice(0, 40))} vs ${JSON.stringify(want.slice(0, 40))}` : "");
				await ann.store.flush();
				check("rv-create: written to the core", ann.store.status() === "saved", ann.store.status());
				await frame(500);
				const drawn = r.getPaintedHighlights().filter((h) => !h.active).map((h) => h.text.slice(h.start, h.end));
				check("rv-create: drawn in the reading view", drawn.some((d) => d.length > 10 && want.includes(d.trim().slice(0, 12))), JSON.stringify(drawn.slice(0, 4)));
				await shot("created-reading", 300);
				// the page view shows it
				ctl.setAltView(null);
				await frame(1500);
				if (a) { ann.act.jump(a); await frame(2500); }
				await shot("created-pdf", 500);
				const w = a && ctx!.rectToWindow?.(a.position.pageIndex, { x: a.position.rects![0]![0] / ctx!.pageSize(a.position.pageIndex).w, y: 1 - a.position.rects![0]![3] / ctx!.pageSize(a.position.pageIndex).h, w: 0.01, h: 0.01 });
				console.log("  page-view rect of the new highlight (window px):", JSON.stringify(w));
				// a fresh load from the core has it too (what Zotero sync reads)
				const fresh = await fetch(`${process.env.ZN_URL ?? "http://127.0.0.1:23160"}/api/attachments/${KEY}/annotations`).then((x) => x.json()) as { id: string }[];
				check("rv-create: the core returns it", !!a && fresh.some((x) => x.id === a.id));
				if (a && !has("keep")) { ann.act.remove([a.id]); await ann.store.flush(); console.log("  (removed it again)"); }
			}
		}
	}

	// ---------------------------------------------------------------- reading view: a sticky note from a selection
	{
		ctl.setAltView("reflow");
		await frame(2000);
		const beforeIds = new Set(ann.store.list().map((x) => x.id));
		let opened = false;
		for (let y = 300; y < 760 && !opened; y += 37) {
			r.clearSelection();
			r.nativeSimulateMouseDown(420, y); pump();
			for (let x = 440; x <= 700; x += 40) { r.nativeSimulateMouseMove(x, y, 0); pump(); }
			r.nativeSimulateMouseUp(700, y); pump();
			await frame(250);
			opened = (r.getSelectedText()?.length ?? 0) > 20 && !!probe()?.selPop();
		}
		const nb = opened ? r.findByText("Note") : undefined;
		const b = nb && r.getElementBounds(nb.id);
		if (!b) check("rv-note: the Note action", false);
		else {
			move(b.x + b.width / 2 - 3, b.y + b.height / 2); pump();
			move(b.x + b.width / 2, b.y + b.height / 2); pump();
			press(b.x + b.width / 2, b.y + b.height / 2);
			await until(() => ann.store.list().some((x) => !beforeIds.has(x.id)), 5000, "the new note");
			const n = ann.store.list().find((x) => !beforeIds.has(x.id));
			check("rv-note: a note annotation at the selection", !!n && n.type === "note" && n.position.rects?.length === 1, n ? `p${n.position.pageIndex + 1} ${JSON.stringify(n.position.rects)}` : "");
			await frame(800);
			check("rv-note: shown in the margin of its paragraph", !!n && !!r.findByTestId(`reflow-note-${n.id}`));
			check("rv-note: the annotations panel opens for its comment", ctx!.sidebarTab?.() === "annotations" && !!r.findByText("Add note from annotations"), String(ctx!.sidebarTab?.()));
			await shot("note", 300);
			if (n) {
				ctl.setAltView(null); await frame(1200); ann.act.jump(n); await frame(2500);
				await shot("note-pdf", 300);
				ctl.setAltView("reflow"); await frame(1500);
				if (!has("keep")) { ann.act.remove([n.id]); await ann.store.flush(); console.log("  (removed the note again)"); }
			}
		}
	}

	// ---------------------------------------------------------------- the annotations panel in the reading view
	ctl.setAltView("reflow");
	await frame(1500);
	ctx!.setSidebar?.(true, "annotations");
	await shot("sidebar", 1500);
	ctx!.setSidebar?.(false);
} finally {
	console.log(failures ? `${failures} FAILED` : "all passed");
	shutdownStructureWorker();
	process.exit(failures ? 1 : 0);
}
