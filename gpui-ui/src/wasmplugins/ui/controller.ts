// One mounted plugin view: its tree (a Solid store, reconciled by node id so GPUIX only touches what changed), the event path to the
// plugin (`ui-events.on-event`, serialized per view, with debounce/throttle from the bindings), `ui.push` batching, patches,
// virtual-row caches, suggestions and the values of named inputs. No GPUIX here: PluginView/render.tsx draw it.
import { batch } from "solid-js";
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store";
import { applyPatch, buildNested, jsonToTree, resolveBatchRows, TreeError } from "./convert";
import type {
	EventBinding,
	EventKind,
	EventPayloadValue,
	FormField,
	Modifiers,
	NamedStyle,
	RenderResult,
	Row,
	RowBatch,
	SortSpec,
	Suggestion,
	Tree,
	UiSupervisor,
	UiValue,
	ViewContext,
	ViewMeta,
	VNode,
} from "./types";

export type ViewStatus = "idle" | "mounting" | "ready" | "error" | "unresponsive" | "gone";

export interface RowCache {
	total?: number;
	rows: Record<number, Row>;
}

export interface ViewState {
	root?: VNode;
	styles: Record<string, NamedStyle>;
	rev: bigint;
	meta?: ViewMeta;
	status: ViewStatus;
	/** Why the status is `error` or `unresponsive` (or a note about the last bad update; the last good tree stays). */
	message?: string;
	/** Virtual rows per node id. */
	rowCache: Record<string, RowCache>;
	/** Bumped on every `refresh`/apply of content that may change what virtual nodes show. */
	generation: number;
}

export const NO_MODS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

/** Payload builders (jco variants). */
export const P = {
	none: { tag: "none" } as EventPayloadValue,
	value: (v: UiValue): EventPayloadValue => ({ tag: "value", val: v }),
	text: (s: string): EventPayloadValue => ({ tag: "value", val: { tag: "text", val: s } }),
	number: (n: number): EventPayloadValue => ({ tag: "value", val: { tag: "number", val: n } }),
	texts: (s: string[]): EventPayloadValue => ({ tag: "value", val: { tag: "texts", val: s } }),
	color: (s: string): EventPayloadValue => ({ tag: "value", val: { tag: "color", val: s } }),
	toggled: (b: boolean): EventPayloadValue => ({ tag: "toggled", val: b }),
	selection: (ids: string[]): EventPayloadValue => ({ tag: "selection", val: ids }),
	row: (row: string, column?: string): EventPayloadValue => ({ tag: "row", val: { row, column } }),
	sort: (s: SortSpec): EventPayloadValue => ({ tag: "sort", val: s }),
	sizes: (s: number[]): EventPayloadValue => ({ tag: "sizes", val: s }),
	tab: (key: string): EventPayloadValue => ({ tag: "tab", val: key }),
	button: (id: string): EventPayloadValue => ({ tag: "button", val: id }),
	form: (f: FormField[]): EventPayloadValue => ({ tag: "form", val: f }),
	key: (key: string, repeat: boolean): EventPayloadValue => ({ tag: "key", val: { key, repeat } }),
	message: (json: string): EventPayloadValue => ({ tag: "message", val: json }),
	pointer: (x: number, y: number, o: { button?: number; hit?: string; row?: string; column?: string; deltaX?: number; deltaY?: number } = {}): EventPayloadValue => ({
		tag: "pointer",
		val: { x, y, button: o.button ?? 0, deltaX: o.deltaX ?? 0, deltaY: o.deltaY ?? 0, hit: o.hit, row: o.row, column: o.column },
	}),
	scroll: (x: number, y: number, progressY: number): EventPayloadValue => ({ tag: "scroll", val: { x, y, progressY } }),
	viewBox: (x: number, y: number, width: number, height: number, zoom: number): EventPayloadValue => ({ tag: "view-box", val: { x, y, width, height, zoom } }),
};

let nextInstance = 1n;
/** Instance ids: host-allocated, unique across plugins. */
export const allocInstance = (): bigint => nextInstance++;

const registry = new Map<string, ViewController>();
export const lookupInstance = (instance: bigint | number | string): ViewController | undefined => registry.get(String(instance));
export const allControllers = (): ViewController[] => [...registry.values()];

