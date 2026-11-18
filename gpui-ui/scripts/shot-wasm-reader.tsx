// Headless check of the WASM plugin API's reader area in Zinc's real reader (src/reader/Reader.tsx), no window opens.
//   bun scripts/shot-wasm-reader.tsx [--out DIR]
// What it does: builds a QuickJS fixture plugin (scripts/fixtures/wasm-reader, with plugin-host/scripts/build-plugin.ts) that registers
// every reader extension point; starts a THROWAWAY core on a free port over a temporary library (a generated 3-page PDF, a parent item,
// three annotations; nothing of the real library is opened); loads the plugin in a real plugin supervisor with the real
// `reader` / `annotations` / `note-editor` import handlers (plugin-host/src/imports/reader.zinc.ts); mounts the real <Reader>; and
// checks, per event and per call, what the plugin gets and what the reader shows. PASS/FAIL per line; exit 1 on a FAIL.
// Shots: <out>/wr-{toolbar,header,annotation-menu,view-menu,thumb-menu,selection,panel}.png (default %TEMP%/zn-wasm-reader/shots).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { apiRequest, setBaseUrl } from "../src/api";
import { registerFonts } from "../src/fonts";
import { setReaderMode } from "../src/reader/env";
import { formatSortIndex, makeAnnotation } from "../src/reader/annotations/model";
import { sessionOf } from "../src/reader/annotations/session";
import { readerPlugins, openReaders } from "../src/reader/plugins";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { register } from "../src/reader/register";
import { OverlayHost } from "../src/ui";
import { resetPluginRegistrations } from "../src/wasmplugins/host";
import { installReaderBridge, setReaderCaller } from "../src/wasmplugins/reader";
import { callPlugin } from "../src/wasmplugins/reader/link";
import { buildPlugin } from "../../plugin-host/scripts/build-plugin";
import { defineHandler, loadHandlerModule } from "../../plugin-host/src/imports/registry";
import { createPluginSupervisor } from "../../plugin-host/src/supervisor";
import { startServer } from "../../core/src/server";
import { insertAttachment, insertItem } from "../../core/test/fixture";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const WORK = join(tmpdir(), `zn-wasm-reader-${process.pid}`);
const OUT = oi >= 0 ? args[oi + 1]! : join(tmpdir(), "zn-wasm-reader", "shots");
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
process.env.ZN_READER_STATE = "off";
setReaderMode("dark");

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
	results.push([name, ok, detail]);
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

