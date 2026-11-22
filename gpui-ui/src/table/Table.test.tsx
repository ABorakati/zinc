// bun test src/table/Table.test.tsx -- the real Classic table (TableView) rendered without a window over a stubbed store: the header's
// resize / reorder gestures and the cells of the rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as TableMod from "./Table";
import type * as LayoutMod from "./layout";
import type * as StoreMod from "../store";
import type { ItemRow } from "../contracts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function findAll(node: HostElement | undefined, pred: (n: HostElement) => boolean, out: HostElement[] = []): HostElement[] {
	if (!node) return out;
	if (pred(node)) out.push(node);
	for (const c of node.children) if (c.kind === "element") findAll(c, pred, out);
	return out;
}
const styleOf = (n: HostElement) => (n.style ?? {}) as unknown as Record<string, unknown>;

describe("table", () => {
	let Table: typeof TableMod;
	let layout: typeof LayoutMod.columnLayout;
	let store: StoreMod.AppStore;
	let saved: Record<string, unknown> = {};
	let envBefore: string | undefined;
	let realFetch: typeof fetch;
	const items: ItemRow[] = [0, 1, 2].map((i) => ({
		key: `ITEM000${i}`,
		itemType: "journalArticle",
		title: `Title ${i}`,
		fields: { language: i === 1 ? "ar" : "en" },
	})) as ItemRow[];
	let roots: (() => void)[] = [];

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch;
		store = (await import("../store")).store;
		layout = (await import("./layout")).columnLayout;
		const s = store as unknown as Record<string, unknown>;
		for (const k of ["total", "itemAt", "peek", "setListFields"]) saved[k] = s[k];
		s.total = () => items.length;
		s.itemAt = (i: number) => items[i];
		s.peek = (i: number) => items[i];
		s.setListFields = () => {};
		Table = await import("./Table");
	});
	afterAll(() => {
		Object.assign(store as unknown as Record<string, unknown>, saved);
		globalThis.fetch = realFetch;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	function mount() {
		let root!: HostElement;
		roots.push(
			createRoot((d) => {
				root = (<div>
						<Table.TableView />
					</div>) as unknown as HostElement;
				return d;
			}),
		);
		return {
			root: () => root,
			handles: () => findAll(root, (n) => styleOf(n).cursor === "col-resize"),
			overlay: () => findAll(root, (n) => n.type === "anchored")[0],
			headerCells: () => findAll(root, (n) => typeof styleOf(n).width === "number" && n.props.has("onMouseMove") && n.props.has("onClick")),
		};
	}

	/** deliver an event, then let the reactive updates it caused settle */
	const fire = async (n: HostElement, name: string, e: Record<string, unknown>) => {
		(n.props.get(name) as (e: unknown) => void)(e);
		await sleep(2);
	};
	const widthOf = (id: string) => layout.widthOf(id);
	const closeAll = () => {
		for (const f of roots.splice(0)) f();
	};

	test("a resize drag follows the pointer, and ends when the button was released outside the window", async () => {
		const m = mount();
		await sleep(20);
		const handle = findAll(m.root(), (n) => n.type === "div" && styleOf(n).cursor === "col-resize")[1]!; // the second column's edge
		const id = layout.ids()[1]!;
		const w0 = widthOf(id);
		await fire(handle, "onMouseDown", { button: 0, x: 200 });
		expect(m.overlay()).toBeDefined();
		await fire(m.overlay()!, "onMouseMove", { x: 230, pressedButton: 0 });
		expect(widthOf(id)).toBe(w0 + 30);
		await fire(m.overlay()!, "onMouseMove", { x: 260, pressedButton: undefined }); // released outside the window
		expect(m.overlay()).toBeUndefined();
		expect(widthOf(id)).toBe(w0 + 30);
		closeAll();
	});

	test("a column drag is cancelled, not dropped, when the button was released outside the window", async () => {
		const m = mount();
		await sleep(20);
		const before = layout.ids().join();
		const cell = m.headerCells()[1]!;
		await fire(cell, "onMouseDown", { button: 0, x: 200 });
		await fire(cell, "onMouseMove", { x: 5000, pressedButton: 0 });
		expect(m.overlay()).toBeDefined();
		await fire(m.overlay()!, "onMouseMove", { x: 5000, pressedButton: undefined });
		expect(m.overlay()).toBeUndefined();
		expect(layout.ids().join()).toBe(before);
		closeAll();
	});

	test("a column drag released inside the window still moves the column", async () => {
		const m = mount();
		await sleep(20);
		const ids = [...layout.ids()];
		const cell = m.headerCells()[1]!;
		await fire(cell, "onMouseDown", { button: 0, x: 200 });
		await fire(cell, "onMouseMove", { x: 5000, pressedButton: 0 }); // far right: the last slot
		await fire(m.overlay()!, "onMouseMove", { x: 5000, pressedButton: 0 });
		await fire(m.overlay()!, "onMouseUp", {});
		expect(m.overlay()).toBeUndefined();
		expect(layout.ids()).toEqual([ids[0]!, ...ids.slice(2), ids[1]!]);
		layout.move(ids[1]!, 1);
		closeAll();
	});
});
