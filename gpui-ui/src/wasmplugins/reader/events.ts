// `reader.subscribe`: watches the open readers and delivers `reader-events.on-reader-event` to the plugins that asked for the kind.
// opened / closed come from reader/plugins.ts `openReaders`; the rest from signals of each reader (page, selection) and of its
// annotation session (selected annotation, tool, the list). Events of one kind to one plugin are delivered in order, one at a time.
import { createEffect, createRoot, on, onCleanup, untrack } from "solid-js";
import { pageLabelFor, type Annotation } from "../../reader/annotations/model";
import { sessionOf, type Session } from "../../reader/annotations/session";
import { openReaders, type ReaderContext } from "../../reader/plugins";
import { opsOf } from "../../reader/ops";
import { infoOf, readerApp } from "./host";
import { callPlugin } from "./link";
import { subscribers } from "./registry";
import type { EventKind, ItemRef, ReaderEvent, ReaderInfo, ToolState } from "./types";
import { witSelectionOf } from "./bridge";

const chains = new Map<string, Promise<unknown>>();
function deliver(plugin: string, kind: EventKind, event: ReaderEvent): void {
	const k = `${plugin}\u0000${kind}`;
	const next = (chains.get(k) ?? Promise.resolve())
		.then(() => callPlugin(plugin, "reader-events", "on-reader-event", [event]))
		.catch((e) => console.error(`[wasm-reader] ${plugin} on-reader-event ${kind}:`, e instanceof Error ? e.message : e));
	chains.set(k, next);
}

/** Send an event to every plugin subscribed to `kind`. `make` builds the plugin's own copy (annotations-changed differs per plugin). */
export function emit(kind: EventKind, make: (plugin: string) => ReaderEvent): void {
	for (const plugin of subscribers(kind)) deliver(plugin, kind, make(plugin));
}

// ---- own writes: `annotations` calls of a plugin mark the change as theirs ----
let own: { plugin: string; attachment: string } | undefined;
/** Run `fn` (a store mutation) as `plugin`'s: the annotations-changed event it causes carries by-this-plugin for that plugin. */
export function withOwn<T>(plugin: string, attachment: string, fn: () => T): T {
	const prev = own;
	own = { plugin, attachment };
	try {
		return fn();
	} finally {
		own = prev;
	}
}

export interface AnnotationsChange {
	attachment: ItemRef;
	added: string[];
	modified: string[];
	removed: string[];
}
/** Deliver an annotations-changed batch (also used for writes to an attachment with no open reader). */
export function emitAnnotationsChange(c: AnnotationsChange, by?: string): void {
	if (!c.added.length && !c.modified.length && !c.removed.length) return;
	emit("annotations-changed", (plugin) => ({ tag: "annotations-changed", val: { ...c, byThisPlugin: plugin === by } }));
}

const toolOf = (s: Session): ToolState => ({ kind: (s.ui.tool() ?? "pointer") as ToolState["kind"], color: s.ui.color() });

