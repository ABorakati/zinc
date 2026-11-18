// UI trees for JS guests. Builders produce the nested JSON form (plugin-api/ui-schema/ui-tree.schema.json), which is what
// `ui-events` results use (`content-update.json`). `toTree()` converts the same nested form into the flat typed `tree` record that
// `ui.run-dialog` / `open-dialog` / `open-window` need (their `content` is a typed tree, not JSON).
//
//   const view = ui.column({ gap: 2 }, ui.heading("Tags"), ui.button("Apply", { on: { press: "apply" } }));
//   return ui.render(view);             // a render-result for mount / on-event
//   ui.runDialog("Add tags", view, ...) // converts with toTree()

import { fill, hexColor, hexU32 } from "./defaults";

export type Text = string | { id: string; args?: Record<string, string | number | { date: number }>; fallback?: string };
export interface Binding {
	handler: string;
	debounceMs?: number;
	throttleMs?: number;
	keys?: string[];
	preventDefault?: boolean;
	stopPropagation?: boolean;
}
export interface UiNode {
	type: string;
	key?: string;
	name?: string;
	pref?: string;
	class?: string[];
	style?: Record<string, any>;
	on?: Record<string, string | Binding>;
	tooltip?: Text;
	disabled?: boolean;
	hidden?: boolean;
	autoFocus?: boolean;
	testId?: string;
	children?: UiNode[];
	[field: string]: any;
}
export type Child = UiNode | false | null | undefined;

/** Generic element: `h("button", { label: "OK" }, ...children)`. */
export function h(type: string, props: Record<string, any> = {}, ...children: Child[]): UiNode {
	const node: UiNode = { type, ...props };
	const kids = children.flat().filter((c): c is UiNode => !!c);
	if (kids.length) node.children = kids;
	return node;
}

const withText = (type: string, extra: Record<string, any>, text: Text, props: Record<string, any>, kids: Child[]) =>
	h(type, { ...extra, ...props }, ...kids);

export const column = (props: Record<string, any> = {}, ...children: Child[]) =>
	h("box", { ...props, style: { direction: "column", ...props.style } }, ...children);
export const row = (props: Record<string, any> = {}, ...children: Child[]) =>
	h("box", { ...props, style: { direction: "row", ...props.style } }, ...children);
export const box = (props: Record<string, any> = {}, ...children: Child[]) => h("box", props, ...children);
export const card = (props: Record<string, any> = {}, ...children: Child[]) => h("card", props, ...children);
export const spacer = (props: Record<string, any> = {}) => h("spacer", props);
export const separator = (props: Record<string, any> = {}) => h("separator", props);
export const group = (caption: Text, props: Record<string, any> = {}, ...children: Child[]) => h("group", { caption, ...props }, ...children);
export const section = (title: Text, props: Record<string, any> = {}, ...children: Child[]) => h("section", { title, ...props }, ...children);
export const form = (props: Record<string, any> = {}, ...children: Child[]) => h("form", props, ...children);

export const text = (t: Text, props: Record<string, any> = {}) => withText("text", { kind: "body", text: t }, t, props, []);
export const label = (t: Text, props: Record<string, any> = {}) => h("text", { kind: "label", text: t, ...props });
export const caption = (t: Text, props: Record<string, any> = {}) => h("text", { kind: "caption", text: t, ...props });
export const heading = (t: Text, props: Record<string, any> = {}) => h("text", { kind: "heading2", text: t, ...props });
export const mono = (t: Text, props: Record<string, any> = {}) => h("text", { kind: "mono", text: t, ...props });
export const callout = (tone: "neutral" | "info" | "success" | "warning" | "error", message: Text, props: Record<string, any> = {}) =>
	h("callout", { tone, message, ...props });
export const badge = (labelText: Text, tone = "neutral", props: Record<string, any> = {}) => h("badge", { label: labelText, tone, ...props });
export const progress = (value?: number, props: Record<string, any> = {}) => h("progress", { value, ...props });

export const button = (labelText: Text, props: Record<string, any> = {}) => h("button", { label: labelText, ...props });
/** A primary button that submits its form. */
export const submitButton = (labelText: Text, props: Record<string, any> = {}) => h("button", { label: labelText, look: "primary", submit: true, ...props });
export const textInput = (value = "", props: Record<string, any> = {}) => h("text-input", { value, ...props });
export const checkbox = (labelText: Text, checked = false, props: Record<string, any> = {}) => h("checkbox", { label: labelText, checked, ...props });
/** `options`: `[value, label]` pairs or `{ value, label }` objects. */
export const select = (options: ([string, Text] | { value: string; label: Text })[], value?: string, props: Record<string, any> = {}) =>
	h("select", { options: options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o)), value, ...props });

// ---- results -------------------------------------------------------------------------------------------------------

