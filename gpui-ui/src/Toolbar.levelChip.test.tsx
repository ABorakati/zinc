// bun test src/Toolbar.levelChip.test.tsx -- the sort bar's level chip (Toolbar.tsx) is one piece of UI shown in two places (a plain
// label while the level is locked by grouping, a menu trigger otherwise). Rendered through the real GPUIX root onto a fake native
// renderer that mirrors its element tree, the tree the renderer is told about must stay equal to the one the app built while the
// grouping is switched back and forth.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "@gpuix/solid";
import { createSignal } from "solid-js";
import type { HostElement, HostRoot } from "@gpuix/solid";
import type * as ToolbarMod from "./Toolbar";
import type * as StoreMod from "./store";
import type { GroupBy, SortLevel } from "./contracts";

/** A native renderer that keeps the tree it is told about. */
function mirrorRenderer() {
	const live = new Set<number>();
	const kids = new Map<number, number[]>();
	const parentOf = new Map<number, number>();
	let rootId = 0;
	const problems: string[] = [];
	const detach = (id: number) => {
		const p = parentOf.get(id);
		if (p !== undefined) {
			kids.set(p, (kids.get(p) ?? []).filter((k) => k !== id));
			parentOf.delete(id);
		}
	};
	const destroy = (id: number) => {
		for (const c of kids.get(id) ?? []) destroy(c);
		kids.delete(id);
		live.delete(id);
		parentOf.delete(id);
	};
	const renderer = {
		applyBatch(raw: string): number[] {
			const destroyed: number[] = [];
			for (const op of JSON.parse(raw) as unknown[][]) {
				const kind = op[0];
				if (kind === "createElement") {
					if (live.has(op[1] as number)) problems.push(`created twice: ${op[1]}`);
					live.add(op[1] as number);
				} else if (kind === "setRoot") rootId = op[1] as number;
				else if (kind === "appendChild" || kind === "insertBefore") {
					const parent = op[1] as number;
					const child = op[2] as number;
					if (!live.has(child)) problems.push(`attached a destroyed element: ${child}`);
					if (parentOf.has(child)) problems.push(`attached while still attached elsewhere: ${child}`);
					detach(child);
					const list = kids.get(parent) ?? [];
					const at = kind === "insertBefore" ? list.indexOf(op[3] as number) : -1;
					if (at >= 0) list.splice(at, 0, child);
					else list.push(child);
					kids.set(parent, list);
					parentOf.set(child, parent);
				} else if (kind === "destroyElement") {
					const id = op[1] as number;
					detach(id);
					destroy(id);
					destroyed.push(id);
				}
			}
			return destroyed;
		},
		setWindowKeyEvents() {},
		setWindowSelectionChange() {},
	};
	return { renderer, live, kids, problems, root: () => rootId };
}

describe("sort bar level chip", () => {
	let Toolbar: typeof ToolbarMod;
	let store: StoreMod.AppStore;
	let saved: Record<string, unknown> = {};
	let envBefore: string | undefined;
	let realFetch: typeof fetch;
	const [groupBy, setGroupBy] = createSignal<GroupBy>("none");
	const levels: SortLevel[] = [
		{ key: "year", dir: "desc" },
		{ key: "title", dir: "asc" },
	];

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch;
		store = (await import("./store")).store;
		const s = store as unknown as Record<string, unknown>;
		for (const k of ["groupBy", "sortLevels"]) saved[k] = s[k];
		s.groupBy = groupBy;
		s.sortLevels = () => levels;
		Toolbar = await import("./Toolbar");
	});
	afterAll(() => {
		Object.assign(store as unknown as Record<string, unknown>, saved);
		globalThis.fetch = realFetch;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	/** The element ids of the app's tree, in order. */
	const hostIds = (n: HostElement | HostRoot): number[] => (n.kind === "root" ? [] : [n.id]).concat(...n.children.map((c) => (c.kind === "element" ? hostIds(c) : [c.id])));
	const mirrorIds = (m: ReturnType<typeof mirrorRenderer>, id: number): number[] => [id, ...(m.kids.get(id) ?? []).flatMap((c) => mirrorIds(m, c))];

	test("switching grouping on and off keeps the renderer's tree equal to the app's", async () => {
		setGroupBy("none");
		const m = mirrorRenderer();
		const root = createRoot(m.renderer as never);
		let host!: HostElement;
		root.render(() => {
			host = (<Toolbar.SortBar />) as unknown as HostElement;
			return host;
		});
		root.flush();
		for (const g of ["year", "none", "year", "none", "year"] as const) {
			setGroupBy(g);
			root.flush();
			await new Promise((r) => setTimeout(r, 2));
			root.flush();
			expect(m.problems).toEqual([]);
			expect(mirrorIds(m, m.root())).toEqual(hostIds(host));
			for (const id of hostIds(host)) expect(m.live.has(id)).toBe(true);
		}
		root.unmount();
	});
});
