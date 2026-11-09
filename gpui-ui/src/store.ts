// App state for the library window (Solid signals). Implements Store + ListStore from contracts.ts (ui/src/store.ts), plus the
// quick-search mode, the sparse page cache of the item list, multi-selection and the persisted list preferences.
import { mkdirSync, readFileSync, writeFile } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { batch, createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack } from "solid-js";
import { api, apiRequest, type ItemGroup, type ItemQuery } from "./api";
import type { Collection, GroupBy, ItemRow, Library, ListStore, Mode, SortLevel, Store, Tab, View } from "./contracts";
import { mark } from "./trace";
import { isWebContent, webBase } from "./webview/config";
import { readState } from "./readState";

export const PAGE = 100;
/** Page cache size (LRU by distance): when more pages are cached, the ones farthest from the visible range go (a page is ~100 rows = ~300 KB). */
export const MAX_PAGES = 24;
/** Pages fetched ahead of the visible range in the scroll direction (and 1 behind), so scrolling meets rows, not skeletons. */
export const PREFETCH_AHEAD = 2;
/** Prefetching pauses while this many page requests are in flight (a fling across the library asks for many pages). */
const MAX_PREFETCH_INFLIGHT = 3;
const FILTER_DEBOUNCE_MS = 200;
export const MAX_LEVELS = 4;

/** Counters for scripts/scroll-bench.ts (plain increments, no reactivity): row evaluations, skeleton evaluations, page fetches. */
export const stats = { itemAt: 0, skeleton: 0, fetches: 0, evictions: 0, visCalls: 0, visMs: 0, visMaxMs: 0, fetchMs: 0, fetchMaxMs: 0, prefetches: 0, pageTouches: 0 };

// ------------------------------------------------------------------------------------------------ persisted UI state
// The web UI keeps list preferences in localStorage; here they live in %APPDATA%\zotero-next-gpui\ui-state.json (one JSON
// object, one key per feature: "viewMode", "sort", "qmode", "columns", "cards", ...). Other modules may use `uiState.get/set`
// for their own keys; writes are debounced and in-process only (a single object, so nothing clobbers anything).
// ZN_UI_STATE=<file> redirects it, ZN_UI_STATE=off keeps it in memory.

const STATE_FILE = (() => {
	const env = typeof process !== "undefined" ? process.env.ZN_UI_STATE : undefined;
	if (env) return env === "off" ? null : env;
	const base = (typeof process !== "undefined" ? process.env.APPDATA : undefined) ?? join(homedir(), "AppData", "Roaming");
	return join(base, "zotero-next-gpui", "ui-state.json");
})();
let stateData: Record<string, unknown> = {};
try { if (STATE_FILE) stateData = JSON.parse(readFileSync(STATE_FILE, "utf8")) ?? {}; } catch { /* first run / unreadable: defaults */ }
let writesOff = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
export const uiState = {
	get<T>(key: string, fallback: T): T {
		const v = stateData[key];
		return v === undefined ? fallback : (v as T);
	},
	set(key: string, value: unknown): void {
		stateData[key] = value;
		if (writesOff || !STATE_FILE) return;
		clearTimeout(writeTimer);
		writeTimer = setTimeout(() => {
			try {
				mkdirSync(dirname(STATE_FILE), { recursive: true });
				writeFile(STATE_FILE, JSON.stringify(stateData, null, 1), () => {});
			} catch { /* a read-only profile just loses the preferences */ }
		}, 400);
	},
	/** Screenshot / test scripts: keep the in-memory state but never write the user's file (nor post the selection to the core). */
	disableWrites(): void { writesOff = true; clearTimeout(writeTimer); },
	writesDisabled: () => writesOff,
};

// ------------------------------------------------------------------------------------------------ types

/** Quick-search modes (toolbar search box): Zotero's "Title, Creator, Year" | "All Fields & Tags" | "Everything". */
export type QMode = "titleCreatorYear" | "fields" | "everything";
export type ViewMode = "cards" | "table";
export type { SortLevel, GroupBy };

/** Groupings the core can compute (GET /api/items/groups?by=). */
export const GROUP_BY: { id: GroupBy; label: string }[] = [
	{ id: "none", label: "None" },
	{ id: "year", label: "Year" },
	{ id: "itemType", label: "Item type" },
	{ id: "publication", label: "Publication" },
];

const isLevel = (s: unknown): s is SortLevel =>
	!!s && typeof (s as SortLevel).key === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test((s as SortLevel).key) &&
	((s as SortLevel).dir === "asc" || (s as SortLevel).dir === "desc");

