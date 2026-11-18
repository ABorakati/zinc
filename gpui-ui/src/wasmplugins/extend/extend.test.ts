// Tests of the extend area that need no window: the handler (registrations, conflicts, permissions, navigation through a fake host),
// conditions, the batch cache ("no per-row calls"), menu resolution, and an end-to-end run with the QuickJS fixture plugin through the
// real supervisor (registrations arrive, a column is fetched in ONE call, a menu command and a toolbar click reach the plugin, the
// registrations go when the plugin stops). The window side (that things are drawn and clickable) is gpui-ui/scripts/shot-wasm-extend.tsx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildPlugin } from "../../../../plugin-host/scripts/build-plugin";
import { defineHandler, type HandlerContext } from "../../../../plugin-host/src/imports/registry";
import { BatchCache } from "./cache";
import { conditionHolds, type CondCtx } from "./conditions";
import { cacheStats, cellText, columnCell, dropDataCaches } from "./data";
import { extendHandler } from "./handler";
import { resolveEntries, resolveTarget, runMenuCommand } from "./menus";
import { bindExtendHostImpl, type ExtendHost } from "./navigation";
import { clearPluginRegistrations, menuPatches, registries } from "./registry";
import type { Context, MenuEntry } from "./wit";

const fns = extendHandler.functions as Record<string, (ctx: HandlerContext, ...a: any[]) => any>;
const plain = (s: string) => ({ tag: "plain" as const, val: s });
const fakeCtx = (pluginId: string, caps: string[] = []): HandlerContext =>
	({
		pluginId,
		has: (p: string) => caps.includes(p),
		require(p: string) {
			if (!caps.includes(p)) throw Object.assign(new Error(`permission-denied: ${p}`), { payload: { tag: "permission-denied", val: p } });
		},
	}) as unknown as HandlerContext;

const x = (over: Partial<CondCtx> = {}): CondCtx => ({ tab: { id: "library", kind: "library" }, itemCount: 1, itemTypes: ["journalArticle"], rowKinds: ["library"], editable: true, ...over });

describe("conditions", () => {
	test("every set field must hold", () => {
		expect(conditionHolds(undefined, x())).toBe(true);
		expect(conditionHolds({ minItems: 2 }, x())).toBe(false);
		expect(conditionHolds({ minItems: 1, maxItems: 1, itemTypes: ["journalArticle", "book"] }, x())).toBe(true);
		expect(conditionHolds({ itemTypes: ["book"] }, x())).toBe(false);
		expect(conditionHolds({ tabKinds: ["reader/*"] }, x())).toBe(false);
		expect(conditionHolds({ tabKinds: ["reader/pdf"] }, x({ tab: { id: "a", kind: "reader", subtype: "pdf" } }))).toBe(true);
		expect(conditionHolds({ tabKinds: ["reader/epub"] }, x({ tab: { id: "a", kind: "reader", subtype: "pdf" } }))).toBe(false);
		expect(conditionHolds({ requireEditable: true }, x({ editable: false }))).toBe(false);
		expect(conditionHolds({ rowKinds: ["collection"] }, x())).toBe(false);
	});
});

describe("batch cache", () => {
	test("one call for many rows, cached, invalidated per key", async () => {
		const sizes: string[][] = [];
		const c = new BatchCache<string>({ delayMs: 5, fetch: async (keys) => (sizes.push(keys), keys.map((k) => k.toUpperCase())) });
		for (let i = 0; i < 50; i++) c.get(`k${i}`);
		await new Promise((r) => setTimeout(r, 40));
		expect(sizes.length).toBe(1);
		expect(sizes[0]!.length).toBe(50);
		expect(c.peek("k7")).toBe("K7");
		for (let i = 0; i < 50; i++) c.get(`k${i}`); // all cached: no call
		await new Promise((r) => setTimeout(r, 20));
		expect(sizes.length).toBe(1);
		c.invalidate(["k1", "k2"]);
		await new Promise((r) => setTimeout(r, 40));
		expect(sizes.length).toBe(2);
		expect(sizes[1]).toEqual(["k1", "k2"]);
	});
	test("a failing call keeps the last good value and retries later", async () => {
		let fail = false;
		const c = new BatchCache<string>({ delayMs: 2, retryMs: 10, fetch: async (k) => (fail ? Promise.reject(new Error("x")) : k.map(() => "v")) });
		c.get("a");
		await new Promise((r) => setTimeout(r, 20));
		fail = true;
		c.invalidate(["a"]);
		await new Promise((r) => setTimeout(r, 20));
		expect(c.peek("a")).toBe("v");
	});
	test("batches are at most 200 keys", async () => {
		const sizes: number[] = [];
		const c = new BatchCache<number>({ delayMs: 2, fetch: async (k) => (sizes.push(k.length), k.map(() => 1)) });
		for (let i = 0; i < 450; i++) c.get(`k${i}`);
		await new Promise((r) => setTimeout(r, 30));
		expect(sizes).toEqual([200, 200, 50]);
	});
});

