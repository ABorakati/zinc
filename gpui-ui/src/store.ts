// App state for the library window (Solid signals). Implements Store from contracts.ts, plus a few extras
// (qmode, loading, error, groups) the toolbar / list can use.
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack } from "solid-js";
import { api, type ItemGroup, type ItemQuery } from "./api";
import type { Collection, ItemRow, Mode, Store, Tab } from "./contracts";
import { mark } from "./trace";

export const PAGE = 100;
const FILTER_DEBOUNCE_MS = 200;

/** Quick-search modes (toolbar search box), as the web UI. */
export type QMode = "titleCreatorYear" | "fields" | "everything";

export interface AppStore extends Store {
	qmode: () => QMode;
	setQMode(m: QMode): void;
	/** true while any page request is in flight */
	loading: () => boolean;
	error: () => string | null;
	/** the effective item query (collection + debounced filter + sort) */
	query: () => ItemQuery;
	/** year group sizes in list order (same order as the rows); empty until loaded */
	groups: () => ItemGroup[];
	/** bumped whenever a page arrives (itemAt also tracks it) */
	pagesLoaded: () => number;
}

function createStore(): AppStore {
	const [mode, setMode] = createSignal<Mode>("dark");

	// ---- collections ----
	const [collections, setCollections] = createSignal<Collection[]>([]);
	const [selectedCollection, setSelectedCollection] = createSignal<string | null>(null);
	api.collections().then((c) => { setCollections(c); mark("collections-loaded"); }).catch((e) => setError(String(e?.message ?? e)));

	// ---- filter (200 ms debounce) ----
	const [filter, setFilterSig] = createSignal("");
	const [appliedFilter, setAppliedFilter] = createSignal("");
	const [qmode, setQMode] = createSignal<QMode>("titleCreatorYear");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const setFilter = (q: string) => {
		setFilterSig(q);
		clearTimeout(timer);
		timer = setTimeout(() => setAppliedFilter(q.trim()), FILTER_DEBOUNCE_MS);
	};
	onCleanup(() => clearTimeout(timer));

	// ---- item list: default List view = grouped by year (year desc, then date added desc) ----
	const query = createMemo<ItemQuery>(() => ({
		// "unfiled" and "trash" are library views, not collection keys
		collection: selectedCollection() === "unfiled" || selectedCollection() === "trash" ? undefined : selectedCollection() ?? undefined,
		unfiled: selectedCollection() === "unfiled" || undefined,
		trash: selectedCollection() === "trash" || undefined,
		qmode: qmode() !== "titleCreatorYear" ? qmode() : undefined,
		q: appliedFilter() || undefined,
		sort: "year",
		dir: "desc",
		then: "dateAdded:desc",
		fields: "DOI,url",
		include: "creators,tags",
	}));

	const [total, setTotal] = createSignal(0);
	const [listVersion, setListVersion] = createSignal(0);
	const [pagesLoaded, setPagesLoaded] = createSignal(0);
	const [pending, setPending] = createSignal(0);
	const [error, setError] = createSignal<string | null>(null);
	const [groups, setGroups] = createSignal<ItemGroup[]>([]);
	const [selectedItem, setSelectedItem] = createSignal<string | null>(null);

	let gen = 0; // bumped on every reset
	let cacheGen = -1; // the generation the rows in `cache` belong to
	let cache = new Map<number, ItemRow>();
	const inflight = new Set<number>();
	let abort = new AbortController();

	async function loadPage(p: number, g: number) {
		if (inflight.has(p) || g !== gen) return;
		inflight.add(p);
		setPending((n) => n + 1);
		try {
			const res = await api.items(untrack(query), p * PAGE, PAGE, abort.signal);
			if (g !== gen) return;
			if (cacheGen !== g) { cache = new Map(); cacheGen = g; } // first page of the new list replaces the old rows
			res.items.forEach((it, i) => cache.set(p * PAGE + i, it));
			setTotal(res.total);
			setError(null);
			setPagesLoaded((n) => n + 1);
			mark("items-loaded");
		} catch (e) {
			if (g === gen && (e as Error)?.name !== "AbortError") setError(String((e as Error)?.message ?? e));
		} finally {
			if (g === gen) inflight.delete(p);
			setPending((n) => n - 1);
		}
	}

	// A new collection / filter starts over; old rows stay visible until page 0 of the new list lands.
	createEffect(on(query, (q) => {
		gen++;
		abort.abort();
		abort = new AbortController();
		inflight.clear();
		setSelectedItem(null);
		setListVersion(gen);
		void loadPage(0, gen);
		const g = gen;
		api.itemGroups(q, "year", abort.signal).then((r) => { if (g === gen) setGroups(r.groups); }).catch(() => {});
	}));

	function itemAt(i: number): ItemRow | undefined {
		pagesLoaded(); // re-run readers when pages arrive
		listVersion();
		const row = cache.get(i);
		if (!row || cacheGen !== gen) {
			// not loaded for the current list yet (a stale row, if any, is returned meanwhile)
			if (i >= 0 && i < Math.max(total(), 1)) queueMicrotask(() => void loadPage(Math.floor(i / PAGE), gen));
		}
		return row;
	}

	// ---- tabs (not persisted): the library plus one reader tab per open attachment, as ui/src/store.ts ----
	const [tabs, setTabs] = createSignal<Tab[]>([{ id: "library" }]);
	const [activeTab, setActiveTab] = createSignal("library");
	function openAttachment(attachmentKey: string, title: string, itemKey: string) {
		if (!tabs().some((t) => t.id === attachmentKey)) setTabs([...tabs(), { id: attachmentKey, kind: "reader", title, itemKey }]);
		setActiveTab(attachmentKey);
	}
	function closeTab(id: string) {
		if (id === "library") return;
		const list = tabs();
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) return;
		const next = list.filter((t) => t.id !== id);
		setTabs(next);
		if (activeTab() === id) setActiveTab(next[Math.min(i, next.length - 1)]!.id); // neighbour on the right, else on the left
	}

	return {
		tabs, activeTab, setActiveTab, openAttachment, closeTab,
		mode, setMode,
		collections,
		selectedCollection,
		selectCollection: (key) => setSelectedCollection(key),
		filter, setFilter,
		total, itemAt, listVersion,
		selectedItem, selectItem: (key) => setSelectedItem(key),
		qmode, setQMode,
		loading: () => pending() > 0,
		error,
		query, groups, pagesLoaded,
	};
}

export const store: AppStore = createRoot(createStore);
