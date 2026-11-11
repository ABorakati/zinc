// Smoke test of the real app window on the machine it runs on (CI: .github/workflows/macos.yml; also works on Linux and Windows):
//   bun scripts/smoke-native.ts [outDir]
// 1. builds a throwaway library (a few items, one PDF: web/demo-article.pdf) in a temp folder, with its own APPDATA,
// 2. starts the app on it (own port; no sync, no Zotero port, no sign-in), opens the PDF in a reader tab (ZN_OPEN_TABS),
// 3. saves screenshots (library.png once the list is in, reader.png once the PDF tab is open) and summary.json,
// 4. macOS and Linux: shows a test page in the web view (webview.png, then clipped: webview-clipped.png) and prints pages 2-3 of the
//    PDF to a file without a dialog (print-2-3.pdf, must have 2 pages),
// 5. exits 1 when the list did not load, the PDF library (zn_pdf + PDFium) could not be used, the reader tab did not open, the web
//    view did not come up, or the print came out wrong.
// Screenshots: GPUIX's captureScreenshot (needs a test-support build of the binding), else macOS `screencapture` of the whole screen.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../core/src/db";
import { rebuildSearchIndex } from "../../core/src/search";
import { insertItem } from "../../core/test/fixture";

const out = resolve(process.argv[2] ?? "smoke-out");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "zn-smoke-"));
const pdf = resolve(import.meta.dir, "..", "web", "demo-article.pdf");
const summary: Record<string, unknown> = { platform: `${process.platform} ${process.arch}`, bun: Bun.version };
const fail = (why: string) => { summary.failure = why; console.error(`[smoke] FAIL: ${why}`); };

// ---- 1. the library
const dbPath = join(root, "library.sqlite");
{
	const db = openDb(dbPath);
	const items = [
		{ key: "SMOKE001", title: "Deep learning in clinical research: a short demo review", last: "Demo", year: "2026" },
		{ key: "SMOKE002", title: "Machine perfusion in liver transplantation", last: "Smith", year: "2024" },
		{ key: "SMOKE003", title: "Outcomes after kidney transplantation in older recipients", last: "Jones", year: "2023" },
	];
	for (const it of items) {
		insertItem(db, { key: it.key, itemType: "journalArticle", title: it.title, creators: [{ creatorType: "author", firstName: "A", lastName: it.last }], date: it.year, publicationTitle: "Smoke Test Journal" } as never);
	}
	insertItem(db, { key: "SMOKEPDF", itemType: "attachment", title: "Full Text PDF", contentType: "application/pdf", linkMode: "linked_file", parentItem: "SMOKE001", path: pdf } as never, "SMOKE001");
	db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES('SMOKEPDF', 'linked_file', 'application/pdf', ?)").run(pdf);
	rebuildSearchIndex(db);
	db.close();
}

