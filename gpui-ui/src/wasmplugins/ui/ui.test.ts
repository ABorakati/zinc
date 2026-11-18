// Unit tests of the plugin UI's pure parts: JSON -> flat tree, flat -> nested, patches, colours, styles, safe html, canvas svg and
// hit testing, text measurement, and the controller (events, debounce, push batching, patches, virtual rows) against a fake plugin.
import { describe, expect, test } from "bun:test";
import { buildCanvas, hitTest, pathBox } from "./canvasSvg";
import { resolveColor } from "./colors";
import { ViewController, matchKey, P, lookupInstance } from "./controller";
import { applyPatch, buildNested, jsonToPatch, jsonToTree, LIMITS, setValidationMode, TreeError } from "./convert";
import { htmlToMarkdown } from "./markup";
import { measureText } from "./measure";
import { mapBox, mergeText, textStyleOf } from "./styleMap";
import type { FlatNode, NodeProps, RenderResult, Tree, UiSupervisor, VNode } from "./types";
import { cssToRgba } from "./host";

const text = (s: string) => ({ type: "text", text: s });

describe("json form -> flat tree", () => {
	test("converts text, icons, colours, spaces and events", () => {
		const tree = jsonToTree({
			root: {
				type: "box",
				key: "r",
				style: { direction: "row", gap: 2, padding: { x: 3 }, width: "50%", height: "fill", background: "primary-tint", border: { width: 1, color: "#ff0000" } },
				on: { press: "go", "key-down": { handler: "k", keys: ["Enter"], debounceMs: 50 } },
				children: [{ type: "button", label: { id: "hello", args: { n: 3 } }, icon: "star" }, text("x")],
			},
		});
		expect(tree.nodes.length).toBe(3);
		const root = tree.nodes[tree.root]!;
		expect(root.props.style.gap).toEqual({ tag: "step", val: 2 });
		expect(root.props.style.padding).toEqual({ start: { tag: "step", val: 3 }, end: { tag: "step", val: 3 } });
		expect(root.props.style.width).toEqual({ tag: "percent", val: 50 });
		expect(root.props.style.height).toEqual({ tag: "fill" });
		expect(root.props.style.background).toEqual({ tag: "token", val: "primary-tint" });
		expect(root.props.style.border!.color).toEqual({ tag: "rgba", val: 0xff0000ff });
		expect(root.props.events.map((e) => [e.event, e.handler, e.keys, e.debounceMs])).toEqual([
			["press", "go", [], undefined],
			["key-down", "k", ["Enter"], 50],
		]);
		const button = tree.nodes[root.children[0]!]!;
		expect(button.kind.tag).toBe("button");
		expect(button.kind.val!.icon).toEqual({ tag: "builtin", val: "star" });
		expect(button.kind.val!.label.tag).toBe("localized");
		expect(button.kind.val!.label.val.args[0]).toEqual({ name: "n", value: { tag: "integer", val: 3n } });
		expect(button.kind.val!.look).toBe("standard");
	});

	test("every node kind of the schema converts", () => {
		const kinds: Record<string, object> = {
			box: {}, grid: { columns: ["fill", 100] }, scroll: {}, split: { orientation: "row" }, tabs: { tabs: [{ key: "a", label: "A" }] }, deck: { selected: 0 },
			section: { title: "S" }, group: {}, toolbar: {}, card: {}, spacer: {}, separator: {}, text: { text: "t" }, link: { label: "l", target: { url: "https://x" } },
			image: { source: { svg: "<svg/>" } }, icon: { icon: "x" }, progress: {}, badge: { label: "b" }, callout: {}, "rich-text": { format: "markdown", source: "x" },
			code: { source: "x" }, skeleton: {}, button: {}, checkbox: {}, switch: {}, "radio-group": { options: [] }, select: { options: [] }, "text-input": { value: "" },
			"number-input": {}, slider: { value: 1, min: 0, max: 2 }, "color-input": { value: "#000000" }, "date-input": { value: "" }, "token-input": { tokens: [] }, form: {},
			"list-view": { rows: [] }, table: { columns: [], rows: [] }, popover: { open: false }, canvas: { width: 1, height: 1, ops: [] }, "web-view": { source: { html: "" } },
			embed: { component: "item-box" },
		}; // prettier-ignore
		for (const [type, extra] of Object.entries(kinds)) {
			const t = jsonToTree({ root: { type, ...extra } });
			expect(t.nodes[0]!.kind.tag).toBe(type as never);
		}
		expect(Object.keys(kinds).length).toBe(40);
	});

	test("rows, cells with content, menus and draw ops", () => {
		const tree = jsonToTree({
			root: {
				type: "table",
				columns: [{ key: "a", label: "A" }],
				rows: [{ id: "r1", cells: [{ text: "one", sortValue: 1 }, { content: { type: "badge", label: "n" } }], content: { type: "text", text: "wide" } }],
				contextMenu: { items: [{ id: "x", label: "X" }, { label: "More", children: [{ id: "y", label: "Y" }] }] },
			},
		});
		const root = tree.nodes[0]!;
		const rows = root.kind.val!.rows;
		expect(rows.tag).toBe("inline");
		expect(rows.val[0].cells[1].content).toBeGreaterThan(0);
		expect(root.props.contextMenu!.roots.length).toBe(2);
		expect(root.props.contextMenu!.items[1]!.kind).toBe("submenu");
		const nested = buildNested(tree);
		const r = (nested.kind.val!.rows.val as { contentNode?: VNode; cells: { contentNode?: VNode }[] }[])[0]!;
		expect(r.contentNode!.kind.tag).toBe("text");
		expect(r.cells[1]!.contentNode!.kind.tag).toBe("badge");
		const cv = jsonToTree({ root: { type: "canvas", width: 10, height: 10, ops: [{ op: "rect", x: 1, y: 2, width: 3, height: 4, style: { fill: "palette-blue", hit: "h" } }, { op: "pop-group" }] } });
		expect(cv.nodes[0]!.kind.val!.ops[0]).toMatchObject({ tag: "rect", val: { x: 1, style: { hit: "h", fill: { tag: "token", val: "palette-blue" } } } });
	});

	test("errors: unknown type, bad colour, limits, shared node", () => {
		expect(() => jsonToTree({ root: { type: "nope" } })).toThrow(TreeError);
		expect(() => jsonToTree({ root: { type: "box", style: { background: "not-a-token" } } })).toThrow(/unknown colour token/);
		expect(() => jsonToTree("{")).toThrow(/does not parse/);
		const many = { type: "box", children: Array.from({ length: LIMITS.nodes + 1 }, () => ({ type: "spacer" })) };
		expect(() => jsonToTree({ root: many })).toThrow(/more than/);
		let deep: Record<string, unknown> = { type: "spacer" };
		for (let i = 0; i < LIMITS.depth + 2; i++) deep = { type: "box", children: [deep] };
		expect(() => jsonToTree({ root: deep })).toThrow(/deeper/);
		const flat: Tree = { rev: 1n, root: 0, styles: [], nodes: [node("box", [1, 1]), node("spacer", [])] };
		expect(() => buildNested(flat)).toThrow(/used twice/);
	});
});

