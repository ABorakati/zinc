// Headless check of the pane hover headers (shell/PaneStack.tsx, shell/paneChrome.ts, the rail in shell/Frame.tsx) in the whole
// app, against an in-process core on a library COPY:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23162 ZN_SHOTS=<dir> bun scripts/shot-pane-chrome.tsx
// Detaches the Attachments section, then: the header is hidden until the pointer reaches a pane's top strip; the detached
// section's Find Full Text sits in that header, not over the content; maximise / restore, minimise to the rail / restore, hide /
// undo; dragging a pane by its header. Writes <ZN_SHOTS>/chrome-*.png. Exits 1 on a failure.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { detachSection } from "../src/shell/sectionPanes";
import { libraryLayout, libraryPaneLocation, undoLayout } from "../src/shell/layout";
import { maximised, minimisedPanes } from "../src/shell/paneChrome";
import { viewPaneModel } from "../src/itempane/model";

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
const h = await boot({ prefs: { mode: "light" }, width: 1400, height: 900 });
const r = h.t.renderer;
const ATT = "section:attachments";

let fails = 0;
const check = (ok: unknown, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};
const bounds = (testId: string) => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	return b && b.width > 0 && b.height > 0 ? b : null;
};
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const move = async (x: number, y: number, ms = 250) => {
	r.nativeSimulateMouseMove(x, y);
	await h.settle(ms);
};
const shot = async (name: string) => {
	await h.settle(400);
	r.captureScreenshot(`${SHOTS}/chrome-${name}.png`);
};
const clickId = async (testId: string) => {
	const b = bounds(testId);
	if (!b) return false;
	const c = centre(b);
	await move(c.x, c.y, 120);
	await h.click(c.x, c.y);
	return true;
};
/** Bring up pane `id`'s hover header by moving onto its top strip. */
const hoverTop = async (id: string) => {
	const s = bounds(`pane-hotstrip-${id}`);
	if (!s) return false;
	await move(s.x + s.width / 2, s.y + s.height / 2);
	return true;
};

h.store.selectItem(pick.parent);
for (let i = 0; i < 100 && viewPaneModel().itemKey() !== pick.parent; i++) await sleep(50);
await h.settle(500);
check(detachSection("attachments"), "detach Attachments");
await h.settle(800);

// ---- 1. hidden until the top strip is reached
await move(700, 500);
check(!bounds("pane-hover-header-item"), "item pane: no header while the pointer is elsewhere");
check(!!bounds("pane-hotstrip-item"), "item pane: the top strip is there");
check(!!bounds(`pane-hotstrip-${ATT}`), "Attachments pane: the top strip is there");
const fft0 = r.findByText("Find Full Text");
const fftB0 = fft0 ? r.getElementBounds(fft0.id) : null;
check(!fftB0 || fftB0.width === 0, "Find Full Text is not drawn over the Attachments content");
await shot("rest");

check(await hoverTop("item"), "move onto the item pane's top strip");
check(!!bounds("pane-hover-header-item"), "item pane: the header comes up");
const hi = bounds("pane-hover-header-item");
await move(hi!.x + 60, hi!.y + hi!.height / 2); // along the header itself
check(!!bounds("pane-hover-header-item"), "item pane: the header stays while the pointer is on it");
await shot("item-header");
await move(700, 500, 700);
check(!bounds("pane-hover-header-item"), "item pane: the header goes once the pointer leaves");

// ---- 2. the detached section's own button is in its header
check(await hoverTop(ATT), "move onto the Attachments pane's top strip");
const ha = bounds(`pane-hover-header-${ATT}`);
check(!!ha, "Attachments pane: the header comes up");
const fft = r.findByText("Find Full Text");
const fftB = fft ? r.getElementBounds(fft.id) : null;
check(
	!!ha && !!fftB && fftB.width > 0 && fftB.y >= ha.y - 1 && fftB.y + fftB.height <= ha.y + ha.height + 1,
	"Find Full Text is in the Attachments header",
);
await shot("attachments-header");

// ---- 3. maximise and restore
check(await clickId(`pane-hover-max-${ATT}`), "click Maximise on Attachments");
await h.settle(500);
check(maximised() === ATT, "Attachments is maximised");
const big = bounds(`pane-${ATT}`);
check(!!big && big.width > 1000, `Attachments fills the frame (${big?.width.toFixed(0)} px wide)`);
check(!bounds("pane-items") && !bounds("pane-item"), "the other panes are not drawn");
await shot("maximised");
await hoverTop(ATT);
check(await clickId(`pane-hover-max-${ATT}`), "click Restore size");
await h.settle(500);
check(maximised() === null && !!bounds("pane-items") && !!bounds("pane-item"), "the layout is back");

// ---- 4. minimise to the rail and back
await hoverTop(ATT);
check(await clickId(`pane-hover-min-${ATT}`), "click Minimise on Attachments");
await h.settle(500);
check(minimisedPanes().includes(ATT) && !bounds(`pane-${ATT}`), "Attachments is minimised and not drawn");
check(!!bounds(`pane-rail-${ATT}`), "its button is on the rail");
await shot("minimised");
check(await clickId(`pane-rail-${ATT}`), "click its rail button");
await h.settle(500);
check(!minimisedPanes().includes(ATT) && !!bounds(`pane-${ATT}`) && !bounds("pane-rail"), "Attachments is back, the rail is gone");

// ---- 5. hide and undo
await hoverTop(ATT);
check(await clickId(`pane-hover-close-${ATT}`), "click Hide on Attachments");
await h.settle(400);
check(libraryLayout().hidden.includes(ATT) && !bounds(`pane-${ATT}`), "Attachments is hidden");
check(!bounds(`pane-rail-${ATT}`), "a hidden pane is not on the rail");
undoLayout();
await h.settle(500);
check(!libraryLayout().hidden.includes(ATT) && !!bounds(`pane-${ATT}`), "Undo brings it back");

// ---- 6. drag a pane by its header: Attachments onto the top of the centre column
const before = libraryPaneLocation(ATT);
await hoverTop(ATT);
const drag = bounds(`pane-hover-drag-${ATT}`);
const items = bounds("pane-items");
check(!!drag && !!items, "the header's drag area and the items pane are there");
if (drag && items) {
	const from = { x: drag.x + 40, y: drag.y + drag.height / 2 };
	const to = { x: items.x + items.width / 2, y: items.y + 24 };
	r.nativeSimulateMouseMove(from.x, from.y);
	await h.settle(100);
	r.nativeSimulateMouseDown(from.x, from.y);
	// cross the drag threshold while still over the header, as a hand does (the third argument: the button held)
	r.nativeSimulateMouseMove(from.x + 8, from.y, 0);
	await sleep(25);
	for (let k = 1; k <= 8; k++) {
		r.nativeSimulateMouseMove(Math.round(from.x + ((to.x - from.x) * k) / 8), Math.round(from.y + ((to.y - from.y) * k) / 8), 0);
		await sleep(25);
	}
	await h.settle(200);
	await shot("dragging");
	r.nativeSimulateMouseUp(to.x, to.y);
	await h.settle(600);
}
const after = libraryPaneLocation(ATT);
check(
	!!before && !!after && (after.column !== before.column || after.stack !== before.stack),
	`dragging the header moved Attachments (${before?.column}/${before?.stack} -> ${after?.column}/${after?.stack})`,
);
const sel = (r as { getSelectedText?: () => string | null }).getSelectedText?.() ?? "";
check(!sel, `the drag selected no text${sel ? ` (selected: ${JSON.stringify(sel.slice(0, 60))})` : ""}`);
await shot("dragged");

console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
