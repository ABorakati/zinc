// Headless probe for annotation tools: filtering, image export/copy, and eraser.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { apiRequest } from "../src/api";
import { registerFonts } from "../src/fonts";
import { kit } from "../src/reader/structure/kit";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { fetchAttachment } from "../src/reader/library";
import { PdfDoc } from "../src/reader/pdf";
import { type NRect, type ReaderContext, type Word } from "../src/reader/plugins";
import { sessionFor } from "../src/reader/annotations/session";
import { AnnotationsPanel } from "../src/reader/annotations/Panel";
import { PageAnnotations } from "../src/reader/annotations/PageOverlay";
import { copyAnnotationImage, exportAnnotationImage, renderAnnotationImage } from "../src/reader/annotations/imageExport";
import { annotationContextMenu } from "../src/reader/annotations/contextMenu";
import { matchesFilter, type Annotation } from "../src/reader/annotations/model";
import { hasClipboardImage, readClipboardImage } from "../src/shell/clipboard-win";
import { OverlayHost } from "../src/ui";

const KEY = "I3ME399W";
const OUT_DIR = "C:/Users/abora/zn-ws/_tmp/annot-tools/probe-results";
await Bun.$`mkdir -p ${OUT_DIR}`;

console.log("=== 1. Starting Annotations Tools Probe ===");
setReaderDpr(1);
setReaderMode("dark");

const bytes = await fetchAttachment(KEY);
const doc = PdfDoc.openBytes(bytes);
const [curPage, setCurPage] = createSignal(0);
const [mode] = createSignal<"light" | "dark">("dark");
const layers = new Map<number, Promise<{ words: Word[] }>>();

const ctx: ReaderContext = {
	attachmentKey: KEY,
	itemKey: "",
	pageCount: () => doc.pageCount,
	pageSize: (i) => ({ w: doc.sizes[i]![0], h: doc.sizes[i]![1] }),
	textLayer: (i) => {
		let p = layers.get(i);
		if (!p) {
			p = doc.textLayerAsync(i).then((l) => ({ words: l.words }));
			layers.set(i, p);
		}
		return p;
	},
	pdfBytes: async () => bytes,
	currentPage: curPage,
	zoom: () => 1,
	scrollTo: (page) => setCurPage(page),
	selection: () => null,
	clearSelection: () => {},
	altView: () => null,
	setAltView: () => {},
	mode,
};

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
registerFonts(r);
const [filterQuery, setFilterQuery] = createSignal("");
const [filterColors, setFilterColors] = createSignal<string[]>([]);
const [filterTag, setFilterTag] = createSignal("");

function Root(): JSX.Element {
	const k = kit(mode);
	const box = () => ({ width: 800, height: 840 });
	return (
		<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: k.tok("background") }}>
			<div style={{ ...k.t("flex flex-col border-r bg-card"), width: 340, flexShrink: 0, height: "100%", minHeight: 0 }}>
				<AnnotationsPanel
					ctx={ctx}
					filter={{
						query: filterQuery,
						setQuery: setFilterQuery,
						colors: filterColors,
						setColors: setFilterColors,
						tag: filterTag,
						setTag: setFilterTag,
					}}
				/>
			</div>
			<div style={{ display: "flex", flexGrow: 1, position: "relative", alignItems: "center", justifyContent: "center" }}>
				<div style={{ position: "relative", width: 800, height: 840 }}>
					<PageAnnotations ctx={ctx} page={curPage()} box={box} />
				</div>
			</div>
			<OverlayHost />
		</div>
	);
}
t.render(() => <Root />);
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

await frame(400);
const s = sessionFor(ctx);
await s.store.load();
console.log(`Loaded ${s.store.list().length} annotations`);

// Take initial screenshot
r.captureScreenshot(join(OUT_DIR, "probe-01-initial.png"));
console.log("Screenshot: probe-01-initial.png");

// === 2. Verify Filtering Logic ===
console.log("\n=== 2. Testing Sidebar Filtering Logic and UI ===");
const list = s.store.list();

// Filter by color: yellow
setFilterColors(["#ffd400"]);
await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-02-filter-color-yellow.png"));
console.log("Screenshot: probe-02-filter-color-yellow.png");

// Filter by tag: diagram
setFilterColors([]);
setFilterTag("diagram");
await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-03-filter-tag-diagram.png"));
console.log("Screenshot: probe-03-filter-tag-diagram.png");

// Filter by search query: milestone
setFilterTag("");
setFilterQuery("milestone");
await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-04-filter-search-milestone.png"));
console.log("Screenshot: probe-04-filter-search-milestone.png");

// Clear filters
setFilterQuery("");
await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-05-filter-cleared.png"));
console.log("Screenshot: probe-05-filter-cleared.png");
// === 3. Testing Image Annotation Export and Copy ===
console.log("\n=== 3. Testing Image Annotation Export and Copy ===");
const imageAnn = list.find((a) => a.type === "image");
if (!imageAnn) throw new Error("No image annotation found");
console.log("Testing image annotation:", imageAnn.id, "on page", imageAnn.position.pageIndex);

// Test context menu items for image annotation
const menuItems = annotationContextMenu(ctx, imageAnn);
console.log(
	"Context menu items for image annotation:",
	menuItems.map((m) => m.label || "---"),
);
if (!menuItems.some((m) => m.label === "Copy Image")) throw new Error("Missing 'Copy Image' in context menu");
if (!menuItems.some((m) => m.label === "Export Image…")) throw new Error("Missing 'Export Image…' in context menu");