function props(o: Partial<NodeProps> = {}): NodeProps {
	return { class: [], style: {}, events: [], a11y: { hidden: false }, disabled: false, hidden: false, autoFocus: false, ...o };
}
function node(tag: string, children: number[], p: Partial<NodeProps> = {}, val?: Record<string, unknown>): FlatNode {
	return { props: props(p), kind: { tag: tag as never, val }, children };
}

describe("nested tree and patches", () => {
	const base = (): Tree => ({
		rev: 1n,
		root: 0,
		styles: [],
		nodes: [node("box", [1, 2], { key: "root" }), node("text", [], { key: "a" }, { kind: "body", runs: [], selectable: false }), node("text", [], {}, { kind: "body", runs: [], selectable: false })],
	});
	test("ids come from keys, else from position", () => {
		const n = buildNested(base());
		expect(n.id).toBe("k:root");
		expect(n.children.map((c) => c.id)).toEqual(["k:a", "k:root/1"]);
	});
	test("set-node, insert, move, remove, replace, set-styles", () => {
		const n = buildNested(base());
		const styles: Record<string, never> = {};
		const sub = (key: string): Tree => ({ rev: 1n, root: 0, styles: [], nodes: [node("badge", [], { key }, { label: { tag: "plain", val: key }, tone: "info", removable: false })] });
		const ok = applyPatch(n, styles, {
			baseRev: 1n,
			rev: 2n,
			ops: [
				{ tag: "set-node", val: { key: "a", props: props({ key: "a", tooltip: { tag: "plain", val: "tip" } }), kind: { tag: "text", val: { kind: "caption", runs: [], selectable: false } } } },
				{ tag: "insert", val: { parent: "root", index: 1, subtree: sub("b") } },
				{ tag: "move", val: { key: "a", parent: "root", index: 2 } },
				{ tag: "replace", val: { key: "b", subtree: sub("b2") } },
				{ tag: "set-styles", val: [{ name: "n", style: {} }] },
			],
		});
		expect(ok).toBe(true);
		expect(n.children.map((c) => c.id)).toEqual(["k:b", "k:root/1", "k:a"]);
		expect(n.children[2]!.kind.val!.kind).toBe("caption");
		expect(n.children[0]!.kind.tag).toBe("badge");
		expect((styles as Record<string, unknown>).n).toBeDefined();
		expect(applyPatch(n, styles, { baseRev: 2n, rev: 3n, ops: [{ tag: "remove", val: "b" }] })).toBe(true);
		expect(n.children.length).toBe(2);
		expect(applyPatch(n, styles, { baseRev: 3n, rev: 4n, ops: [{ tag: "remove", val: "nope" }] })).toBe(false);
	});
	test("JSON patch-set decodes, validates and applies", () => {
		const n = buildNested(base());
		const styles: Record<string, never> = {};
		const patchJson = JSON.stringify({
			baseRev: 1,
			rev: 2,
			ops: [
				{ op: "set-node", key: "a", node: { type: "text", kind: "caption", text: "updated" } },
				{ op: "insert", parent: "root", index: 1, node: { type: "badge", key: "b", label: "b", tone: "info" } },
				{ op: "move", key: "a", parent: "root", index: 2 },
				{ op: "replace", key: "b", node: { type: "badge", key: "b2", label: "b2", tone: "success" }, styles: [{ name: "chip", style: { radius: "full" } }] },
				{ op: "set-styles", styles: [{ name: "n", style: { gap: 2 } }] },
			],
		});
		expect(applyPatch(n, styles, patchJson)).toBe(true);
		expect(n.children.map((c) => c.id)).toEqual(["k:b", "k:root/1", "k:a"]);
		expect(n.children[2]!.kind.val!.kind).toBe("caption");
		expect(n.children[0]!.kind.tag).toBe("badge");
		expect((styles as Record<string, unknown>).chip).toBeDefined();
		expect((styles as Record<string, unknown>).n).toBeDefined();
		expect(() => jsonToPatch(JSON.stringify({ baseRev: 1, rev: 2, ops: [{ op: "unknown-op" }] }))).toThrow(TreeError);
	});
	test("schema validation: full mode catches unknown fields and bad enums; cheap mode skips schema walk", () => {
		setValidationMode("full");
		expect(() => jsonToTree({ root: { type: "box", unknownProp: 123 } })).toThrow(/unknown field "unknownProp"/);
		expect(() => jsonToTree({ root: { type: "button", look: "not-a-look" } })).toThrow(/not-a-look/);
		expect(() => jsonToTree({ root: { type: "grid" } })).toThrow(/missing required field "columns"/);
		setValidationMode("cheap");
		expect(jsonToTree({ root: { type: "box", unknownProp: 123 } }).nodes.length).toBe(1);
		setValidationMode("full");
	});
});