/** Direction a group field sorts in by default (years newest first). */
const groupDir = (g: GroupBy): "asc" | "desc" => (g === "year" ? "desc" : "asc");
/** Default direction when a sort key is picked. */
export const defaultDir = (key: string): "asc" | "desc" => (/^(year|dateAdded|dateModified|accessDate)$/.test(key) ? "desc" : "asc");

export interface Mods { shift: boolean; ctrl: boolean }

export interface AppStore extends Store, ListStore {
	/** My Library first, then the account's group libraries. */
	libraries: () => Library[];
	/** The library the list shows (1 = My Library). */
	libraryId: () => number;
	/** Show a library's items (its top level, no collection). */
	selectLibrary(id: number): void;
	/** The collection trees of the group libraries, by library id. */
	groupCollections: () => Record<number, Collection[]>;
	/** Which library a collection key belongs to. */
	libraryOfCollection(key: string): number;
	/** Can this library be edited by this user? (false for a read-only group) */
	libraryEditable(id: number): boolean;
	/** `libraryEditable` for the library being shown. */
	canEdit: () => boolean;
	/** Re-read the library list and the group collection trees (the sync service adds and renames groups in the background). */
	reloadLibraries(): Promise<void>;
	qmode: () => QMode;
	setQMode(m: QMode): void;
	/** "Full text" quick-search mode: the list is replaced by search results with snippets (SearchResults). */
	fulltext: () => boolean;
	setFulltext(on: boolean): void;
	/** true while any page request is in flight */
	loading: () => boolean;
	error: () => string | null;
	/** the effective item query (view + tag + filter + sort + the fields/include the visible list asked for) */
	query: () => ItemQuery;
	/** group sizes in list order (same order as the rows); empty when not grouped / not loaded */
	groups: () => ItemGroup[];
	/** bumped whenever a page arrives (itemAt does NOT track it: rows depend only on their own page) */
	pagesLoaded: () => number;
	/** Zotero data fields / extras the visible list needs, sent as the query's `fields` / `include`. Changing them refetches the visible pages only. */
	setListFields(fields: string, include: string): void;
	/** Tell the cache which item indexes are on screen so far-away pages can be evicted. */
	setVisible(first: number, last: number): void;
	/** Row i if its page is cached (no fetch, not reactive). */
	peek(i: number): ItemRow | undefined;
	/** Index of a cached row by key, or -1. */
	indexOfKey(key: string): number;
	/** Replace fields of a cached row (optimistic edits such as the star). */
	patchItem(key: string, patch: Partial<ItemRow>): void;
	/** Cached pages (for tests / memory checks). */
	cachedPages(): number[];
	// ---- selection (cards and table share it) ----
	anchor: () => number;
	focusIndex: () => number;
	/** Select exactly this item (key null clears); `index` becomes the anchor and focus row. */
	selectOnly(key: string | null, index?: number): void;
	/** Plain click = select only, Ctrl = toggle, Shift = range from the anchor (Ctrl+Shift extends). */
	selectClick(index: number, mods: Mods): void;
	/** Arrow-key move of the focus row (Shift extends the range). false when row `next` is not loaded yet. */
	focusRow(next: number, extend: boolean): boolean;
	/** Ctrl+A: every item of the current list. */
	selectAll(): void;
	/** Keys to act on for an item: the whole selection if it is part of it, else just the item. */
	keysFor(key: string): string[];
	/** One-level sort (header click): keeps the group level first while grouped. */
	sortBy(level: SortLevel): void;
	/** Bumped by refresh() (data changed): views that cache other per-item data re-read on it. */
	itemsRev: () => number;
}

/** Every collection key in a tree (roots with children). */
function flattenKeys(tree: Collection[], out = new Set<string>()): Set<string> {
	for (const c of tree) { out.add(c.key); if (c.children) flattenKeys(c.children, out); }
	return out;
}

interface CachedPage { gen: number; rows: ItemRow[] }

