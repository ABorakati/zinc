// UI trees, patches, dialogs and toasts for JS guests.
//
// Builders produce the nested JSON form (`plugin-api/ui-schema/ui-tree.schema.json`), which is used everywhere across the WIT
// boundary (`content-update.json`, `content-update.patch`, `dialog-spec.content`, `window-spec.content`, `row.content`, `cell.content`).
//
//   const view = ui.column({ style: { gap: 2 } }, ui.heading("Tags"), ui.button("Apply", { on: { press: "apply" } }));
//   return ui.render(view);                                           // a render-result for mount / on-event
//   const out = await ui.dialog(ui.dialogSpec("Add tags", view, ...)); // opens via open-dialog, resolves on its close event

import { fill } from "./defaults";

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

const withText = (type: string, extra: Record<string, any>, _text: Text, props: Record<string, any>, kids: Child[]) =>
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

// ---- results & JSON serialization ----------------------------------------------------------------------------------

export interface RenderResult {
	content: { tag: "unchanged" } | { tag: "json"; val: string } | { tag: "patch"; val: string };
	meta?: unknown;
	focus?: string;
}

/** Serialize a root `UiNode` into a JSON tree string (`$defs.tree` in `ui-tree.schema.json`). */
export function treeJson(root: UiNode, extra: { rev?: number; styles?: unknown[] } = {}): string {
	const tree: Record<string, unknown> = { root };
	if (extra.rev !== undefined) tree.rev = extra.rev;
	if (extra.styles) tree.styles = extra.styles;
	return JSON.stringify(tree);
}

/** A `render-result` carrying the whole tree in the nested JSON form. */
export function render(root: UiNode, extra: { rev?: number; focus?: string; styles?: unknown[]; meta?: unknown } = {}): RenderResult {
	return { content: { tag: "json", val: treeJson(root, extra) }, meta: extra.meta, focus: extra.focus };
}

export type PatchOpJson =
	| { op: "set-node"; key: string; node: UiNode }
	| { op: "replace"; key: string; node: UiNode; styles?: unknown[] }
	| { op: "insert"; parent: string; index: number; node: UiNode; styles?: unknown[] }
	| { op: "remove"; key: string }
	| { op: "move"; key: string; parent: string; index: number }
	| { op: "set-styles"; styles: unknown[] };

/** A `render-result` carrying an incremental JSON patch set (`$defs.patchSet` in `ui-tree.schema.json`). */
export function patch(baseRev: number, rev: number, ops: PatchOpJson[], extra: { focus?: string; meta?: unknown } = {}): RenderResult {
	return { content: { tag: "patch", val: JSON.stringify({ baseRev, rev, ops }) }, meta: extra.meta, focus: extra.focus };
}

export const unchanged = (): RenderResult => ({ content: { tag: "unchanged" } });

// ---- WIT localized-string helper -----------------------------------------------------------------------------------

export const plainText = (t: Text | undefined) => {
	if (t === undefined) return undefined;
	if (typeof t === "string") return { tag: "plain", val: t };
	return {
		tag: "localized",
		val: {
			id: t.id,
			args: Object.entries(t.args ?? {}).map(([name, v]) => ({
				name,
				value:
					typeof v === "string"
						? { tag: "text", val: v }
						: typeof v === "number"
							? Number.isInteger(v)
								? { tag: "integer", val: BigInt(v) }
								: { tag: "number", val: v }
							: { tag: "date", val: BigInt(v.date) },
			})),
			fallback: t.fallback,
		},
	};
};

// ---- dialogs and toasts (thin wrappers over zinc:plugin/ui) --------------------------------------------------------

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
export interface DialogOutcome {
	button?: string;
	values: { name: string; value: { tag: string; val?: unknown } }[];
}

export const button_ = (b: DialogButtonDef) => ({
	id: b.id,
	label: plainText(b.label),
	role: b.role ?? "extra",
	disabled: !!b.disabled,
	closes: b.closes ?? true,
	isDefault: !!b.isDefault,
});

