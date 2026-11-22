// Valid plugin UI data used by malformed.test.ts: a rich tree, patches for it, and a driver that records what the controller shows
// after each step. The recorded run (golden.json) was produced by the code before the malformed-data fixes: valid data must still
// give exactly the same tree.
import { ViewController } from "../controller";
import type { UiSupervisor } from "../types";

const text = (s: string, extra: object = {}) => ({ type: "text", text: s, ...extra });

/** A tree with most node kinds, row and cell content, a menu, a canvas, named styles. Rev 1. */
export const validTree = () => ({
	rev: 1,
	styles: [{ name: "accent", style: { background: "primary-tint", padding: 2 }, states: { hover: { background: "primary-soft" } } }],
	root: {
		type: "box",
		key: "root",
		class: ["accent"],
		style: { direction: "column", gap: 2, padding: { x: 3, y: "4px" }, width: "fill", border: { width: 1, color: "#336699" } },
		on: { press: "root-press", "key-down": { handler: "k", keys: ["Enter", "ctrl+s"], debounceMs: 50 } },
		contextMenu: { items: [{ id: "cut", label: "Cut" }, { label: "More", children: [{ id: "copy", label: { id: "copy.label", args: { n: 2, s: "x" } } }] }] },
		children: [
			text("hello", { key: "greeting", tooltip: "tip" }),
			{ type: "button", key: "go", label: "Go", icon: "star", look: "primary", on: { press: { handler: "go", stopPropagation: true } }, menu: { items: [{ id: "a", label: "A" }] } },
			{ type: "text-input", key: "name", value: "abc", placeholder: "Name", suggest: { items: [{ value: "x", label: "X" }], dynamic: false } },
			{ type: "select", key: "sel", options: [{ value: "1", label: "One" }, { value: "2", label: "Two", disabled: true }], value: "1" },
			{ type: "tabs", key: "tabs", tabs: [{ key: "a", label: "A", closable: true }, { key: "b", label: "B" }], selected: "a", children: [text("tab a"), text("tab b")] },
			{
				type: "table",
				key: "tbl",
				columns: [{ key: "c1", label: "One", sortable: true }, { key: "c2", label: "Two", width: 120 }],
				rows: [
					{ id: "r1", cells: [{ text: "one", sortValue: 1 }, { content: { type: "badge", label: "n" } }], content: text("wide row") },
					{ id: "r2", depth: 1, expandable: true, cells: [{ text: { id: "r2.t" }, bold: true }, { icon: "star", color: "primary" }] },
				],
				selection: "multiple",
				selected: ["r1"],
			},
			{ type: "list-view", key: "virt", rows: { count: 500, rowHeight: 24 } },
			{
				type: "canvas",
				key: "cv",
				width: 200,
				height: 100,
				background: "background",
				ops: [
					{ op: "rect", x: 1, y: 2, width: 30, height: 20, cornerRadius: 3, style: { fill: "palette-blue", hit: "r", stroke: { color: "#000000", width: 1 } } },
					{ op: "polyline", points: [0, 0, 10, 20, 30, 5], closed: true, style: { hit: "p" } },
					{ op: "path", d: "M 0 0 L 10 10 Z", style: { hit: "d" } },
					{ op: "push-group", translateX: 5, translateY: 5, scale: 2 },
					{ op: "text", x: 1, y: 8, text: "label", hit: "t" },
					{ op: "pop-group" },
				],
			},
			{ type: "form", key: "f", children: [{ type: "checkbox", key: "chk", label: "Check", checked: true }, { type: "slider", key: "sl", value: 3, min: 0, max: 10 }] },
			{ type: "section", key: "sec", title: "Section", buttons: [{ id: "sb", icon: "x", label: "B" }], children: [{ type: "callout", tone: "info", message: "note" }] },
		],
	},
});

/** Patches over `validTree`: rev 1 -> 2 -> 3 -> 4. */
export const validPatches = () => [
	{
		baseRev: 1,
		rev: 2,
		ops: [
			{ op: "set-node", key: "greeting", node: text("patched", { key: "greeting" }) },
			{ op: "insert", parent: "root", index: 1, node: { type: "badge", key: "new", label: "new" } },
			{ op: "set-styles", styles: [{ name: "extra", style: { gap: 1 } }] },
		],
	},
	{
		baseRev: 2,
		rev: 3,
		ops: [
			{ op: "move", key: "new", parent: "root", index: 3 },
			{ op: "replace", key: "go", node: { type: "button", key: "go", label: "Go again" } },
		],
	},
	{ baseRev: 3, rev: 4, ops: [{ op: "remove", key: "new" }] },
];

/** A supervisor whose plugin answers every call with `answer` (the controller needs one even when the test feeds it content directly). */
export function fakeSup(answer: (fn: string, args: unknown[]) => unknown = () => undefined): { sup: UiSupervisor; calls: { fn: string; args: unknown[] }[] } {
	const calls: { fn: string; args: unknown[] }[] = [];
	const sup: UiSupervisor = {
		async call(_id, _iface, fn, args = []) {
			calls.push({ fn, args });
			await Promise.resolve();
			return answer(fn, args);
		},
	};
	return { sup, calls };
}

export const ctxOf = { view: "v", surface: "custom" as const, theme: "light" as const, locale: "en-US" };

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v);
/** What the controller shows, as comparable text. */
export const snap = (ctl: ViewController): string => JSON.stringify({ root: ctl.state.root, styles: ctl.state.styles, rev: ctl.state.rev, message: ctl.state.message }, replacer);

/** The tree, styles and rev (not the message; keys in sorted order): what a rejected update must leave untouched. */
const sorted = (_k: string, v: unknown) =>
	v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)
		? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
		: replacer(_k, v);
export const snapTree = (ctl: ViewController): string => JSON.stringify({ root: ctl.state.root, styles: ctl.state.styles, rev: ctl.state.rev }, sorted);

/** Mount `validTree` as json content, then apply each of `validPatches` as json strings; the snapshot after every step. */
export async function recordRun(): Promise<string[]> {
	const { sup } = fakeSup((fn) => (fn === "mount" ? { content: { tag: "json", val: JSON.stringify(validTree()) } } : undefined));
	const ctl = new ViewController("p@x", sup, ctxOf);
	const out: string[] = [];
	await ctl.mount();
	out.push(snap(ctl));
	for (const p of validPatches()) {
		ctl.apply({ content: { tag: "patch", val: JSON.stringify(p) } });
		out.push(snap(ctl));
	}
	await ctl.unmount();
	return out;
}
