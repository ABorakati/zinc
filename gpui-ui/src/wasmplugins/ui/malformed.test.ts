// Malformed plugin UI data must never throw into the app or leave an unhandled rejection (shell/errorlog.ts ends the process on one).
// Real controller, fake plugin; a fixed corpus and fast-check runs over mutated valid trees and patches.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createRoot } from "solid-js";
import { ViewController, lookupInstance } from "./controller";
import { jsonToPatch, jsonToTree, normalizeTree, parseBatchStyles, resolveBatchRows, setValidationMode, TreeError, type ValidationMode } from "./convert";
import { openDialogNow, push, refresh, updateDialog, UiHostError, type HostCtx } from "./host";
import { ControllerView } from "./ControllerView";
import type { RenderResult } from "./types";
import golden from "./test/golden.json";
import { ctxOf, fakeSup, recordRun, snapTree, validPatches, validTree } from "./test/uiFixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(120); // longer than the push (33 ms) and row-range (60 ms) timers

const escaped: unknown[] = [];
const onEscape = (e: unknown) => escaped.push(e);
beforeAll(() => {
	process.on("unhandledRejection", onEscape);
	process.on("uncaughtException", onEscape);
});
afterAll(() => {
	process.off("unhandledRejection", onEscape);
	process.off("uncaughtException", onEscape);
});

const T = (node: unknown) => ({ root: node });
const table = (rows: unknown) => T({ type: "table", columns: [{ key: "a" }], rows });
const deepMenu = (n: number) => {
	let m: Record<string, unknown> = { id: "leaf", label: "x" };
	for (let i = 0; i < n; i++) m = { id: "m" + i, label: "x", children: [m] };
	return m;
};

/** JSON trees that are not valid against the schema. Every one must come out as a TreeError, never a TypeError or RangeError. */
const badTrees: Record<string, unknown> = {
	"rows [null]": table([null]),
	"list-view rows [null]": T({ type: "list-view", rows: [null] }),
	"cells [null]": table([{ id: "a", cells: [null] }]),
	"cells not a list": table([{ id: "a", cells: 5 }]),
	"row without id": table([{ cells: [] }]),
	"children [null]": T({ type: "box", children: [null] }),
	"children number": T({ type: "box", children: 5 }),
	"children string": T({ type: "box", children: "abc" }),
	"children object": T({ type: "box", children: {} }),
	"context menu items [null]": T({ type: "box", contextMenu: { items: [null] } }),
	"context menu items string": T({ type: "box", contextMenu: { items: "x" } }),
	"menu children [null]": T({ type: "box", contextMenu: { items: [{ id: "a", label: "A", children: [null] }] } }),
	"menu nested 100000 deep": T({ type: "box", contextMenu: { items: [deepMenu(100000)] } }),
	"tabs [null]": T({ type: "tabs", tabs: [null] }),
	"options [null]": T({ type: "select", options: [null] }),
	"tokens [null]": T({ type: "token-input", tokens: [null] }),
	"columns [null]": T({ type: "table", columns: [null], rows: [] }),
	"section buttons [null]": T({ type: "section", title: "s", buttons: [null] }),
	"text runs [null]": T({ type: "text", runs: [null] }),
	"text runs number": T({ type: "text", runs: 5 }),
	"canvas ops [null]": T({ type: "canvas", width: 1, height: 1, ops: [null] }),
	"canvas ops string": T({ type: "canvas", width: 1, height: 1, ops: "abc" }),
	"canvas ops object": T({ type: "canvas", width: 1, height: 1, ops: {} }),
	"canvas op without op": T({ type: "canvas", width: 1, height: 1, ops: [{}] }),
	"binding null": T({ type: "box", on: { press: null } }),
	"binding number": T({ type: "box", on: { press: 5 } }),
	"date argument that is not a date": T({ type: "text", text: { id: "x", args: { a: { date: "nope" } } } }),
	"text id number": T({ type: "text", text: { id: 5 } }),
	"image source null": T({ type: "image", source: null }),
	"png that is not a string": T({ type: "image", source: { png: 5 } }),
	"rev string": { rev: "x", root: { type: "box" } },
	"rev fraction": { rev: 1.5, root: { type: "box" } },
	"rev object": { rev: {}, root: { type: "box" } },
	"root array": { root: [] },
	"root string": { root: "box" },
	"root null": { root: null },
	"no root": {},
	"padding object": T({ type: "box", style: { padding: { x: {} } } }),
	"width object": T({ type: "box", style: { width: {} } }),
	"border number": T({ type: "box", style: { border: 5 } }),
	"named styles [null]": { root: { type: "box" }, styles: [null] },
	"JSON null": null,
	"JSON number": 5,
	"JSON text that is not JSON": "{",
	"JSON array text": "[]",
	"JSON null text": "null",
};

