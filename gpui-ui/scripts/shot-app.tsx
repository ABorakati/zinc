// Headless screenshots of the whole <App/> shell: bun scripts/shot-app.tsx [out.png] [--mode light|dark] [--scheme id] [--drag]
//   [--panels 10|01|00] [--toggle] [--stacked] [--move] [--tabs] [--focus]   (exit code 1 when a check FAILs)
//   out.png          default <scratchpad>/gpui-shots/shell-app.png
//   --drag           drag the first column gutter 140 px right (the Resizable), screenshot as <out>-resized.png and print the saved sizes
//   --panels 10      hide the item pane (also 01 / 00)
//   --toggle         scroll the list, then hide and show the sidebar and the item pane: the panes must not be rebuilt (same host
//                    element ids, the list keeps its scroll offset); compares the shots before and after (<out>-toggle-*.png)
//   --stacked        put the item pane below the list in the centre column (the right column empties), screenshot, then drag the
//                    row gutter 120 px up (<out>-stacked*.png)
//                    The gutter is found from the list's bottom edge: every stack draws a 26 px header above its pane.
//   --move           (phase 2) select an item, scroll the list, then through the pane menu (paneMenuItems("item"): "Stack with" >
//                    the items stack's title, onSelect) stack the item pane with the list, activate the items tab, and move the item
//                    pane back with "Move to" > "Right column". Checks: host ids of the panes and of their descendants unchanged
//                    (native element tree), the list's native scroll anchor (getListScrollTop) nonzero before and the same
//                    after each step, and the list crop identical to the before shot once back. Shots <out>-move-*.png.
//   --tabs           stack the item pane with the list through the menu, items tab active, screenshot as <out>-tabs.png (run it
//                    once per --mode)
//   --focus          F6 / Shift+F6 (app actions pane-next / pane-previous): left, items, item in reading order, and a
//                    focusable descendant remembered per pane (<out>-focus.png)
// Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts), never the real one.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { SHOTS, STATE_FILE, boot, sleep } from "./shell-shot-lib";
import { libraryLayout, setLeftOpen, setLibraryLayout, setRightOpen } from "../src/shell/layout";
import { flag } from "./_args";
import { gotoSection } from "../src/settings";
import { openSettings } from "../src/shell/layout";
import { setThemePrefs } from "../src/shell/appearance";
import { appActions } from "../src/registry";
import { closeMenus, dismissToast, overlayLayers, toastList, type MenuItem } from "../src/ui/core";
import { locatePane, standardLibrary } from "../src/shell/frameLayout";
import { activateLibraryPane } from "../src/shell/layout";
import { paneMenuItems } from "../src/shell/PaneStack";
import { paneDef } from "../src/shell/panes";
import type { TestElement } from "@gpuix/solid/testing";

const args = process.argv.slice(2);
const val = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const out = args.find((a) => a.endsWith(".png")) ?? `${SHOTS}/shell-app.png`;
const mode = val("--mode") as "light" | "dark" | undefined;
const scheme = val("--scheme");
const panels = val("--panels");
const sizes = () => libraryLayout().sizes.map((n) => +n.toFixed(3));

const h = await boot({ prefs: { ...(mode ? { mode } : { mode: "dark" }), ...(scheme ? { scheme } : {}) } });
const live = val("--live-scheme"); // switch the scheme after the app is up: every drawn component must restyle
if (live) {
	setThemePrefs({ scheme: live });
	await h.settle(800);
}
if (flag(args, "--select")) {
	const it = h.store.itemAt(1);
	if (it) h.store.selectItem(it.key);
	await h.settle(1500);
}
if (flag(args, "--settings")) {
	openSettings();
	gotoSection(val("--settings-section") ?? "appearance");
	await h.settle(800);
}
if (panels) {
	setLeftOpen(panels[0] === "1");
	setRightOpen(panels[1] === "1");
	await h.settle();
}
await h.settle(400);
h.t.renderer.captureScreenshot(out);
console.log("wrote", out);

const win = h.t.renderer.getWindowSize();
async function dragBy(x0: number, y0: number, dx: number, dy: number) {
	h.t.renderer.nativeSimulateMouseDown(x0, y0);
	for (let i = 1; i <= 7; i++) {
		h.t.renderer.nativeSimulateMouseMove(Math.round(x0 + (i * dx) / 7), Math.round(y0 + (i * dy) / 7), 0);
		await sleep(30);
	}
	h.t.renderer.nativeSimulateMouseUp(x0 + dx, y0 + dy);
	await h.settle(500);
}

