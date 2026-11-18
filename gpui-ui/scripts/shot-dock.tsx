// Headless check of phase 2 pane docking (src/shell/dock.tsx) in the whole <App/>, with screenshots:
//   ZN_URL=<core> ZN_SHOTS=<dir> bun scripts/shot-dock.tsx
// Needs a core on a library COPY (ZN_URL), as shot-app.tsx. Prints PASS / FAIL lines, the console error / warning counts, and
// exits 1 on a failure. Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts). Writes <ZN_SHOTS>/shell-dock-*.png.
//
// TEST HARNESS SUBSTITUTES FOR THE PANE HEADERS. The branch's Frame has neither pane headers / tabs nor a mounted <DockOverlay/>, so
// <Harness/> mounts <App/> next to <DockOverlay/> and one anchored, test-only drag header ("dock-test-source") whose handlers are
// paneDragSource(...) (a signal picks the dragged pane id, "item" / "items" / "section:tags"), plus a small anchored "dock-test-gap"
// box registered as a section-gap host. Drop hosts are the painted pane elements the Frame already draws ("pane-items", "pane-item"),
// fetched through renderer.findByTestId and wrapped as HostElement ({ id, mounted } is all boundsOf reads), registered with the stack
// resolved through locatePane / libraryLayout() right before each drag. Nothing here depends on the stacks / sections agents' files.
//
// Scenarios: a click without a drag; item -> bottom quarter of "items" (two centre stacks, empty right; preview + after shots, Undo
// toast); item -> middle of "items" (tab); item -> empty-right strip (registered with a painted host); Escape cancel; release over no
// target; unregistered hosts leave no zone; section:tags detached into a stack, then returned through a section-gap host.
import assert from "node:assert/strict";
import { createSignal, For, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { paneDragSource } from "../src/shell/dock";
import { SHOTS, boot, sleep } from "./shell-shot-lib";

// ---- the harness: App + DockOverlay + a test drag header + a test section gap
interface Mods {
	App: () => JSX.Element;
	DockOverlay: () => JSX.Element;
	paneDragSource: typeof paneDragSource;
}
const [mods, setMods] = createSignal<Mods | null>(null);
const [srcPane, setSrcPane] = createSignal("item");
// bumped by reset(): <App/> (and so the base Frame) is mounted fresh for every scenario, DockOverlay and the header stay put
const [epoch, setEpoch] = createSignal(1);
let srcWasDrag!: () => boolean;

const HEADER = { x: 600, y: 842, w: 200, h: 32 };
const GAP = { x: 1100, y: 300, w: 140, h: 28 };

function Mounted(p: { m: Mods }): JSX.Element {
	const { App, DockOverlay } = p.m;
	const { wasDrag, ...handlers } = p.m.paneDragSource(srcPane);
	srcWasDrag = wasDrag;
	const box = { display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6 } as const;
	return (
		<div style={{ width: "100%", height: "100%" }}>
			<For each={[epoch()]}>{() => <App />}</For>
			<DockOverlay />
			<anchored position={{ x: HEADER.x, y: HEADER.y }} anchor="topLeft" fit="snap" priority={500} style={{ backgroundColor: "rgba(0, 0, 0, 0)" }}>
				<div testId="dock-test-source" {...handlers} style={{ ...box, width: HEADER.w, height: HEADER.h, backgroundColor: "#7c3aed", cursor: "grab" }}>
					<text style={{ color: "#ffffff", fontSize: 13 }}>{`drag: ${srcPane()}`}</text>
				</div>
			</anchored>
			<anchored position={{ x: GAP.x, y: GAP.y }} anchor="topLeft" fit="snap" priority={500} style={{ backgroundColor: "rgba(0, 0, 0, 0)" }}>
				<div testId="dock-test-gap" style={{ ...box, width: GAP.w, height: GAP.h, backgroundColor: "#0d9488" }}>
					<text style={{ color: "#ffffff", fontSize: 12 }}>section gap</text>
				</div>
			</anchored>
		</div>
	);
}
const Harness = (): JSX.Element => <Show when={mods()}>{(m) => <Mounted m={m()} />}</Show>;

// ---- console counts (dock work must log no error)
let errors = 0;
let warnings = 0;
const { error: logError, warn: logWarn } = console;
console.error = (...a: unknown[]) => { errors++; logError(...a); };
console.warn = (...a: unknown[]) => { warnings++; logWarn(...a); };

const h = await boot({ prefs: { mode: "dark" }, view: () => <Harness /> });
const r = h.t.renderer;
const [{ App }, dock, layout, fl, panes, shortcuts, overlay, sections] = await Promise.all([
	import("../src/App"),
	import("../src/shell/dock"),
	import("../src/shell/layout"),
	import("../src/shell/frameLayout"),
	import("../src/shell/panes"),
	import("../src/shell/shortcuts"),
	import("../src/ui/overlay"),
	import("../src/shell/sectionPanes"),
]);
layout.setLibraryLayout(fl.standardLibrary());
setMods({ App, DockOverlay: dock.DockOverlay, paneDragSource: dock.paneDragSource });
for (let i = 0; i < 100 && h.store.total() === 0; i++) await sleep(100);
await h.settle(800);
errors = 0;
warnings = 0;

const win = r.getWindowSize();
const snap = () => JSON.stringify(layout.libraryLayout());
let base = snap();

// ---- helpers
const present = (testId: string) => !!r.findByTestId(testId);
const bounds = (testId: string) => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	if (!b || !(b.width > 0) || !(b.height > 0)) throw new Error(`no painted bounds for ${testId}`);
	return b;
};
const near = (a: number, b: number, what: string, tol = 3) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const rectNear = (testId: string, want: { x: number; y: number; width: number; height: number }, what: string) => {
	const b = bounds(testId);
	near(b.x, want.x, `${what} x`);
	near(b.y, want.y, `${what} y`);
	near(b.width, want.width, `${what} width`);
	near(b.height, want.height, `${what} height`);
};
const tick = async (ms = 30) => {
	r.flush();
	r.dispatchNativeEvents();
	await sleep(ms);
};