export interface RenderResult {
	content: { tag: "unchanged" } | { tag: "json"; val: string };
	meta?: unknown;
	focus?: string;
}
/** A `render-result` carrying the whole tree in the nested JSON form. */
export function render(root: UiNode, extra: { rev?: number; focus?: string; styles?: unknown[] } = {}): RenderResult {
	const tree: Record<string, unknown> = { root };
	if (extra.rev !== undefined) tree.rev = extra.rev;
	if (extra.styles) tree.styles = extra.styles;
	return { content: { tag: "json", val: JSON.stringify(tree) }, focus: extra.focus };
}
export const unchanged = (): RenderResult => ({ content: { tag: "unchanged" } });

// ---- nested JSON -> flat typed tree ------------------------------------------------------------------------------------

const plainText = (t: Text | undefined) => {
	if (t === undefined) return undefined;
	if (typeof t === "string") return { tag: "plain", val: t };
	return {
		tag: "localized",
		val: {
			id: t.id,
			args: Object.entries(t.args ?? {}).map(([name, v]) => ({
				name,
				value: typeof v === "string" ? { tag: "text", val: v } : typeof v === "number" ? (Number.isInteger(v) ? { tag: "integer", val: BigInt(v) } : { tag: "number", val: v }) : { tag: "date", val: BigInt(v.date) },
			})),
			fallback: t.fallback,
		},
	};
};
const space = (v: number | string | undefined) => (v === undefined ? undefined : typeof v === "number" ? { tag: "step", val: v } : { tag: "px", val: parseFloat(v) });
const dim = (v: number | string | undefined) => {
	if (v === undefined) return undefined;
	if (typeof v === "number") return { tag: "step", val: v };
	if (v === "auto" || v === "fill" || v === "content") return { tag: v };
	return v.endsWith("%") ? { tag: "percent", val: parseFloat(v) } : { tag: "px", val: parseFloat(v) };
};
const edges = (v: any) => {
	if (v === undefined) return undefined;
	if (typeof v !== "object") return { top: space(v), end: space(v), bottom: space(v), start: space(v) };
	return { top: space(v.top ?? v.y), end: space(v.end ?? v.x), bottom: space(v.bottom ?? v.y), start: space(v.start ?? v.x) };
};
const icon = (v: any) => (v === undefined ? undefined : typeof v === "string" ? { tag: "builtin", val: v } : v.bundled ? { tag: "bundled", val: v.bundled } : { tag: "svg", val: v.svg });
const color = (v: any) =>
	v === undefined
		? undefined
		: typeof v === "string" && v.startsWith("#")
			? hexColor(v)
			: typeof v === "string"
				? { tag: "token", val: v }
				: v.token
					? { tag: "token-alpha", val: v }
					: { tag: "themed", val: { light: hexU32(v.light), dark: hexU32(v.dark) } };