if (flag(args, "--drag")) {
	const before = sizes();
	// the first gutter sits at the right edge of the sidebar column: 18% of the width left after the two 12 px gutters and the 12 px right padding
	const x0 = Math.round(0.18 * (win.width - 12 - 24) + 6);
	await dragBy(x0, Math.round(win.height / 2), 140, 0);
	const resized = out.replace(/\.png$/, "-resized.png");
	h.t.renderer.captureScreenshot(resized);
	console.log("wrote", resized, "sizes before", before, "after", sizes());
}

/** Fraction of pixels that differ between two screenshots. */
function diff(a: string, b: string): number {
	const pa = PNG.sync.read(readFileSync(a));
	const pb = PNG.sync.read(readFileSync(b));
	if (pa.width !== pb.width || pa.height !== pb.height) return 1;
	const n = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
	return n / (pa.width * pa.height);
}
const idOf = (testId: string) => h.t.renderer.findByTestId(testId)?.id;

const R = h.t.renderer;
let failed = 0;
/** Print a PASS / FAIL line; any FAIL makes the script exit with code 1. */
function check(name: string, ok: boolean, extra = ""): boolean {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? `: ${extra}` : ""}`);
	if (!ok) failed++;
	return ok;
}
type El = TestElement;
const elOf = (testId: string): El | undefined => R.findByTestId(testId);
const j = (v: unknown) => JSON.stringify(v);

/** The native element and its descendants down to `depth` (text nodes and the rows of a virtual list left out). */
function subtree(rootId: number, depth: number, cap = 4000): El[] {
	const out: El[] = [];
	const walk = (id: number, d: number) => {
		const e = R.getElement(id);
		if (!e || e.type === "text" || out.length >= cap) return;
		out.push(e);
		if (d >= depth || e.type === "virtual-list") return;
		for (const c of e.children) walk(c, d + 1);
	};
	walk(rootId, 0);
	return out;
}
/** Whether element `id` is `anc` or lies below it. */
function contains(anc: number, id: number): boolean {
	let e = R.getElement(id);
	for (let n = 0; e && n < 300; n++) {
		if (e.id === anc) return true;
		e = e.parentId == null ? undefined : R.getElement(e.parentId);
	}
	return false;
}

const ROOTS = { items: "pane-items", item: "pane-item", left: "column-left" } as const;
interface Snap {
	roots: Record<string, number | undefined>;
	nodes: Map<number, { type: string; parentId: number | null; root: string }>;
	list: number | undefined;
	anchor: number[] | null;
}
/** The items pane's virtual list: among the `virtual-list` nodes below `pane-items`, the one with a native scroll anchor (the tallest viewport). */
function findList(itemsRoot: number | undefined): number | undefined {
	if (itemsRoot === undefined) return undefined;
	const cands = [...R.findByType("virtual-list").filter((e) => contains(itemsRoot, e.id)), ...subtree(itemsRoot, 14).filter((e) => e.type === "virtual-list")];
	let best: number | undefined;
	let bestViewport = -1;
	for (const e of cands) {
		const a = R.getListScrollTop(e.id);
		if (a && a[2]! > bestViewport) {
			best = e.id;
			bestViewport = a[2]!;
		}
	}
	return best ?? cands[0]?.id;
}
/** Where the list is drawn: the virtual-list's own bounds when the native tree reports them, else the items pane's (as --toggle uses). */
function listRegion(s: Snap): { x: number; y: number; width: number; height: number } | null {
	const own = s.list === undefined ? null : R.getElementBounds(s.list);
	if (own && own.width > 0 && own.height > 0) return own;
	const pane = s.roots.items === undefined ? null : R.getElementBounds(s.roots.items);
	return pane && pane.width > 0 && pane.height > 0 ? pane : null;
}
/** Native ids of the pane hosts, of their descendants (4 levels) and of the list, plus the list's scroll anchor. */
function snap(): Snap {
	const roots: Snap["roots"] = {};
	const nodes: Snap["nodes"] = new Map();
	for (const [k, tid] of Object.entries(ROOTS)) {
		const e = elOf(tid);
		roots[k] = e?.id;
		if (e) for (const n of subtree(e.id, 4)) nodes.set(n.id, { type: n.type, parentId: n.parentId, root: k });
	}
	const list = findList(roots.items);
	return { roots, nodes, list, anchor: list === undefined ? null : R.getListScrollTop(list) };
}
/** Every host id of `a` still exists in `b` with the same type and parent (the pane hosts may change parent: they were moved). */
function sameHosts(name: string, a: Snap, b: Snap): boolean {
	const rootsSame = Object.keys(ROOTS).every((k) => a.roots[k] !== undefined && a.roots[k] === b.roots[k]);
	const roots = j(a.roots) + (rootsSame ? "" : ` -> ${j(b.roots)}`);
	const lost: string[] = [];
	for (const [id, n] of a.nodes) {
		const m = b.nodes.get(id);
		const isRoot = a.roots[n.root] === id;
		if (!m || m.type !== n.type || (!isRoot && m.parentId !== n.parentId)) lost.push(`${id}:${n.type}`);
	}
	return check(
		`${name}: host ids unchanged`,
		rootsSame && lost.length === 0 && a.list === b.list && a.list !== undefined,
		`pane roots ${roots}, list ${a.list} -> ${b.list}, ${a.nodes.size} hosts compared${lost.length ? `, LOST ${lost.slice(0, 8).join(" ")}` : ""}`,
	);
}
const nonzero = (a: number[] | null) => !!a && (a[0]! > 0 || a[1]! > 0.5);
const sameAnchor = (a: number[] | null, b: number[] | null) => !!a && !!b && a[0] === b[0] && Math.abs(a[1]! - b[1]!) < 0.5;

/** Wheel the items pane down (at its centre, as --toggle does), then let the scrollbar thumb and group popup fade (they would show in a shot). */
async function scrollList(s: Snap) {
	const b = s.roots.items === undefined ? null : R.getElementBounds(s.roots.items);
	if (!b || b.width <= 0 || b.height <= 0) throw new Error(`pane-items has no bounds: ${j(b)}`);
	for (let i = 0; i < 6; i++) {
		R.nativeSimulateScrollWheel(b.x + b.width / 2, b.y + b.height / 2, 0, -500);
		R.flush();
		R.dispatchNativeEvents();
		await sleep(30);
	}
	await h.settle(1500);
}
/** A shot without the undo toast and without hover state (the pointer leaves the window). */
async function shotClean(file: string) {
	dismissToast();
	R.nativeSimulateMouseExit(win.width - 1, win.height - 1);
	await h.settle(600);
	R.captureScreenshot(file);
	console.log("wrote", file);
}
/** Fraction of differing pixels inside `r` (window px) of two shots. */
function cropDiff(a: string, b: string, r: { x: number; y: number; width: number; height: number }): number {
	const pa = PNG.sync.read(readFileSync(a));
	const pb = PNG.sync.read(readFileSync(b));
	if (pa.width !== pb.width || pa.height !== pb.height) return 1;
	const k = pa.width / win.width;
	const x0 = Math.max(0, Math.floor(r.x * k));
	const y0 = Math.max(0, Math.floor(r.y * k));
	const w = Math.min(pa.width - x0, Math.ceil(r.width * k));
	const hh = Math.min(pa.height - y0, Math.ceil(r.height * k));
	if (w <= 0 || hh <= 0) return 1;
	const crop = (p: PNG) => {
		const o = Buffer.alloc(w * hh * 4);
		for (let y = 0; y < hh; y++) p.data.copy(o, y * w * 4, ((y0 + y) * p.width + x0) * 4, ((y0 + y) * p.width + x0 + w) * 4);
		return o;
	};
	return pixelmatch(crop(pa), crop(pb), null, w, hh, { threshold: 0.1 }) / (w * hh);
}

/** A menu entry by label path, e.g. ["Move to", "Right column"]. */
function menuEntry(items: MenuItem[], path: string[]): MenuItem | undefined {
	let cur = items;
	let found: MenuItem | undefined;
	for (const label of path) {
		found = cur.find((i) => i.label === label);
		if (!found) return undefined;
		cur = found.submenu ?? [];
	}
	return found;
}
/** The stacks of both columns, for messages: "items+item[item]" is one stack of two panes with `item` active. */
const stacksText = () => {
	const l = libraryLayout();
	const col = (c: "centre" | "right") => l[c].stacks.map((s) => `${s.panes.join("+")}[${s.active}]`).join(" / ") || "-";
	return `centre ${col("centre")}, right ${col("right")}`;
};
async function resetStandard() {
	setLibraryLayout(standardLibrary());
	await h.settle(1000);
	dismissToast();
}
/** Stack the item pane with the list through the pane menu's real onSelect. */
async function stackItemWithItems(): Promise<boolean> {
	const title = paneDef("items")?.title() ?? "Items";
	const e = menuEntry(paneMenuItems("item"), ["Stack with", title]);
	if (!check(`menu "Stack with" > "${title}" is enabled`, !!e && !e.disabled && !!e.onSelect)) return false;
	e!.onSelect!();
	await h.settle(800);
	dismissToast();
	await h.settle(400);
	return true;
}

if (flag(args, "--toggle")) {
	const items = h.t.renderer.findByTestId("pane-items");
	const box = items ? h.t.renderer.getElementBounds(items.id) : null;
	if (box) h.t.renderer.nativeSimulateScrollWheel(box.x + box.width / 2, box.y + box.height / 2, 0, -1500);
	await h.settle(800);
	const ids0 = ["pane-items", "pane-item", "column-left"].map(idOf);
	const a = out.replace(/\.png$/, "-toggle-a.png");
	h.t.renderer.captureScreenshot(a);
	setLeftOpen(false);
	setRightOpen(false);
	await h.settle(600);
	const mid = out.replace(/\.png$/, "-toggle-hidden.png");
	h.t.renderer.captureScreenshot(mid);
	setLeftOpen(true);
	setRightOpen(true);
	await h.settle(800);
	const b = out.replace(/\.png$/, "-toggle-b.png");
	h.t.renderer.captureScreenshot(b);
	const ids1 = ["pane-items", "pane-item", "column-left"].map(idOf);
	const same = ids0.every((x, i) => x !== undefined && x === ids1[i]);
	console.log("wrote", a, mid, b);
	console.log(
		`toggle: host ids ${same ? "unchanged" : "CHANGED"} ${JSON.stringify(ids0)} -> ${JSON.stringify(ids1)}; ` +
		`before/after differ in ${(diff(a, b) * 100).toFixed(3)}% of pixels; sizes ${JSON.stringify(sizes())}`,
	);
	check("toggle: pane host ids unchanged", same);
}

if (flag(args, "--stacked")) {
	const l = libraryLayout();
	setLibraryLayout({
		...l,
		centre: {
			stacks: [
				{ panes: ["items"], active: "items" },
				{ panes: ["item"], active: "item" },
			],
			sizes: [0.6, 0.4],
		},
		right: { stacks: [], sizes: [] },
	});
	await h.settle(800);
	const s1 = out.replace(/\.png$/, "-stacked.png");
	h.t.renderer.captureScreenshot(s1);
	const list0 = elOf("pane-items");
	const lb = list0 ? R.getElementBounds(list0.id) : null;
	const item = elOf("pane-item");
	const b = item ? R.getElementBounds(item.id) : null;
	if (lb && b && b.height > 0) {
		const before = JSON.stringify(libraryLayout().centre.sizes);
		// The row gutter is the 12 px canvas gap under the list's stack. Every stack draws a 26 px header above its pane, so the
		// item pane's top edge is NOT the gutter (it is 26 px lower, or 26 + 12 px above the header, depending on what carries the
		// test id): take the gutter from the list's bottom edge, its middle 6 px further down.
		await dragBy(Math.round(lb.x + lb.width / 2), Math.round(lb.y + lb.height + 6), 0, -120);
		const s2 = out.replace(/\.png$/, "-stacked-resized.png");
		h.t.renderer.captureScreenshot(s2);
		const after = JSON.stringify(libraryLayout().centre.sizes);
		console.log("wrote", s1, s2, "centre stacks before", before, "after", after);
		check("stacked: dragging the row gutter changed the stack heights", before !== after, `${before} -> ${after}`);
	} else {
		console.log("wrote", s1);
		check("stacked: the item pane is drawn", false, JSON.stringify(b));
	}
}

/** --move: stack, activate, move back through the pane menu; host ids, native scroll anchor and pixels checked at each step. */
async function runMove() {
	console.log("== --move");
	await resetStandard();
	const it = h.store.itemAt(1);
	if (it) h.store.selectItem(it.key); // the item pane gets content: more descendants to follow
	await h.settle(1500);
	const first = snap();
	const vls = R.findByType("virtual-list").map((e) => `${e.id}${e.id === first.list ? "*" : ""}:bounds ${j(R.getElementBounds(e.id))} anchor ${j(R.getListScrollTop(e.id))}`);
	console.log(`note: pane-items bounds ${j(first.roots.items === undefined ? null : R.getElementBounds(first.roots.items))}; virtual-list nodes: ${vls.join(" | ") || "none"}`);
	if (!check("move: list and pane hosts found", Object.values(first.roots).every((x) => x !== undefined) && first.list !== undefined, j(first.roots))) return;
	await scrollList(first);
	const before = snap();
	check("move: the list is scrolled before the move (nonzero native anchor)", nonzero(before.anchor), `[item index, px in item, viewport px] ${j(first.anchor)} -> ${j(before.anchor)}`);
	const listBox = listRegion(before);
	if (!check("move: list region has bounds", !!listBox, j(listBox))) return;
	const fBefore = out.replace(/\.png$/, "-move-before.png");
	await shotClean(fBefore);

	// 1. item pane into the list's stack (item becomes the active tab)
	if (!(await stackItemWithItems())) return;
	const lay1 = libraryLayout();
	check(
		"move: item stacked with items, item active, right column empty",
		lay1.centre.stacks.length === 1 && j(lay1.centre.stacks[0]!.panes) === '["items","item"]' && lay1.centre.stacks[0]!.active === "item" && lay1.right.stacks.length === 0,
		stacksText(),
	);
	const stacked = snap();
	sameHosts("move: after Stack with", before, stacked);
	const ib = elOf("pane-item") ? R.getElementBounds(elOf("pane-item")!.id) : null;
	check("move: the item pane is drawn in the centre column", !!ib && ib.width > 0 && ib.height > 0, j(ib));
	if (stacked.anchor) check("move: hidden list keeps its native scroll anchor", sameAnchor(before.anchor, stacked.anchor), `${j(before.anchor)} -> ${j(stacked.anchor)}`);
	else console.log("note: the hidden list reports no native scroll anchor (getListScrollTop null)");
	await shotClean(out.replace(/\.png$/, "-move-stacked.png"));

	// 2. activate the items tab again (the intermediate state)
	activateLibraryPane("items");
	await h.settle(800);
	check("move: items tab active", libraryLayout().centre.stacks[0]?.active === "items", stacksText());
	const tab = snap();
	sameHosts("move: after activating items", before, tab);
	const tb = listRegion(tab);
	check("move: list drawn again (nonzero bounds and viewport)", !!tb && (tab.anchor?.[2] ?? 0) > 0, `${j(tb)} anchor ${j(tab.anchor)}`);
	check("move: list native scroll anchor kept across tab activation", sameAnchor(before.anchor, tab.anchor), `${j(before.anchor)} -> ${j(tab.anchor)}`);
	await shotClean(out.replace(/\.png$/, "-move-tab-items.png"));

	// 3. back to the right column through the menu
	const e = menuEntry(paneMenuItems("item"), ["Move to", "Right column"]);
	if (!check('menu "Move to" > "Right column" is enabled', !!e && !e.disabled && !!e.onSelect)) return;
	e!.onSelect!();
	await h.settle(800);
	console.log(`note: ${toastList().length} toast(s) after the menu move (the undo toast), dismissed for the shots`);
	dismissToast();
	await h.settle(400);
	const lay2 = libraryLayout();
	check(
		"move: item back in the right column, items alone in the centre",
		j(lay2.centre.stacks.map((s) => s.panes)) === '[["items"]]' && j(lay2.right.stacks.map((s) => s.panes)) === '[["item"]]' && locatePane(lay2, "item")?.column === "right",
		stacksText(),
	);
	const end = snap();
	sameHosts("move: after Move to Right column", before, end);
	check("move: list native scroll anchor kept after moving back", sameAnchor(before.anchor, end.anchor), `${j(before.anchor)} -> ${j(end.anchor)}`);
	const endBox = listRegion(end);
	check(
		"move: list geometry as before the move",
		!!endBox && (["x", "y", "width", "height"] as const).every((k) => Math.abs(endBox[k] - listBox![k]) <= 1),
		`${j(listBox)} -> ${j(endBox)}`,
	);
	const fBack = out.replace(/\.png$/, "-move-back.png");
	await shotClean(fBack);
	const crop = cropDiff(fBefore, fBack, listBox!);
	check("move: list pixels unchanged (same geometry, toast dismissed)", crop < 0.01, `${(crop * 100).toFixed(3)}% of the list crop differs; whole window ${(diff(fBefore, fBack) * 100).toFixed(3)}%`);
}

/** --tabs: the stack with two tabs, items active, shot in the current mode. */
async function runTabs() {
	console.log("== --tabs");
	await resetStandard();
	if (!(await stackItemWithItems())) return;
	activateLibraryPane("items");
	await h.settle(800);
	dismissToast();
	const lay = libraryLayout();
	check("tabs: one stack of items + item, items active", lay.centre.stacks.length === 1 && j(lay.centre.stacks[0]!.panes) === '["items","item"]' && lay.centre.stacks[0]!.active === "items", stacksText());
	for (const id of ["items", "item"]) {
		const t = elOf(`pane-tab-${id}`);
		const b = t ? R.getElementBounds(t.id) : null;
		check(`tabs: tab pane-tab-${id} drawn`, !!b && b.width > 0 && b.height > 0, j(b));
	}

	// native clicks on the tab centres (the real onClick path, not activateLibraryPane)
	const active = () => libraryLayout().centre.stacks[0]?.active;
	const centreOf = (testId: string) => {
		const e = elOf(testId);
		const b = e ? R.getElementBounds(e.id) : null;
		return b && b.width > 0 && b.height > 0 ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
	};
	const clickTab = async (id: string, expect: string) => {
		const c = centreOf(`pane-tab-${id}`);
		if (!check(`tabs: pane-tab-${id} has a click point`, !!c, j(c))) return;
		R.nativeSimulateClick(c!.x, c!.y);
		await h.settle(600);
		const pb = R.getElementBounds(elOf(`pane-${expect}`)?.id ?? -1);
		check(`tabs: native click on pane-tab-${id} makes ${expect} active and drawn`, active() === expect && !!pb && pb.width > 0 && pb.height > 0, `${stacksText()}, pane-${expect} ${j(pb)}`);
	};
	await clickTab("item", "item");
	await clickTab("items", "items");

	// keys on a focused tab: Right / Left step along the tabs and move focus to the new tab, Shift+F10 opens the pane menu.
	// nativeSimulateKeystrokes(elementId, keystrokes) focuses the element first and needs its key listener (the tab has one).
	const tabIds = { items: elOf("pane-tab-items")?.id, item: elOf("pane-tab-item")?.id };
	if (tabIds.items !== undefined && tabIds.item !== undefined) {
		R.nativeSimulateKeystrokes(tabIds.items, "right");
		await h.settle(400);
		check("tabs: Right on the focused items tab activates item and focuses its tab", active() === "item" && R.getFocusedElementId() === tabIds.item, `${stacksText()}, focused ${R.getFocusedElementId()}`);
		R.nativeSimulateKeystrokes(tabIds.item, "left");
		await h.settle(400);
		check("tabs: Left on the focused item tab activates items and focuses its tab", active() === "items" && R.getFocusedElementId() === tabIds.items, `${stacksText()}, focused ${R.getFocusedElementId()}`);
		closeMenus();
		R.nativeSimulateKeystrokes(tabIds.items, "shift-f10");
		await h.settle(400);
		check("tabs: Shift+F10 on the focused tab opens the pane menu", overlayLayers().some((l) => l.kind === "menu"), `${overlayLayers().length} overlay layer(s)`);
		closeMenus();
		await h.settle(300);
	}
	if (active() !== "items") await clickTab("items", "items");
	const f = out.replace(/\.png$/, "-tabs.png");
	await shotClean(f);
}

/** --focus: F6 / Shift+F6 through the registered app actions, reading order left, items, item. */
async function runFocus() {
	console.log("== --focus");
	await resetStandard();
	const focusEl = (id: number) => R.focusElement(id);
	/** Which pane holds focus: the focused element is the pane's host (or the test-id node), below it, or just above it. */
	const where = (): string | null => {
		const f = R.getFocusedElementId();
		if (f == null) return null;
		const ids = Object.fromEntries(Object.entries(ROOTS).map(([k, tid]) => [k, elOf(tid)?.id]));
		const inside = Object.keys(ids).filter((k) => ids[k] !== undefined && contains(ids[k]!, f));
		if (inside.length) return inside[0]!;
		const above = Object.keys(ids).filter((k) => ids[k] !== undefined && contains(f, ids[k]!));
		return above.length === 1 ? above[0]! : null;
	};
	const focusedText = () => {
		const f = R.getFocusedElementId();
		const e = f == null ? undefined : R.getElement(f);
		return `${f} (${e?.type ?? "?"}${e?.testId ? ` ${e.testId}` : ""}) in pane ${where()}`;
	};
	const act = async (id: string): Promise<boolean> => {
		const a = appActions().find((x) => x.id === id);
		if (!check(`focus: app action ${id} registered`, !!a)) return false;
		a!.run();
		await h.settle(300);
		return true;
	};

	const items = elOf("pane-items");
	if (!check("focus: pane-items found", !!items)) return;
	R.flush();
	focusEl(items!.id);
	await h.settle(200);
	if (!check("focus: focusElement(pane-items) focuses the items pane", where() === "items", focusedText())) return;
	if (!(await act("pane-next"))) return;
	check("focus: pane-next from items -> item", where() === "item", focusedText());
	await act("pane-next");
	check("focus: pane-next from item -> sidebar (column-left)", where() === "left", focusedText());
	await act("pane-previous");
	check("focus: pane-previous from sidebar -> item", where() === "item", focusedText());
	await shotClean(out.replace(/\.png$/, "-focus.png"));

	// a focused descendant is remembered per pane: leave the pane with F6 and come back with Shift+F6
	const focusableKind = (e: El): number => {
		const tab = e.customProps?.["tabIndex"] ?? e.style?.["tabIndex"];
		if (typeof tab === "number" && tab >= 0) return 0;
		return e.events.has("keyDown") || e.events.has("focus") ? 1 : 2;
	};
	for (const [key, expectNext] of [
		["items", "item"],
		["item", "left"],
	] as const) {
		const root = elOf(ROOTS[key]);
		if (!root) continue;
		const cands = subtree(root.id, 14)
			.filter((e) => e.id !== root.id && focusableKind(e) < 2)
			.sort((a, b) => focusableKind(a) - focusableKind(b))
			.slice(0, 12);
		let d: El | undefined;
		for (const c of cands) {
			R.flush();
			focusEl(c.id);
			await h.settle(150);
			if (R.getFocusedElementId() === c.id) {
				d = c;
				break;
			}
		}
		if (!d) {
			console.log(`SKIP focus: ${ROOTS[key]} has no descendant that takes focus (tabIndex / keyDown / focus listener) among ${cands.length} candidates`);
			continue;
		}
		const how = focusableKind(d) === 0 ? "tabIndex" : "key/focus listener";
		check(`focus: descendant ${d.id} (${d.type}, ${how}) of ${ROOTS[key]} focused`, where() === key, focusedText());
		await act("pane-next");
		check(`focus: pane-next from that descendant -> ${expectNext}`, where() === expectNext, focusedText());
		await act("pane-previous");
		check(`focus: pane-previous returns to the remembered descendant ${d.id}`, R.getFocusedElementId() === d.id, focusedText());
	}

	// focus on a header tab counts as focus in its pane: F6 leaves it for the next pane, Shift+F6 returns to the exact tab
	const headTab = elOf("pane-tab-items");
	if (!check("focus: header tab pane-tab-items found", !!headTab)) return;
	R.flush();
	focusEl(headTab!.id);
	await h.settle(200);
	if (!check("focus: focusElement(pane-tab-items) focuses the header tab", R.getFocusedElementId() === headTab!.id, focusedText())) return;
	await act("pane-next");
	check("focus: pane-next from the items header tab -> item pane", where() === "item", focusedText());
	await act("pane-previous");
	check(`focus: pane-previous restores the exact items header tab ${headTab!.id}`, R.getFocusedElementId() === headTab!.id, focusedText());
}

if (flag(args, "--move")) await runMove();
if (flag(args, "--tabs")) await runTabs();
if (flag(args, "--focus")) await runFocus();

await sleep(800); // the ui-state.json write is debounced
const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
console.log("saved shell.* keys:", JSON.stringify(Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith("shell.")))));
h.t.unmount();
if (failed) console.log(`${failed} check(s) FAILED`);
process.exit(failed ? 1 : 0);