/** Build a `dialog-spec` for `ui.dialog(spec)` / `zui.openDialog(spec)`. `content` is serialized to JSON. */
export function dialogSpec(title: Text, content: UiNode | string, buttons: DialogButtonDef[], o: DialogOptions = {}) {
	return fill("ui/DialogSpec", {
		title: plainText(title),
		content: typeof content === "string" ? content : treeJson(content),
		buttons: buttons.map(button_),
		width: o.width ?? 420,
		height: o.height,
		resizable: !!o.resizable,
		modal: o.modal ?? true,
		dismissOnEscape: o.dismissOnEscape ?? true,
	});
}

type OpenDialogFn = (spec: any) => bigint | number;
let defaultOpenDialog: OpenDialogFn | undefined;

/** Set the `ui.openDialog` implementation used by `ui.dialog()` (wired automatically by `sdk/js/scripts/build.ts`). */
export function setDialogOpener(fn: OpenDialogFn | { openDialog: OpenDialogFn } | undefined): void {
	defaultOpenDialog = typeof fn === "function" ? fn : fn?.openDialog;
}

interface PendingDialog {
	button?: string;
	resolve: (outcome: DialogOutcome) => void;
}
const pendingDialogs = new Map<string, PendingDialog>();

/**
 * Open a dialog with `ui.open-dialog` and return a Promise that resolves with `{ button, values }` when the dialog's
 * `close` event arrives in `ui-events.on-event` (routed automatically by `definePlugin`).
 */
export function dialog(spec: Record<string, unknown>, openFn?: OpenDialogFn | { openDialog: OpenDialogFn }): Promise<DialogOutcome> {
	const opener = typeof openFn === "function" ? openFn : openFn?.openDialog ?? defaultOpenDialog ?? (globalThis as any).__zincOpenDialog;
	if (!opener) throw new Error("ui.dialog: no openDialog function available (pass zui or build with sdk/js/scripts/build.ts)");
	const id = opener(spec);
	const key = String(id);
	const callbacks: ((outcome: DialogOutcome) => void)[] = [];
	let settled: DialogOutcome | undefined;
	const p = new Promise<DialogOutcome>((res) => {
		pendingDialogs.set(key, {
			button: undefined,
			resolve(outcome) {
				settled = outcome;
				res(outcome);
				for (const cb of callbacks.splice(0)) cb(outcome);
			},
		});
	});
	// Also run `.then(onFulfilled)` synchronously inside `on-event` if the guest runtime does not pump microtasks between calls.
	const origThen = p.then.bind(p);
	(p as any).then = (onFulfilled?: (v: DialogOutcome) => any, onRejected?: (e: any) => any) => {
		if (!onFulfilled) return origThen(undefined, onRejected);
		if (settled !== undefined) {
			try {
				return Promise.resolve(onFulfilled(settled));
			} catch (e) {
				return Promise.reject(e);
			}
		}
		return new Promise((res, rej) => {
			callbacks.push((outcome) => {
				try {
					res(onFulfilled(outcome));
				} catch (e) {
					if (onRejected) res(onRejected(e));
					else rej(e);
				}
			});
		});
	};
	return p;
}

/** Internal: called by `definePlugin`'s `uiEvents.onEvent` wrapper to resolve dialogs opened with `ui.dialog()`. */
export function dispatchDialogEvent(instance: bigint | number | string, event: any): boolean {
	const key = String(instance);
	const entry = pendingDialogs.get(key);
	if (!entry || event?.kind !== "close") return false;
	const p = event.payload;
	if (p?.tag === "button") {
		entry.button = p.val;
		return true;
	}
	if (p?.tag === "none") {
		entry.button = undefined;
		return true;
	}
	if (p?.tag === "form") {
		pendingDialogs.delete(key);
		const button = entry.button ?? (event.handler ? String(event.handler) : undefined);
		entry.resolve({ button, values: p.val ?? [] });
		return true;
	}
	return false;
}

/** The value of a named form field from `DialogOutcome.values` or a `ui-event` form payload. `undefined` if absent. */
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