/** A painted element as a HostElement: boundsOf (shell/dock.tsx) reads only `mounted` and `id`. null when it has no painted size. */
const shim = (testId: string): HostElement | null => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	return el && b && b.width > 0 && b.height > 0 ? ({ id: el.id, mounted: true } as unknown as HostElement) : null;
};

let unregs: (() => void)[] = [];
const clearHosts = () => {
	for (const u of unregs) u();
	unregs = [];
};
/** Register the hosts one drag needs, resolving each stack through locatePane against the layout as it is now. Returns how many. */
function register(o: { stacks?: boolean; emptyRight?: boolean; gap?: boolean } = {}): number {
	clearHosts();
	if (o.stacks !== false) {
		const l = layout.libraryLayout();
		for (const column of ["centre", "right"] as const)
			l[column].stacks.forEach((s, index) => {
				const first = s.panes[0]!;
				const el = shim(`pane-${s.active}`) ?? shim(`stack-${first}`);
				if (!el) return; // ghost / not painted: no host
				unregs.push(
					dock.registerDropHost(() => {
						const at = fl.locatePane(layout.libraryLayout(), first);
						return { kind: "stack", column: at?.column ?? column, stack: at?.stack ?? index };
					}, el),
				);
			});
	}
	if (o.emptyRight) {
		const el = shim("column-centre"); // any painted, window-visible element
		assert.ok(el, "column-centre is painted");
		unregs.push(dock.registerDropHost(() => ({ kind: "empty-right" }), el));
	}
	if (o.gap) {
		const el = shim("dock-test-gap");
		assert.ok(el, "the test gap is painted");
		unregs.push(dock.registerDropHost(() => ({ kind: "section-gap", before: null }), el));
	}
	return unregs.length;
}