const MODES: ValidationMode[] = ["full", "cheap"];
function outcome(fn: () => unknown): "ok" | "TreeError" | Error {
	try {
		fn();
		return "ok";
	} catch (e) {
		return e instanceof TreeError ? "TreeError" : (e as Error);
	}
}

describe("decoding turns every failure on plugin data into TreeError", () => {
	for (const mode of MODES)
		for (const [label, value] of Object.entries(badTrees))
			test(`jsonToTree ${mode}: ${label}`, () => {
				const r = outcome(() => jsonToTree(value, { validate: mode }));
				expect(r === "TreeError" || r === "ok").toBe(true);
				// the schema rejects all of these; "cheap" skips the schema, so it may decode some
				if (mode === "full") expect(r).toBe("TreeError");
				let text: string | undefined;
				try {
					text = typeof value === "string" ? value : JSON.stringify(value);
				} catch {
					/* too deep to serialize: only the object form can carry it */
				}
				if (text !== undefined) {
					const s = outcome(() => jsonToTree(text, { validate: mode }));
					expect(s === "TreeError" || s === "ok").toBe(true);
				}
			});

	const patch = (ops: unknown, extra: object = {}) => ({ baseRev: 1, rev: 2, ops, ...extra });
	const goodOp = { op: "set-node", key: "t", node: { type: "text", key: "t", text: "x" } };
	const badPatches: Record<string, unknown> = {
		"ops [null]": patch([null]),
		"ops string": patch("x"),
		"ops object": patch({}),
		"ops [5]": patch([5]),
		"op without op": patch([{}]),
		"unknown op": patch([{ op: "nope" }]),
		"set-node without node": patch([{ op: "set-node", key: "t" }]),
		"set-node node null": patch([{ op: "set-node", key: "t", node: null }]),
		"set-node unknown type": patch([{ op: "set-node", key: "t", node: { type: "nope" } }]),
		"replace node number": patch([{ op: "replace", key: "t", node: 5 }]),
		"insert without parent": patch([{ op: "insert", index: 0, node: { type: "box" } }]),
		"insert node null": patch([{ op: "insert", parent: "t", index: 0, node: null }]),
		"remove key object": patch([{ op: "remove", key: {} }]),
		"move index string": patch([{ op: "move", key: "t", parent: "r", index: "x" }]),
		"set-styles [null]": patch([{ op: "set-styles", styles: [null] }]),
		"set-styles number": patch([{ op: "set-styles", styles: 5 }]),
		"a good op then a bad one": patch([goodOp, null]),
		"baseRev string": { baseRev: "1", rev: 2, ops: [] },
		"no rev": { baseRev: 1, ops: [] },
		"rev object": patch([], { rev: {} }),
		"patch null": null,
		"patch array": [],
		"patch number": 5,
		"patch text that is not JSON": "{",
	};
	for (const mode of MODES)
		for (const [label, value] of Object.entries(badPatches))
			test(`jsonToPatch ${mode}: ${label}`, () => {
				const r = outcome(() => jsonToPatch(value, { validate: mode }));
				expect(r === "TreeError" || r === "ok").toBe(true);
				if (mode === "full") expect(r).toBe("TreeError");
			});

	test("pre-built patch sets with bad ops", () => {
		for (const ops of [[null], [{ tag: "remove" }], [{ tag: "nope", val: 1 }], [{ tag: "remove", val: "a" }, 5]])
			expect(outcome(() => jsonToPatch({ baseRev: 1n, rev: 2n, ops }))).toBe("TreeError");
		expect(outcome(() => jsonToPatch({ baseRev: 1n, rev: 2, ops: [] }))).toBe("TreeError");
	});

	test("pre-built trees", () => {
		const node = (o: object = {}) => ({ props: { events: [], style: {}, a11y: {}, class: [] }, kind: { tag: "box" }, children: [], ...o });
		const ok = { rev: 1n, root: 0, styles: [], nodes: [node()] };
		expect(outcome(() => normalizeTree(ok))).toBe("ok");
		const bad: Record<string, unknown> = {
			null: null,
			"no nodes": { ...ok, nodes: undefined },
			"nodes string": { ...ok, nodes: "x" },
			"root string": { ...ok, root: "0" },
			"root NaN": { ...ok, root: NaN },
			"styles [null]": { ...ok, styles: [null] },
			"styles number": { ...ok, styles: 5 },
			"rev missing": { ...ok, rev: undefined },
			"rev string": { ...ok, rev: "1" },
		};
		for (const [label, v] of Object.entries(bad)) expect([label, outcome(() => normalizeTree(v))]).toEqual([label, "TreeError"]);
		// shape of the nodes is checked when the tree is built (the controller does that)
		const { sup } = fakeSup();
		const badNodes: Record<string, unknown[]> = {
			"node null": [null],
			"props missing": [node({ props: undefined })],
			"events null": [node({ props: { events: null, style: {}, a11y: {} } })],
			"style null": [node({ props: { events: [], style: null, a11y: {} } })],
			"kind null": [node({ kind: null })],
			"unknown kind": [node({ kind: { tag: "nope" } })],
			"children missing": [node({ children: undefined })],
			"child out of range": [node({ children: [9] })],
			"child is itself": [node({ children: [0] })],
			"child not a number": [node({ children: ["a"] })],
			"two parents": [node({ children: [1, 1] }), node()],
		};
		for (const [label, nodes] of Object.entries(badNodes)) {
			const ctl = new ViewController("p@x", sup, ctxOf);
			expect(() => ctl.apply({ content: { tag: "full", val: { ...ok, nodes } as never } })).not.toThrow();
			expect([label, ctl.state.message, ctl.state.root]).toEqual([label, expect.stringMatching(/invalid UI tree/), undefined]);
		}
	});

	test("row batches and batch styles", () => {
		expect(outcome(() => resolveBatchRows(null as never, undefined, "n"))).toBe("TreeError");
		expect(outcome(() => resolveBatchRows([null] as never, undefined, "n"))).toBe("TreeError");
		expect(outcome(() => resolveBatchRows([{ id: "a", cells: null }] as never, undefined, "n"))).toBe("TreeError");
		expect(outcome(() => resolveBatchRows([{ id: "a", cells: [], content: "{" }] as never, undefined, "n"))).toBe("TreeError");
		expect(outcome(() => resolveBatchRows([{ id: "a", cells: [], content: 3 }] as never, [], "n"))).toBe("TreeError");
		expect(outcome(() => parseBatchStyles([null] as never))).toBe("TreeError");
		expect(outcome(() => parseBatchStyles("[null]"))).toBe("TreeError");
		expect(outcome(() => parseBatchStyles("{"))).toBe("TreeError");
	});
});