export interface ControllerHooks {
	focus?: (el: unknown) => void;
	scrollTo?: (el: unknown, align: string) => void;
}

interface Timer {
	handle?: ReturnType<typeof setTimeout>;
	last: number;
}

const PUSH_INTERVAL_MS = 33; // at most 30 `push` per second per instance (ui.md "Host limits"); extra pushes are merged into one frame

export class ViewController {
	readonly instance: bigint;
	readonly state: ViewState;
	private setState: SetStoreFunction<ViewState>;
	/** Painted elements by node id (popover anchors, `ui.focus`, `popup-menu` at a node). */
	readonly els = new Map<string, unknown>();
	/** Current values of named inputs (and the form each sits in). */
	readonly fields = new Map<string, UiValue>();
	private fieldForm = new Map<string, string | undefined>();
	hooks: ControllerHooks = {};
	ctx: ViewContext;
	onMeta?: (m: ViewMeta) => void;
	onFocusRequest?: (key: string) => void;
	/** Enter in a single-line input that is not in a form (a dialog presses its default button). */
	onDefaultAction?: () => void;
	/** The view asked to be closed (a dialog's `close-dialog`). */
	onStatus?: (s: ViewStatus) => void;
	private chain: Promise<unknown> = Promise.resolve();
	private timers = new Map<string, Timer>();
	private queued: RenderResult[] = [];
	private pushTimer: ReturnType<typeof setTimeout> | undefined;
	private rangeTimer: ReturnType<typeof setTimeout> | undefined;
	private wanted = new Map<string, { node: VNode; need: Set<number>; sort?: SortSpec }>();
	private requested = new Map<string, Set<number>>();
	private destroyed = false;
	private mounted = false;

	constructor(
		readonly pluginId: string,
		readonly sup: UiSupervisor,
		ctx: Omit<ViewContext, "params"> & { params?: unknown },
		instance?: bigint,
	) {
		this.instance = instance ?? allocInstance();
		this.ctx = { ...ctx, params: typeof ctx.params === "string" ? ctx.params : JSON.stringify(ctx.params ?? {}) };
		const [state, setState] = createStore<ViewState>({ styles: {}, rev: 0n, status: "idle", rowCache: {}, generation: 0 });
		this.state = state;
		this.setState = setState;
		registry.set(String(this.instance), this);
	}

	// ------------------------------------------------------------------------------------------------ calls into the plugin

	private async call<T>(fn: string, args: unknown[]): Promise<T | undefined> {
		try {
			return (await this.sup.call(this.pluginId, "ui-events", fn, args)) as T;
		} catch (e) {
			this.fail(e);
			return undefined;
		}
	}

	private enqueue<T>(job: () => Promise<T>): Promise<T | undefined> {
		const run = this.chain.then(job, job);
		this.chain = run.catch(() => undefined);
		return run.catch(() => undefined);
	}

	private fail(e: unknown) {
		if (this.destroyed) return;
		const err = e as { kind?: string; message?: string; payload?: { tag?: string; val?: unknown } };
		const kind = err.kind ?? "internal";
		const msg = err.message ?? String(e);
		if (kind === "timeout" || kind === "disabled" || kind === "host-restarting" || kind === "not-loaded" || kind === "trap") {
			this.setStatus("unresponsive", msg);
		} else if (kind === "wit") {
			// The plugin answered with `err(...)` (for example from `mount`): say so, but the previous tree stays.
			this.setStatus(this.state.root ? "ready" : "error", msg, true);
		} else this.setStatus("error", msg);
	}

	private setStatus(status: ViewStatus, message?: string, keepStatus = false) {
		batch(() => {
			if (!keepStatus || !this.state.root) this.setState("status", status);
			this.setState("message", message);
		});
		this.onStatus?.(status);
	}

	/** Mount the view: `ui-events.mount`, then show what it returns. Safe to call again after a plugin host restart. */
	async mount(): Promise<void> {
		this.setStatus("mounting");
		const r = await this.enqueue(() => this.call<RenderResult>("mount", [this.instance, this.ctx]));
		if (this.destroyed) return;
		if (r) {
			this.mounted = true;
			this.apply(r);
			if (this.state.status === "mounting") this.setStatus("ready");
		}
	}