describe("extend handler", () => {
	const P = "t@zinc.test";
	test("registrations are namespaced by plugin, a duplicate is a conflict", () => {
		clearPluginRegistrations();
		const reg = { menuId: "m", target: "library-item", entries: [{ id: "e", kind: "item", label: plain("E"), hooks: {} }] };
		fns["register-menu"]!(fakeCtx(P), reg);
		fns["register-menu"]!(fakeCtx("other@zinc.test"), reg); // same id, other plugin: fine
		expect(() => fns["register-menu"]!(fakeCtx(P), reg)).toThrow(/already registered/);
		expect(registries.menus.list().map((m) => m.plugin)).toEqual([P, "other@zinc.test"]);
		fns.unregister!(fakeCtx(P), "menu", "m");
		expect(registries.menus.list().length).toBe(1);
		expect(() => fns.unregister!(fakeCtx(P), "menu", "m")).toThrow(/not-found/);
		clearPluginRegistrations();
	});
	test("a menu entry with an unknown parent is refused", () => {
		const bad = { menuId: "m", target: "library-item", entries: [{ id: "e", parent: "nope", kind: "item", hooks: {} }] };
		expect(() => fns["register-menu"]!(fakeCtx(P), bad)).toThrow(/unknown parent/);
	});
	test("permissions: open-tab needs ui.windows, select-items ui.navigate, get-context library.read", async () => {
		expect(() => fns["open-tab"]!(fakeCtx(P), { tabId: "t", kind: "mine", title: plain("T"), select: false, pinned: false, closable: true })).toThrow(/permission-denied/);
		expect(() => fns["register-drop-target"]!(fakeCtx(P), { dropId: "d" })).toThrow(/permission-denied/);
		expect(() => fns["get-context"]!(fakeCtx(P), undefined)).toThrow(/permission-denied/);
		await expect(Promise.resolve().then(() => fns["select-items"]!(fakeCtx(P), ["A"], {}))).rejects.toThrow(/permission-denied/);
	});
	test("tabs: built-in kinds are refused; open, rename, close", () => {
		clearPluginRegistrations();
		const caps = ["ui.windows"];
		const spec = { tabId: "t", kind: "mine", title: plain("T"), select: false, pinned: false, closable: true };
		expect(() => fns["open-tab"]!(fakeCtx(P, caps), { ...spec, kind: "reader" })).toThrow(/built-in/);
		fns["open-tab"]!(fakeCtx(P, caps), spec);
		fns["rename-tab"]!(fakeCtx(P, caps), "t", plain("New"));
		expect(registries.tabs.list()[0]!.reg.title).toEqual(plain("New"));
		fns["close-tab"]!(fakeCtx(P, caps), "t");
		expect(registries.tabs.list().length).toBe(0);
	});
	test("navigation goes through the bound host; without one it is unavailable", async () => {
		const calls: string[] = [];
		const host = {
			getContext: () => ({ window: 1, tab: { id: "library", kind: "library" }, rows: [], items: ["A"], itemCount: 1, itemsTruncated: false, editable: true }) as Context,
			listSelected: () => ["A"],
			selectItems: async (keys: string[]) => (calls.push(`select ${keys.join(",")}`), keys.length),
			setSearch: (t: string) => void calls.push(`search ${t}`),
			builtinTabs: () => [],
			activeTabId: () => "library",
		} as unknown as ExtendHost;
		bindExtendHostImpl(undefined);
		expect(() => fns["get-context"]!(fakeCtx(P, ["library.read"]), undefined)).toThrow(/unavailable/);
		bindExtendHostImpl(host);
		expect(fns["get-context"]!(fakeCtx(P, ["library.read"]), undefined).items).toEqual(["A"]);
		expect(await fns["select-items"]!(fakeCtx(P, ["ui.navigate"]), ["A", "B"], {})).toBe(2);
		fns["set-search"]!(fakeCtx(P, ["ui.navigate"]), "smith");
		expect(calls).toEqual(["select A,B", "search smith"]);
		bindExtendHostImpl(undefined);
	});
	test("all-or-none register-columns", () => {
		clearPluginRegistrations();
		const col = (k: string) => ({ dataKey: k, label: plain(k), sort: "text", align: "start" });
		fns["register-column"]!(fakeCtx(P), col("a"));
		expect(() => fns["register-columns"]!(fakeCtx(P), [col("b"), col("a")])).toThrow(/already registered/);
		expect(registries.columns.list().map((c) => c.id)).toEqual(["a"]);
		clearPluginRegistrations();
	});
});