/** Render results the controller must take without throwing and without unhandled rejections. */
const badResults: Record<string, unknown> = {
	"result null": null,
	"result number": 5,
	"result string": "x",
	"result array": [],
	"no content": {},
	"content null": { content: null },
	"content number": { content: 5 },
	"content tag number": { content: { tag: 5 } },
	"unknown content tag": { content: { tag: "nope" } },
	"json that is not a tree": { content: { tag: "json", val: JSON.stringify({ root: { type: "table", columns: [], rows: [null] } }) } },
	"json val number": { content: { tag: "json", val: 5 } },
	"json val undefined": { content: { tag: "json" } },
	"full val null": { content: { tag: "full", val: null } },
	"full val without nodes": { content: { tag: "full", val: { rev: 1n, root: 0, styles: [] } } },
	"patch val null": { content: { tag: "patch", val: null } },
	"patch with a null op": { content: { tag: "patch", val: JSON.stringify({ baseRev: 1, rev: 2, ops: [null] }) } },
	"meta number": { content: { tag: "unchanged" }, meta: 5 },
	"meta buttons number": { content: { tag: "unchanged" }, meta: { buttons: 5 } },
	"meta buttons [null]": { content: { tag: "unchanged" }, meta: { buttons: [null] } },
	"meta button without id": { content: { tag: "unchanged" }, meta: { buttons: [{}] } },
	"focus number": { content: { tag: "unchanged" }, focus: 5 },
	"focus object": { content: { tag: "unchanged" }, focus: {} },
};