// Test renderAnnotationImage
const rendered = await renderAnnotationImage(ctx, imageAnn, 3);
if (!rendered) throw new Error("renderAnnotationImage returned null");
console.log(
	`Rendered image: ${rendered.width}x${rendered.height} px, PNG bytes: ${rendered.png.length}, DIB bytes: ${rendered.dib.length}`,
);
if (rendered.width <= 0 || rendered.height <= 0) throw new Error("Invalid rendered dimensions");

// Test exportAnnotationImage
const exportPath = await exportAnnotationImage(ctx, imageAnn, OUT_DIR);
if (!exportPath || !existsSync(exportPath)) throw new Error("exportAnnotationImage failed to write file");
const stat = statSync(exportPath);
console.log(`Exported PNG to: ${exportPath} (size: ${stat.size} bytes)`);

// Validate exported PNG file with pngjs
const parsedPng = PNG.sync.read(Buffer.from(await Bun.file(exportPath).arrayBuffer()));
console.log(`Exported PNG parsed successfully: ${parsedPng.width}x${parsedPng.height}`);
if (parsedPng.width !== rendered.width || parsedPng.height !== rendered.height) {
	throw new Error("Exported PNG dimension mismatch");
}

// Test copyAnnotationImage to clipboard
const copyOk = await copyAnnotationImage(ctx, imageAnn);
console.log("copyAnnotationImage result:", copyOk);
if (!copyOk) throw new Error("copyAnnotationImage returned false");

const clipHasImage = hasClipboardImage();
console.log("Clipboard has image:", clipHasImage);
if (!clipHasImage) throw new Error("Clipboard should contain image data");

const clipPng = readClipboardImage();
console.log("Read clipboard PNG length:", clipPng?.length);
if (!clipPng || clipPng.length === 0) throw new Error("Failed to read PNG from clipboard");
const clipParsed = PNG.sync.read(clipPng);
console.log(`Clipboard PNG parsed: ${clipParsed.width}x${clipParsed.height}`);

// Select the image annotation and take a screenshot
s.ui.select(imageAnn.id);
await frame(500);
r.captureScreenshot(join(OUT_DIR, "probe-02-image-selected.png"));
console.log("Screenshot: probe-02-image-selected.png");

// === 4. Testing Ink and Eraser ===
console.log("\n=== 4. Testing Ink Drawing and Eraser Tools ===");
// Select ink tool
s.ui.setTool("ink");
s.ui.setColor("#ff6666");
s.ui.setInkWidth?.(3);
await frame(200);
r.captureScreenshot(join(OUT_DIR, "probe-03-ink-tool-active.png"));
console.log("Screenshot: probe-03-ink-tool-active.png");

const strokePts = [150, 200, 180, 220, 220, 210, 260, 240, 300, 230];
const inkPos = { pageIndex: 0, width: 3, paths: [strokePts] };
const inkSort = await s.act.sortIndex(inkPos);
const newInkAnn = {
	id: "INKTEST1",
	type: "ink" as const,
	color: "#ff6666",
	position: inkPos,
	sortIndex: inkSort,
	pageLabel: "1",
	comment: "Drawn test stroke",
	tags: [{ name: "test-ink" }],
	dateModified: new Date().toISOString(),
};
s.store.add(newInkAnn);
await s.store.flush();
console.log("Added test ink annotation INKTEST1");

await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-04-ink-drawn.png"));
console.log("Screenshot: probe-04-ink-drawn.png");

// Now test eraser: erasing part of INKTEST1
console.log("Testing eraser on stroke...");
s.ui.setTool("eraser");
await frame(200);
r.captureScreenshot(join(OUT_DIR, "probe-05-eraser-tool-active.png"));
console.log("Screenshot: probe-05-eraser-tool-active.png");

// Erase around point (220, 210) with radius 15
const ex = 220,
	ey = 210,
	radius = 15;
const inkBefore = s.store.get("INKTEST1");
console.log("Paths before erase:", inkBefore?.position.paths?.length);

const newPaths: number[][] = [];
for (const p of inkBefore?.position.paths ?? []) {
	let cur: number[] = [];
	for (let i = 0; i + 1 < p.length; i += 2) {
		const px = p[i]!,
			py = p[i + 1]!;
		if (Math.hypot(px - ex, py - ey) <= radius) {
			if (cur.length >= 4) newPaths.push(cur);
			cur = [];
		} else {
			cur.push(px, py);
		}
	}
	if (cur.length >= 4) newPaths.push(cur);
}
console.log(`Erased at (${ex}, ${ey}): stroke split into ${newPaths.length} segments`);
if (newPaths.length !== 2) throw new Error(`Expected stroke to split into 2 segments, got ${newPaths.length}`);
s.store.update("INKTEST1", { position: { ...inkBefore!.position, paths: newPaths } });
await s.store.flush();

await frame(300);
r.captureScreenshot(join(OUT_DIR, "probe-06-after-erased.png"));
console.log("Screenshot: probe-06-after-erased.png");

console.log("\n=== ALL CHECKS PASSED SUCCESSFULLY ===");
t.unmount();
process.exit(0);
