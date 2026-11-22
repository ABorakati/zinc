// bun test src/table/Table.test.tsx -- the real Classic table (TableView) rendered without a window over a stubbed store: the header's
// resize / reorder gestures and the cells of the rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
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
	const [rev, bump] = createSignal(0, { equals: false });

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
		s.itemAt = (i: number) => (rev(), items[i]);
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
			headerCells: () => findAll(root, (n) => typeof styleOf(n).width === "number" && styleOf(n).height === "100%" && n.props.has("onMouseMove") && n.props.has("onClick")),
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

	// ---- the cells survive a resize / reorder / column change: the same elements, updated in place ----

	/** The cells of every body row, and the header's cells, as they are now. */
	const snapshot = (m: ReturnType<typeof mount>) => {
		const list = findAll(m.root(), (n) => n.type === "virtual-list")[0]!;
		const rows = list.children.filter((c): c is HostElement => c.kind === "element" && c.children.length > 1);
		return {
			rows: rows.map((r) => r.children.filter((c): c is HostElement => c.kind === "element")),
			header: m.headerCells().slice(),
		};
	};
	const textOf = (n: HostElement): string => n.children.map((c) => (c.kind === "text" ? c.text : textOf(c as HostElement))).join("");
	const sameCells = (a: HostElement[][], b: HostElement[][]) => a.length === b.length && a.every((r, i) => r.length === b[i]!.length && r.every((c, j) => c === b[i]![j]));
	/** How many of the cells `before` held are not in `after` (a cell that is gone was disposed and built again). */
	const lost = (before: HostElement[][], after: HostElement[][]) => before.flat().filter((e) => !after.flat().includes(e)).length;

	test("resizing a column recreates no cell, and the new width reaches the header and every row", async () => {
		const m = mount();
		await sleep(20);
		const before = snapshot(m);
		expect(before.rows.length).toBe(items.length);
		const id = layout.ids()[1]!;
		const w0 = widthOf(id);
		for (let step = 1; step <= 10; step++) {
			layout.setWidth(id, w0 + step * 3);
			await sleep(1);
		}
		const after = snapshot(m);
		expect(lost(before.rows, after.rows)).toBe(0);
		expect(sameCells(before.rows, after.rows)).toBe(true);
		expect(after.header).toEqual(before.header);
		expect(styleOf(after.header[1]!).width).toBe(w0 + 30);
		for (const row of after.rows) {
			expect(styleOf(row[1]!).width).toBe(w0 + 30);
			expect(styleOf(row[0]!).width).toBe(widthOf(layout.ids()[0]!)); // the others keep theirs
			expect(styleOf(row[2]!).width).toBe(widthOf(layout.ids()[2]!));
		}
		layout.setWidth(id, w0);
		closeAll();
	});

	test("moving a column moves its cells and header, with the same elements", async () => {
		const m = mount();
		await sleep(20);
		const before = snapshot(m);
		const ids = [...layout.ids()];
		layout.move(ids[1]!, ids.length - 1); // to the end
		await sleep(5);
		const after = snapshot(m);
		const perm = [0, 2, 3, 4, 5, 1].slice(0, ids.length);
		expect(after.rows.map((r, i) => r.map((c) => before.rows[i]!.indexOf(c)))).toEqual(after.rows.map(() => perm));
		expect(after.header.map((c) => before.header.indexOf(c))).toEqual(perm);
		expect(styleOf(after.rows[0]![ids.length - 1]!).width).toBe(widthOf(ids[1]!));
		layout.move(ids[1]!, 1);
		closeAll();
	});

	test("hiding and showing a column removes and adds only its cells, with the right definition", async () => {
		const m = mount();
		await sleep(20);
		const before = snapshot(m);
		const ids = [...layout.ids()];
		layout.toggle(ids[2]!, false);
		await sleep(5);
		const hidden = snapshot(m);
		const without = before.rows.map((r) => r.filter((_, j) => j !== 2));
		expect(sameCells(hidden.rows, without)).toBe(true);
		expect(hidden.header).toEqual(before.header.filter((_, j) => j !== 2));
		layout.toggle(ids[2]!, true); // comes back at the end
		await sleep(5);
		const shown = snapshot(m);
		expect(shown.header.length).toBe(before.header.length);
		expect(shown.rows.map((r) => r.slice(0, -1))).toEqual(hidden.rows);
		const added = shown.rows[0]![shown.rows[0]!.length - 1]!;
		expect(textOf(added)).toBe(textOf(before.rows[0]![2]!)); // the same column's text
		expect(textOf(shown.header[shown.header.length - 1]!)).toBe(textOf(before.header[2]!)); // and its label
		expect(styleOf(added).width).toBe(widthOf(ids[2]!));
		layout.move(ids[2]!, 2);
		closeAll();
	});

	test("a cell's text direction follows its item, in the same element", async () => {
		const m = mount();
		await sleep(20);
		const dirs = (cell: HostElement) => findAll(cell, (n) => n.type === "text").map((t) => t.props.get("dir"));
		const before = snapshot(m);
		expect(dirs(before.rows[0]![0]!)).toContain("ltr"); // an English item
		expect(dirs(before.rows[1]![0]!)).toContain("rtl"); // an Arabic-language item
		const orig = items[0]!;
		items[0] = { ...orig, fields: { language: "ar" } } as ItemRow; // the item arrives with its language changed
		bump();
		await sleep(5);
		const after = snapshot(m);
		expect(after.rows[0]![0]).toBe(before.rows[0]![0]);
		expect(dirs(after.rows[0]![0]!)).toContain("rtl");
		items[0] = orig;
		closeAll();
	});
});