const mounted = async (answer?: (fn: string, args: unknown[]) => unknown) => {
	const { sup, calls } = fakeSup((fn, args) => (fn === "mount" ? { content: { tag: "json", val: JSON.stringify(validTree()) } } : (answer?.(fn, args) ?? { content: { tag: "unchanged" } })));
	const ctl = new ViewController("p@x", sup, ctxOf);
	await ctl.mount();
	return { ctl, calls };
};

describe("ViewController contains malformed content", () => {
	for (const [label, r] of Object.entries(badResults))
		test(`apply: ${label}`, async () => {
			const { ctl } = await mounted();
			const before = snapTree(ctl);
			expect(() => ctl.apply(r as RenderResult)).not.toThrow();
			await settle();
			expect(escaped).toEqual([]);
			expect(snapTree(ctl)).toBe(before); // the tree is untouched
			expect(ctl.state.root).toBeDefined();
			await ctl.unmount();
		});

	test("the message says what was wrong, and a good tree afterwards clears it", async () => {
		const { ctl } = await mounted();
		ctl.apply({ content: { tag: "json", val: JSON.stringify({ root: { type: "table", columns: [], rows: [null] } }) } });
		expect(ctl.state.message).toMatch(/invalid UI tree/);
		ctl.apply({ content: { tag: "json", val: JSON.stringify(validTree()) } });
		expect(ctl.state.message).toBeUndefined();
		await ctl.unmount();
	});

	test("a malformed mount answer leaves an error message, no rejection", async () => {
		for (const bad of [null, 5, { content: null }, { content: { tag: "json", val: JSON.stringify({ root: { type: "box", children: [null] } }) } }]) {
			const { sup } = fakeSup((fn) => (fn === "mount" ? bad : undefined));
			const ctl = new ViewController("p@x", sup, ctxOf);
			await ctl.mount();
			await settle();
			expect(escaped).toEqual([]);
			await ctl.unmount();
		}
	});

	test("push: malformed updates in a frame are contained, later good ones still apply", async () => {
		const { ctl } = await mounted();
		for (const r of Object.values(badResults)) ctl.push(r as RenderResult);
		ctl.push({ content: { tag: "patch", val: JSON.stringify(validPatches()[0]) } });
		await settle();
		expect(escaped).toEqual([]);
		expect(ctl.state.rev).toBe(2n);
		await ctl.unmount();
	});

	test("showInitial: a pre-built tree or json that is malformed", async () => {
		const { sup } = fakeSup();
		for (const v of [{ nodes: [null], root: 0, rev: 1n, styles: [] }, { nodes: 5 }, null as never, "{", { root: { type: "nope" } }, { a: 1n } as never]) {
			const ctl = new ViewController("p@x", sup, ctxOf);
			expect(() => ctl.showInitial(v)).not.toThrow();
			expect(ctl.state.root).toBeUndefined();
			await ctl.unmount();
		}
		await settle();
		expect(escaped).toEqual([]);
	});

	test("a patch that fails part-way applies nothing", async () => {
		const { ctl } = await mounted((fn) => (fn === "resync" ? { content: { tag: "unchanged" } } : undefined));
		const before = snapTree(ctl);
		const good = { op: "set-node", key: "greeting", node: { type: "text", key: "greeting", text: "changed" } };
		const partial: Record<string, unknown[]> = {
			"later op is null": [good, null],
			"later op has a bad node": [good, { op: "insert", parent: "root", index: 0, node: { type: "nope" } }],
			"later op names a missing key": [good, { op: "remove", key: "nowhere" }],
			"later op is an unknown op": [good, { op: "nope" }],
		};
		for (const [label, ops] of Object.entries(partial)) {
			for (const mode of MODES) {
				setValidationMode(mode);
				ctl.apply({ content: { tag: "patch", val: JSON.stringify({ baseRev: 1, rev: 2, ops }) } });
				expect([label, mode, snapTree(ctl)]).toEqual([label, mode, before]);
			}
		}
		setValidationMode("full");
		// pre-built patch set whose second op cannot be applied
		const pre = { baseRev: 1n, rev: 2n, ops: [{ tag: "remove", val: "greeting" }, { tag: "replace", val: { key: "go", subtree: null } }] };
		ctl.apply({ content: { tag: "patch", val: pre as never } });
		expect(snapTree(ctl)).toBe(before);
		expect(ctl.state.rev).toBe(1n);
		await settle();
		expect(escaped).toEqual([]);
		await ctl.unmount();
	});

	test("virtual rows: malformed render-range answers are contained", async () => {
		const answers: unknown[] = [
			{},
			{ start: 0, rows: null },
			{ start: 0, rows: [null] },
			{ start: 0, rows: [{ id: "a", cells: null }] },
			{ start: "x", rows: [] },
			{ start: 0, rows: [], styles: "[null]" },
			{ start: 0, rows: [{ id: "a", depth: 0, cells: [], content: "{" }] },
			{ start: 0, rows: [], styles: [null] },
			5,
		];
		for (const a of answers) {
			const { ctl } = await mounted((fn) => (fn === "render-range" ? a : undefined));
			const vt = ctl.state.root!.children.find((c) => c.id === "k:virt")!;
			ctl.requestRange(vt, 0, 5);
			await settle();
			await sleep(60);
			expect(escaped).toEqual([]);
			expect(ctl.state.rowCache["k:virt"]?.rows ?? {}).toEqual({});
			await ctl.unmount();
		}
	});

	test("host entry points: push, refresh, update-dialog take malformed content without throwing", async () => {
		const { ctl } = await mounted();
		const ctx: HostCtx = { pluginId: "p@x", has: () => true, callExport: async () => ({ content: { tag: "json", val: "{" } }) };
		for (const r of Object.values(badResults)) expect(() => push(ctx, ctl.instance, r as RenderResult)).not.toThrow();
		expect(() => refresh(ctx, ctl.instance)).not.toThrow();
		expect(() => updateDialog(ctx, ctl.instance, {} as never)).toThrow(UiHostError); // not a dialog: the usual error, nothing else
		await settle();
		expect(escaped).toEqual([]);
		await ctl.unmount();
	});

	test("openDialogNow refuses malformed content with invalid-argument", () => {
		const ctx: HostCtx = { pluginId: "p@x", has: () => true, callExport: async () => undefined };
		const spec = (content: unknown) => ({ title: "t", content, buttons: [], resizable: false, modal: false, dismissOnEscape: true }) as never;
		const prebuilt = { rev: 1n, root: 0, styles: [] };
		const contents: unknown[] = [
			{ ...prebuilt, nodes: [null] },
			{ ...prebuilt, nodes: [{ props: null, kind: { tag: "box" }, children: [] }] },
			{ ...prebuilt, nodes: [{ props: { events: [], style: {}, a11y: {} }, kind: { tag: "box" }, children: [0] }] },
			{ nodes: [] },
			{ nodes: "x" },
			T({ type: "table", columns: [], rows: [null] }),
			"{",
			null,
			{ a: 1n },
		];
		const before = lookupInstance(0n);
		expect(before).toBeUndefined();
		for (const c of contents) {
			let e: unknown;
			try {
				openDialogNow(ctx, spec(c));
			} catch (x) {
				e = x;
			}
			expect([JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? "n" : v)), e instanceof UiHostError ? e.tag : e]).toEqual([expect.anything(), "invalid-argument"]);
		}
	});
});

