import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as DndMod from "../dnd";
import type * as DockMod from "./dock";
import type * as LayoutMod from "./layout";
import type * as LayoutEditMod from "./layoutEdit";
import type * as PaneChromeMod from "./paneChrome";
import type * as PanesMod from "./panes";
import type * as PaneStackMod from "./PaneStack";
import type * as StoreMod from "../store";
import type * as UiCoreMod from "../ui/core";
import { standardLibrary, type Stack, type ViewLayout } from "./frameLayout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findByTestId(node: HostElement | undefined, id: string): HostElement | null {
	if (!node) return null;
	if (node.props.get("testId") === id) return node;
	for (const child of node.children) {
		if (child.kind !== "element") continue;
		const hit = findByTestId(child, id);
		if (hit) return hit;
	}
	return null;
}

function fire(el: HostElement | null | undefined, prop: string, payload?: Record<string, unknown>): void {
	const fn = el?.props.get(prop) as ((e?: Record<string, unknown>) => void) | undefined;
	fn?.(payload ?? {});
}

describe("pane hover header lifecycle", () => {
	let envBefore: string | undefined;
	let PaneStack: typeof PaneStackMod.PaneStack;
	let HOVER_REVEAL_DELAY_MS: number;
	let HOVER_HIDE_DELAY_MS: number;
	let dnd: typeof DndMod;
	let dock: typeof DockMod;
	let layoutMod: typeof LayoutMod;
	let layoutEdit: typeof LayoutEditMod;
	let paneChrome: typeof PaneChromeMod;
	let panes: typeof PanesMod;
	let store: typeof StoreMod.store;
	let uiCore: typeof UiCoreMod;
	let cleanups: (() => void)[] = [];

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		// dynamic imports so ZN_UI_STATE=off takes effect before store.ts / prefs.ts initialize
		const stackMod = await import("./PaneStack");
		PaneStack = stackMod.PaneStack;
		HOVER_REVEAL_DELAY_MS = stackMod.HOVER_REVEAL_DELAY_MS;
		HOVER_HIDE_DELAY_MS = stackMod.HOVER_HIDE_DELAY_MS;
		dnd = await import("../dnd");
		dock = await import("./dock");
		layoutMod = await import("./layout");
		layoutEdit = await import("./layoutEdit");
		paneChrome = await import("./paneChrome");
		panes = await import("./panes");
		store = (await import("../store")).store;
		uiCore = await import("../ui/core");

		if (!panes.paneDef("items")) {
			panes.registerPane({
				id: "items",
				title: () => "My Library",
				icon: "library",
				views: ["library"],
				required: true,
				minSize: { w: 320, h: 160 },
				render: () => null,
			});
		}
		if (!panes.paneDef("item")) {
			panes.registerPane({
				id: "item",
				title: () => "Item details",
				icon: "info",
				views: ["library"],
				minSize: { w: 200, h: 160 },
				render: () => null,
			});
		}
	});

	afterEach(() => {
		for (const fn of cleanups.splice(0)) fn();
		dnd.endDrag();
		layoutEdit.editLayout(false);
		paneChrome.clearMaximise();
		dock.clearPanePress();
		layoutMod.setLibraryLayout(standardLibrary());
		while (layoutMod.undoLayout());
		store.setActiveTab("library");
		for (const layer of [...uiCore.overlayLayers()]) uiCore.removeLayer(layer.id);
	});

	afterAll(() => {
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	function mountStack(initialPane: "items" | "item" = "items") {
		let rootEl!: HostElement;
		let contentEl!: HostElement;
		const [layout, setLayout] = createSignal<ViewLayout>(standardLibrary());
		const column = initialPane === "items" ? "centre" : "right";
		const [stack, setStack] = createSignal<Stack | undefined>(layout()[column].stacks[0]);
		const registered = () => new Set(["items", "item"]);
		const dispose = createRoot((d) => {
			rootEl = (
				<PaneStack
					column={column}
					index={() => 0}
					stack={stack}
					layout={layout}
					registered={registered}
					contentRef={(el) => {
						contentEl = el;
					}}
				/>
			) as unknown as HostElement;
			return d;
		});
		cleanups.push(dispose);
		const revealHeader = async () => {
			const strip = findByTestId(rootEl, `pane-hotstrip-${initialPane}`);
			expect(strip).not.toBeNull();
			fire(strip, "onMouseEnter");
			await sleep(HOVER_REVEAL_DELAY_MS + 40);
			const header = findByTestId(rootEl, `pane-hover-header-${initialPane}`);
			expect(header).not.toBeNull();
			return { strip: strip!, header: header! };
		};
		return {
			get root() {
				return rootEl;
			},
			get content() {
				return contentEl;
			},
			layout,
			setLayout,
			stack,
			setStack,
			revealHeader,
		};
	}

	test("hover header is unmounted by default and hotstrip is a narrow centred pill", () => {
		const m = mountStack("items");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		const strip = findByTestId(m.root, "pane-hotstrip-items");
		expect(strip).not.toBeNull();
		expect(strip!.style.pointerEvents).toBe("auto");
		expect(typeof strip!.style.width).toBe("number");
		expect(strip!.style.width as number).toBeGreaterThanOrEqual(80);
		expect(strip!.style.width as number).toBeLessThanOrEqual(100);
		expect(strip!.style.height).toBe(8);
		// outer centering wrapper must not intercept pointer events across the toolbar
		const wrapper = strip!.parent;
		expect(wrapper && wrapper.kind === "element" ? wrapper.style.pointerEvents : undefined).toBe("none");
		expect(wrapper && wrapper.kind === "element" ? wrapper.style.justifyContent : undefined).toBe("center");
	});

	test("brushing past the hotstrip before the hover-intent delay never mounts the header", async () => {
		const m = mountStack("items");
		const strip = findByTestId(m.root, "pane-hotstrip-items")!;
		fire(strip, "onMouseEnter");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		await sleep(Math.max(10, Math.floor(HOVER_REVEAL_DELAY_MS / 3)));
		fire(strip, "onMouseLeave");
		await sleep(HOVER_REVEAL_DELAY_MS + 50);
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("pausing on the hotstrip mounts the header, keeps it while hovered, and unmounts it after leaving", async () => {
		const m = mountStack("items");
		const { strip, header } = await m.revealHeader();
		expect(findByTestId(m.root, "pane-hover-drag-items")).not.toBeNull();
		// even if GPUIX delivers header enter before hotstrip leave, the header stays open while hovered
		fire(header, "onMouseEnter");
		fire(strip, "onMouseLeave");
		await sleep(HOVER_HIDE_DELAY_MS + 50);
		expect(findByTestId(m.root, "pane-hover-header-items")).not.toBeNull();
		// leaving the header unmounts it after the hide delay
		fire(header, "onMouseLeave");
		await sleep(HOVER_HIDE_DELAY_MS + 50);
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("dismisses immediately on stack root mouseLeave, content mouseDown, or mouseDownOutside", async () => {
		const m = mountStack("items");

		await m.revealHeader();
		fire(m.root, "onMouseLeave");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();

		await m.revealHeader();
		fire(m.content, "onMouseDown");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();

		const { header } = await m.revealHeader();
		fire(header, "onMouseDownOutside");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("dismisses immediately when opening the pane menu and stays closed while an overlay is open", async () => {
		const m = mountStack("items");
		await m.revealHeader();
		const menuBtn = findByTestId(m.root, "pane-hover-menu-items");
		expect(menuBtn).not.toBeNull();
		fire(menuBtn, "onClick");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		expect(uiCore.overlayLayers().length).toBeGreaterThan(0);

		// while the menu overlay is open, hovering the hotstrip must not mount the header behind it
		const strip = findByTestId(m.root, "pane-hotstrip-items")!;
		fire(strip, "onMouseEnter");
		await sleep(HOVER_REVEAL_DELAY_MS + 40);
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("dismisses immediately on maximise button click and double-click on drag area", async () => {
		const m = mountStack("item");
		await m.revealHeader();
		fire(findByTestId(m.root, "pane-hover-max-item"), "onClick");
		expect(paneChrome.maximised()).toBe("item");
		expect(findByTestId(m.root, "pane-hover-header-item")).toBeNull();

		paneChrome.clearMaximise();
		await m.revealHeader();
		fire(findByTestId(m.root, "pane-hover-drag-item"), "onClick", { clickCount: 2 });
		expect(paneChrome.maximised()).toBe("item");
		expect(findByTestId(m.root, "pane-hover-header-item")).toBeNull();
	});

	test("dismisses immediately on activeTab change, layout edit mode, or multi-tab stack", async () => {
		const m = mountStack("items");

		await m.revealHeader();
		store.setActiveTab("settings");
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		store.setActiveTab("library");

		await m.revealHeader();
		layoutEdit.editLayout(true);
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		expect(findByTestId(m.root, "pane-hotstrip-items")).toBeNull();
		layoutEdit.editLayout(false);

		await m.revealHeader();
		m.setStack({ panes: ["items", "item"], active: "items" });
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
		expect(findByTestId(m.root, "pane-hotstrip-items")).toBeNull();
	});

	test("panePressed cannot stick the hover header open when mouseUp is missed", async () => {
		const m = mountStack("items");
		await m.revealHeader();
		const drag = findByTestId(m.root, "pane-hover-drag-items")!;

		// press down, then simulate pointer moving without button 0 held (lost mouseUp outside window)
		fire(drag, "onMouseDown", { x: 10, y: 10, button: 0 });
		expect(dock.panePressed()).toBe("items");
		fire(drag, "onMouseMove", { x: 12, y: 10, pressedButton: undefined });
		expect(dock.panePressed()).toBeNull();

		// press down, then click inside pane content: both pressed state and hover header clear immediately
		fire(drag, "onMouseDown", { x: 10, y: 10, button: 0 });
		expect(dock.panePressed()).toBe("items");
		fire(m.content, "onMouseDown");
		expect(dock.panePressed()).toBeNull();
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();

		// press down, then leave the stack root: both pressed state and hover header clear immediately
		await m.revealHeader();
		const drag2 = findByTestId(m.root, "pane-hover-drag-items")!;
		fire(drag2, "onMouseDown", { x: 10, y: 10, button: 0 });
		expect(dock.panePressed()).toBe("items");
		fire(m.root, "onMouseLeave");
		expect(dock.panePressed()).toBeNull();
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("ending a pane drag unmounts the hover header immediately without needing mouseLeave", async () => {
		const m = mountStack("items");
		await m.revealHeader();
		dnd.startDrag({ kind: "pane", id: "items" });
		// held while dragging
		expect(findByTestId(m.root, "pane-hover-header-items")).not.toBeNull();
		// once the drag ends, revealed was already cleared so the header unmounts right away
		dnd.endDrag();
		expect(findByTestId(m.root, "pane-hover-header-items")).toBeNull();
	});

	test("right-click on drag bar, minimise, and hide all dismiss the hover header immediately", async () => {
		const m = mountStack("item");

		await m.revealHeader();
		fire(findByTestId(m.root, "pane-hover-drag-item"), "onAuxClick", { isRightClick: true, x: 50, y: 10 });
		expect(findByTestId(m.root, "pane-hover-header-item")).toBeNull();
		for (const layer of [...uiCore.overlayLayers()]) uiCore.removeLayer(layer.id);

		await m.revealHeader();
		fire(findByTestId(m.root, "pane-hover-min-item"), "onClick");
		expect(findByTestId(m.root, "pane-hover-header-item")).toBeNull();
		paneChrome.restorePane("item");

		await m.revealHeader();
		fire(findByTestId(m.root, "pane-hover-close-item"), "onClick");
		expect(findByTestId(m.root, "pane-hover-header-item")).toBeNull();
	});
});