describe("menu resolution", () => {
	const P = "m@zinc.test";
	const entries: MenuEntry[] = [
		{ id: "a", kind: "item", label: plain("A"), hooks: {} },
		{ id: "sep", kind: "separator", hooks: {} },
		{ id: "sub", kind: "submenu", label: plain("Sub"), hooks: {} },
		{ id: "c", parent: "sub", kind: "item", label: plain("C"), hooks: {}, visibleWhen: { minItems: 2 } },
		{ id: "d", parent: "sub", kind: "item", label: plain("D"), hooks: {}, enabledWhen: { minItems: 2 } },
	];
	test("children, conditions, patches", () => {
		clearPluginRegistrations();
		fns["register-menu"]!(fakeCtx(P), { menuId: "m", target: "library-item", entries });
		const list = resolveTarget("library-item", x());
		expect(list.map((e) => e.id)).toEqual(["a", "sep", "sub"]);
		expect(list[2]!.children.map((c) => [c.id, c.disabled])).toEqual([["d", true]]); // c is hidden (needs 2 items), d disabled
		fns["patch-menu"]!(fakeCtx(P), "m", [{ id: "a", disabled: true, label: plain("A2") }, { id: "sub", hidden: true }]);
		const patched = resolveEntries(P, "m", entries, x());
		expect(patched.map((e) => [e.id, e.label, e.disabled])).toEqual([["a", "A2", true]]);
		expect(menuPatches.get(P, "m")?.size).toBe(2);
		clearPluginRegistrations();
	});
});

// ---- the real plugin --------------------------------------------------------------------------------------------------------

describe("fixture plugin through the supervisor", () => {
	// ZN_EXTEND_FIXTURE=<folder>: use a fixture that is already built (skips the componentize step, about 12 s)
	const out = process.env.ZN_EXTEND_FIXTURE ?? join(process.env.TEMP ?? "/tmp", "zn-wasm-extend-fixture-test");
	const lines: string[] = [];
	let sup: Awaited<ReturnType<typeof import("../index").startWasmPlugins>>;
	let stop: () => Promise<void>;
	const ID = "extend-fixture@zinc.test";

	beforeAll(async () => {
		if (!process.env.ZN_EXTEND_FIXTURE) await buildPlugin({ dir: join(import.meta.dir, "../../../test/wasm-extend-fixture"), out, world: "ext" });
		const mod = await import("../index");
		const log = defineHandler({
			interface: "zinc:plugin/log",
			where: "zinc",
			functions: { write: (ctx: HandlerContext, _l: string, m: string) => void lines.push(m) },
		});
		sup = await mod.startWasmPlugins({ force: true, bindUi: false, dirs: [out], handlers: [log, extendHandler], supervisor: { callTimeoutMs: 8000 } });
		stop = mod.stopWasmPlugins;
	}, 120_000);
	afterAll(async () => {
		await stop?.();
		dropDataCaches();
	});

	test("startup registered everything", () => {
		expect(sup).toBeDefined();
		expect(lines.some((l) => l.startsWith("startup extend-fixture@zinc.test"))).toBe(true);
		for (const k of ["menus", "sections", "infoRows", "columns", "rowStyles", "toolbarButtons", "shortcuts", "prefPanes"] as const)
			expect(registries[k].list().length).toBeGreaterThan(0);
		expect(registries.menus.list().map((m) => m.reg.target).sort()).toEqual(["library-item", "menubar-tools"]);
	});

	test("a column asks the plugin ONCE for a screenful of rows", async () => {
		const keys = Array.from({ length: 40 }, (_, i) => `ITEM${String(i).padStart(4, "0")}`);
		for (const k of keys) columnCell(ID, "len", k); // 40 rows drawn
		await new Promise((r) => setTimeout(r, 400));
		const stats = cacheStats("column", ID, "len")!;
		expect(stats.calls).toBe(1);
		expect(stats.sizes).toEqual([40]);
		expect(lines.filter((l) => l.startsWith("column-values len n=40")).length).toBe(1);
		expect(cellText(columnCell(ID, "len", "ITEM0003"))).toBe("len 8");
	});

	test("a menu command and a toolbar click reach the plugin", async () => {
		const ctx = { window: 1, tab: { id: "library", kind: "library" }, rows: [], items: ["A", "B"], itemCount: 2, itemsTruncated: false, editable: true } as Context;
		await runMenuCommand({ plugin: ID, menuId: "m1", id: "hello", checked: undefined }, ctx);
		expect(lines).toContain("menu-command m1/hello items=2 tab=library");
		await sup!.call(ID, "extend-handlers", "on-toolbar-click", ["tb1", undefined, ctx]);
		expect(lines).toContain("toolbar-click tb1 tab=library");
	});

	test("the info row value comes from the plugin", async () => {
		const v = await sup!.call(ID, "extend-handlers", "on-info-row-get", ["row1", "ABCD2345", { id: "library", kind: "library" }, true]);
		expect((v as { value: string }).value).toBe("row row1 of ABCD2345");
	});

	test("registrations are cleared when the plugin stops", async () => {
		await stop();
		for (const r of Object.values(registries)) expect(r.list().length).toBe(0);
	});
});