// ------------------------------------------------------------------------------------------------ valid data is unchanged

describe("valid data renders the same as before the fix", () => {
	test("mount and patches give the recorded trees", async () => {
		const run = await recordRun();
		expect(run.length).toBe(golden.length);
		for (let i = 0; i < run.length; i++) expect([i, run[i]]).toEqual([i, golden[i]]);
	});
	test("json and pre-built forms agree", () => {
		const t = jsonToTree(validTree());
		expect(normalizeTree(t)).toEqual(t);
	});
});

// ------------------------------------------------------------------------------------------------ fuzz

type Path = (string | number)[];
const paths = (v: unknown, base: Path = [], out: Path[] = []): Path[] => {
	out.push(base);
	if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...base, i], out));
	else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) paths(x, [...base, k], out);
	return out;
};
const replacements = fc.constantFrom<unknown>(null, undefined, 0, -1, 1.5, 1e308, "", "x", "#zz", "50%", "999999999999999999999999", true, [], {}, [null], [[]], { a: null }, { op: "nope" }, { type: "nope" }, { type: "box" }, "{", [1, 2, 3]);
function mutate(doc: unknown, edits: [number, unknown][]): unknown {
	let d: any = structuredClone(doc);
	for (const [pick, value] of edits) {
		const ps = paths(d);
		const p = ps[pick % ps.length]!;
		if (!p.length) {
			d = structuredClone(value);
			continue;
		}
		let o = d;
		for (const k of p.slice(0, -1)) o = o[k];
		if (value === undefined) delete o[p[p.length - 1]!];
		else o[p[p.length - 1]!] = structuredClone(value);
	}
	return d;
}
const edits = fc.array(fc.tuple(fc.nat(100000), replacements), { minLength: 1, maxLength: 3 });