	/** Show an initial tree before the plugin's `mount` answers (dialogs carry their content in the spec). */
	showInitial(tree: Tree): void {
		this.applyContent({ tag: "full", val: tree });
		this.setStatus("ready");
	}

	updateContext(patch: Partial<Omit<ViewContext, "params">> & { params?: unknown }): Promise<void> {
		const next = { ...this.ctx, ...patch, params: patch.params === undefined ? this.ctx.params : typeof patch.params === "string" ? patch.params : JSON.stringify(patch.params) };
		const same = JSON.stringify({ ...next, _: 0 }) === JSON.stringify({ ...this.ctx, _: 0 });
		this.ctx = next as ViewContext;
		if (same || !this.mounted) return Promise.resolve();
		return this.enqueue(async () => {
			const r = await this.call<RenderResult>("update-context", [this.instance, this.ctx]);
			if (r && !this.destroyed) this.apply(r);
		}) as Promise<void>;
	}

	/** `ui.refresh`: ask the plugin for the view again with the current context. */
	refreshContext(): Promise<void> {
		return this.enqueue(async () => {
			const r = await this.call<RenderResult>("update-context", [this.instance, this.ctx]);
			if (r && !this.destroyed) this.apply(r);
		}) as Promise<void>;
	}

	setVisible(visible: boolean): void {
		if (!this.mounted) return;
		void this.enqueue(() => this.call("visibility", [this.instance, visible]));
	}

	async unmount(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		registry.delete(String(this.instance));
		for (const t of this.timers.values()) if (t.handle) clearTimeout(t.handle);
		if (this.pushTimer) clearTimeout(this.pushTimer);
		if (this.rangeTimer) clearTimeout(this.rangeTimer);
		this.timers.clear();
		this.queued = [];
		if (this.mounted) {
			try {
				await this.sup.call(this.pluginId, "ui-events", "unmount", [this.instance]);
			} catch {
				/* the plugin is gone or has no UI */
			}
		}
		this.setState("status", "gone");
	}

	/** The plugin host restarted: the plugin lost its state. Mount again with the same instance id. */
	async remount(): Promise<void> {
		if (this.destroyed) return;
		this.requested.clear();
		await this.mount();
	}

	// ------------------------------------------------------------------------------------------------ applying updates

	/** `ui.push`: queued and applied at most once per frame, in order. */
	push(update: RenderResult): void {
		if (this.destroyed) return;
		this.queued.push(update);
		if (this.pushTimer) return;
		this.pushTimer = setTimeout(() => {
			this.pushTimer = undefined;
			const q = this.queued;
			this.queued = [];
			batch(() => {
				for (const u of q) this.apply(u);
			});
		}, PUSH_INTERVAL_MS);
	}

	/** Apply a render-result now. */
	apply(r: RenderResult): void {
		if (this.destroyed) return;
		batch(() => {
			this.applyContent(r.content);
			if (r.meta) {
				this.setState("meta", r.meta);
				this.onMeta?.(r.meta);
			}
		});
		if (r.focus) this.focusKey(r.focus);
	}

	private applyContent(c: RenderResult["content"]): void {
		try {
			switch (c.tag) {
				case "unchanged":
					return;
				case "full":
					return this.setTree(c.val);
				case "json":
					return this.setTree(jsonToTree(c.val));
				case "patch": {
					if (c.val.baseRev !== this.state.rev) {
						// The plugin patched a tree the host does not have: drop it and ask for the whole tree.
						void this.enqueue(async () => {
							const r = await this.call<RenderResult>("resync", [this.instance]);
							if (r && !this.destroyed) this.apply(r);
						});
						return;
					}
					let ok = true;
					this.setState(
						produce((s) => {
							if (!s.root) {
								ok = false;
								return;
							}
							ok = applyPatch(s.root, s.styles, c.val);
							s.rev = c.val.rev;
						}),
					);
					if (!ok) void this.resync();
					else this.bump();
					return;
				}
			}
		} catch (e) {
			if (e instanceof TreeError) {
				// invalid tree from the plugin: keep the last good one and say what was wrong
				this.setState("message", `the plugin sent an invalid UI tree: ${e.message}`);
				return;
			}
			throw e;
		}
	}