function watchReader(c: ReaderContext): () => void {
	return createRoot((dispose) => {
		const id = c.attachmentKey;
		// page
		let pageTimer: ReturnType<typeof setTimeout> | undefined;
		createEffect(
			on(
				() => c.currentPage(),
				(page) => {
					clearTimeout(pageTimer);
					pageTimer = setTimeout(() => {
						const labels = sessionOf(id)?.store.list() ?? [];
						emit("page-changed", () => ({ tag: "page-changed", val: { reader: id, pageIndex: page, pageLabel: pageLabelFor(page, labels) } }));
					}, 200);
				},
				{ defer: true },
			),
		);
		// selection: sent once the selection is final (the reader sets it when the pointer is released)
		createEffect(
			on(
				() => c.selection(),
				(sel) => {
					const selection = sel ? witSelectionOf(c) : undefined;
					emit("selection-changed", () => ({ tag: "selection-changed", val: { reader: id, selection } }));
				},
				{ defer: true },
			),
		);
		// view state: at most once a second
		let vsTimer: ReturnType<typeof setTimeout> | undefined;
		let vsLast = 0;
		createEffect(
			on(
				() => {
					const s = opsOf(c)?.state();
					return s ? `${s.page}|${s.zoom}|${s.zoomMode}|${s.scroll}|${s.spread}|${s.rotation}` : "";
				},
				(k) => {
					if (!k) return;
					clearTimeout(vsTimer);
					const wait = Math.max(0, 1000 - (Date.now() - vsLast));
					vsTimer = setTimeout(() => {
						vsLast = Date.now();
						emit("view-state-changed", () => ({ tag: "view-state-changed", val: id }));
					}, wait);
				},
				{ defer: true },
			),
		);
		// the annotation session appears when the annotations plugin opens (a moment after the document): attach once it is there
		let attached = false;
		const attach = (s: Session) => {
			attached = true;
			createEffect(
				on(
					() => s.ui.selectedId(),
					(sel) => {
						const keys = sel ? [sel] : [];
						emit("annotations-selected", () => ({ tag: "annotations-selected", val: { reader: id, keys } }));
					},
					{ defer: true },
				),
			);
			createEffect(
				on(
					() => `${s.ui.tool()}|${s.ui.color()}`,
					() => {
						const tool = toolOf(s);
						emit("tool-changed", () => ({ tag: "tool-changed", val: { reader: id, tool } }));
					},
					{ defer: true },
				),
			);
			// the list: diff by object identity (the store replaces an annotation when it changes). The first load is the baseline.
			let base: Map<string, Annotation> | undefined;
			createEffect(() => {
				if (!s.store.loaded()) return;
				const now = new Map(s.store.list().map((a) => [a.id, a]));
				const prev = base;
				base = now;
				if (!prev) return;
				const added = [...now.keys()].filter((k) => !prev.has(k));
				const removed = [...prev.keys()].filter((k) => !now.has(k));
				const modified = [...now].filter(([k, a]) => prev.has(k) && prev.get(k) !== a).map(([k]) => k);
				const by = own && own.attachment === id ? own.plugin : undefined;
				const info = untrack(() => infoOf(c));
				emitAnnotationsChange({ attachment: info.attachment, added, modified, removed }, by);
			});
		};
		const poll = setInterval(() => {
			const s = sessionOf(id);
			if (!s || attached) return;
			clearInterval(poll);
			createRoot(() => attach(s));
		}, 100);
		onCleanup(() => {
			clearInterval(poll);
			clearTimeout(pageTimer);
			clearTimeout(vsTimer);
		});
		return dispose;
	});
}

let stop: (() => void) | undefined;
/** Start watching the readers. Idempotent; returns the stop function. */
export function startReaderEvents(): () => void {
	if (stop) return stop;
	const watchers = new Map<ReaderContext, () => void>();
	const infos = new Map<ReaderContext, ReaderInfo>();
	const dispose = createRoot((d) => {
		createEffect(() => {
			const list = openReaders();
			untrack(() => {
				for (const c of list)
					if (!watchers.has(c)) {
						watchers.set(c, watchReader(c));
						infos.set(c, infoOf(c));
						const info = infoOf(c);
						emit("opened", () => ({ tag: "opened", val: info }));
					}
				for (const [c, w] of [...watchers])
					if (!list.includes(c)) {
						w();
						watchers.delete(c);
						const info = infos.get(c) ?? infoOf(c);
						infos.delete(c);
						emit("closed", () => ({ tag: "closed", val: info }));
					}
			});
		});
		let prevTab: string | undefined;
		createEffect(() => {
			const tab = readerApp().activeTab?.();
			if (tab === prevTab) return;
			prevTab = tab;
			const c = tab ? openReaders().find((x) => x.attachmentKey === tab) : undefined;
			if (c) {
				const info = infoOf(c);
				emit("tab-selected", () => ({ tag: "tab-selected", val: info }));
			}
		});
		return d;
	});
	stop = () => {
		for (const w of watchers.values()) w();
		watchers.clear();
		dispose();
		stop = undefined;
	};
	return stop;
}