function createStore(): AppStore {
	const [mode, setMode] = createSignal<Mode>("dark");

	// ---- collections ----
	const [collections, setCollections] = createSignal<Collection[]>([]);
	const loadCollections = () => api.collections().then((c) => { setCollections(c); mark("collections-loaded"); }).catch((e) => setError(String(e?.message ?? e)));
	void loadCollections();

	// ---- libraries: My Library plus the group libraries zotero.org sync brought in ----
	const [libraries, setLibraries] = createSignal<Library[]>([]);
	const [groupCollections, setGroupCollections] = createSignal<Record<number, Collection[]>>({});
	const [libraryId, setLibraryId] = createSignal(1);
	async function reloadLibraries() {
		try {
			const list = await api.libraries();
			const trees: Record<number, Collection[]> = {};
			await Promise.all(list.filter((l) => l.id !== 1).map(async (l) => { trees[l.id] = await api.collections(l.id); }));
			batch(() => {
				setLibraries(list);
				setGroupCollections(trees);
				// the library on screen left the account (or an old core without groups answered): fall back to My Library
				if (!list.some((l) => l.id === untrack(libraryId))) { setLibraryId(1); setViewSig({ kind: "library" }); }
			});
		} catch { /* a core without groups (404) or a transient error: My Library alone */ }
	}
	// after the first screen: a library list is not needed to paint it. The sync service adds and renames groups in the background, so poll lightly.
	const libraryStart = setTimeout(() => void reloadLibraries(), 800);
	const libraryPoll = setInterval(() => void reloadLibraries(), 30_000);
	onCleanup(() => { clearTimeout(libraryStart); clearInterval(libraryPoll); });
	const libraryOfCollection = (key: string): number => {
		for (const [id, tree] of Object.entries(groupCollections())) if (flattenKeys(tree).has(key)) return Number(id);
		return 1;
	};
	const libraryEditable = (id: number): boolean => libraries().find((l) => l.id === id)?.editable !== false;
	const canEdit = () => libraryEditable(libraryId());

	// ---- view / tag filter ----
	const [view, setViewSig] = createSignal<View>({ kind: "library" });
	const [tagFilter, setTagFilter] = createSignal<string[]>([]);
	const selectedCollection = () => {
		const v = view();
		return v.kind === "collection" ? v.key : v.kind === "unfiled" ? "unfiled" : v.kind === "trash" ? "trash" : null;
	};
	const setView = (v: View) => {
		// a collection decides the library (a group's collection opens that group); every other view is My Library's
		const lib = v.kind === "collection" ? libraryOfCollection(v.key) : 1;
		batch(() => {
			if (untrack(libraryId) !== lib) { setLibraryId(lib); setTagFilter([]); } // tags belong to one library
			if (JSON.stringify(untrack(view)) !== JSON.stringify(v)) setViewSig(v);
		});
	};
	/** Show a library's items: My Library or a group, no collection. */
	const selectLibrary = (id: number) => batch(() => {
		if (untrack(libraryId) !== id) setTagFilter([]);
		setLibraryId(id);
		setViewSig({ kind: "library" });
	});
	/** Sidebar compat: null = My Library; "unfiled" / "trash" are library views; any other string is a collection key. */
	const selectCollection = (key: string | null) =>
		setView(key === null ? { kind: "library" } : key === "unfiled" ? { kind: "unfiled" } : key === "trash" ? { kind: "trash" } : { kind: "collection", key });

	// ---- filter (200 ms debounce) + quick-search mode ----
	const [filter, setFilterSig] = createSignal("");
	const [appliedFilter, setAppliedFilter] = createSignal("");
	const initialMode = uiState.get<string>("qmode", "titleCreatorYear");
	const [qmode, setQModeSig] = createSignal<QMode>(initialMode === "fields" || initialMode === "everything" ? initialMode : "titleCreatorYear");
	const [fulltext, setFulltextSig] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const setFilter = (q: string) => {
		setFilterSig(q);
		clearTimeout(timer);
		timer = setTimeout(() => setAppliedFilter(q.trim()), FILTER_DEBOUNCE_MS);
	};
	onCleanup(() => clearTimeout(timer));
	const setQMode = (m: QMode) => { setQModeSig(m); uiState.set("qmode", m); };

	// ---- sort / group / view mode (persisted) ----
	const savedSort = uiState.get<{ levels?: unknown; groupBy?: unknown } | null>("sort", null);
	const initGroup = ((): GroupBy => {
		const g = savedSort?.groupBy;
		return GROUP_BY.some((x) => x.id === g) ? (g as GroupBy) : "year";
	})();
	const normalise = (levels: SortLevel[], g: GroupBy): SortLevel[] => {
		const seen = new Set<string>();
		let ls = levels.filter((l) => isLevel(l) && !seen.has(l.key) && !!seen.add(l.key));
		if (g !== "none" && ls[0]?.key !== g) ls = [ls.find((l) => l.key === g) ?? { key: g, dir: groupDir(g) }, ...ls.filter((l) => l.key !== g)];
		if (!ls.length) ls = [{ key: "dateAdded", dir: "desc" }];
		return ls.slice(0, MAX_LEVELS);
	};
	const [groupBy, setGroupBySig] = createSignal<GroupBy>(initGroup);
	const [sortLevels, setSortLevelsSig] = createSignal<SortLevel[]>(
		normalise(Array.isArray(savedSort?.levels) ? (savedSort!.levels as SortLevel[]) : [{ key: "year", dir: "desc" }, { key: "dateAdded", dir: "desc" }], initGroup),
	);
	createEffect(() => uiState.set("sort", { levels: sortLevels(), groupBy: groupBy() }));
	/** Replace every level; while grouped, the group field is forced to stay first. */
	const setSortLevels = (levels: SortLevel[]) => setSortLevelsSig(normalise(levels, untrack(groupBy)));
	/** Group the list; the group field becomes sort level 1 and the old levels follow it. */
	const setGroupBy = (g: GroupBy) => batch(() => { setGroupBySig(g); setSortLevelsSig((l) => normalise(l, g)); });
	const sortBy = (level: SortLevel) => {
		const g = untrack(groupBy);
		const cur = untrack(sortLevels);
		if (g === "none" || level.key === g) setSortLevels([level, ...cur.slice(1).filter((l) => l.key !== level.key)]);
		else setSortLevels([cur[0]!, level]);
	};

	const [viewMode, setViewModeSig] = createSignal<ViewMode>(uiState.get<string>("viewMode", "cards") === "table" ? "table" : "cards");
	const setViewMode = (m: ViewMode) => { setViewModeSig(m); uiState.set("viewMode", m); };

	// ---- the item query ----
	const [listFields, setListFieldsSig] = createSignal({ fields: "DOI,url", include: "creators,tags" });
	const setListFields = (fields: string, include: string) => {
		const c = untrack(listFields);
		if (c.fields !== fields || c.include !== include) setListFieldsSig({ fields, include });
	};
	/** Everything but fields/include: a change starts the list over (selection and scroll reset). */
	const baseQuery = createMemo<ItemQuery>(() => {
		const v = view();
		const ls = sortLevels();
		const first = ls[0]!;
		return {
			library: libraryId() !== 1 ? libraryId() : undefined,
			collection: v.kind === "collection" ? v.key : undefined,
			search: v.kind === "savedSearch" ? v.key : undefined,
			unfiled: v.kind === "unfiled" || undefined,
			publications: v.kind === "publications" || undefined,
			trash: v.kind === "trash" || undefined,
			tag: tagFilter()[0],
			qmode: qmode() !== "titleCreatorYear" ? qmode() : undefined,
			q: !fulltext() && appliedFilter() ? appliedFilter() : undefined,
			sort: first.key,
			dir: first.dir,
			then: ls.slice(1).map((l) => `${l.key}:${l.dir}`).join(",") || undefined,
		};
	}, undefined as never, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
	const query = createMemo<ItemQuery>(() => ({ ...baseQuery(), fields: listFields().fields || undefined, include: listFields().include || undefined }));
	/** The grouping field when the first sort level is it (groups stay contiguous), else null. */
	const groupField = createMemo(() => {
		const g = groupBy();
		const k = view().kind;
		return g !== "none" && sortLevels()[0]?.key === g && k !== "duplicates" ? g : null;
	});

	// ---- selection state (the actions are below) ----
	const [selected, setSelectedSig] = createSignal<Set<string>>(new Set<string>());
	const [selectedItem, setActiveKey] = createSignal<string | null>(null); // the focused item (shown in the item pane)
	const [anchor, setAnchor] = createSignal(-1);
	const [focusIndex, setFocusIndex] = createSignal(-1);

	// ---- item list: sparse page cache ----
	const [total, setTotal] = createSignal(0);
	const [listVersion, setListVersion] = createSignal(0);
	const [pagesLoaded, setPagesLoaded] = createSignal(0);
	// "loading…" is a signal other views render, so it must not flicker (a commit each) for the 60 ms page fetches a scroll triggers:
	// with rows on screen it turns on only once a fetch has been pending for 250 ms; with an empty list it is immediate.
	let pendingN = 0;
	let loadingTimer: ReturnType<typeof setTimeout> | undefined;
	const [loadingSig, setLoadingSig] = createSignal(false);
	const setPending = (f: (n: number) => number) => {
		pendingN = f(pendingN);
		if (pendingN > 0) {
			if (untrack(loadingSig) || loadingTimer) return;
			if (untrack(total) === 0) { setLoadingSig(true); return; }
			loadingTimer = setTimeout(() => { loadingTimer = undefined; if (pendingN > 0) setLoadingSig(true); }, 250);
		} else {
			if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = undefined; }
			if (untrack(loadingSig)) setLoadingSig(false);
		}
	};
	const [error, setErrorRaw] = createSignal<string | null>(null);
	// a refused connection means no library service is running: say that, not "ECONNREFUSED"
	const setError = (m: string | null) =>
		setErrorRaw(m && /ECONNREFUSED|Unable to connect|failed to fetch|connection refused/i.test(m)
			? "Can't reach the library. Start Zinc, then reopen this window."
			: m);
	const [groups, setGroups] = createSignal<ItemGroup[]>([]);
	const [itemsRev, setItemsRev] = createSignal(0);

	let gen = 0; // bumped on every reset
	let hardGen = 0; // the generation of the last hard reset (a different list): pages older than it are dropped
	let hardCleared = 0;
	const cache = new Map<number, CachedPage>(); // page -> rows
	const inflight = new Set<number>();
	/** Per-page abort, so a fast jump can drop the requests for pages it has left behind (still queued at the core). */
	const pageAbort = new Map<number, AbortController>();
	let abort = new AbortController();
	// Fast moves (dragging the scrollbar thumb, a fling): the visible range jumps several pages between two reports. Fetching every
	// page passed over queued dozens of requests on the core (in-process: the same thread that draws), and the page the drag
	// stopped on waited behind them. While the list moves that fast nothing is fetched (rows show skeletons); SETTLE_MS after the
	// last big jump, the pages then in view load, and requests for pages far from there are aborted.
	const FAST_JUMP_PAGES = process.env.ZN_NO_SETTLE ? Infinity : 2, SETTLE_MS = 90; // ZN_NO_SETTLE=1: the old fetch-everything behaviour, for A/B
	let fastUntil = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let lastRange: [number, number] = [0, 0];
	let centerPage = 0;
	let scrollDir = 1; // direction the visible range last moved in (1 = down)
	let lastVisible = { fp: -1, lp: -1, dir: 0 };
	// Per-page reactivity: a row reads only the signal of its own page, so a page arriving (or an edit patching a row) re-runs the
	// rows of that page, not every mounted row. Signals are created on first read (at most one per page of the list).
	const pageSigs = new Map<number, [() => number, (f: (n: number) => number) => void]>();
	const pageVersion = (p: number): number => {
		let s = pageSigs.get(p);
		if (!s) { const [get, set] = createSignal(0); s = [get, set]; pageSigs.set(p, s); }
		return s[0]();
	};
	const touchPage = (p: number) => { const s = pageSigs.get(p); if (s) { stats.pageTouches++; s[1]((n) => n + 1); } };
	const touchAllPages = () => batch(() => { for (const p of [...pageSigs.keys()]) touchPage(p); });
	/** Wake the rows of pages [from, to] that have no current rows yet (they re-run itemAt, which fetches). */
	const touchPagesIn = (from: number, to: number) => batch(() => {
		for (let p = Math.max(0, from); p <= to; p++) { const e = cache.get(p); if (!e || e.gen !== gen) touchPage(p); }
	});
	let dupCache: Promise<ItemRow[]> | null = null;

	/** The duplicate sets as flat rows (one per item, sets adjacent): the core lists sets, not items. */
	function duplicateRows(signal: AbortSignal): Promise<ItemRow[]> {
		dupCache ??= api.duplicates(signal).then((r) => r.sets.flatMap((s) => s.keys.map((key): ItemRow => ({
			key, itemType: s.itemType ?? "journalArticle", title: s.title ?? "", creatorsSummary: s.creatorsSummary, year: s.year ?? null,
			publication: `Duplicate by ${s.reason}`, dateAdded: "", primaryAttachment: null, attachmentCount: 0, noteCount: 0, tags: [],
		})))).catch((e) => { dupCache = null; throw e; });
		return dupCache;
	}

	async function fetchPage(p: number, signal: AbortSignal): Promise<{ total: number; items: ItemRow[] }> {
		const v = untrack(view);
		if (v.kind === "duplicates") {
			const rows = await duplicateRows(signal);
			return { total: rows.length, items: rows.slice(p * PAGE, (p + 1) * PAGE) };
		}
		return api.items(untrack(query), p * PAGE, PAGE, signal);
	}

	/** Keep at most MAX_PAGES pages: drop the ones farthest from the visible range. */
	function evict() {
		if (cache.size <= MAX_PAGES) return;
		const far = [...cache.keys()].sort((a, b) => Math.abs(b - centerPage) - Math.abs(a - centerPage));
		for (const p of far) {
			if (cache.size <= MAX_PAGES) break;
			cache.delete(p);
			stats.evictions++;
		}
	}

	async function loadPage(p: number, g: number) {
		if (inflight.has(p) || g !== gen) return;
		inflight.add(p);
		const mine = new AbortController();
		pageAbort.set(p, mine);
		stats.fetches++;
		setPending((n) => n + 1);
		const t0 = performance.now();
		try {
			const res = await fetchPage(p, AbortSignal.any([abort.signal, mine.signal]));
			if (g !== gen) return;
			const dropped: number[] = [];
			if (hardCleared < hardGen) { // first page of a new list replaces the old list's rows
				for (const [k, v] of cache) if (v.gen < hardGen) { cache.delete(k); dropped.push(k); }
				hardCleared = hardGen;
			}
			cache.set(p, { gen: g, rows: res.items });
			evict();
			const ms = performance.now() - t0;
			stats.fetchMs += ms;
			stats.fetchMaxMs = Math.max(stats.fetchMaxMs, ms);
			batch(() => {
				setTotal(res.total);
				setError(null);
				setPagesLoaded((n) => n + 1);
				touchPage(p);
				for (const k of dropped) touchPage(k); // rows still showing the old list's page go to skeleton / refetch
			});
			mark("items-loaded");
		} catch (e) {
			if (g === gen && (e as Error)?.name !== "AbortError") setError(String((e as Error)?.message ?? e));
		} finally {
			// only this request's own bookkeeping: an aborted one may already have been replaced by a new request for the page
			if (pageAbort.get(p) === mine) { pageAbort.delete(p); if (g === gen) inflight.delete(p); }
			setPending((n) => n - 1);
		}
	}
	/** Drop the requests for pages outside [from, to] that have not come back yet. */
	function abortOutside(from: number, to: number) {
		for (const [p, c] of [...pageAbort]) {
			if (p >= from && p <= to) continue;
			c.abort();
			pageAbort.delete(p);
			inflight.delete(p);
		}
	}

	/** Start over with the current query. `hard`: a different list (selection cleared, views scroll to the top); else refetch in place. */
	function reset(hard: boolean) {
		gen++;
		abort.abort();
		abort = new AbortController();
		inflight.clear();
		pageAbort.clear();
		fastUntil = 0;
		dupCache = null;
		if (hard) {
			hardGen = gen;
			centerPage = 0;
			batch(() => { setSelectedSig(new Set<string>()); setActiveKey(null); setAnchor(-1); setFocusIndex(-1); setListVersion(gen); });
		}
		// the stale rows stay on screen until the fresh page lands; itemAt() asks for every page in view (soft reset: wake the rows)
		if (!hard) touchAllPages();
		void loadPage(hard ? 0 : Math.min(centerPage, Math.max(0, Math.ceil(untrack(total) / PAGE) - 1)), gen);
	}

	let groupSeq = 0;
	function loadGroups() {
		const f = untrack(groupField);
		const s = ++groupSeq;
		if (!f) { setGroups([]); return; }
		api.itemGroups(untrack(baseQuery), f).then((r) => { if (s === groupSeq) setGroups(r.groups); }).catch(() => { if (s === groupSeq) setGroups([]); });
	}

	// A new view / filter / sort starts over; old rows stay visible until page 0 of the new list lands.
	createEffect(on(() => JSON.stringify([baseQuery(), view()]), () => reset(true)));
	// What the visible list shows (fields / include) changed: refetch, keep selection and scroll.
	createEffect(on(listFields, () => reset(false), { defer: true }));
	createEffect(on(() => [JSON.stringify(baseQuery()), groupField(), itemsRev()] as const, () => loadGroups()));
	// browser-extension saves go to the selected collection (best effort; not while a script runs with writes disabled)
	createEffect(on(view, (v) => {
		if (writesOff) return;
		void api.postSelection(v.kind === "collection" || v.kind === "savedSearch" ? { kind: v.kind === "savedSearch" ? "search" : "collection", key: v.key } : { kind: v.kind }).catch(() => {});
	}, { defer: true }));

	function itemAt(i: number): ItemRow | undefined {
		stats.itemAt++;
		const p = Math.floor(i / PAGE);
		pageVersion(p); // re-run this row when ITS page arrives (not on every page of the list)
		listVersion();
		const e = cache.get(p);
		// (not during a fast move: the settle step loads the pages in view; this row re-runs when its page arrives)
		if ((!e || e.gen !== gen) && i >= 0 && i < Math.max(untrack(total), 1) && performance.now() >= fastUntil) queueMicrotask(() => void loadPage(p, gen));
		if (!e) stats.skeleton++;
		return e?.rows[i - p * PAGE]; // a stale row (older generation) is returned meanwhile
	}
	const peek = (i: number): ItemRow | undefined => {
		const p = Math.floor(i / PAGE);
		return cache.get(p)?.rows[i - p * PAGE];
	};
	/** The visible item range: re-centres the cache and prefetches the pages ahead in the scroll direction. */
	function setVisible(first: number, last: number) {
		const fp = Math.max(0, Math.floor(first / PAGE)), lp = Math.max(fp, Math.floor(last / PAGE));
		lastRange = [first, last];
		if (lastVisible.fp >= 0 && Math.abs(fp - lastVisible.fp) > FAST_JUMP_PAGES) {
			// a big jump: fetch nothing until the range settles (see FAST_JUMP_PAGES)
			fastUntil = performance.now() + SETTLE_MS;
			lastVisible = { fp, lp, dir: fp > lastVisible.fp ? 1 : -1 };
			centerPage = Math.max(0, Math.floor((first + last) / 2 / PAGE));
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = undefined;
				fastUntil = 0;
				const [a, b] = lastRange;
				const sfp = Math.max(0, Math.floor(a / PAGE)), slp = Math.max(sfp, Math.floor(b / PAGE));
				abortOutside(sfp - PREFETCH_AHEAD - 1, slp + PREFETCH_AHEAD + 1);
				lastVisible = { fp: -1, lp: -1, dir: 0 }; // force the normal path below to load what is in view now
				setVisible(a, b);
				touchPagesIn(sfp - 1, slp + 1); // rows that skipped their fetch during the move ask again
			}, SETTLE_MS);
			return;
		}
		if (performance.now() < fastUntil) { lastVisible = { fp, lp, dir: scrollDir }; return; } // still settling
		const c = Math.max(0, Math.floor((first + last) / 2 / PAGE));
		if (c !== centerPage) {
			scrollDir = c > centerPage ? 1 : -1;
			centerPage = c;
			evict();
		}
		if (fp === lastVisible.fp && lp === lastVisible.lp && scrollDir === lastVisible.dir) return;
		lastVisible = { fp, lp, dir: scrollDir };
		const lastPage = Math.ceil(untrack(total) / PAGE) - 1;
		if (lastPage < 0) return;
		const from = Math.max(0, fp - (scrollDir < 0 ? PREFETCH_AHEAD : 1)), to = Math.min(lastPage, lp + (scrollDir > 0 ? PREFETCH_AHEAD : 1));
		for (let p = from; p <= to; p++) {
			const e = cache.get(p);
			if ((e && e.gen === gen) || inflight.has(p)) continue;
			const visible = p >= fp && p <= lp;
			if (!visible && inflight.size >= MAX_PREFETCH_INFLIGHT) continue;
			if (!visible) stats.prefetches++;
			void loadPage(p, gen);
		}
	}
	function indexOfKey(key: string): number {
		for (const [p, e] of cache) { const j = e.rows.findIndex((r) => r.key === key); if (j >= 0) return p * PAGE + j; }
		return -1;
	}
	function patchItem(key: string, patch: Partial<ItemRow>) {
		for (const [p, e] of cache) {
			const j = e.rows.findIndex((r) => r.key === key);
			if (j >= 0) { e.rows[j] = { ...e.rows[j]!, ...patch }; touchPage(p); }
		}
	}

	/** Re-fetch collections + the list (after edits, imports, trash...). Selection and scroll stay. */
	function refresh() {
		void loadCollections();
		void reloadLibraries();
		batch(() => { setItemsRev((n) => n + 1); reset(false); });
	}

	// ---- selection ----
	const setSelected = (s: Set<string>) => setSelectedSig(new Set(s));

	function selectOnly(key: string | null, index = -1) {
		batch(() => {
			setSelectedSig(key ? new Set([key]) : new Set<string>());
			setActiveKey(key);
			setAnchor(index);
			setFocusIndex(index);
		});
	}
	/** Keys of rows a..b that are cached. */
	function rangeKeys(a: number, b: number): string[] {
		const out: string[] = [];
		for (let i = a; i <= b; i++) { const r = peek(i); if (r) out.push(r.key); }
		return out;
	}
	async function loadRange(a: number, b: number) {
		const g = gen;
		const need: number[] = [];
		for (let p = Math.floor(a / PAGE); p <= Math.floor(b / PAGE); p++) if (cache.get(p)?.gen !== g) need.push(p);
		await Promise.all(need.map((p) => loadPage(p, g)));
	}
	function selectClick(index: number, mods: Mods) {
		const it = peek(index);
		if (!it) return;
		const sel = new Set(selected());
		if (mods.shift && anchor() >= 0) {
			const a = Math.min(anchor(), index), b = Math.max(anchor(), index);
			if (!mods.ctrl) sel.clear();
			for (const k of rangeKeys(a, b)) sel.add(k);
			setFocusIndex(index);
			// a range spanning pages that are not cached: fetch them and complete the selection
			if (b - a >= PAGE) void loadRange(a, b).then(() => { const s2 = new Set(untrack(selected)); for (const k of rangeKeys(a, b)) s2.add(k); setSelectedSig(s2); });
		} else if (mods.ctrl) {
			if (!sel.delete(it.key)) sel.add(it.key);
			batch(() => { setAnchor(index); setFocusIndex(index); });
		} else {
			selectOnly(it.key, index);
			return;
		}
		batch(() => { setSelectedSig(sel); setActiveKey(it.key); });
	}
	function focusRow(next: number, extend: boolean): boolean {
		const it = peek(next);
		if (!it) return false;
		if (extend && anchor() >= 0) {
			const a = Math.min(anchor(), next), b = Math.max(anchor(), next);
			batch(() => { setSelectedSig(new Set(rangeKeys(a, b))); setActiveKey(it.key); setFocusIndex(next); });
		} else selectOnly(it.key, next);
		return true;
	}
	function selectAll() {
		const n = untrack(total);
		if (n === 0) return;
		const v = untrack(view);
		if (v.kind === "duplicates" || n <= PAGE) {
			void loadRange(0, n - 1).then(() => setSelectedSig(new Set(rangeKeys(0, n - 1))));
			return;
		}
		// the whole list: keys only, 1000 per request
		const g = gen, q = { ...untrack(baseQuery), fields: undefined, include: undefined } as ItemQuery;
		void (async () => {
			const keys = new Set<string>();
			for (let off = 0; off < Math.min(n, 50_000); off += 1000) {
				const r = await api.items(q, off, 1000);
				if (g !== gen) return;
				r.items.forEach((x) => keys.add(x.key));
			}
			setSelectedSig(keys);
		})().catch((e) => setError(String(e?.message ?? e)));
	}
	const keysFor = (key: string): string[] => (selected().has(key) ? [...selected()] : [key]);

	// ---- tabs (not persisted): the library plus one reader tab per open attachment, as ui/src/store.ts ----
	const [tabs, setTabs] = createSignal<Tab[]>([{ id: "library" }]);
	const [activeTab, setActiveTab] = createSignal("library");
	function openAttachment(attachmentKey: string, title: string, itemKey: string) {
		if (tabs().some((t) => t.id === attachmentKey)) return void setActiveTab(attachmentKey);
		const openTab = (tab: Tab = { id: attachmentKey, kind: "reader", title, itemKey }) => {
			if (!tabs().some((t) => t.id === attachmentKey)) setTabs([...tabs(), tab]);
			setActiveTab(attachmentKey);
			if (itemKey) readState.markRead(itemKey);
		};
		// PDFs open in the native reader; snapshots and EPUBs in a web tab (Zotero's reader-host in the shared WebView2, src/webview) when
		// the core serves it, else in their default app.
		void api.item(attachmentKey).then(
			(d) => {
				const parent = itemKey || (d.data && typeof d.data === "object" && "parentItem" in d.data && typeof d.data.parentItem === "string" ? d.data.parentItem : "");
				if (parent) readState.markRead(parent);
				const ct = String((d.data as { contentType?: unknown }).contentType ?? "");
				if (!ct || /pdf/i.test(ct)) return openTab();
				// a linked URL has no file for the reader (the core opens it in the browser)
				const linked = (d.data as { linkMode?: unknown }).linkMode === "linked_url";
				if (isWebContent(ct) && !linked && webBase()) return openTab({ id: attachmentKey, kind: "web", title, itemKey, attachmentKey, contentType: ct });
				return apiRequest("POST", `/attachments/${encodeURIComponent(attachmentKey)}/open-external`).catch(() => openTab());
			},
			() => openTab(), // unknown: let the reader try and report
		);
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
		libraries, libraryId, selectLibrary, groupCollections, libraryOfCollection, libraryEditable, canEdit, reloadLibraries,
		selectedCollection,
		selectCollection,
		filter, setFilter,
		total, itemAt, listVersion,
		selectedItem, selectItem: (key) => selectOnly(key, key ? indexOfKey(key) : -1),
		qmode, setQMode, fulltext, setFulltext: setFulltextSig,
		loading: loadingSig,
		error,
		query, groups, pagesLoaded,
		// ListStore
		view, setView, tagFilter, setTagFilter: (t) => setTagFilter([...t]),
		selected, setSelected,
		viewMode, setViewMode,
		sortLevels, setSortLevels, groupBy, setGroupBy,
		refresh,
		// list internals
		setListFields, setVisible, peek, indexOfKey, patchItem, cachedPages: () => [...cache.keys()].sort((a, b) => a - b),
		anchor, focusIndex, selectOnly, selectClick, focusRow, selectAll, keysFor, sortBy, itemsRev,
	};
}

export const store: AppStore = createRoot(createStore);
