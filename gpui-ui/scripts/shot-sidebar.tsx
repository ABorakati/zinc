// Headless screenshots of the Sidebar (260 px column + the overlay layer) against the core at ZN_URL (default :23160, a library COPY).
//   bun scripts/shot-sidebar.tsx [dark|light] [scene...] [--out DIR]
// Scenes (default: all, in this order; each writes <DIR>/sidebar-<scene>[-light].png; DIR defaults to <scratchpad>/gpui-shots):
//   base      the sidebar as it opens
//   menu      right-click context menu of a collection (built-ins + registry actions)
//   create    the inline "new collection" row with a name typed, then the new collection in the tree
//   rename    inline rename of that collection (from its context menu)
//   drag      a collection mid-drag over another one, and the result (nested)
//   tags      Tags pane open, two tags selected, one coloured
//   tagmenu   right-click menu of a tag, then the colour dialog
//   search    the Advanced Search dialog with two conditions and live results
//   itemdrop  items dragged from the list (dnd.ts startDrag / moveDrag / endDrag) onto a temporary collection: hover outline, drop, count
//   saved     Save Search... (named by the dialog), the saved search selected in the sidebar, its context menu; deleted afterwards
// Writes go only through the core API: collections created here are deleted again, tag colours restored, no saved search is
// created. ui-state.json is never written (uiState.disableWrites()).
import { createTestRoot } from "@gpuix/solid/testing";
import { mkdirSync } from "node:fs";
import { Sidebar } from "../src/Sidebar";
import { registerFonts } from "../src/fonts";
import { openAdvancedSearch } from "../src/searches/AdvancedSearch";
import { dragging, endDrag, moveDrag, startDrag } from "../src/dnd";
import { request, sidebarApi } from "../src/sidebar/client";
import { reloadCollections } from "../src/sidebar/Collections";
import { setTagsOpen } from "../src/sidebar/state";
import { store, uiState } from "../src/store";
import { setTagColor, tagColors, toggleTag } from "../src/tags/state";
import { tw } from "../src/theme";
import { OverlayHost } from "../src/ui";

uiState.disableWrites();
const args = process.argv.slice(2);
const mode = args.includes("light") ? "light" : "dark";
const outIdx = args.indexOf("--out");
const SHOTS = outIdx >= 0 ? args[outIdx + 1]! : "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
const ALL = ["base", "menu", "create", "rename", "drag", "tags", "tagmenu", "search", "saved", "itemdrop"];
const wanted = args.filter((a) => ALL.includes(a));
const scenes = wanted.length ? wanted : ALL;
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (scene: string) => `${SHOTS}/sidebar-${scene}${mode === "light" ? "-light" : ""}.png`;

store.setMode(mode);
const t = createTestRoot({ width: 1440, height: 880 });
registerFonts(t.renderer);
t.render(() => (
	<div style={{ ...tw("bg-canvas", store.mode()), display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ width: 260, height: 880, flexShrink: 0, display: "flex" }}>
			<Sidebar />
		</div>
		<OverlayHost />
	</div>
));
for (let i = 0; i < 100 && store.collections().length === 0; i++) await sleep(50);
console.log("collections loaded:", store.collections().length);
await sleep(500);

const settle = async (ms = 300) => {
	for (let i = 0; i < 3; i++) {
		t.renderer.flush();
		t.renderer.dispatchNativeEvents();
		await sleep(ms / 3);
	}
	t.renderer.flush();
};
const shot = async (scene: string) => {
	await settle(500);
	t.renderer.captureScreenshot(file(scene));
	console.log("wrote", file(scene));
};
/** Centre of the first <text> with this exact content. */
function at(label: string): { x: number; y: number; w: number; h: number } {
	const el = t.renderer.findByText(label);
	const b = el ? t.renderer.getElementBounds(el.id) : null;
	if (!b) throw new Error(`no element with text "${label}"`);
	return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}
const click = async (x: number, y: number, button = 0) => {
	t.renderer.nativeSimulateClick(x, y, button);
	await settle();
};
const clickText = (label: string, button = 0, dx = 0) => click(at(label).x + dx, at(label).y, button);
const type = async (text: string) => {
	for (const ch of text) t.renderer.simulateKeystrokes(ch === " " ? "space" : ch);
	await settle();
};
const key = async (k: string) => {
	t.renderer.simulateKeystrokes(k);
	await settle();
};

const created: string[] = [];
// names that sort first, so the rows are on screen without scrolling the tree
const NAME = "A temp sidebar test";
const NAME2 = "A temp sidebar target";

