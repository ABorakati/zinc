// Headless check of drag to dock (src/shell/dock.tsx) through the real UI: the stack tabs of shell/PaneStack.tsx, the item pane's
// section headers and gaps (itempane/kit.tsx), and the drop hosts they register. No test-only hosts.
//   ZN_URL=<core on a library COPY> ZN_SHOTS=<dir> bun scripts/shot-dock.tsx
// Prints PASS / FAIL lines and exits 1 on a failure. Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts).
// Writes <ZN_SHOTS>/shell-dock-*.png.
//
// Normal use draws no pane headers; the scenarios run in edit layout mode (shell/layoutEdit.tsx), which shows them.
// Scenarios, each from the Standard layout (sidebar | items | item):
//   1. drag the Item tab onto the bottom quarter of the Items stack: Item becomes a stack below Items; the pane and list host ids are
//      unchanged, the list keeps its scroll offset, a click on a list row still selects it; Undo from the toast restores Standard
//   2. drag the Item tab onto the middle of the Items stack: a tab beside Items
//   3. Escape during a drag cancels it
//   4. drag the Info section header out of the item pane onto the bottom quarter of the Item stack: section:info is a stack of its
//      own below Item; then drag its tab onto a section gap in the item pane: it returns there
import { SHOTS, boot, sleep } from "./shell-shot-lib";
import { standardLibrary } from "../src/shell/frameLayout";
import { libraryLayout, setLibraryLayout } from "../src/shell/layout";
import { isDetached } from "../src/shell/sectionPanes";
import { handleWindowKeyDown } from "../src/shell/shortcuts";
import { editLayout, layoutEditing } from "../src/shell/layoutEdit";
import { closeMenus } from "../src/ui/core";

const h = await boot({ prefs: { mode: "light" } });
const r = h.t.renderer;
let failed = 0;
const check = (ok: unknown, msg: string) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
	if (!ok) failed++;
};
const box = (testId: string) => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	return b && b.width > 0 && b.height > 0 ? b : null;
};
const shape = () => {
	const l = libraryLayout();
	const col = (c: typeof l.centre) => c.stacks.map((s) => `${s.panes.join("+")}[${s.active}]`).join(" / ") || "-";
	return `centre ${col(l.centre)} | right ${col(l.right)}`;
};
const STANDARD = "centre items[items] | right item[item]";

/** Press at `from`, move in steps to `to` (crossing the drag threshold), optionally release. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, release = true) {
	r.nativeSimulateMouseMove(from.x, from.y);
	await h.settle(100);
	r.nativeSimulateMouseDown(from.x, from.y);
	// cross the drag threshold while still over the source, as a hand does
	r.nativeSimulateMouseMove(from.x + 8, from.y, 0);
	await sleep(25);
	for (let i = 1; i <= 8; i++) {
		r.nativeSimulateMouseMove(Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), 0);
		await sleep(25);
	}
	await h.settle(200);
	if (release) {
		r.nativeSimulateMouseUp(to.x, to.y);
		await h.settle(600);
	}
}
const mid = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const ids = () => ["pane-items", "pane-item", "column-left"].map((t) => r.findByTestId(t)?.id);
/** The item list: the virtual list scrolled away from its first row (the item pane's list is at its top). */
let listId: number | undefined;
const pickList = () => {
	listId = r.findByType("virtual-list").find((e) => (r.getListScrollTop(e.id)?.[0] ?? 0) > 0)?.id;
};
/** The list's first drawn row and the offset into it (the viewport height changes with the stack's height). */
const listAnchor = () => (listId === undefined ? null : JSON.stringify(r.getListScrollTop(listId)?.slice(0, 2) ?? null));
/** Escape as the window's key handler gets it (main.tsx passes handleWindowKeyDown to render(); the test root has none). */
const escape = () =>
	handleWindowKeyDown({ key: "escape", modifiers: { ctrl: false, shift: false, alt: false, meta: false }, defaultPrevented: false, preventDefault() {} } as never);
async function reset() {
	setLibraryLayout(standardLibrary());
	await h.settle(600);
	check(shape() === STANDARD, `reset to Standard: ${shape()}`);
}

h.store.selectItem(h.store.itemAt(0)!.key);
await h.settle(1800);

// ---- 0. normal use: no headers; edit mode: headers, grips and the edit bar
{
	check(!box("pane-tab-items") && !box("pane-tab-item"), "normal use draws no pane headers");
	r.captureScreenshot(`${SHOTS}/shell-dock-normal.png`);
	editLayout(true);
	await h.settle(600);
	check(!!box("pane-tab-items") && !!box("pane-tab-item") && !!box("layout-edit-bar"), "edit mode shows the pane headers and the edit bar");
	r.captureScreenshot(`${SHOTS}/shell-dock-edit-mode.png`);
}

