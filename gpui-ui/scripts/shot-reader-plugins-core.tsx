// Headless end-to-end check of the reader plugins inside the REAL reader core (src/reader/Reader.tsx), no window opens:
// the plugins' side panels, toolbar items, selection popup, page overlays and alternate view as the core hosts them.
//   bun scripts/shot-reader-plugins-core.tsx <attachment key> [--out DIR] [--light] [--keep]
// Annotations go through the core API (a COPY of the library) and are deleted again unless --keep.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { apiRequest } from "../src/api";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { sessionFor } from "../src/reader/annotations/session";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const KEY = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--out"));
if (!KEY) { console.error("usage: bun scripts/shot-reader-plugins-core.tsx <attachment key> [--out DIR] [--light]"); process.exit(2); }
const OUT = val("out", "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/reader-shots");
mkdirSync(OUT, { recursive: true });
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
			<Reader attachmentKey={KEY} title="Reader with plugins" ephemeral controller={(c) => { ctl = c; }} />
		</div>
		<OverlayHost />
	</div>
));
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const shot = async (name: string, wait = 500) => {
	await frame(wait);
	const file = join(OUT, `plugins-core-${name}.png`);
	r.captureScreenshot(file);
	console.log("shot", file);
};
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) { pump(); if (cond()) return true; await Bun.sleep(30); }
	console.warn(`timeout waiting for ${what}`);
	return false;
}

const created: string[] = [];
try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctl.context() !== null && ctx !== null, 10000, "the plugin context");
	await ctl.idle();
	await shot("page", 1200);
	console.log(`context: key=${ctx!.attachmentKey} item=${ctx!.itemKey} pages=${ctx!.pageCount()}`);

	// ---- annotations: select with the core's own selection, then create through the plugin
	const s = sessionFor(ctx!);
	await until(() => s.store.loaded(), 8000, "annotations");
	ctl.setSidebar(true, "plugin:annotations:annotations");
	await ctl.select({ page: 0, w: 120, c: 0 }, { page: 0, w: 135, c: 3 });
	await shot("selection", 700);
	console.log(`selection: "${ctl.selectedText()?.slice(0, 60)}"`);
	const a1 = await s.act.fromSelection("highlight", "#ffd400");
	await ctl.select({ page: 0, w: 160, c: 0 }, { page: 0, w: 168, c: 2 });
	const a2 = await s.act.fromSelection("underline", "#2ea8e5", { comment: true });
	if (a2) s.store.update(a2.id, { comment: "Underlined through the plugin; the comment is stored with it." });
	for (const a of [a1, a2]) if (a) created.push(a.id);
	await shot("annotations", 900);
	await s.store.flush();
	const saved = await apiRequest<unknown[]>("GET", `/attachments/${KEY}/annotations`);
	console.log(`created ${created.length}; the core has ${saved.length} annotations`);

	// ---- academic: panels, a citation link, the reading view
	const ac = academicFor(ctx!);
	ctl.setSidebar(true, "plugin:academic-figures:figures-tables");
	await ac.start();
	console.log(`structure: ${ac.struct().phase}, ${ac.figItems().length} figure/table entries`);
	await shot("figures", 2500);
	ctl.setSidebar(true, "plugin:academic-references:references");
	await shot("references", 2000);
	ctl.setSidebar(true, "plugin:annotations:annotations");
	const links = ctl.linksOf(0);
	console.log(`page 0 has ${links.length} links`);
	const cite = links.find((l) => ctx!.pageLinks) ?? null;
	void cite;
	ctl.setAltView("reflow");
	await until(() => ac.struct().phase === "ready", 60000, "structure");
	await shot("reflow", 2500);
	ctl.setAltView(null);
	await shot("back-to-pages", 800);
} finally {
	if (!has("keep") && created.length) {
		await apiRequest("DELETE", `/attachments/${KEY}/annotations`, { ids: created }).catch((e) => console.warn("cleanup failed:", e.message));
		console.log(`removed ${created.length} test annotations again`);
	}
	shutdownStructureWorker();
	process.exit(0);
}