	private resync() {
		return this.enqueue(async () => {
			const r = await this.call<RenderResult>("resync", [this.instance]);
			if (r && !this.destroyed) this.apply(r);
		});
	}

	private setTree(tree: Tree) {
		const root = buildNested(tree);
		const styles: Record<string, NamedStyle> = {};
		for (const s of tree.styles) styles[s.name] = s;
		batch(() => {
			this.setState("root", reconcile(root, { key: "id", merge: false }));
			this.setState("styles", reconcile(styles, { merge: false }));
			this.setState("rev", tree.rev);
			this.setState("message", undefined);
			this.bump();
		});
	}

	private bump() {
		this.setState("generation", (g) => g + 1);
	}

	// ------------------------------------------------------------------------------------------------ events out

	/** Does `node` have a binding for this kind? */
	static bindings(node: VNode, kind: EventKind): EventBinding[] {
		return node.props.events.filter((b) => b.event === kind);
	}
	has(node: VNode, kind: EventKind): boolean {
		return node.props.events.some((b) => b.event === kind);
	}

	/**
	 * Deliver an event to the plugin for each binding of `kind` on `node`, honouring `debounce-ms` and `throttle-ms`. Returns true if
	 * there was a binding. `keys` filters key events (`matchKey` decides).
	 */
	fire(node: VNode, kind: EventKind, payload: EventPayloadValue = P.none, mods: Modifiers = NO_MODS, keyName?: string): boolean {
		let any = false;
		for (const b of node.props.events) {
			if (b.event !== kind) continue;
			if ((kind === "key-down" || kind === "key-up") && b.keys.length && !(keyName && matchKey(b.keys, keyName, mods))) continue;
			any = true;
			this.deliver(b, node.props.key, kind, payload, mods, `${node.id}|${kind}|${b.handler}`);
		}
		return any;
	}

	/** An event that is not tied to a node binding (a section header button, a toast action, a dialog button). */
	fireRaw(handler: string, kind: EventKind, payload: EventPayloadValue = P.none, nodeKey?: string): Promise<void> {
		return this.send({ handler, nodeKey, kind, modifiers: NO_MODS, payload, rev: this.state.rev });
	}

	private deliver(b: EventBinding, nodeKey: string | undefined, kind: EventKind, payload: EventPayloadValue, mods: Modifiers, timerKey: string) {
		const send = () => void this.send({ handler: b.handler, nodeKey, kind, modifiers: mods, payload, rev: this.state.rev });
		const now = Date.now();
		let t = this.timers.get(timerKey);
		if (!t) this.timers.set(timerKey, (t = { last: 0 }));
		if (b.debounceMs) {
			if (t.handle) clearTimeout(t.handle);
			t.handle = setTimeout(() => {
				t!.handle = undefined;
				send();
			}, b.debounceMs);
			return;
		}
		if (b.throttleMs) {
			if (now - t.last >= b.throttleMs) {
				t.last = now;
				send();
			} else {
				// trailing call with the latest payload
				if (t.handle) clearTimeout(t.handle);
				t.handle = setTimeout(() => {
					t!.handle = undefined;
					t!.last = Date.now();
					send();
				}, b.throttleMs - (now - t.last));
			}
			return;
		}
		send();
	}

	private send(event: Parameters<ViewController["sendNow"]>[0]): Promise<void> {
		return this.enqueue(() => this.sendNow(event)) as Promise<void>;
	}
	private async sendNow(event: { handler: string; nodeKey?: string; kind: EventKind; modifiers: Modifiers; payload: EventPayloadValue; rev: bigint }) {
		if (this.destroyed) return;
		const r = await this.call<RenderResult>("on-event", [this.instance, event]);
		if (r && !this.destroyed) this.apply(r);
	}

	// ------------------------------------------------------------------------------------------------ pulled data

	/** `ui-events.suggest` (not serialized with events: it must not wait behind a slow handler). */
	async suggest(nodeKey: string, text: string, limit = 8): Promise<Suggestion[]> {
		const r = await this.call<Suggestion[]>("suggest", [this.instance, { nodeKey, text, limit }]);
		return r ?? [];
	}