// ---- 2. the app
Object.assign(process.env, {
	APPDATA: join(root, "appdata"), ZN_DB: dbPath, ZN_PORT: process.env.ZN_PORT ?? "23191", ZN_SYNC: "0", ZN_ZPORT: "0", ZN_SIGNIN: "0", ZN_OPEN_TABS: "SMOKEPDF",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await import("../src/main");
const { store } = await import("../src/store");
const { hostRenderer } = await import("../src/shell/native");

async function shot(name: string): Promise<string> {
	const file = join(out, `${name}.png`);
	// the web view lives in AppKit, not in GPUI's scene: only a screen capture shows it
	if (process.platform === "darwin" && name.startsWith("webview")) {
		const p = Bun.spawn(["screencapture", "-x", file], { stderr: "pipe" });
		await p.exited;
		return existsSync(file) ? "screencapture" : "none";
	}
	try {
		(hostRenderer() as { captureScreenshot?(p: string): void } | undefined)?.captureScreenshot?.(file);
		if (existsSync(file)) return "gpuix";
	} catch (e) {
		summary[`${name}GpuixError`] = e instanceof Error ? e.message : String(e);
	}
	if (process.platform === "darwin") {
		const p = Bun.spawn(["screencapture", "-x", file], { stderr: "pipe" });
		await p.exited;
		if (existsSync(file)) return "screencapture";
	}
	return "none";
}

const t0 = performance.now();
while (store.pagesLoaded() === 0 && performance.now() - t0 < 60_000) await sleep(100);
summary.listLoadedMs = Math.round(performance.now() - t0);
summary.pagesLoaded = store.pagesLoaded();
if (store.pagesLoaded() === 0) fail("the item list did not load within 60 s");
await sleep(1500);
summary.libraryShot = await shot("library");

// ---- 3. the PDF library and the reader tab
try {
	const { findDll, nativeVersion, pdfiumStatus } = await import("../src/reader/pdf");
	summary.znPdf = findDll();
	summary.nativeVersion = nativeVersion();
	summary.pdfium = pdfiumStatus() || "in use";
} catch (e) {
	fail(`the PDF library could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
}
for (let i = 0; i < 100 && !store.tabs().some((t) => JSON.stringify(t).includes("SMOKEPDF")); i++) await sleep(100);
summary.tabs = store.tabs().map((t) => ("kind" in t ? (t as { kind: string }).kind : "tab"));
if (!store.tabs().some((t) => JSON.stringify(t).includes("SMOKEPDF"))) fail("the PDF reader tab did not open");
await sleep(6000);
summary.readerShot = await shot("reader");

// ---- 4. the web view (the machinery behind snapshots, EPUBs and the note editor): a test page in a box over the window, then the
// same box clipped to its top half. Zotero's reader and note pages are not built in CI, so a data: page stands in for them.
if (process.platform !== "win32") {
	const { WebHost } = await import("../src/webview/host");
	const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:28px system-ui;background:#fff6d6">
		<div style="height:50vh;background:#2a7de1;color:white;padding:24px;box-sizing:border-box">Web view: top half (blue)</div>
		<div style="height:50vh;background:#e8483b;color:white;padding:24px;box-sizing:border-box">bottom half (red): hidden when clipped</div>`;
	const host = new WebHost({ init: "" });
	const box = { x: 240, y: 120, width: 560, height: 360 };
	let clip: typeof box | null = null;
	host.show(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`, () => ({ rect: box, clip }));
	for (let i = 0; i < 150 && host.state() !== "ready" && host.state() !== "error"; i++) await sleep(100);
	await sleep(3000);
	summary.webState = host.state();
	if (host.error()) summary.webError = host.error();
	summary.webOnScreen = host.onScreen;
	if (host.state() !== "ready" || !host.onScreen) fail(`the web view did not come up (${host.state()} ${host.error()})`);
	summary.webShot = await shot("webview");
	clip = { x: box.x, y: box.y, width: box.width, height: box.height / 2 };
	await sleep(1500);
	summary.webClipShot = await shot("webview-clipped");
	if (process.platform === "darwin") summary.webPopups = (await import("../src/webview/cocoa")).debugPopups();
	host.release(0);
	await sleep(500);
}

// ---- 5. printing without a dialog: pages 2-3 of the 3-page demo into a PDF file (macOS: PDFKit's save job; Linux: the cut file)
if (process.platform !== "win32") {
	const { printPdfTo, PdfDoc } = await import("../src/reader/pdf");
	const output = join(out, "print-2-3.pdf");
	try {
		summary.print = await printPdfTo(new Uint8Array(await Bun.file(pdf).arrayBuffer()), { title: "smoke", output, first: 2, last: 3 });
		const pages = existsSync(output) ? PdfDoc.openBytes(new Uint8Array(await Bun.file(output).arrayBuffer())).pageCount : 0;
		summary.printedPages = pages;
		if (pages !== 2) fail(`printing pages 2-3 to a file gave ${pages} pages`);
	} catch (e) {
		fail(`printing to a file failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
console.log("[smoke]", JSON.stringify(summary));
process.exit(summary.failure ? 1 : 0);