// ---------------------------------------------------------------------------------------------------------------- a small PDF
function makePdf(pages: string[][]): Uint8Array {
	const objs: string[] = [];
	objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pages.forEach((lines, i) => {
		const stream = `BT /F1 14 Tf 18 TL 72 700 Td ${lines.map((l) => `(${l}) '`).join(" ")} ET`;
		objs[4 + i * 2] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
		objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	for (let i = 1; i < objs.length; i++) {
		offs[i] = out.length;
		out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offs
		.slice(1)
		.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
		.join("")}`;
	out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}
const LINES = (n: number) => [
	`Zinc reader plugin check, page ${n}`,
	"The quick brown fox jumps over the lazy dog",
	"Pack my box with five dozen liquor jugs",
	"Sphinx of black quartz, judge my vow",
	"How vexingly quick daft zebras jump",
	"Amazingly few discotheques provide jukeboxes",
];

// ---------------------------------------------------------------------------------------------------------------- throwaway core
const ATT = "ZEVATT22";
const PARENT = "ZEVPAR22";
const pdfPath = join(WORK, "doc.pdf");
writeFileSync(pdfPath, makePdf([LINES(1), LINES(2), LINES(3)]));
const core = startServer({ dbPath: join(WORK, "lib.sqlite"), port: 0 });
insertItem(core.db, { key: PARENT, itemType: "journalArticle", title: "Reader plugin check", dateAdded: "2024-01-01T00:00:00Z" });
insertAttachment(core.db, ATT, PARENT, "application/pdf", pdfPath);
setBaseUrl(core.url);
const mk = (page: number, rect: [number, number, number, number], text: string, color: string, type: "highlight" | "note" = "highlight") =>
	makeAnnotation({
		type,
		color,
		position: { pageIndex: page, rects: [rect] },
		sortIndex: formatSortIndex(page, 0, 700 - rect[3]),
		pageLabel: String(page + 1),
		text,
		comment: type === "note" ? "a sticky note" : "",
	});
await apiRequest("PUT", `/attachments/${ATT}/annotations`, [
	mk(0, [72, 696, 250, 712], "Zinc reader plugin", "#ffd400"),
	mk(1, [72, 678, 300, 694], "quick brown fox", "#5fb236"),
	mk(2, [72, 660, 160, 676], "", "#a28ae5", "note"),
]);

// ---------------------------------------------------------------------------------------------------------------- the fixture plugin
const ID = "zev-reader@zinc.test";
const src = join(WORK, "src");
cpSync(resolve(import.meta.dir, "fixtures", "wasm-reader"), src, { recursive: true });
const built = await buildPlugin({ dir: src, out: join(WORK, "plugin") });
const logs: string[] = [];
const zev = () => logs.filter((l) => l.startsWith("ZEV "));
const sawLog = (re: RegExp) => zev().some((l) => re.test(l));
const importHandlers = [
	defineHandler({
		interface: "zinc:plugin/log",
		where: "zinc",
		functions: {
			write(_ctx, _level: string, message: string) {
				logs.push(String(message));
			},
		},
	}),
	...(await loadHandlerModule(resolve(import.meta.dir, "../../plugin-host/src/imports/reader.zinc.ts"))),
];
const sup = createPluginSupervisor({ importHandlers, coreUrl: core.url });
sup.on("status", (e) => {
	if (e.status === "stopped" || e.status === "disabled" || e.status === "failed") resetPluginRegistrations(e.plugin);
});
setReaderCaller(sup);
const stopBridge = installReaderBridge();
const info = await sup.load(built.out);
check("plugin loads", info.id === ID, `${info.id} ${info.status}`);

await sup.start(ID);
check("plugin starts and registers", sawLog(/^ZEV startup/), `${zev().length} log lines`);

// ---------------------------------------------------------------------------------------------------------------- the real reader
register();
const t = createTestRoot({ width: 1400, height: 880 });
registerFonts(t.renderer);
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: "#141413" }}>
		<Reader attachmentKey={ATT} itemKey={PARENT} path={pdfPath} ephemeral active title="WASM reader check" controller={(c) => (ctl = c)} />
		<OverlayHost />
	</div>
));
const r = t.renderer;
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
const until = async (what: () => boolean, ms = 6000) => {
	const t0 = performance.now();
	while (!what() && performance.now() - t0 < ms) await frame(50);
	return what();
};
const shot = async (name: string) => {
	await frame(300);
	r.captureScreenshot(join(OUT, `wr-${name}.png`));
};
const centre = (el: { id: number } | undefined) => {
	const b = el ? r.getElementBounds(el.id) : null;
	return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
};
const has = (text: string) => !!r.findByText(text);
const closeMenu = async () => {
	r.nativeSimulateClick(1390, 870);
	await frame(250);
};
/** run a plugin-side command (the fixture's `on-overlay-click` interpreter), then pump frames */
const cmd = async (command: string, settle = 300) => {
	const reader = infoNow();
	await callPlugin(ID, "reader-events", "on-overlay-click", ["ov", reader, 0, command]);
	await frame(settle);
};
const infoNow = () => ({
	id: ATT,
	kind: "pdf",
	attachment: { library: 1, key: ATT },
	parentItem: PARENT,
	tabId: ATT,
	window: undefined,
	title: "WASM reader check",
	readOnly: false,
	selected: true,
});

await frame(200);
await Promise.race([ctl.ready(), Bun.sleep(20000)]);
if (ctl.error()) throw new Error(`reader failed to open: ${ctl.error()}`);
await frame(1500);
await ctl.idle();
const rctx = ctl.context()!;

// ---- events: opened (the reader was opened after the plugin subscribed)
check("event opened", await until(() => sawLog(new RegExp(`^ZEV event opened ${ATT} pdf`))), zev().find((l) => l.includes("event opened")));
check("openReaders lists the reader", openReaders().some((c) => c.attachmentKey === ATT));

// ---- slots
// the first ui-events call of a QuickJS plugin takes ~19 s (link.ts FIRST_UI_CALL_MS)
check("slot toolbar", (await until(() => has("ZEV toolbar"), 60000)) && sawLog(new RegExp(`mount tb surface=toolbar-slot slot=toolbar reader=${ATT}`)), zev().find((l) => l.includes("mount tb")));
await shot("toolbar");

ctl.setSidebar(true, "plugin:annotations:annotations");
await frame(1500);
const headerEl = ["ZEV hdr highlight", "ZEV hdr note"].map((s) => r.findByText(s)).find(Boolean);
check("slot sidebar-annotation-header", !!headerEl && sawLog(/mount hdr surface=toolbar-slot slot=sidebar-annotation-header/));
await shot("header");

// ---- menus
const hc = centre(headerEl);
if (hc) {
	r.nativeSimulateClick(hc.x - 120, hc.y + 20, 2);
	await until(() => has("ZEV annotation item"), 3000);
	const item = r.findByText("ZEV annotation item");
	await shot("annotation-menu");
	const ic = centre(item);
	if (ic) {
		r.nativeSimulateClick(ic.x, ic.y);
		await frame(500);
	}
	check("menu annotation (build-menu + on-menu-command)", !!item && sawLog(/build-menu m-ann annotation \w{8} (highlight|note)/) && sawLog(/menu-command m-ann ann-item \w{8}/), zev().find((l) => l.includes("menu-command m-ann")));
	if (!sawLog(/menu-command m-ann/)) await closeMenu();
} else check("menu annotation (build-menu + on-menu-command)", false, "no annotation card to right-click");

const vm = centre(r.findByTestId("reader-view-menu"));
if (vm) {
	r.nativeSimulateClick(vm.x, vm.y);
	await frame(400);
	const item = r.findByText("ZEV view item");
	await shot("view-menu");
	const ic = centre(item);
	if (ic) {
		r.nativeSimulateClick(ic.x, ic.y);
		await frame(400);
	}
	check("menu view (static)", !!item && sawLog(/menu-command m-view view-item/), zev().find((l) => l.includes("menu-command m-view")));
	if (!sawLog(/menu-command m-view/)) await closeMenu();
} else check("menu view (static)", false, "no View menu button");

ctl.setSidebar(true, "thumbs");
await frame(1500);
const lab = centre(r.findByText("2"));
if (lab) {
	r.nativeSimulateClick(lab.x, lab.y - 40, 2);
	await until(() => has("ZEV thumbnail item"), 3000);
	const item = r.findByText("ZEV thumbnail item");
	await shot("thumb-menu");
	const ic = centre(item);
	if (ic) {
		r.nativeSimulateClick(ic.x, ic.y);
		await frame(500);
	}
	check("menu thumbnail (build-menu pages)", !!item && sawLog(/build-menu m-thumb thumbnail pages=1/) && sawLog(/menu-command m-thumb thumb-item pages=1/), zev().find((l) => l.includes("menu-command m-thumb")));
	if (!sawLog(/menu-command m-thumb/)) await closeMenu();
} else check("menu thumbnail (build-menu pages)", false, "no thumbnail label 2");

const mine = readerPlugins().find((p) => p.id === `wasm:${ID}`);
const colorItems = mine?.colorMenu?.(rctx) ?? [];
check("menu color (hook)", colorItems.some((i) => i.label === "ZEV color item" && i.iconColor === "#2ea8e5" && !!i.onSelect), JSON.stringify(colorItems.map((i) => [i.label, i.iconColor, !!i.onSelect])));
const selItems = mine?.selectorMenu?.(rctx, { enableClearSelection: true }) ?? [];
check("menu selector (hook)", selItems.some((i) => i.label === "ZEV selector item"), JSON.stringify(selItems.map((i) => i.label)));
const themeItems = mine?.themeMenu?.(rctx, { theme: "sepia" }) ?? [];
check("menu theme (hook)", themeItems.some((i) => i.label === "ZEV theme item"));
colorItems.find((i) => i.onSelect)?.onSelect?.();
check("menu color command runs", await until(() => sawLog(/menu-command m-color color-item/), 3000));

// ---- selection popup + events
ctl.setSidebar(false);
await frame(400);
await ctl.select({ page: 0, w: 0, c: 0 }, { page: 0, w: 4, c: 0 });
await frame(800);
const sel = ctl.selectedText() ?? "";
check("slot text-selection-popup", await until(() => sawLog(/mount popup surface=popover slot=text-selection-popup/)) && has(`ZEV sel: ${sel.replace(/\s+/g, " ").trim().slice(0, 24)}`), `selected ${JSON.stringify(sel.slice(0, 30))}`);
await shot("selection");
check("event selection-changed", await until(() => sawLog(/event selection-changed text=/)), zev().find((l) => l.includes("selection-changed")));
await cmd("selection");
check("reader.get-selection", sawLog(/ZEV selection text=.+ rects=\d+ kind=highlight/), zev().find((l) => l.startsWith("ZEV selection")));

// ---- panel, overlay, links
await cmd("sidebar:zev-panel", 600);
await until(() => has("ZEV panel"), 8000);
check("panel sidebar-tab + reader.set-sidebar", has("ZEV panel") && sawLog(/mount zev-panel surface=reader-sidebar slot=panel/));
await shot("panel");
check("overlay render-overlay (page 0)", await until(() => sawLog(/render-overlay ov page=0/)));
const n0 = zev().filter((l) => l.includes("render-overlay ov page=0")).length;
await cmd("invalidate", 800);
check("reader.invalidate redraws the overlay", zev().filter((l) => l.includes("render-overlay ov page=0")).length > n0);
let linkCb: ((e: unknown) => boolean) | undefined;
const fake = { ...rctx, onLink: (cb: (e: unknown) => boolean) => ((linkCb = cb), () => {}) };
mine?.onOpen?.(fake as never);
const claimed = linkCb?.({ page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, target: { kind: "uri", uri: "https://example.test/x" } });
const claimed2 = linkCb?.({ page: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, target: { kind: "page", page: 2, y: 0.25 } });
check("link interceptor claims clicks", claimed === true && claimed2 === true && (await until(() => sawLog(/link lk uri page=1 https:\/\/example.test\/x/) && sawLog(/link lk page page=0/))));

// ---- reader.* calls
await cmd("readers");
check("reader.list-readers / selected-reader", sawLog(new RegExp(`readers n=1 first=${ATT}`)), zev().find((l) => l.startsWith("ZEV readers")));
await cmd("navigate:2", 1200);
check("reader.navigate (page index)", rctx.currentPage() === 2, `currentPage=${rctx.currentPage()}`);
check("event page-changed", await until(() => sawLog(/event page-changed page=2 label=3/)), zev().find((l) => l.includes("page-changed")));
const z0 = rctx.zoom();
await cmd("zoom-in", 500);
check("reader.run-command zoom-in", rctx.zoom() > z0, `${z0.toFixed(2)} -> ${rctx.zoom().toFixed(2)}`);
check("event view-state-changed", await until(() => sawLog(/event view-state-changed/), 4000));
await cmd("tool:highlight", 500);
check("reader.set-tool + event tool-changed", sessionOf(ATT)?.ui.tool() === "highlight" && (await until(() => sawLog(/event tool-changed highlight/))));
await cmd("state");
check("reader.get-state", sawLog(/state page=\d+ pages=3 zoom=[\d.]+ tool=highlight sidebar=true:zev-panel/), zev().find((l) => l.startsWith("ZEV state")));
await cmd("find:fox", 800);
check("reader.find", sawLog(/find fox active=true/) && ctl.hits()[1] > 0, `hits=${JSON.stringify(ctl.hits())}`);
await cmd("page-text:0");
check("reader.get-page-text (with words)", sawLog(/page-text len=\d+ words=\d+ first=Zinc w=612/), zev().find((l) => l.startsWith("ZEV page-text")));
await cmd("render:0", 600);
check("reader.render-page (PNG)", sawLog(/render \d+x\d+ bytes=\d+ png=true/), zev().find((l) => l.startsWith("ZEV render ")));
await cmd("outline");
await cmd("labels");
check("reader.get-outline / get-page-labels", sawLog(/outline n=\d+/) && sawLog(/labels 1,2,3/));
await cmd("themes");
check("reader.list-themes / set-theme-choice", sawLog(/themes normal,dark,sepia/));
await cmd("step:first-page", 800);
check("reader.navigate-step", rctx.currentPage() === 0, `currentPage=${rctx.currentPage()}`);

// ---- annotations.*
await cmd("ann-list");
check("annotations.list-annotations", sawLog(/list n=3 kinds=highlight,highlight,note/), zev().find((l) => l.startsWith("ZEV list")));
await cmd("ann-colors");
check("annotations.annotation-colors", sawLog(/colors n=8 first=#ffd400/));
await cmd("ann-create", 800);
const created = zev().find((l) => l.startsWith("ZEV created"));
const key = /key=(\w{8})/.exec(created ?? "")?.[1];
check("annotations.create-annotations (open reader: through the session)", !!key && /color=#2ea8e5 sort=00000\|/.test(created ?? "") && !!sessionOf(ATT)?.store.get(key), created);
check("event annotations-changed (own write)", await until(() => sawLog(/event annotations-changed added=1 modified=0 removed=0 by=true/)), zev().find((l) => l.includes("annotations-changed")));
await cmd("ann-get");
check("annotations.get-annotations", sawLog(/get comment=made by plugin tags=zev/), zev().find((l) => l.startsWith("ZEV get")));
await cmd("ann-update", 600);
check("annotations.update-annotations", sawLog(/updated comment=updated by plugin color=#ff6666/) && sessionOf(ATT)?.store.get(key!)?.color === "#ff6666");
check("event annotations-changed (modified)", await until(() => sawLog(/event annotations-changed added=0 modified=1 removed=0 by=true/)));
await cmd("serialize");
check("note-editor.serialize-annotations", sawLog(/serialized len=\d+ has=true/), zev().find((l) => l.startsWith("ZEV serialized")));
await cmd("ann-image");
await cmd("editors");
check("note-editor.list-editors / active-editor (no editor open)", sawLog(/editors n=0 active=none/), zev().find((l) => l.startsWith("ZEV editors")));
await cmd("open-note");
// open-note is real since integration: a missing note answers not-found
check("note-editor.open-note answers not-found for a missing note", sawLog(/ERR open-note not-found:/), zev().find((l) => l.includes("ERR open-note")));
await frame(1500); // the store saves 500 ms after the last change
const server = await apiRequest<{ id: string; color: string }[]>("GET", `/attachments/${ATT}/annotations`);
check("the core has the plugin's annotation", server.some((a) => a.id === key && a.color === "#ff6666"), `${server.length} annotations`);
await cmd("ann-delete", 600);
check("annotations.remove-annotations", !sessionOf(ATT)?.store.get(key!) && (await until(() => sawLog(/event annotations-changed added=0 modified=0 removed=1 by=true/))));
// a user's change (not the plugin's) arrives with by-this-plugin false
const first = sessionOf(ATT)!.store.list()[0]!;
sessionOf(ATT)!.store.update(first.id, { comment: "by the user" });
check("event annotations-changed (user's change, by=false)", await until(() => sawLog(/event annotations-changed added=0 modified=1 removed=0 by=false/)));
sessionOf(ATT)!.ui.select(first.id);
check("event annotations-selected", await until(() => sawLog(new RegExp(`event annotations-selected keys=${first.id}`))));
await cmd("unregister:lk");
await cmd("unregister:m-view", 400);
check("reader.unregister removes the registration", !((readerPlugins().find((p) => p.id === `wasm:${ID}`)?.viewMenu?.(rctx) ?? []).length));

// ---- shutdown removes everything the plugin registered
await sup.stop(ID);
await frame(600);
check("shutdown removes the toolbar mark", !has("ZEV toolbar") && !readerPlugins().some((p) => p.id.startsWith(`wasm:${ID}`)));

if (process.env.ZN_DUMP_LOG) console.log(zev().join("\n"));
const bad = logs.filter((l) => l.startsWith("ZEV ERR"));
if (bad.length) console.log("plugin errors:", bad);
t.unmount();
stopBridge();
await sup.shutdown();
core.stop();
rmSync(WORK, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