	/** Forget the cached rows of a virtual node (its count, sort or the tree changed). */
	invalidateRows(nodeId: string) {
		this.requested.delete(nodeId);
		this.setState("rowCache", nodeId, undefined as never);
	}

	/** Ask the plugin for rows [start, start+count) of a virtual list/table, merged and at most a few times a second. */
	requestRange(node: VNode, start: number, count: number, sort?: SortSpec): void {
		const key = node.props.key;
		if (key === undefined) {
			this.setState("message", "a virtual list or table needs a `key` so the host can ask for its rows");
			return;
		}
		const have = this.state.rowCache[node.id]?.rows ?? {};
		const sent = this.requested.get(node.id) ?? new Set<number>();
		this.requested.set(node.id, sent);
		const w = this.wanted.get(node.id) ?? { node, need: new Set<number>(), sort };
		w.node = node;
		w.sort = sort;
		for (let i = start; i < start + count; i++) if (!(i in have) && !sent.has(i)) w.need.add(i);
		if (!w.need.size) return;
		this.wanted.set(node.id, w);
		if (this.rangeTimer) return;
		this.rangeTimer = setTimeout(() => {
			this.rangeTimer = undefined;
			const jobs = [...this.wanted.values()];
			this.wanted.clear();
			for (const j of jobs) void this.fetchRange(j.node, j.need, j.sort);
		}, 60);
	}

	private async fetchRange(node: VNode, need: Set<number>, sort?: SortSpec) {
		const sorted = [...need].sort((a, b) => a - b);
		const sent = this.requested.get(node.id) ?? new Set<number>();
		// contiguous runs, one call per run
		const runs: [number, number][] = [];
		for (const i of sorted) {
			const last = runs[runs.length - 1];
			if (last && i === last[0] + last[1]) last[1]++;
			else runs.push([i, 1]);
			sent.add(i);
		}
		for (const [start, count] of runs) {
			const batchRes = await this.call<RowBatch>("render-range", [this.instance, { nodeKey: node.props.key, start, count, sort }]);
			if (!batchRes || this.destroyed) return;
			const rows = resolveBatchRows(batchRes.rows, batchRes.nodes, node.id);
			batch(() => {
				if (!this.state.rowCache[node.id]) this.setState("rowCache", node.id, { rows: {} });
				rows.forEach((r, i) => this.setState("rowCache", node.id, "rows", batchRes.start + i, r));
				if (batchRes.total !== undefined) this.setState("rowCache", node.id, "total", batchRes.total);
				for (const s of batchRes.styles) this.setState("styles", s.name, s);
			});
		}
	}

	// ------------------------------------------------------------------------------------------------ form values, focus

	setField(name: string | undefined, value: UiValue, formId?: string) {
		if (!name) return;
		this.fields.set(name, value);
		this.fieldForm.set(name, formId);
	}
	/** The named inputs' values: all of them, or those inside one `form` node. */
	formValues(formId?: string): FormField[] {
		return [...this.fields].filter(([name]) => formId === undefined || this.fieldForm.get(name) === formId).map(([name, value]) => ({ name, value }));
	}
	focusKey(key: string) {
		this.onFocusRequest?.(key);
		const el = this.els.get("k:" + key);
		if (el) this.hooks.focus?.(el);
	}
	scrollToKey(key: string, align: string) {
		const el = this.els.get("k:" + key);
		if (el) this.hooks.scrollTo?.(el, align);
	}
}

/** Does a key event match one of a binding's `keys` ("Enter", "ctrl+Enter", "Escape")? */
export function matchKey(keys: string[], key: string, mods: Modifiers): boolean {
	const k = key.toLowerCase();
	return keys.some((spec) => {
		const parts = spec.toLowerCase().split("+");
		const name = parts.pop()!;
		const want = new Set(parts);
		const have = (m: string, on: boolean) => want.has(m) === on;
		return (name === k || (name === "space" && k === " ")) && have("shift", mods.shift) && have("ctrl", mods.ctrl) && have("alt", mods.alt) && have("meta", mods.meta);
	});
}
