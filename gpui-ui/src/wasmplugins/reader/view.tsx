// A plugin's ui view inside the reader (toolbar strip, selection popup, annotation header, sidebar panel, note head, item pane
// section). The ui area's `PluginView` (wasmplugins/ui/index.ts) does the real work: mount, patches, events, unmount. Until that
// module exists the stand-in below mounts the view itself and shows the text of what the plugin rendered, so the reader hooks can
// be checked without the ui area.
import { createComponent, createEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { readerMode } from "../../reader/env";
import { callPlugin, queuedSupervisor } from "./link";

export type ViewSurface = "toolbar-slot" | "popover" | "reader-sidebar" | "reader-overlay" | "item-pane-section";

export interface WasmViewProps {
	/** the plugin id */
	plugin: string;
	/** `view-context.view`: the id the plugin registered */
	view: string;
	surface: ViewSurface;
	/** `view-context.params` as an object (the view serialises it). A function is read reactively: a change calls `update-context`. */
	params: () => Record<string, unknown>;
	width?: number;
	height?: number;
}

// ---- the ui area's component, if it is there ----
type PluginViewComponent = (p: Record<string, unknown>) => JSX.Element;
const [uiView, setUiView] = createSignal<PluginViewComponent | undefined>(undefined);
const [settled, setSettled] = createSignal(false);
let tried = false;
/** Look for `PluginView` in wasmplugins/ui once (a variable specifier: the module may not exist yet). */
export function loadUiModule(): void {
	if (tried) return;
	tried = true;
	const spec: string = "../ui/index";
	void import(spec).then(
		(m: Record<string, unknown>) => {
			if (typeof m.PluginView === "function") setUiView(() => m.PluginView as PluginViewComponent);
			setSettled(true);
		},
		() => setSettled(true),
	);
}
/** Tests: use this component instead of the ui area's. */
export const setPluginViewComponent = (c: PluginViewComponent | undefined): void => {
	tried = true;
	setUiView(() => c);
	setSettled(true);
};

let seq = 0n;

/** Params as plain JSON data: WIT records carry u64 as bigint (annotation dates), which JSON cannot hold. */
export const jsonSafe = (v: unknown): Record<string, unknown> =>
	JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x))) as Record<string, unknown>;

/** The `view-context` of ui.wit in jco's shape. */
export function viewContext(p: WasmViewProps) {
	return {
		view: p.view,
		surface: p.surface,
		params: JSON.stringify(jsonSafe(untrack(p.params))),
		theme: readerMode()() === "dark" ? "dark" : "light",
		width: p.width,
		height: p.height,
		locale: "en",
	};
}

/** Every string a rendered tree shows (the stand-in's only output). Handles the JSON form and the typed form. */
export function textOfRender(r: unknown): string {
	const out: string[] = [];
	const walk = (v: unknown, key?: string) => {
		if (typeof v === "string") {
			if (key && /^(text|label|value|title|content|plain)$/.test(key)) out.push(v);
			return;
		}
		if (Array.isArray(v)) return void v.forEach((x) => walk(x, key));
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (o.tag === "plain" && typeof o.val === "string") return void out.push(o.val);
			for (const [k, x] of Object.entries(o)) walk(x, k);
		}
	};
	const rr = r as { content?: { tag?: string; val?: unknown } } | undefined;
	let val = rr?.content?.val;
	if (rr?.content?.tag === "json" && typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch {
			/* keep the string */
		}
	}
	walk(val);
	return out.join(" ");
}

function StandInView(p: WasmViewProps): JSX.Element {
	const instance = 0x7e000000n + ++seq; // instance-id is a u64; far from the ui area's own ids
	const [text, setText] = createSignal("");
	let mounted = false;
	let gone = false;
	let chain: Promise<unknown> = Promise.resolve();
	createEffect(() => {
		const ctx = viewContext(p); // reads p.params()
		const fn = mounted ? "update-context" : "mount";
		mounted = true;
		chain = chain
			.then(() => (gone ? undefined : callPlugin(p.plugin, "ui-events", fn, [instance, ctx])))
			.then((r) => {
				if (r !== undefined && !gone) setText(textOfRender(r));
			})
			.catch((e) => console.error(`[wasm-reader] ${p.plugin} ui-events.${fn}:`, e instanceof Error ? e.message : e));
	});
	onCleanup(() => {
		gone = true;
		if (mounted) void chain.then(() => callPlugin(p.plugin, "ui-events", "unmount", [instance])).catch(() => {});
	});
	return <text style={{ color: readerMode()() === "dark" ? "#e8e6e1" : "#1c1c1a", fontSize: 12, whiteSpace: "nowrap" }}>{text()}</text>;
}

/** Mount a plugin view. */
export function WasmView(p: WasmViewProps): JSX.Element {
	loadUiModule();
	return (() => {
		if (!settled()) return undefined; // do not mount twice (first the stand-in, then the real view)
		const PV = uiView();
		if (!PV) return createComponent(StandInView, p);
		// the ui area's component; props under both spellings so it can take either (see phase2-reader.md "Needs")
		return createComponent(PV, {
			get plugin() {
				return p.plugin;
			},
			supervisor: queuedSupervisor,
			get pluginId() {
				return p.plugin;
			},
			get view() {
				return p.view;
			},
			get surface() {
				return p.surface;
			},
			get params() {
				return jsonSafe(p.params());
			},
			get width() {
				return p.width;
			},
			get height() {
				return p.height;
			},
		});
	}) as unknown as JSX.Element;
}