function toStyle(s: Record<string, any> = {}) {
	const o: Record<string, any> = {};
	for (const k of ["direction", "wrap", "alignItems", "justifyContent", "alignSelf", "flexGrow", "flexShrink", "overflow", "position", "radius", "opacity", "shadow", "cursor", "fontSize", "fontFamily", "fontWeight", "italic", "underline", "strike", "lineHeight", "textAlign", "textWrap", "maxLines", "aspectRatio", "zIndex"]) {
		if (s[k] !== undefined) o[k] = s[k];
	}
	if (s.gap !== undefined) o.gap = space(s.gap);
	for (const k of ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis"]) if (s[k] !== undefined) o[k] = dim(s[k]);
	for (const k of ["padding", "margin", "inset"]) if (s[k] !== undefined) o[k] = edges(s[k]);
	for (const k of ["background", "foreground"]) if (s[k] !== undefined) o[k] = color(s[k]);
	return o;
}

const run = (t: Text) => ({ text: plainText(t), bold: false, italic: false, underline: false, strike: false, mono: false });
const choice = (c: any) => ({ value: c.value, label: plainText(c.label), disabled: !!c.disabled });

function toKind(n: UiNode): { tag: string; val?: any } {
	switch (n.type) {
		case "box": case "card": case "spacer":
			return { tag: n.type };
		case "separator": return { tag: "separator", val: { orientation: n.orientation ?? "horizontal" } };
		case "group": return { tag: "group", val: { caption: plainText(n.caption) } };
		case "form": return { tag: "form", val: { busy: !!n.busy } };
		case "section":
			return { tag: "section", val: { title: plainText(n.title), icon: icon(n.icon), open: n.open, summary: plainText(n.summary), count: n.count, buttons: (n.buttons ?? []).map((b: any) => ({ id: b.id, icon: icon(b.icon), label: plainText(b.label), disabled: !!b.disabled, hidden: !!b.hidden })), persistKey: n.persistKey } };
		case "text": {
			const runs = n.runs ? n.runs.map((r: any) => ({ ...run(r.text), bold: !!r.bold, italic: !!r.italic, mono: !!r.mono })) : [run(n.text ?? "")];
			return { tag: "text", val: { kind: n.kind ?? "body", runs, selectable: !!n.selectable } };
		}
		case "callout": return { tag: "callout", val: { tone: n.tone ?? "info", title: plainText(n.title), message: plainText(n.message), icon: icon(n.icon), dismissible: !!n.dismissible } };
		case "badge": return { tag: "badge", val: { label: plainText(n.label), tone: n.tone ?? "neutral", color: color(n.color), icon: icon(n.icon), removable: !!n.removable } };
		case "progress": return { tag: "progress", val: { value: n.value, look: n.look ?? "bar", label: plainText(n.label) } };
		case "button": return { tag: "button", val: { label: plainText(n.label), icon: icon(n.icon), look: n.look ?? "standard", size: n.size ?? "md", pressed: n.pressed, loading: !!n.loading, menuMode: n.menuMode ?? "dropdown", submit: !!n.submit } };
		case "text-input": return { tag: "text-input", val: { value: n.value ?? "", placeholder: plainText(n.placeholder), kind: n.kind ?? "text", look: n.look ?? "field", multiline: !!n.multiline, minRows: n.minRows, maxRows: n.maxRows, maxLength: n.maxLength, readOnly: !!n.readOnly, selectOnFocus: !!n.selectOnFocus, clearButton: !!n.clearButton, spellcheck: !!n.spellcheck, prefixIcon: icon(n.prefixIcon) } };
		case "checkbox": return { tag: "checkbox", val: { label: plainText(n.label), checked: !!n.checked, indeterminate: !!n.indeterminate } };
		case "select": return { tag: "select", val: { options: (n.options ?? []).map(choice), value: n.value, placeholder: plainText(n.placeholder), multiple: !!n.multiple, values: n.values ?? [], searchable: !!n.searchable } };
		default:
			throw new Error(`toTree: node type "${n.type}" is not supported in typed trees; use the JSON form (ui.render) or add it to sdk/js/src/ui.ts`);
	}
}

/** Flatten the nested form into the typed WIT `tree` (for dialogs and windows). Supports the common node types. */
export function toTree(root: UiNode, rev = 0): { rev: bigint; root: number; nodes: unknown[]; styles: unknown[] } {
	const nodes: any[] = [];
	const push = (n: UiNode): number => {
		const idx = nodes.length;
		const events = Object.entries(n.on ?? {}).map(([event, b]) => {
			const o = typeof b === "string" ? { handler: b } : b;
			return { event, handler: o.handler, debounceMs: o.debounceMs, throttleMs: o.throttleMs, keys: o.keys ?? [], preventDefault: !!o.preventDefault, stopPropagation: !!o.stopPropagation };
		});
		nodes.push({
			props: { key: n.key, name: n.name, pref: n.pref, class: n.class ?? [], style: toStyle(n.style), events, a11y: { hidden: false }, tooltip: plainText(n.tooltip), disabled: !!n.disabled, hidden: !!n.hidden, autoFocus: !!n.autoFocus, testId: n.testId },
			kind: toKind(n),
			children: [],
		});
		nodes[idx].children = (n.children ?? []).map(push);
		return idx;
	};
	push(root);
	return fill("ui/Tree", { rev: BigInt(rev), root: 0, nodes, styles: [] }) as { rev: bigint; root: number; nodes: unknown[]; styles: unknown[] };
}

// ---- dialogs and toasts (thin wrappers over zinc:plugin/ui) ----------------------------------------------------------------

export interface DialogButtonDef {
	id: string;
	label: Text;
	role?: "accept" | "cancel" | "destructive" | "extra";
	disabled?: boolean;
	closes?: boolean;
	isDefault?: boolean;
}
export interface DialogOptions {
	width?: number;
	height?: number;
	resizable?: boolean;
	modal?: boolean;
	dismissOnEscape?: boolean;
}
export const button_ = (b: DialogButtonDef) => ({ id: b.id, label: plainText(b.label), role: b.role ?? "extra", disabled: !!b.disabled, closes: b.closes ?? true, isDefault: !!b.isDefault });

/** Build a `dialog-spec` for `ui.runDialog(spec)`. */
export function dialogSpec(title: Text, content: UiNode, buttons: DialogButtonDef[], o: DialogOptions = {}) {
	return fill("ui/DialogSpec", {
		title: plainText(title),
		content: toTree(content),
		buttons: buttons.map(button_),
		width: o.width ?? 420,
		height: o.height,
		resizable: !!o.resizable,
		modal: o.modal ?? true,
		dismissOnEscape: o.dismissOnEscape ?? true,
	});
}

/** The value of a named form field from a `dialog-outcome.values` / `ui-event` form payload. `undefined` if absent. */
export function fieldValue(values: { name: string; value: { tag: string; val?: unknown } }[], name: string): string | number | boolean | string[] | undefined {
	const f = values.find((v) => v.name === name);
	return f?.value.val as any;
}

export const toastSpec = (title: Text, message: Text, tone: "neutral" | "info" | "success" | "warning" | "error" = "info", durationMs = 4000) =>
	fill("ui/ToastSpec", {
		title: plainText(title),
		lines: [{ text: plainText(message), tone }],
		tone,
		durationMs,
		actions: [],
	});

export { plainText };