let cur = { x: 0, y: 0 };
/** Press the test header for `id`, then move 3 px (no drag yet) and 9 px (the drag starts while still inside the header). */
async function startDrag(id: string) {
	setSrcPane(id);
	await h.settle(150);
	const b = bounds("dock-test-source");
	cur = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	r.nativeSimulateMouseDown(cur.x, cur.y, 0);
	await tick();
	r.nativeSimulateMouseMove(cur.x + 3, cur.y, 0);
	await tick();
	assert.equal(dock.paneDragging(), null, "3 px of travel must not start a drag");
	r.nativeSimulateMouseMove(cur.x + 9, cur.y, 0);
	cur = { x: cur.x + 9, y: cur.y };
	await h.settle(250); // mounts the capture layer
	assert.equal(dock.paneDragging(), id, "the header did not start the pane drag");
	assert.ok(present("dock-capture"), "capture layer exists mid-drag");
	assert.ok(present("dock-ghost"), "ghost exists mid-drag");
}
async function moveTo(x: number, y: number, steps = 8) {
	const from = cur;
	for (let i = 1; i <= steps; i++) {
		r.nativeSimulateMouseMove(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps, 0);
		await tick(20);
	}
	cur = { x, y };
	await h.settle(200);
}
const release = async () => {
	r.nativeSimulateMouseUp(cur.x, cur.y, 0);
	await h.settle(300);
};
const escape = async () => {
	shortcuts.handleWindowKeyDown({ key: "escape", modifiers: { ctrl: false, shift: false, alt: false, meta: false }, defaultPrevented: false, preventDefault() { } } as never);
	await h.settle(250);
};
const clickUndo = async () => {
	assert.ok(present("dock-test-source"), "harness still mounted");
	await h.clickText("Undo");
};
const gone = () => {
	assert.equal(dock.paneDragging(), null, "paneDragging cleared");
	assert.ok(!present("dock-capture"), "capture layer removed");
	assert.ok(!present("dock-ghost"), "ghost removed");
	assert.ok(!present("dock-preview"), "preview removed");
};
const stacksOf = (c: "centre" | "right") => layout.libraryLayout()[c].stacks.map((s) => s.panes);
const centreOf = (testId: string) => {
	const b = bounds(testId);
	return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
};

async function reset() {
	if (dock.paneDragging()) await escape();
	clearHosts();
	overlay.toast.dismiss();
	while (layout.undoLayout()) { /* drain the undo history */ }
	layout.setLibraryLayout(fl.standardLibrary());
	setEpoch((n) => n + 1); // a fresh <App/>: the base Frame does not survive stack moves (see the bottom-quarter step)
	await h.settle(1000);
	bounds("pane-items");
	bounds("pane-item");
	base = snap();
}
let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
	try {
		await reset();
		await fn();
		console.log(`PASS ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}  (${e instanceof Error ? e.message : String(e)})`);
		const file = `${SHOTS}/shell-dock-fail-${name.replace(/\W+/g, "-")}.png`;
		r.captureScreenshot(file);
		console.log("wrote", file);
	}
}

// ---- 0. the starting point
await step("standard layout: items centre, item right, both painted", async () => {
	assert.deepEqual(fl.locatePane(layout.libraryLayout(), "items"), { column: "centre", stack: 0, index: 0 });
	assert.deepEqual(fl.locatePane(layout.libraryLayout(), "item"), { column: "right", stack: 0, index: 0 });
	assert.ok(panes.paneDef("items") && panes.paneDef("item"), "panes registered");
	assert.equal(register(), 2, "two stack hosts registered");
	bounds("pane-items");
	bounds("pane-item");
});

// ---- 1. a press that never reaches the drag threshold
await step("a short press is not a drag", async () => {
	register();
	setSrcPane("item");
	await h.settle(150);
	const b = bounds("dock-test-source");
	const x = b.x + b.width / 2;
	const y = b.y + b.height / 2;
	r.nativeSimulateMouseDown(x, y, 0);
	await tick();
	r.nativeSimulateMouseMove(x + 2, y, 0);
	await tick();
	r.nativeSimulateMouseUp(x + 2, y, 0);
	await h.settle(300);
	gone();
	assert.equal(srcWasDrag(), false, "wasDrag stays false after a click");
	assert.equal(snap(), base, "layout unchanged");
});