describe("fuzz: mutated valid trees and patches", () => {
	test("trees (json object, json text, pre-built) never throw and never leave a half result", async () => {
		const base = validTree();
		await fc.assert(
			fc.asyncProperty(edits, fc.constantFrom<ValidationMode>("full", "cheap"), async (e, mode) => {
				setValidationMode(mode);
				const doc = mutate(base, e);
				const { sup } = fakeSup((fn) => (fn === "resync" ? { content: { tag: "unchanged" } } : undefined));
				const ctl = new ViewController("p@x", sup, ctxOf);
				ctl.showInitial(JSON.stringify(validTree()));
				const before = snapTree(ctl);
				for (const content of [{ tag: "json", val: doc }, { tag: "json", val: JSON.stringify(doc) }] as const) {
					ctl.apply({ content: content as never });
					const bad = /invalid UI tree/.test(ctl.state.message ?? "");
					if (bad) expect(snapTree(ctl)).toBe(before);
					ctl.showInitial(JSON.stringify(validTree()));
				}
				// the same document as a pre-built tree, when it decodes
				const t = outcome(() => jsonToTree(doc));
				expect(t === "ok" || t === "TreeError").toBe(true);
				if (t === "ok") {
					const tree = jsonToTree(doc);
					ctl.apply({ content: { tag: "full", val: mutatePrebuilt(tree, e) as never } });
				}
				await ctl.unmount();
			}),
			{ numRuns: 1200 },
		);
		setValidationMode("full");
		await settle();
		expect(escaped).toEqual([]);
	});

	test("patches: a failing patch changes nothing, none throws", async () => {
		const patches = validPatches();
		await fc.assert(
			fc.asyncProperty(fc.nat(2), edits, fc.constantFrom<ValidationMode>("full", "cheap"), async (which, e, mode) => {
				setValidationMode(mode);
				const { sup } = fakeSup((fn) => (fn === "resync" ? { content: { tag: "unchanged" } } : undefined));
				const ctl = new ViewController("p@x", sup, ctxOf);
				ctl.showInitial(JSON.stringify(validTree()));
				// bring the tree to the patch's base rev with the earlier valid patches
				for (let i = 0; i < which; i++) ctl.apply({ content: { tag: "patch", val: JSON.stringify(patches[i]) } });
				const before = snapTree(ctl);
				const doc = mutate(patches[which], e);
				for (const val of [doc, JSON.stringify(doc)]) {
					expect(() => ctl.apply({ content: { tag: "patch", val: val as never } })).not.toThrow();
					if (/invalid UI tree/.test(ctl.state.message ?? "")) {
						expect(snapTree(ctl)).toBe(before);
						break;
					}
				}
				await ctl.unmount();
			}),
			{ numRuns: 1500 },
		);
		setValidationMode("full");
		await settle();
		expect(escaped).toEqual([]);
	});
});

