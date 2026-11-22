// bun test src/sidebar/itemDrop.test.tsx -- the real Collections rows: items dropped on a row are added to that collection, but a
// drag that was cancelled or handed to the OS (the pointer left the window) must not be a drop on the row it last crossed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as CollMod from "./Collections";
import type * as ClientMod from "./client";
import type * as DndMod from "../dnd";
import type * as CoreMod from "../ui/core";

function findAll(node: HostElement | undefined, pred: (n: HostElement) => boolean, out: HostElement[] = []): HostElement[] {
	if (!node) return out;
	if (pred(node)) out.push(node);
	for (const c of node.children) if (c.kind === "element") findAll(c, pred, out);
	return out;
}

describe("item drops on collection rows", () => {
	let coll: typeof CollMod;
	let client: typeof ClientMod;
	let dnd: typeof DndMod;
	let core: typeof CoreMod;
	let added: { key: string; items: string[] }[] = [];
	let saved: { add: unknown; collections: unknown; refresh: unknown };
	let realFetch: typeof fetch;
	let dispose = () => {};
	let envBefore: string | undefined;
	const rowBounds = { x: 0, y: 100, width: 200, height: 30 };
	let storeRef: { refresh: unknown };

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch;
		client = await import("./client");
		dnd = await import("../dnd");
		core = await import("../ui/core");
		storeRef = (await import("../store")).store as unknown as { refresh: unknown };
		saved = { add: client.sidebarApi.addToCollection, collections: client.sidebarApi.collections, refresh: storeRef.refresh };
		(client.sidebarApi as { addToCollection: unknown }).addToCollection = async (key: string, items: string[]) => void added.push({ key, items });
		(client.sidebarApi as { collections: unknown }).collections = async () => [
			{ key: "COLLAAAA", name: "Reading", parentKey: null, itemCount: 0, children: [] },
		];
		storeRef.refresh = () => {};
		coll = await import("./Collections");
		await coll.reloadCollections(); // the tree the rows are built from
		const entries = coll.collectionEntries(0);
		const root = createRoot((d) => {
			dispose = d;
			return (<div>{entries.map((e) => e.render())}</div>) as unknown as HostElement;
		});
		const row = findAll(root, (n) => n.props.get("role") === "treeitem")[0];
		expect(row).toBeDefined();
		core.setNative({ getElementBounds: (id) => (id === row!.id ? rowBounds : null) });
		(row as { mounted: boolean }).mounted = true;
	});
	afterAll(() => {
		dispose();
		core.setNative(undefined);
		(client.sidebarApi as { addToCollection: unknown }).addToCollection = saved.add;
		(client.sidebarApi as { collections: unknown }).collections = saved.collections;
		storeRef.refresh = saved.refresh;
		globalThis.fetch = realFetch;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	const drag = (end: () => void) => {
		added = [];
		dnd.startDrag({ kind: "items", keys: ["ITEM0001"] });
		dnd.moveDrag(50, 110); // over the row
		end();
	};

	test("a drop on a row adds the items to its collection", async () => {
		drag(() => dnd.endDrag());
		await new Promise((r) => setTimeout(r, 10));
		expect(added).toEqual([{ key: "COLLAAAA", items: ["ITEM0001"] }]);
	});

	test("a cancelled drag adds nothing", async () => {
		drag(() => dnd.cancelDrag());
		await new Promise((r) => setTimeout(r, 10));
		expect(added).toEqual([]);
	});

	test("a drag handed to the OS adds nothing", async () => {
		drag(() => dnd.endDrag("handed-off"));
		await new Promise((r) => setTimeout(r, 10));
		expect(added).toEqual([]);
	});

	test("the source's release outside the window cancels", async () => {
		added = [];
		const src = dnd.dragSource(() => ["ITEM0001"]);
		src.onMouseDown({ x: 50, y: 110, button: 0 });
		src.onMouseMove({ x: 70, y: 110, pressedButton: 0 });
		expect(dnd.dragging()).not.toBeNull();
		src.onMouseMove({ x: 50, y: 110, pressedButton: undefined });
		await new Promise((r) => setTimeout(r, 10));
		expect(dnd.dragging()).toBeNull();
		expect(dnd.dragOutcome()).toBe("cancelled");
		expect(added).toEqual([]);
	});

	test("a release over the source inside the window is a drop", async () => {
		added = [];
		const src = dnd.dragSource(() => ["ITEM0001"]);
		src.onMouseDown({ x: 50, y: 110, button: 0 });
		src.onMouseMove({ x: 70, y: 110, pressedButton: 0 });
		src.onMouseMove({ x: 60, y: 112, pressedButton: 0 });
		src.onMouseUp();
		await new Promise((r) => setTimeout(r, 10));
		expect(dnd.dragOutcome()).toBe("dropped");
		expect(added).toEqual([{ key: "COLLAAAA", items: ["ITEM0001"] }]);
	});
});