// ---- 1. Item tab -> bottom quarter of Items
{
	await reset();
	const items = box("pane-items")!;
	r.nativeSimulateScrollWheel(items.x + items.width / 2, items.y + items.height / 2, 0, -1200);
	await h.settle(600);
	pickList();
	const ids0 = ids();
	const anchor0 = listAnchor();
	const tab = box("pane-tab-item")!;
	const stack = box("stack-items")!;
	await drag(mid(tab), { x: stack.x + stack.width / 2, y: stack.y + stack.height * 0.9 }, false);
	check(!!box("dock-preview") && !!box("dock-ghost"), "preview and ghost shown during the drag");
	r.captureScreenshot(`${SHOTS}/shell-dock-preview.png`);
	r.nativeSimulateMouseUp(stack.x + stack.width / 2, Math.round(stack.y + stack.height * 0.9));
	await h.settle(800);
	check(shape() === "centre items[items] / item[item] | right -", `split below: ${shape()}`);
	check(JSON.stringify(ids()) === JSON.stringify(ids0), `pane hosts kept: ${JSON.stringify(ids0)} -> ${JSON.stringify(ids())}`);
	check(anchor0 !== null && listAnchor() === anchor0, `list scroll kept: ${anchor0} -> ${listAnchor()}`);
	r.captureScreenshot(`${SHOTS}/shell-dock-after.png`);
	// a click inside the moved layout still works: pick a visible row of the list
	// a row inside the list's visible area: below the toolbar and sort bar (about 110 px), above the pane's bottom edge (the
	// virtual list reports bounds for rows scrolled out under the toolbar too)
	const pane = box("pane-items")!;
	let target = h.store.itemAt(0)!;
	let rb: { x: number; y: number; width: number; height: number } | null = null;
	for (let i = 0; i < 60 && !rb; i++) {
		const it = h.store.itemAt(i);
		const row = it && it.key !== h.store.selectedItem() ? r.findByText(it.title) : null;
		const b = row ? r.getElementBounds(row.id) : null;
		if (it && b && b.height > 0 && b.y > pane.y + 130 && b.y + b.height < pane.y + pane.height - 20) {
			target = it;
			rb = b;
		}
	}
	if (rb && rb.height > 0) {
		const before = h.store.selectedItem();
		// a hand moves to the row first; after the drag layer goes away GPUI hit-tests from the last pointer move
		r.nativeSimulateMouseMove(rb.x + 4, rb.y + rb.height / 2);
		await h.settle(200);
		r.nativeSimulateClick(rb.x + 4, rb.y + rb.height / 2);
		await h.settle(800);
		// the selection follows the click (the row under the pointer may be a neighbour of `target` while the list settles)
		check(h.store.selectedItem() !== before, `a list row click changes the selection after the move (${before} -> ${h.store.selectedItem()}, aimed at ${target.key})`);
		closeMenus();
		await h.settle(300);
	} else console.log("SKIP row click: the row is not on screen");
	const undo = r.findByText("Undo");
	const ub = undo ? r.getElementBounds(undo.id) : null;
	check(!!ub, "the toast offers Undo");
	if (ub) {
		r.nativeSimulateClick(ub.x + ub.width / 2, ub.y + ub.height / 2);
		await h.settle(600);
		check(shape() === STANDARD, `Undo restores Standard: ${shape()}`);
	}
}

// ---- 2. Item tab -> middle of Items (a tab)
{
	await reset();
	const tab = box("pane-tab-item")!;
	const stack = box("stack-items")!;
	await drag(mid(tab), mid(stack));
	check(shape() === "centre items+item[item] | right -", `tab beside Items: ${shape()}`);
	r.captureScreenshot(`${SHOTS}/shell-dock-tab-after.png`);
}

// ---- 3. Escape cancels
{
	await reset();
	const tab = box("pane-tab-item")!;
	const stack = box("stack-items")!;
	await drag(mid(tab), mid(stack), false);
	escape();
	await h.settle(400);
	check(!box("dock-preview"), "Escape removes the preview");
	r.nativeSimulateMouseUp(Math.round(stack.x + stack.width / 2), Math.round(stack.y + stack.height / 2));
	await h.settle(500);
	check(shape() === STANDARD, `nothing moved after Escape: ${shape()}`);
}

// ---- 4. a section dragged out of the item pane, and back
{
	await reset();
	const head = box("ip-section-title-info");
	const itemStack = box("stack-item")!;
	if (!head) check(false, "the Info header is on screen");
	else {
		await drag(mid(head), { x: itemStack.x + itemStack.width / 2, y: itemStack.y + itemStack.height * 0.9 });
		check(isDetached("info"), `Info dragged out: ${shape()}`);
		check(shape() === "centre items[items] | right item[item] / section:info[section:info]", `below Item: ${shape()}`);
		r.captureScreenshot(`${SHOTS}/shell-dock-section-detached.png`);
		await sleep(400);
		const tab = box("pane-tab-section:info");
		const gap = box("ip-gap-abstract") ?? box("ip-gap-end");
		if (!tab || !gap) check(false, `section tab and a gap are on screen (tab ${!!tab}, gap ${!!gap})`);
		else {
			await drag(mid(tab), mid(gap));
			check(!isDetached("info"), `Info returned to the item pane: ${shape()}`);
			r.captureScreenshot(`${SHOTS}/shell-dock-section-returned.png`);
		}
	}
}

// ---- 5. Escape leaves edit mode (when no drag is running)
escape();
await h.settle(400);
check(!layoutEditing() && !box("pane-tab-item") && !box("layout-edit-bar"), "Escape leaves edit mode");

console.log(failed ? `${failed} check(s) FAILED` : "all dock checks passed");
h.t.unmount();
process.exit(failed ? 1 : 0);