/** The pre-built tree with one field replaced, to exercise `normalizeTree` and the node checks. */
function mutatePrebuilt(tree: unknown, e: [number, unknown][]): unknown {
	const plain = JSON.parse(JSON.stringify(tree, (_k, v) => (typeof v === "bigint" ? { __big: String(v) } : v)));
	const m: any = mutate(plain, e.slice(0, 1));
	return JSON.parse(JSON.stringify(m), (_k, v) => (v && typeof v === "object" && typeof v.__big === "string" && /^\d+$/.test(v.__big) ? BigInt(v.__big) : v));
}

// ------------------------------------------------------------------------------------------------ rendering

describe("a renderer that throws is contained", () => {
	test("the surface shows a notice, and the next tree draws again", async () => {
		const { sup } = fakeSup();
		const ctl = new ViewController("p@x", sup, ctxOf);
		const node = (kind: object) => ({ props: { events: [], style: {}, a11y: {}, class: [] }, kind, children: [] });
		// decodes (the node has the fields every renderer reads) but a text node whose runs is a number makes the renderer throw
		const poisoned = { rev: 1n, root: 0, styles: [], nodes: [node({ tag: "text", val: { kind: "body", runs: 5, selectable: false } })] };
		let dispose = () => {};
		const el = createRoot((d) => {
			dispose = d;
			return ControllerView({ controller: ctl });
		}) as unknown;
		// the view is a memo (a function); host elements have `children`, host text has `text`
		const textsOf = (n: any, out: string[] = []): string[] => {
			if (typeof n === "function") return textsOf(n(), out);
			if (Array.isArray(n)) for (const c of n) textsOf(c, out);
			else if (n && typeof n === "object") {
				if (typeof n.text === "string") out.push(n.text);
				for (const c of n.children ?? []) textsOf(c, out);
			}
			return out;
		};
		ctl.apply({ content: { tag: "full", val: poisoned as never } });
		await sleep(20);
		expect(escaped).toEqual([]);
		expect(textsOf(el).join("|")).toContain("could not be drawn");
		ctl.apply({ content: { tag: "json", val: JSON.stringify({ rev: 2, root: { type: "text", text: "fine now" } }) } });
		await sleep(20);
		expect(textsOf(el).join("|")).toContain("fine now");
		expect(textsOf(el).join("|")).not.toContain("could not be drawn");
		dispose();
		await ctl.unmount();
	});
});
