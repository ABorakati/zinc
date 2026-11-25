import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createTestRoot, hasNativeTestRenderer } from "@gpuix/solid/testing";
import { openMenu, OverlayHost } from "./index";
import { closeMenus, overlayLayers } from "./core";

const findText = (
	r: {
		findByText(s: string): { id: number } | undefined | null;
		getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null;
	},
	label: string,
) => {
	const el = r.findByText(label);
	return el ? r.getElementBounds(el.id) : null;
};

describe.skipIf(!hasNativeTestRenderer)("MenuLayerView", () => {
	let unmount: (() => void) | undefined;

	afterEach(() => {
		closeMenus();
		unmount?.();
		unmount = undefined;
	});

	test("closes immediately on left or right mouseDown outside without leaking clicks behind", () => {
		const t = createTestRoot({ width: 800, height: 600 });
		unmount = () => t.unmount();
		const r = t.renderer;
		let behindClicks = 0;

		t.render(() => (
			<div style={{ width: "100%", height: "100%" }}>
				<div
					onClick={() => {
						behindClicks++;
					}}
					style={{ width: 120, height: 80 }}
				>
					<text>Behind</text>
				</div>
				<OverlayHost />
			</div>
		));

		t.flushSync(() => {
			openMenu({ x: 240, y: 200 }, [{ label: "First action" }, { label: "Second action" }]);
		});
		expect(overlayLayers().length).toBe(1);
		expect(findText(r, "First action")).not.toBeNull();

		// Left mouseDown outside hides the menu panel on press while absorbing the paired mouseUp so the button behind does not fire
		r.nativeSimulateMouseDown(40, 40, 0);
		r.flush();
		expect(findText(r, "First action")).toBeNull();
		expect(behindClicks).toBe(0);
		r.nativeSimulateMouseUp(40, 40, 0);
		r.flush();
		expect(overlayLayers().length).toBe(0);
		expect(behindClicks).toBe(0);

		// Right mouseDown outside also hides on press and removes the layer on release
		t.flushSync(() => {
			openMenu({ x: 240, y: 200 }, [{ label: "First action" }]);
		});
		expect(overlayLayers().length).toBe(1);
		expect(findText(r, "First action")).not.toBeNull();
		r.nativeSimulateMouseDown(40, 40, 2);
		r.flush();
		expect(findText(r, "First action")).toBeNull();
		r.nativeSimulateMouseUp(40, 40, 2);
		r.flush();
		expect(overlayLayers().length).toBe(0);
	});

	test("clicking an item invokes onSelect and closes; lazy submenus evaluate only when opened", () => {
		const t = createTestRoot({ width: 800, height: 600 });
		unmount = () => t.unmount();
		const r = t.renderer;
		let picked = 0;
		let subEvaluated = 0;

		t.render(() => (
			<div style={{ width: "100%", height: "100%" }}>
				<OverlayHost />
			</div>
		));

		t.flushSync(() => {
			openMenu({ x: 100, y: 100 }, [
				{
					label: "Run me",
					onSelect: () => {
						picked++;
					},
				},
				{
					label: "More",
					submenu: () => {
						subEvaluated++;
						return [{ label: "Sub item" }];
					},
				},
			]);
		});
		expect(subEvaluated).toBe(0);

		const more = findText(r, "More");
		expect(more).not.toBeNull();
		r.nativeSimulateMouseMove(more!.x + more!.width / 2, more!.y + more!.height / 2);
		r.flush();
		expect(subEvaluated).toBe(1);
		expect(findText(r, "Sub item")).not.toBeNull();

		const run = findText(r, "Run me")!;
		r.nativeSimulateClick(run.x + run.width / 2, run.y + run.height / 2, 0);
		r.flush();
		expect(picked).toBe(1);
		expect(overlayLayers().length).toBe(0);
	});

	test("updates reactively when the items signal changes while open", () => {
		const t = createTestRoot({ width: 800, height: 600 });
		unmount = () => t.unmount();
		const r = t.renderer;
		const [extra, setExtra] = createSignal(false);

		t.render(() => (
			<div style={{ width: "100%", height: "100%" }}>
				<OverlayHost />
			</div>
		));

		t.flushSync(() => {
			openMenu({ x: 120, y: 120 }, () => (extra() ? [{ label: "Open" }, { label: "Loaded item" }] : [{ label: "Open" }]));
		});
		expect(findText(r, "Open")).not.toBeNull();
		expect(findText(r, "Loaded item")).toBeNull();

		t.flushSync(() => {
			setExtra(true);
		});
		expect(findText(r, "Loaded item")).not.toBeNull();
	});
});
