// Headless check of Settings > Reader > "Fit attachment preview to width" (src/itempane/Preview.tsx) against an in-process core
// on a library COPY:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23161 ZN_SHOTS=<dir> bun scripts/shot-preview-fit.tsx
// Selects the first item whose PDF is on disk, measures the first page of the item pane's preview with the option off (a thumbnail,
// at most 240 px wide) and on (as wide as the pane), and back off. Writes <ZN_SHOTS>/preview-fit-{off,on}.png. Exits 1 on a failure.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { ItemPane } from "../src/itempane";
import { OverlayHost } from "../src/ui";
import { store } from "../src/store";
import { tw } from "../src/theme";
import { previewStats, thumbCache } from "../src/itempane/previewDoc";
import { readerPrefs } from "../src/settings/readerPrefs";
import { paneDef } from "../src/shell/panes";
import { sectionPaneId } from "../src/shell/frameLayout";

const dbPath = process.env.ZN_DB;
if (!dbPath) throw new Error("set ZN_DB to a COPY of library.sqlite");
const ro = new Database(dbPath, { readonly: true });
const rows = ro
	.query(
		`SELECT i.parent_key AS parent, a.path AS path FROM attachments a JOIN items i ON i.key = a.item_key
		 WHERE a.content_type LIKE '%pdf%' AND i.deleted = 0 AND i.parent_key IS NOT NULL AND a.path NOT LIKE 'attachments:%'`,
	)
	.all() as { parent: string; path: string }[];
ro.close();
const pick = rows.find((r) => r.path && existsSync(r.path));
if (!pick) throw new Error("no item with a PDF on disk");

await startCore();
// ZN_PANE=bottom: the item pane docked along the bottom of the window (wide and short) instead of on the right.
// ZN_SECTION=detached: the Attachments section dragged out into a pane of its own (shell/sectionPanes.tsx) in that place, not the
// whole item pane.
const BOTTOM = process.env.ZN_PANE === "bottom";
const DETACHED = process.env.ZN_SECTION === "detached";
const sectionPane = paneDef(sectionPaneId("attachments"));
if (DETACHED && !sectionPane) throw new Error("the Attachments section pane is not registered");
const TAG = `${BOTTOM ? "bottom-" : ""}${DETACHED ? "detached-" : ""}`;
const WIN_W = BOTTOM ? 1400 : 1100;
const PANE_W = BOTTOM ? WIN_W : 403;
const PANE_H = BOTTOM ? 380 : 900;
const { t, settle, click } = await boot({
	prefs: { mode: "light" },
	width: WIN_W,
	height: 900,
	view: () => (
		<div style={{ ...tw("flex bg-canvas", store.mode()), flexDirection: BOTTOM ? "column" : "row", width: "100%", height: "100%" }}>
			<div style={{ flexGrow: 1 }} />
			<div
				style={{
					...tw("rounded-[14px] bg-background shadow-raised overflow-hidden", store.mode()),
					width: PANE_W,
					height: PANE_H,
					flexShrink: 0,
				}}
			>
				{DETACHED ? sectionPane!.render() : <ItemPane />}
			</div>
			<OverlayHost />
		</div>
	),
});
store.setMode("light");
readerPrefs.setPreviewFitWidth(false);

const boundsOf = (testId: string) => {
	const el = t.renderer.findByTestId(testId);
	return el ? t.renderer.getElementBounds(el.id) : null;
};
const toFiles = async () => {
	if (DETACHED) return void (await settle(150)); // the pane is the section: no tab row to click
	for (let i = 0; i < 8; i++) {
		const b = boundsOf("ip-nav-attachments");
		if (!b) {
			await settle(60);
			continue;
		}
		await click(b.x + b.width / 2, b.y + b.height / 2);
		await sleep(150);
		await settle(150);
		const p = boundsOf("ip-preview");
		if (p && p.y > 0 && p.y < 880) return;
	}
};
const waitRender = async (r0: number) => {
	for (let i = 0; i < 400 && previewStats.renders === r0; i++) await settle(15);
	await settle(300);
};
const measure = async (name: string) => {
	await toFiles();
	const page = boundsOf("ip-preview-pagebox-0");
	const strip = boundsOf("ip-preview-strip");
	t.renderer.captureScreenshot(`${SHOTS}/preview-fit-${TAG}${name}.png`);
	console.log(
		`${name}: page 1 ${page?.width.toFixed(0)} x ${page?.height.toFixed(0)}, strip ${strip?.width.toFixed(0)} x ${strip?.height.toFixed(0)}` +
			` (pane ${PANE_W} x ${PANE_H}), thumbnail cache ${(thumbCache.bytes / 1024 / 1024).toFixed(1)} MB`,
	);
	return { page, strip };
};

let fails = 0;
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};

let r0 = previewStats.renders;
store.selectItem(pick.parent);
await settle(30);
await toFiles();
await waitRender(r0);
const off = await measure("off");

r0 = previewStats.renders;
readerPrefs.setPreviewFitWidth(true);
await waitRender(r0);
const on = await measure("on");

readerPrefs.setPreviewFitWidth(false);
await settle(400);
const back = await measure("back-off");

const pageW = (b: { width: number } | null | undefined) => (b ? b.width : 0);
check(!!off.page && pageW(off.page) <= 240, `off: page 1 is a thumbnail, at most 240 px wide (${pageW(off.page).toFixed(0)})`);
// the strip spans the section's width; a page fills it less the 10 px gutters, in 8 px steps, up to 816 px
const want = Math.min(816, Math.floor(((on.strip?.width ?? 0) - 20) / 8) * 8);
check(
	!!on.page && pageW(on.page) === want,
	`on: page 1 fills the pane, up to 816 px (${pageW(on.page).toFixed(0)} px, expected ${want}, in a ${PANE_W} px pane)`,
);
// the list runs from under the section tab row to the bottom of the pane (the virtual list itself is not found by test id); a
// detached section's list is the whole pane
const nav = boundsOf("ip-nav-attachments");
const list = DETACHED ? { height: PANE_H } : nav ? { height: 900 - (nav.y + nav.height) } : null;
check(
	!!on.strip && !!list && on.strip.height < list.height,
	`on: the strip is shorter than the item pane's list, so the list scrolls past it (${on.strip?.height.toFixed(0)} px in ${list?.height.toFixed(0)} px)`,
);
if (!BOTTOM) check(!!on.strip && !!off.strip && on.strip.height > off.strip.height, "on: the strip is taller");
check(!!back.page && Math.abs(pageW(back.page) - pageW(off.page)) < 1, "back off: page 1 is a thumbnail again");
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