// ---- 2. item -> bottom quarter of items: [items] / [item] in the centre, the right column empty
await step("item onto the bottom quarter of items", async () => {
	assert.equal(register(), 2);
	const items = centreOf("pane-items");
	await startDrag("item");
	await moveTo(items.x, items.b.y + items.b.height * 0.9);
	assert.ok(present("dock-preview"), "preview exists over the target");
	rectNear("dock-preview", { x: items.b.x, y: items.b.y + items.b.height * 0.75, width: items.b.width, height: items.b.height / 4 }, "preview is the bottom quarter");
	assert.ok(present("dock-capture") && present("dock-ghost"), "capture and ghost still exist");
	await h.shot("dock-preview");
	await release();
	gone();
	assert.deepEqual(stacksOf("centre"), [["items"], ["item"]], "two centre stacks");
	assert.deepEqual(stacksOf("right"), [], "right column empty");
	assert.deepEqual(fl.locatePane(layout.libraryLayout(), "item"), { column: "centre", stack: 1, index: 0 });
	assert.ok(r.findByText("Moved Item"), "toast says Moved Item");
	assert.equal(srcWasDrag(), true, "wasDrag reports the drag once");
	assert.equal(srcWasDrag(), false, "wasDrag is consumed");
	assert.ok(layout.canUndoLayout(), "move is undoable");
	await h.shot("dock-after");
	// KNOWN LIMITATION OF THE BASE FRAME (not asserted): it moves a pane between stacks by destroying and re-creating it, so the
	// moved content may be missing from the "dock-after" shot and pane-items / pane-item may lose their painted bounds. This script
	// proves the dock (zones, preview, drop, layout, toast Undo), not the stacks integration; every step starts on a fresh <App/>.
	console.log("  NOTE base Frame remount limitation: layout asserted, painted result after the move not asserted (see dock-after shot)");
	await clickUndo();
	await h.settle(400);
	assert.equal(snap(), base, "the Undo toast action restores the original layout");
	assert.ok(!r.findByText("Moved Item"), "toast dismissed");
});

// ---- 3. item -> middle of items: one centre stack with two tabs
await step("item onto the middle of items (tab)", async () => {
	register();
	const items = centreOf("pane-items");
	await startDrag("item");
	await moveTo(items.x, items.y);
	assert.ok(present("dock-preview"), "preview exists over the middle");
	rectNear("dock-preview", { x: items.b.x, y: items.b.y + items.b.height * 0.25, width: items.b.width, height: items.b.height / 2 }, "preview is the middle half");
	await release();
	gone();
	assert.deepEqual(stacksOf("centre"), [["items", "item"]], "one centre stack with two tabs");
	assert.equal(layout.libraryLayout().centre.stacks[0]!.active, "item", "the dropped pane is active");
	assert.deepEqual(stacksOf("right"), [], "right column empty");
	await h.shot("dock-tab-after");
	await clickUndo();
	await h.settle(400);
	assert.equal(snap(), base, "Undo restores the original layout");
});

// ---- 4. item -> the empty right strip, registered with a painted, window-visible host
await step("item onto the empty right strip", async () => {
	assert.ok(layout.moveLibraryPane("item", { kind: "split", column: "centre", at: 1 }), "prelude: item below items");
	await h.settle(500);
	assert.deepEqual(stacksOf("right"), [], "prelude: right column empty");
	const prelude = snap();
	register({ emptyRight: true });
	await startDrag("item");
	await moveTo(win.width - 24, win.height / 2);
	assert.ok(present("dock-empty-right"), "the empty-right strip is shown mid-drag");
	assert.ok(present("dock-preview"), "preview over the strip");
	rectNear("dock-preview", { x: win.width - 48, y: 0, width: 48, height: win.height }, "preview is the 48 px strip");
	await h.shot("dock-empty-right");
	await release();
	gone();
	assert.deepEqual(stacksOf("right"), [["item"]], "item back in the right column");
	assert.deepEqual(stacksOf("centre"), [["items"]], "items alone in the centre");
	await clickUndo();
	await h.settle(400);
	assert.equal(snap(), prelude, "the toast Undo restores the layout before the drop");
	assert.ok(layout.undoLayout(), "history has the prelude move");
	assert.equal(snap(), base, "undoing the prelude restores the original");
});

// ---- 5. Escape cancels a drag
await step("Escape cancels the drag", async () => {
	register();
	const items = centreOf("pane-items");
	await startDrag("item");
	await moveTo(items.x, items.b.y + items.b.height * 0.9);
	assert.ok(present("dock-preview"), "preview exists before Escape");
	await escape();
	gone();
	assert.equal(snap(), base, "layout unchanged");
	// releasing afterwards must not drop anything
	r.nativeSimulateMouseUp(items.x, items.b.y + items.b.height * 0.9, 0);
	await h.settle(300);
	gone();
	assert.equal(snap(), base, "layout unchanged after the release");
	assert.ok(!r.findByText("Moved Item"), "no toast");
	assert.ok(!layout.canUndoLayout(), "nothing to undo");
});

