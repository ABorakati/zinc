// Patches may not take a tree past the host limits (the limits of a whole tree hold across any number of patches), may not move a
// node into itself, and take any index.
import { describe, expect, test } from "bun:test";
import { applyPatch, applyPatchCopy, buildNested, jsonToTree, LIMITS, TreeError } from "./convert";
import type { VNode } from "./types";

const root = (): VNode => buildNested(jsonToTree({ root: { type: "box", key: "root", children: [{ type: "text", key: "a", text: "a" }, { type: "text", key: "b", text: "b" }] } }));
const patch = (...ops: unknown[]) => JSON.stringify({ baseRev: 1, rev: 2, ops });
const wide = (n: number, key?: string) => ({ type: "box", ...(key ? { key } : {}), children: Array.from({ length: n }, () => ({ type: "spacer" })) });
/** A chain of `n` boxes; the innermost has the key `leaf`. */
const chain = (n: number, leaf: string) => {
	let node: Record<string, unknown> = { type: "box", key: leaf };
	for (let i = 1; i < n; i++) node = { type: "box", children: [node] };
	return node;
};
const count = (n: VNode): number => 1 + n.children.reduce((s, c) => s + count(c), 0);
const depth = (n: VNode): number => 1 + Math.max(0, ...n.children.map(depth));

describe("limits hold across patches", () => {
	test("a patch that takes the tree past the node limit is refused and leaves the tree as it was", () => {
		const t = root();
		const first = applyPatchCopy(t, {}, patch({ op: "insert", parent: "root", index: 0, node: wide(LIMITS.nodes - 100, "w1") }));
		expect(first).toBeDefined();
		expect(count(first!.root)).toBeGreaterThan(LIMITS.nodes - 100);
		const before = count(first!.root);
		expect(() => applyPatchCopy(first!.root, {}, patch({ op: "insert", parent: "root", index: 0, node: wide(500) }))).toThrow(TreeError);
		expect(() => applyPatchCopy(first!.root, {}, patch({ op: "insert", parent: "root", index: 0, node: wide(500) }))).toThrow(/more than/);
		expect(count(first!.root)).toBe(before);
	});

	test("a patch that takes the tree past the depth limit is refused", () => {
		let t: VNode = root();
		const down = (under: string, key: string) => applyPatchCopy(t, {}, patch({ op: "insert", parent: under, index: 0, node: chain(LIMITS.depth - 30, key) }))!;
		t = down("root", "d1").root;
		expect(depth(t)).toBeLessThan(LIMITS.depth);
		expect(() => down("d1", "d2")).toThrow(/deeper/);
	});

	test("insert and replace are held to the same limits", () => {
		const t = root();
		expect(() => applyPatchCopy(t, {}, patch({ op: "insert", parent: "root", index: 0, node: wide(LIMITS.nodes) }))).toThrow(/more than/);
		const big = applyPatchCopy(t, {}, patch({ op: "insert", parent: "root", index: 0, node: wide(LIMITS.nodes - 10, "w") }))!;
		expect(() => applyPatchCopy(big.root, {}, patch({ op: "replace", key: "a", node: wide(100) }))).toThrow(/more than/);
	});

	test("a patch within the limits still applies", () => {
		const r = applyPatchCopy(root(), {}, patch({ op: "insert", parent: "root", index: 1, node: wide(100) }));
		expect(r && count(r.root)).toBe(3 + 101); // the root and its two children, and a box with 100 children
	});
});

describe("move", () => {
	const nested = () => buildNested(jsonToTree({ root: { type: "box", key: "root", children: [{ type: "box", key: "b", children: [{ type: "box", key: "c" }] }] } }));
	test("into the node itself or one of its own descendants is refused: the subtree would be cut off from the tree", () => {
		for (const to of ["b", "c"]) {
			const t = nested();
			expect(() => applyPatch(t, {}, patch({ op: "move", key: "b", parent: to, index: 0 }))).toThrow(TreeError);
			expect(count(t)).toBe(3); // nothing was moved
			expect(t.children.map((c) => c.id)).toEqual(["k:b"]);
		}
	});
	test("to another place still works", () => {
		const t = buildNested(jsonToTree({ root: { type: "box", key: "root", children: [{ type: "box", key: "x" }, { type: "box", key: "y" }] } }));
		expect(applyPatch(t, {}, patch({ op: "move", key: "x", parent: "y", index: 0 }))).toBe(true);
		expect(t.children.map((c) => c.id)).toEqual(["k:y"]);
		expect(t.children[0]!.children.map((c) => c.id)).toEqual(["k:x"]);
	});
});

describe("indexes", () => {
	const ids = (t: VNode) => t.children.map((c) => c.id);
	const sub = { rev: 1n, root: 0, styles: [], nodes: [{ props: { class: [], style: {}, events: [], a11y: { hidden: false }, disabled: false, hidden: false, autoFocus: false, key: "n" }, kind: { tag: "spacer" }, children: [] }] };
	const ins = (index: number) => ({ baseRev: 1n, rev: 2n, ops: [{ tag: "insert", val: { parent: "root", index, subtree: sub } }] });
	test("a negative, fractional, infinite or NaN index goes to the start or the end, never counted from the end", () => {
		for (const [index, at] of [[-1, 0], [-1e9, 0], [-Infinity, 0], [NaN, 0], [0.5, 0], [1, 1], [2, 2], [99, 2], [Infinity, 2]] as const) {
			const t = root();
			expect(applyPatch(t, {}, ins(index) as never)).toBe(true);
			expect([index, ids(t).indexOf("k:n")]).toEqual([index, at]);
		}
	});
	test("move takes the same indexes", () => {
		const t = root();
		expect(applyPatch(t, {}, { baseRev: 1n, rev: 2n, ops: [{ tag: "move", val: { key: "b", parent: "root", index: -5 } }] } as never)).toBe(true);
		expect(ids(t)).toEqual(["k:b", "k:a"]);
	});
});

describe("a patch that fails part-way applies nothing", () => {
	test("an unknown key, or a TreeError later in the list, leaves the original tree and styles as they were", () => {
		const t = root();
		const styles = { keep: { name: "keep", style: {} } };
		const was = JSON.stringify([t.children.map((c) => c.id), Object.keys(styles)]);
		const sub = (n: number) => ({ type: "box", children: Array.from({ length: n }, () => ({ type: "spacer" })) });
		const unknownKey = patch({ op: "remove", key: "a" }, { op: "set-styles", styles: [{ name: "x", style: {} }] }, { op: "remove", key: "nope" });
		expect(applyPatchCopy(t, styles, unknownKey)).toBeUndefined();
		const tooBig = patch({ op: "remove", key: "a" }, { op: "insert", parent: "root", index: 0, node: sub(LIMITS.nodes) });
		expect(() => applyPatchCopy(t, styles, tooBig)).toThrow(TreeError);
		expect(JSON.stringify([t.children.map((c) => c.id), Object.keys(styles)])).toBe(was);
	});
});