describe("colours and styles", () => {
	test("token, token+alpha, rgba and themed resolve per mode", () => {
		expect(resolveColor({ tag: "token", val: "palette-blue" }, "light")).toBe("#2B5FA8");
		expect(resolveColor({ tag: "token", val: "palette-blue" }, "dark")).toBe("#7BA3E6");
		expect(resolveColor({ tag: "rgba", val: 0x11223344 }, "light")).toBe("rgba(17, 34, 51, 0.267)");
		expect(resolveColor({ tag: "themed", val: { light: 0xffffffff, dark: 0x000000ff } }, "dark")).toBe("#000000");
		expect(resolveColor({ tag: "token-alpha", val: { token: "primary", alpha: 128 } }, "light")).toMatch(/^rgba\(/);
		expect(resolveColor({ tag: "token", val: "foreground" }, "light")).not.toBe(resolveColor({ tag: "token", val: "foreground" }, "dark"));
	});
	test("style -> GPUIX style, text inheritance kept apart", () => {
		const s = mapBox(
			{ direction: "row", gap: { tag: "step", val: 2 }, padding: { top: { tag: "px", val: 3 }, start: { tag: "step", val: 1 } }, width: { tag: "fill" }, radius: "md", background: { tag: "token", val: "card" }, border: { width: 1, color: { tag: "token", val: "border" }, dashed: true } },
			"light",
		);
		expect(s).toMatchObject({ display: "flex", flexDirection: "row", gap: 8, paddingTop: 3, paddingLeft: 4, flexGrow: 1, flexBasis: 0, minWidth: 0, borderRadius: 6, borderWidth: 1, borderStyle: "dashed" });
		expect(s.fontSize).toBeUndefined();
		const t1 = mergeText({}, { foreground: { tag: "token", val: "primary" }, fontSize: "lg", fontWeight: "bold", textWrap: "truncate", maxLines: 2 }, "light");
		const t2 = mergeText(t1, { underline: true }, "light");
		expect(t2).toMatchObject({ fontSize: 15, fontWeight: 700, underline: true });
		expect(mergeText(t2, {}, "light")).toBe(t2);
		const g = textStyleOf(t2, { fontSize: 13, color: "#000" });
		expect(g).toMatchObject({ fontSize: 15, fontWeight: 700, textDecoration: "underline", lineClamp: 2 });
	});
	test("cssToRgba", () => {
		expect(cssToRgba("#2B5FA8")).toBe(0x2b5fa8ff);
		expect(cssToRgba("rgba(17, 34, 51, 0.5)")).toBe(0x11223380);
	});
});

describe("rich text and measurement", () => {
	test("html-subset drops scripts, styles, events and bad links", () => {
		const md = htmlToMarkdown(
			`<h2>Title</h2><p onclick="x()">A <b>bold</b> and <i>it</i> <a href="javascript:alert(1)">bad</a> <a href="https://e.org/a(b)">ok</a></p><script>evil()</script><style>p{}</style><iframe src="x">frame</iframe><ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>`,
		);
		expect(md).toContain("## Title");
		expect(md).toContain("**bold**");
		expect(md).toContain("*it*");
		expect(md).not.toContain("evil");
		expect(md).not.toContain("javascript");
		expect(md).not.toContain("frame");
		expect(md).toContain("[ok](https://e.org/a(b%29)");
		expect(md).toContain("- one");
		expect(md).toContain("| a | b |");
		expect(md).toContain("| --- | --- |");
	});
	test("measure-text wraps and scales with size", () => {
		const one = measureText({ text: "Hello world", size: "base", weight: "normal", family: "sans" });
		const big = measureText({ text: "Hello world", size: "xl", weight: "normal", family: "sans" });
		const wrapped = measureText({ text: "Hello wonderful big world", size: "base", weight: "normal", family: "sans", maxWidth: 60 });
		expect(one.lines).toBe(1);
		expect(big.width).toBeGreaterThan(one.width);
		expect(wrapped.lines).toBeGreaterThan(1);
		expect(wrapped.width).toBeLessThanOrEqual(60);
	});
});

describe("canvas", () => {
	const spec = jsonToTree({
		root: {
			type: "canvas", width: 200, height: 100, background: "muted",
			ops: [
				{ op: "rect", x: 10, y: 10, width: 50, height: 30, style: { fill: "palette-blue", hit: "box", hoverTip: "Box" } },
				{ op: "ellipse", cx: 120, cy: 50, rx: 20, ry: 20, style: { fill: "palette-green", hit: "round" } },
				{ op: "line", x1: 0, y1: 90, x2: 200, y2: 90, style: { stroke: { color: "foreground", width: 2 }, hit: "rule" } },
				{ op: "push-group", translateX: 100, translateY: 0, scale: 2 },
				{ op: "rect", x: 0, y: 0, width: 10, height: 10, style: { fill: "palette-rust", hit: "scaled" } },
				{ op: "pop-group" },
				{ op: "text", x: 5, y: 5, text: "a < b & c", size: "sm" },
			],
		},
	}).nodes[0]!.kind.val!;
	const built = buildCanvas(spec, { x: 0, y: 0, width: 200, height: 100 }, { mode: "dark", txt: (t) => (t as { val: string } | undefined)?.val ?? "", image: () => undefined });
	test("svg has the shapes, escaped text and dark colours", () => {
		expect(built.svg.startsWith("<svg ")).toBe(true);
		expect(built.svg).toContain("<rect");
		expect(built.svg).toContain("<ellipse");
		expect(built.svg).toContain("a &lt; b &amp; c");
		expect(built.svg).toContain("#7BA3E6");
		expect((built.svg.match(/<g /g) ?? []).length).toBe((built.svg.match(/<\/g>/g) ?? []).length);
	});
	test("hit testing: rect, ellipse corner miss, line tolerance, scaled group", () => {
		expect(hitTest(built.hits, 20, 20)?.id).toBe("box");
		expect(hitTest(built.hits, 120, 50)?.id).toBe("round");
		expect(hitTest(built.hits, 101, 31)).toBeUndefined(); // inside the ellipse's bbox, outside the ellipse
		expect(hitTest(built.hits, 50, 91)?.id).toBe("rule");
		expect(hitTest(built.hits, 50, 70)).toBeUndefined();
		expect(hitTest(built.hits, 110, 10)?.id).toBe("scaled"); // translate 100 + scale 2: the rect covers x 100..120, y 0..20
		expect(built.hits.find((h) => h.id === "box")?.tip).toBe("Box");
	});
	test("path bounding box", () => {
		expect(pathBox("M 10 10 L 50 10 L 50 40 Z")).toEqual({ x: 10, y: 10, w: 40, h: 30 });
		expect(pathBox("M 0 0 h 10 v 5")).toEqual({ x: 0, y: 0, w: 10, h: 5 });
	});
});

// ---- the controller against a fake plugin

type Call = { fn: string; args: any[] };
function fakePlugin(answer: (c: Call) => unknown) {
	const calls: Call[] = [];
	const sup: UiSupervisor = {
		async call(_id, iface, fn, args = []) {
			expect(iface).toBe("ui-events");
			const c = { fn, args };
			calls.push(c);
			await Promise.resolve();
			return answer(c);
		},
	};
	return { sup, calls };
}
const fullTree = (rev: bigint, label: string, extra: Partial<NodeProps> = {}): RenderResult => ({
	content: {
		tag: "full",
		val: { rev, root: 0, styles: [], nodes: [node("box", [1], { key: "root" }), node("text", [], { key: "t", ...extra }, { kind: "body", runs: [{ text: { tag: "plain", val: label }, bold: false, italic: false, underline: false, strike: false, mono: false }], selectable: false })] },
	},
});
const ctx = { view: "v", surface: "custom" as const, theme: "light" as const, locale: "en-US" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ViewController", () => {
	test("mount shows the tree, events carry handler, node key and rev, the answer replaces the tree", async () => {
		const press = { event: "press" as const, handler: "go", keys: [], preventDefault: false, stopPropagation: false };
		const { sup, calls } = fakePlugin((c) => (c.fn === "mount" ? fullTree(5n, "one", { events: [press] }) : c.fn === "on-event" ? fullTree(6n, "two", { events: [press] }) : undefined));
		const ctl = new ViewController("p@x", sup, { ...ctx, params: { a: 1 } });
		expect(lookupInstance(ctl.instance)).toBe(ctl);
		await ctl.mount();
		expect(ctl.state.status).toBe("ready");
		expect(calls[0]!.args[0]).toBe(ctl.instance);
		expect(calls[0]!.args[1]).toMatchObject({ view: "v", surface: "custom", params: '{"a":1}' });
		const t = ctl.state.root!.children[0]!;
		expect(ctl.state.rev).toBe(5n);
		expect(ctl.fire(t, "press")).toBe(true);
		expect(ctl.fire(t, "change")).toBe(false);
		await sleep(20);
		const ev = calls.find((c) => c.fn === "on-event")!.args[1];
		expect(ev).toMatchObject({ handler: "go", nodeKey: "t", kind: "press", rev: 5n, payload: { tag: "none" } });
		expect(ctl.state.rev).toBe(6n);
		expect((ctl.state.root!.children[0]!.kind.val!.runs[0].text as { val: string }).val).toBe("two");
		await ctl.unmount();
		expect(calls.some((c) => c.fn === "unmount")).toBe(true);
		expect(lookupInstance(ctl.instance)).toBeUndefined();
	});

	test("the node object survives a re-render with the same key (state kept), a changed key replaces it", async () => {
		const { sup } = fakePlugin((c) => (c.fn === "mount" ? fullTree(1n, "a") : undefined));
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		const first = ctl.state.root!.children[0]!;
		ctl.apply(fullTree(2n, "b"));
		expect(ctl.state.root!.children[0]).toBe(first);
		ctl.apply(fullTree(3n, "c", { key: "other" }));
		expect(ctl.state.root!.children[0]!.id).toBe("k:other");
		await ctl.unmount();
	});

	test("debounce keeps the last event; throttle sends the first and the trailing one", async () => {
		const sent: string[] = [];
		const b = (event: "input" | "scroll", extra: object) => ({ event, handler: event, keys: [], preventDefault: false, stopPropagation: false, ...extra });
		const { sup } = fakePlugin((c) => {
			if (c.fn === "on-event") sent.push(`${c.args[1].kind}:${c.args[1].payload.val?.val ?? ""}`);
			return c.fn === "mount" ? fullTree(1n, "a", { events: [b("input", { debounceMs: 30 }), b("scroll", { throttleMs: 40 })] }) : { content: { tag: "unchanged" } };
		});
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		const n = ctl.state.root!.children[0]!;
		for (const v of ["a", "ab", "abc"]) ctl.fire(n, "input", P.text(v));
		for (const v of ["1", "2", "3"]) ctl.fire(n, "scroll", P.text(v));
		await sleep(150);
		expect(sent.filter((s) => s.startsWith("input"))).toEqual(["input:abc"]);
		expect(sent.filter((s) => s.startsWith("scroll"))).toEqual(["scroll:1", "scroll:3"]);
		await ctl.unmount();
	});

	test("key filters", () => {
		const m = { shift: false, ctrl: true, alt: false, meta: false };
		expect(matchKey(["ctrl+Enter"], "Enter", m)).toBe(true);
		expect(matchKey(["Enter"], "Enter", m)).toBe(false);
		expect(matchKey(["Escape", "Enter"], "escape", { ...m, ctrl: false })).toBe(true);
	});

	test("push is batched to one frame, patches apply, a patch on the wrong rev asks for a resync", async () => {
		const { sup, calls } = fakePlugin((c) => (c.fn === "mount" ? fullTree(1n, "a") : c.fn === "resync" ? fullTree(10n, "resynced") : undefined));
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		ctl.push(fullTree(2n, "p1"));
		ctl.push(fullTree(3n, "p2"));
		expect((ctl.state.root!.children[0]!.kind.val!.runs[0].text as { val: string }).val).toBe("a"); // not applied yet
		await sleep(80);
		expect(ctl.state.rev).toBe(3n);
		const textOf = () => (ctl.state.root!.children[0]!.kind.val!.runs[0].text as { val: string }).val;
		expect(textOf()).toBe("p2");
		const patchStr = JSON.stringify({ baseRev: 3, rev: 4, ops: [{ op: "set-node", key: "t", node: { type: "text", key: "t", text: "patched" } }] });
		ctl.apply({ content: { tag: "patch", val: patchStr } });
		expect(textOf()).toBe("patched");
		expect(ctl.state.rev).toBe(4n);
		ctl.apply({ content: { tag: "patch", val: JSON.stringify({ baseRev: 99, rev: 100, ops: [] }) } });
		await sleep(30);
		expect(calls.some((c) => c.fn === "resync")).toBe(true);
		expect(textOf()).toBe("resynced");
		await ctl.unmount();
	});

	test("an invalid json tree keeps the last good tree and says why", async () => {
		const { sup } = fakePlugin((c) => (c.fn === "mount" ? fullTree(1n, "a") : undefined));
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		ctl.apply({ content: { tag: "json", val: JSON.stringify({ root: { type: "nope" } }) } });
		expect(ctl.state.message).toMatch(/invalid UI tree/);
		expect(ctl.state.root!.children.length).toBe(1);
		ctl.apply({ content: { tag: "json", val: JSON.stringify({ root: { type: "box", key: "j", children: [text("from json")] } }) } });
		expect(ctl.state.message).toBeUndefined();
		expect(ctl.state.root!.id).toBe("k:j");
		await ctl.unmount();
	});

	test("virtual rows: ranges are merged, requested once, cached, and invalidated", async () => {
		const ranges: string[] = [];
		const vnode = (): VNode => ({ id: "k:vt", props: props({ key: "vt" }), kind: { tag: "table", val: {} }, children: [] });
		const { sup } = fakePlugin((c) => {
			if (c.fn !== "render-range") return c.fn === "mount" ? fullTree(1n, "a") : undefined;
			const r = c.args[1];
			ranges.push(`${r.start}+${r.count}`);
			return {
				start: r.start,
				rows: Array.from({ length: r.count }, (_, i) => ({
					id: "v" + (r.start + i),
					depth: 0,
					expandable: false,
					expanded: false,
					disabled: false,
					style: i === 0 ? JSON.stringify({ background: "primary-tint" }) : undefined,
					content: i === 1 ? JSON.stringify({ type: "badge", label: "custom" }) : undefined,
					cells: [{ bold: false, content: i === 2 ? JSON.stringify({ type: "text", text: "cell-node" }) : undefined }],
				})),
				styles: JSON.stringify([{ name: "batch-style", style: { gap: 1 } }]),
				total: 500,
			};
		});
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		ctl.requestRange(vnode(), 0, 10);
		ctl.requestRange(vnode(), 5, 10);
		await sleep(150);
		expect(ranges).toEqual(["0+15"]);
		expect(ctl.state.rowCache["k:vt"]!.total).toBe(500);
		expect(ctl.state.rowCache["k:vt"]!.rows[14]!.id).toBe("v14");
		expect((ctl.state.rowCache["k:vt"]!.rows[0]!.style as { background?: { val: string } })?.background?.val).toBe("primary-tint");
		expect(ctl.state.rowCache["k:vt"]!.rows[1]!.contentNode?.kind.tag).toBe("badge");
		expect(ctl.state.rowCache["k:vt"]!.rows[2]!.cells[0]!.contentNode?.kind.tag).toBe("text");
		expect(ctl.state.styles["batch-style"]).toBeDefined();
		ctl.requestRange(vnode(), 0, 15);
		await sleep(100);
		expect(ranges.length).toBe(1); // cached
		ctl.invalidateRows("k:vt");
		ctl.requestRange(vnode(), 0, 5);
		await sleep(150);
		expect(ranges).toEqual(["0+15", "0+5"]);
		await ctl.unmount();
	});

	test("a failing plugin call shows `unresponsive`; a wit error keeps the tree", async () => {
		let mode = "ok";
		const { sup } = fakePlugin((c) => {
			if (c.fn === "mount") return fullTree(1n, "a");
			if (mode === "timeout") throw Object.assign(new Error("plugin timed out"), { kind: "timeout" });
			if (mode === "wit") throw Object.assign(new Error("invalid-argument: x"), { kind: "wit", payload: { tag: "invalid-argument", val: "x" } });
			return { content: { tag: "unchanged" } };
		});
		const ctl = new ViewController("p@x", sup, ctx);
		await ctl.mount();
		mode = "wit";
		await ctl.fireRaw("h", "press");
		expect(ctl.state.status).toBe("ready");
		expect(ctl.state.message).toMatch(/invalid-argument/);
		mode = "timeout";
		await ctl.fireRaw("h", "press");
		expect(ctl.state.status).toBe("unresponsive");
		expect(ctl.state.root).toBeDefined();
		await ctl.unmount();
	});

	test("form values per form, update-context only when something changed", async () => {
		const { sup, calls } = fakePlugin((c) => (c.fn === "mount" || c.fn === "update-context" ? fullTree(1n, "a") : undefined));
		const ctl = new ViewController("p@x", sup, ctx);
		ctl.setField("a", { tag: "text", val: "1" }, "k:f1");
		ctl.setField("b", { tag: "flag", val: true }, "k:f2");
		expect(ctl.formValues("k:f1")).toEqual([{ name: "a", value: { tag: "text", val: "1" } }]);
		expect(ctl.formValues().length).toBe(2);
		await ctl.mount();
		await ctl.updateContext({ theme: "light" });
		expect(calls.filter((c) => c.fn === "update-context").length).toBe(0);
		await ctl.updateContext({ theme: "dark", width: 300 });
		expect(calls.filter((c) => c.fn === "update-context").length).toBe(1);
		expect(calls.at(-1)!.args[1]).toMatchObject({ theme: "dark", width: 300 });
		await ctl.unmount();
	});
});