// ---- 6. release over no target
await step("release over no drop target", async () => {
	register();
	await startDrag("item");
	await moveTo(40, win.height / 2); // the sidebar: no registered host
	assert.ok(present("dock-capture") && present("dock-ghost"), "capture and ghost exist over no target");
	assert.ok(!present("dock-preview"), "no preview over no target");
	await release();
	gone();
	assert.equal(snap(), base, "layout unchanged");
	assert.ok(!r.findByText("Moved Item"), "no toast");
	assert.ok(!layout.canUndoLayout(), "nothing to undo");
});

// ---- 7. unregistered hosts leave no zones
await step("unregister helper removes the zones", async () => {
	register();
	clearHosts(); // every stack host unregistered
	const off = dock.registerDropHost(() => ({ kind: "empty-right" }), shim("column-centre")!);
	off();
	const items = centreOf("pane-items");
	await startDrag("item");
	await moveTo(items.x, items.y);
	assert.ok(!present("dock-preview"), "no preview over a stack that was unregistered");
	await moveTo(win.width - 24, win.height / 2);
	assert.ok(!present("dock-empty-right") && !present("dock-preview"), "no strip for an unregistered empty-right host");
	await release();
	gone();
	assert.equal(snap(), base, "layout unchanged");
	assert.ok(!layout.canUndoLayout(), "nothing to undo");
});

// ---- 8. a section pane: detach into a stack, then return through a section gap
await step("section:tags detaches into a stack and returns to a gap", async () => {
	assert.ok(fl.sectionIdOf("section:tags") === "tags");
	assert.equal(fl.locatePane(layout.libraryLayout(), "section:tags"), null, "tags is in the item pane");
	register({ gap: true });
	const gap = centreOf("dock-test-gap");
	const item = centreOf("pane-item");
	await startDrag("section:tags");
	await moveTo(gap.x, gap.y);
	// The gap overlaps the item stack. An attached section can tab there, but cannot return through the gap.
	rectNear("dock-preview", { x: item.b.x, y: item.b.y + item.b.height / 4, width: item.b.width, height: item.b.height / 2 }, "attached section uses the underlying stack, not the gap");
	await moveTo(item.x, item.b.y + item.b.height * 0.9);
	assert.ok(present("dock-preview"), "preview over the item pane's bottom quarter");
	rectNear("dock-preview", { x: item.b.x, y: item.b.y + item.b.height * 0.75, width: item.b.width, height: item.b.height / 4 }, "detach preview");
	await release();
	gone();
	assert.deepEqual(stacksOf("right"), [["item"], ["section:tags"]], "tags is a stack below the item pane");
	assert.ok(sections.isDetached("tags"), "isDetached(tags)");
	assert.deepEqual(stacksOf("centre"), [["items"]], "centre unchanged");
	await h.shot("dock-section-detached");
	const detached = snap();

	register({ gap: true }); // locatePane resolves the stacks again
	await startDrag("section:tags");
	await moveTo(gap.x, gap.y);
	assert.ok(present("dock-preview"), "preview over the section gap");
	rectNear("dock-preview", { x: gap.b.x, y: gap.b.y, width: gap.b.width, height: gap.b.height }, "gap preview");
	await h.shot("dock-section-gap");
	await release();
	gone();
	assert.equal(fl.locatePane(layout.libraryLayout(), "section:tags"), null, "tags left the layout");
	assert.ok(!sections.isDetached("tags"), "isDetached(tags) is false again");
	assert.equal(snap(), base, "the layout is the original again");
	await clickUndo();
	await h.settle(400);
	assert.equal(snap(), detached, "Undo puts tags back in its stack");
	assert.ok(layout.undoLayout(), "history has the detach");
	assert.equal(snap(), base, "undoing the detach restores the original");
});

// ---- done
clearHosts();
console.log(`console errors during the run: ${errors}, warnings: ${warnings}`);
if (errors > 0) {
	failed++;
	console.log("FAIL console.error was called during the run");
}
console.log(failed ? `${failed} step(s) FAILED` : "all steps PASSED");
h.t.unmount();
process.exit(failed ? 1 : 0);
