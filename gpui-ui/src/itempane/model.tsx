// State of the item pane: the focused item's detail, the schema, tag colours, and the optimistic save queue
// (ports of SingleItem in ui/src/ItemPane.tsx and ctx.ts). Sections reach it through usePane().
import { createContext, createEffect, createMemo, createSignal, on, useContext, type Accessor } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import { store } from "../store";
import { toast } from "../ui";
import { ipApi, type ItemDetail, type TagColor, type ZoteroItemData, type ZoteroSchema } from "./net";

export interface PaneModel {
	/** the focused item's key (null = nothing selected) */
	key: Accessor<string | null>;
	/** loaded detail of that item; undefined while it loads */
	detail: Accessor<ItemDetail | undefined>;
	/** key of the loaded item; unlike detail() it only notifies when the item changes, not on every save (use it for reset-on-item-change effects) */
	itemKey: Accessor<string | undefined>;
	error: Accessor<string | null>;
	schema: Accessor<ZoteroSchema | undefined>;
	/** tag name -> colour for the library's coloured tags */
	tagColors: Accessor<Map<string, string>>;
	/** replace the shown detail (e.g. with a PATCH/relations response) */
	setDetail(d: ItemDetail): void;
	/** optimistic PATCH of the item's data, reverted with a toast on failure; runs one at a time */
	save(patch: Partial<ZoteroItemData>): Promise<void>;
	/** re-fetch the item */
	reload(): Promise<void>;
	/** tell the list / sidebar that something changed (store.refresh when the store has it) */
	refreshList(): void;
	/** put plain text on the clipboard */
	copyText(text: string): void;
}

export const PaneContext = createContext<PaneModel>();
export const usePane = (): PaneModel => useContext(PaneContext)!;

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

/** store.refresh() exists once the list owner's ListStore lands; until then nothing to do. */
export function refreshStore(): void {
	(store as unknown as { refresh?: () => void }).refresh?.();
}

/** After an edit of the item's own fields: refetch the list pages only (no collection / library requests). */
export function refreshItemsStore(fields: string[]): void {
	// membership / trash changes move collection counts: those still refresh everything
	if (fields.some((f) => f === "collections" || f === "deleted" || f === "parentItem")) store.refresh();
	else store.refreshItems(fields);
}

export function createPaneModel(key: Accessor<string | null>): PaneModel {
	const gp = useGpuix();
	const [detail, setDetailSig] = createSignal<ItemDetail | undefined>(undefined);
	const [error, setError] = createSignal<string | null>(null);
	const [schema, setSchema] = createSignal<ZoteroSchema | undefined>(undefined);
	const [tagColors, setTagColors] = createSignal<Map<string, string>>(new Map());
	void ipApi.schema().then(setSchema, (e) => fail("Could not load the item schema", e));
	void ipApi.tagColors().then(
		(l: TagColor[]) => setTagColors(new Map(l.map((c) => [c.name, c.color]))),
		() => {},
	);

	let seq = 0;
	async function load(k: string, keepOld: boolean) {
		const my = ++seq;
		if (!keepOld) setDetailSig(undefined);
		setError(null);
		try {
			const d = await ipApi.item(k);
			if (my === seq) setDetailSig(d);
		} catch (e) {
			if (my === seq) setError(errMsg(e));
		}
	}
	createEffect(
		on(key, (k) => {
			if (k) void load(k, false);
			else {
				seq++;
				setDetailSig(undefined);
			}
		}),
	);

	// Saves run one at a time so a slow response can't clobber a later optimistic edit.
	let chain: Promise<void> = Promise.resolve();
	const save: PaneModel["save"] = (patch) => {
		const k = detail()?.data.key;
		if (!k) return Promise.resolve();
		return (chain = chain.then(async () => {
			const before = detail();
			const prev: Record<string, unknown> = {};
			if (before?.data.key === k) {
				for (const f of Object.keys(patch)) prev[f] = before.data[f];
				setDetailSig({ ...before, data: { ...before.data, ...patch } });
			}
			try {
				const r = await ipApi.patchItem(k, patch);
				if (detail()?.data.key === k) setDetailSig(r);
				refreshItemsStore(Object.keys(patch)); // an edit of the item's own fields: the list refetches, nothing else
			} catch (e) {
				const cur = detail();
				if (cur?.data.key === k) setDetailSig({ ...cur, data: { ...cur.data, ...prev } });
				fail("Could not save changes", e);
			}
		}));
	};

	return {
		key,
		detail,
		itemKey: createMemo(() => detail()?.data.key),
		error,
		schema,
		tagColors,
		setDetail: setDetailSig,
		save,
		reload: async () => {
			const k = detail()?.data.key ?? key();
			if (k) await load(k, true);
		},
		refreshList: refreshStore,
		copyText: (text) => {
			try {
				(gp?.renderer as unknown as { writeToClipboard?: (s: string) => void } | undefined)?.writeToClipboard?.(text);
			} catch {
				/* no clipboard */
			}
		},
	};
}