try {
	if (scenes.includes("base")) await shot("base");

	if (scenes.includes("menu")) {
		await clickText("ACC Economics", 2);
		await shot("menu");
		await key("escape");
	}

	if (scenes.includes("create") || scenes.includes("rename") || scenes.includes("drag")) {
		// "+" next to COLLECTIONS: 20 px box at the right end of the header row
		const h = at("COLLECTIONS");
		await click(217, h.y);
		await type(NAME);
		if (scenes.includes("create")) await shot("create");
		await key("enter");
		await sleep(600);
		await reloadCollections();
		await settle(400);
		const c = store.collections().find((x) => x.name === NAME);
		if (c) created.push(c.key);
		console.log("created:", c?.key ?? "(not found)");
		if (scenes.includes("create")) await shot("create-done");
	}

	if (scenes.includes("rename")) {
		await clickText(NAME, 2);
		await clickText("Rename");
		await shot("rename");
		await key("enter"); // unchanged name: nothing is written
	}

	if (scenes.includes("drag")) {
		const target = await sidebarApi.createCollection(NAME2, null);
		created.push(target.key);
		await reloadCollections();
		await settle(400);
		const a = at(NAME), b = at(NAME2);
		t.renderer.nativeSimulateMouseDown(a.x, a.y);
		for (const f of [0.25, 0.6, 1]) {
			t.renderer.nativeSimulateMouseMove(a.x, a.y + (b.y - a.y) * f, 0);
			await settle(120);
		}
		await shot("drag");
		t.renderer.nativeSimulateMouseUp(b.x, b.y);
		await sleep(800);
		await settle(500);
		await shot("drag-done");
	}

	if (scenes.includes("tags") || scenes.includes("tagmenu")) {
		setTagsOpen(true);
		for (let i = 0; i < 100 && !t.renderer.findByText("Abdomen"); i++) await sleep(100);
		await settle(600);
		toggleTag("Abdomen");
		toggleTag("ACC");
		await setTagColor("Abdomen", "#5FB236");
		await setTagColor("ACC", "#A28AE5");
		if (scenes.includes("tags")) await shot("tags");
	}
	if (scenes.includes("tagmenu")) {
		await clickText("Abdomen", 2);
		await shot("tagmenu");
		await clickText("Assign Colour…");
		await shot("tagcolor");
		await key("escape");
	}

	if (scenes.includes("search")) {
		void openAdvancedSearch();
		await sleep(800);
		await settle();
		await shot("search-empty");
		// first condition: the value field is right of the operator select; "+" adds a second condition below it
		await click(858, 316);
		await type("liver");
		await click(1069, 316);
		await click(858, 335); // the new row sits 19 px higher once the dialog re-centres
		await type("transplant");
		await sleep(1500); // debounce + search
		await shot("search");
		await key("escape"); // close the dialog so the next scene starts clean
	}

	if (scenes.includes("itemdrop")) {
		const DROP = "A temp sidebar drop";
		const c = await sidebarApi.createCollection(DROP, null);
		created.push(c.key);
		await reloadCollections();
		await settle(400);
		const first = (await request<{ items: { key: string }[] }>("GET", "/items?limit=1&sort=dateAdded&dir=desc")).items[0]!.key;
		startDrag({ kind: "items", keys: [first] });
		const p = at(DROP);
		moveDrag(p.x, p.y);
		await settle(300);
		await shot("itemdrop-hover");
		endDrag(); // the list's drag source does this on release; the sidebar turns "the drag ended over a collection" into the drop
		await sleep(1000);
		await settle(600);
		const after = (await sidebarApi.collections()).find((x) => x.name === DROP);
		console.log("itemCount after drop:", after?.itemCount, "dragging:", dragging());
		await shot("itemdrop");
	}

	if (scenes.includes("saved")) {
		void openAdvancedSearch();
		await sleep(800);
		await click(858, 316);
		await type("liver transplant");
		await sleep(1200);
		await clickText("Save Search…");
		await shot("saved-name");
		await clickText("Save"); // the dialog's primary button once a name (suggested from the first condition) is filled
		await sleep(1200);
		await settle(600);
		await shot("saved");
		await clickText("Title contains liver transplant", 2);
		await shot("saved-menu");
		await key("escape");
	}
} finally {
	for (const x of await sidebarApi.savedSearches()) if (x.name.startsWith("Title contains liver")) await sidebarApi.deleteSavedSearch(x.key).catch(() => {});
	for (const k of created.reverse()) await sidebarApi.deleteCollection(k).catch(() => {});
	for (const n of ["Abdomen", "ACC"]) if (tagColors().some((c) => c.name === n)) await setTagColor(n, null);
	await reloadCollections();
}
t.unmount();
process.exit(0);
