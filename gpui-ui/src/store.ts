// App state for the library window (Solid signals). Implements Store + ListStore from contracts.ts (ui/src/store.ts), plus the
// quick-search mode, the sparse page cache of the item list, multi-selection and the persisted list preferences.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { logWarn } from "../../core/src/log";
import { dirname, join } from "node:path";
import { configDir } from "../../core/src/platform-dirs";
import { batch, createEffect, createMemo, createRoot, createSelector, createSignal, on, onCleanup, untrack } from "solid-js";
import { api, apiRequest, type ItemGroup, type ItemQuery } from "./api";
import type { Collection, GroupBy, ItemRow, Library, ListStore, Mode, SortLevel, Store, Tab, View } from "./contracts";
import { mark } from "./trace";
import { isWebContent, webBase, webTabOpener } from "./webview/config";
import { readState } from "./readState";

export const PAGE = 100;
/** After store.revealItem the lists keep the revealed row in view this long while the new list (count, group headers) arrives. */
export const REVEAL_SETTLE_MS = 3000;
/** Page cache size (LRU by distance): when more pages are cached, the ones farthest from the visible range go (a page is ~100 rows = ~300 KB). */
export const MAX_PAGES = 24;
/** Pages fetched ahead of the visible range in the scroll direction (and 1 behind), so scrolling meets rows, not skeletons. */
export const PREFETCH_AHEAD = 2;
/** Prefetching pauses while this many page requests are in flight (a fling across the library asks for many pages). */
const MAX_PREFETCH_INFLIGHT = 3;
const FILTER_DEBOUNCE_MS = 200;
export const MAX_LEVELS = 4;

/** Data fields whose edit can change which items are duplicates (title, DOI / ISBN, creators, year, type): the duplicate scan is redone for them. */
const DUPLICATE_FIELDS = new Set(["title", "DOI", "ISBN", "creators", "date", "year", "itemType", "deleted", "parentItem"]);
export const affectsDuplicates = (fields: string[]): boolean => fields.some((f) => DUPLICATE_FIELDS.has(f));

/** Counters for scripts/scroll-bench.ts (plain increments, no reactivity): row evaluations, skeleton evaluations, page fetches. */
export const stats = {
	itemAt: 0,
	skeleton: 0,
	fetches: 0,
	evictions: 0,
	visCalls: 0,
	visMs: 0,
	visMaxMs: 0,
	fetchMs: 0,
	fetchMaxMs: 0,
	prefetches: 0,
	pageTouches: 0,
};

// ------------------------------------------------------------------------------------------------ persisted UI state
// The web UI keeps list preferences in localStorage; here they live in %APPDATA%\zotero-next-gpui\ui-state.json (one JSON
// object, one key per feature: "viewMode", "sort", "qmode", "columns", "cards", ...). Other modules may use `uiState.get/set`
// for their own keys; writes are debounced and in-process only (a single object, so nothing clobbers anything).
// ZN_UI_STATE=<file> redirects it, ZN_UI_STATE=off keeps it in memory.

const STATE_FILE = (() => {
	const env = typeof process !== "undefined" ? process.env.ZN_UI_STATE : undefined;
	if (env) return env === "off" ? null : env;
	return join(configDir(), "zotero-next-gpui", "ui-state.json");
})();
let stateData: Record<string, unknown> = {};
try {
	if (STATE_FILE) stateData = JSON.parse(readFileSync(STATE_FILE, "utf8")) ?? {};
} catch {
	/* first run / unreadable: defaults */
}
let writesOff = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let failureLogged = false;
/** Write the state now: synchronously (a few KB) to a temp file renamed over the old one, so a crash never leaves half a file. A
 *  failure is logged once (it used to be dropped without a word, which hid settings that never saved). */
function flushUiState(): void {
	clearTimeout(writeTimer);
	writeTimer = undefined;
	if (!dirty || writesOff || !STATE_FILE) return;
	dirty = false;
	const tmp = `${STATE_FILE}.tmp`;
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(tmp, JSON.stringify(stateData, null, 1));
		renameSync(tmp, STATE_FILE);
	} catch (e) {
		if (!failureLogged) {
			failureLogged = true;
			logWarn("ui", `could not save the interface settings: ${e instanceof Error ? e.message : String(e)}`, { file: STATE_FILE });
		}
	}
}
// a change made just before quitting is saved too (the 400 ms debounce would drop it)
if (typeof process !== "undefined") process.on("exit", flushUiState);
export const uiState = {
	get<T>(key: string, fallback: T): T {
		const v = stateData[key];
		return v === undefined ? fallback : (v as T);
	},
	set(key: string, value: unknown): void {
		stateData[key] = value;
		if (writesOff || !STATE_FILE) return;
		dirty = true;
		clearTimeout(writeTimer);
		writeTimer = setTimeout(flushUiState, 400);
	},
	/** Write pending changes now (before a restart or an update install). */
	flush: flushUiState,
	/** Screenshot / test scripts: keep the in-memory state but never write the user's file (nor post the selection to the core). */
	disableWrites(): void {
		writesOff = true;
		clearTimeout(writeTimer);
	},
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
	{ id: "firstAuthor", label: "First author" },
	{ id: "dateAdded", label: "Date added" },
	{ id: "dateModified", label: "Date modified" },
	{ id: "hasPdf", label: "Has PDF" },
	{ id: "language", label: "Language" },
	{ id: "publisher", label: "Publisher" },
];

const isLevel = (s: unknown): s is SortLevel =>
	!!s &&
	typeof (s as SortLevel).key === "string" &&
	/^[A-Za-z][A-Za-z0-9]*$/.test((s as SortLevel).key) &&
	((s as SortLevel).dir === "asc" || (s as SortLevel).dir === "desc");

/** Direction a group field sorts in by default (years and months newest first, names A-Z, PDF before other files). */
const groupDir = (g: GroupBy): "asc" | "desc" => (g === "year" || g === "dateAdded" || g === "dateModified" ? "desc" : "asc");
/** Default direction when a sort key is picked. */
export const defaultDir = (key: string): "asc" | "desc" => (/^(year|dateAdded|dateModified|accessDate)$/.test(key) ? "desc" : "asc");

export interface Mods {
	shift: boolean;
	ctrl: boolean;
}

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
	/** May this user change the files of a library (false for a group that forbids it, and for any read-only group)? */
	libraryFilesEditable(id: number): boolean;
	/** Re-read the library list and the group collection trees (the sync service adds and renames groups in the background). */
	reloadLibraries(): Promise<void>;
	/**
	 * After an edit of an item's own fields (the item pane): refetch the list pages in place and the group sizes, nothing else (no
	 * collection or library requests). `fields` = the data fields that changed; the duplicate scan is dropped only when one of them
	 * can change which items are duplicates.
	 */
	refreshItems(fields?: string[]): void;
	/** Page numbers whose last request failed (the rows show skeletons until retried): 0 when every page is fine. */
	failedPages: () => number;
	/** Request the failed pages again (the list's Retry button). */
	retryFailed(): void;
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
	/**
	 * Show a top-level item from outside the list ("Open in Zinc"): select it where it is in the current view, else in My Library with
	 * no search or tag filter, and ask the list to scroll to it. Resolves to false when even My Library does not list it.
	 */
	revealItem(key: string): Promise<boolean>;
	/** The row the list should scroll to (set by revealItem; the table and the cards follow it). */
	scrollRequest: () => { index: number; seq: number } | null;
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
	/** Fine-grained per-key selection check (notifies only the rows whose selection changed). */
	isSelected(key: string): boolean;
	/** Called while dragging a scrollbar thumb: defers page fetches until a short pause or release. */
	beginDragScroll(): void;
	/** Called on scrollbar release: immediately fetches the visible pages at the final position. */
	endDragScroll(first?: number, last?: number): void;
}

/** Every collection key in a tree (roots with children). */
function flattenKeys(tree: Collection[], out = new Set<string>()): Set<string> {
	for (const c of tree) {
		out.add(c.key);
		if (c.children) flattenKeys(c.children, out);
	}
	return out;
}

interface CachedPage {
	gen: number;
	rows: ItemRow[];
}

function createStore(): AppStore {
	const [mode, setMode] = createSignal<Mode>("dark");

	// ---- collections ----
	const [collections, setCollections] = createSignal<Collection[]>([]);
	const loadCollections = () =>
		api
			.collections()
			.then((c) => {
				setCollections(c);
				mark("collections-loaded");
			})
			.catch((e) => setError(String(e?.message ?? e)));
	void loadCollections();

	// ---- libraries: My Library plus the group libraries zotero.org sync brought in ----
	const [libraries, setLibraries] = createSignal<Library[]>([]);
	const [groupCollections, setGroupCollections] = createSignal<Record<number, Collection[]>>({});
	const [libraryId, setLibraryId] = createSignal(1);
	let libSeq = 0; // only the newest reload may write: a slow older answer must not undo a newer one
	async function reloadLibraries() {
		const my = ++libSeq;
		try {
			const list = await api.libraries();
			const groupLibs = list.filter((l) => l.id !== 1);
			// one failing group keeps its previous tree instead of dropping every group's
			const answers = await Promise.allSettled(groupLibs.map((l) => api.collections(l.id)));
			if (my !== libSeq) return;
			const before = untrack(groupCollections);
			const trees: Record<number, Collection[]> = {};
			groupLibs.forEach((l, i) => {
				const a = answers[i]!;
				trees[l.id] = a.status === "fulfilled" ? a.value : (before[l.id] ?? []);
			});
			batch(() => {
				setLibraries(list);
				setGroupCollections(trees);
				// the library on screen left the account (or an old core without groups answered): fall back to My Library
				if (!list.some((l) => l.id === untrack(libraryId))) {
					setLibraryId(1);
					setViewSig({ kind: "library" });
				}
			});
		} catch {
			/* a core without groups (404) or a transient error: My Library alone */
		}
	}
	// after the first screen: a library list is not needed to paint it. The sync service adds and renames groups in the background, so poll lightly.
	const libraryStart = setTimeout(() => void reloadLibraries(), 800);
	const libraryPoll = setInterval(() => void reloadLibraries(), 30_000);
	onCleanup(() => {
		clearTimeout(libraryStart);
		clearInterval(libraryPoll);
	});
	const libraryOfCollection = (key: string): number => {
		for (const [id, tree] of Object.entries(groupCollections())) if (flattenKeys(tree).has(key)) return Number(id);
		return 1;
	};
	const libraryEditable = (id: number): boolean => libraries().find((l) => l.id === id)?.editable !== false;
	const canEdit = () => libraryEditable(libraryId());
	const libraryFilesEditable = (id: number): boolean => {
		const l = libraries().find((x) => x.id === id);
		return l?.editable !== false && l?.filesEditable !== false;
	};

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
			if (untrack(libraryId) !== lib) {
				setLibraryId(lib);
				setTagFilter([]);
			} // tags belong to one library
			if (JSON.stringify(untrack(view)) !== JSON.stringify(v)) setViewSig(v);
		});
	};
	/** Show a library's items: My Library or a group, no collection. */
	const selectLibrary = (id: number) =>
		batch(() => {
			if (untrack(libraryId) !== id) setTagFilter([]);
			setLibraryId(id);
			setViewSig({ kind: "library" });
		});
	/** Sidebar compat: null = My Library; "unfiled" / "trash" are library views; any other string is a collection key. */
	const selectCollection = (key: string | null) =>
		setView(
			key === null
				? { kind: "library" }
				: key === "unfiled"
					? { kind: "unfiled" }
					: key === "trash"
						? { kind: "trash" }
						: { kind: "collection", key },
		);

	// ---- filter (200 ms debounce) + quick-search mode ----
	const [filter, setFilterSig] = createSignal("");
	const [appliedFilter, setAppliedFilter] = createSignal("");
	const initialMode = uiState.get<string>("qmode", "titleCreatorYear");
	const [qmode, setQModeSig] = createSignal<QMode>(
		initialMode === "fields" || initialMode === "everything" ? initialMode : "titleCreatorYear",
	);
	const [fulltext, setFulltextSig] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const setFilter = (q: string) => {
		setFilterSig(q);
		clearTimeout(timer);
		timer = setTimeout(() => setAppliedFilter(q.trim()), FILTER_DEBOUNCE_MS);
	};
	onCleanup(() => clearTimeout(timer));
	const setQMode = (m: QMode) => {
		setQModeSig(m);
		uiState.set("qmode", m);
	};

	// ---- sort / group / view mode (persisted) ----
	const savedSort = uiState.get<{ levels?: unknown; groupBy?: unknown } | null>("sort", null);
	const initGroup = ((): GroupBy => {
		const g = savedSort?.groupBy === "creator" ? "firstAuthor" : savedSort?.groupBy; // "creator" was the settings page's old name for it
		return GROUP_BY.some((x) => x.id === g) ? (g as GroupBy) : "year";
	})();
	const normalise = (levels: SortLevel[], g: GroupBy): SortLevel[] => {
		const seen = new Set<string>();
		let ls = levels.filter((l) => isLevel(l) && !seen.has(l.key) && !!seen.add(l.key));
		if (g !== "none" && ls[0]?.key !== g)
			ls = [ls.find((l) => l.key === g) ?? { key: g, dir: groupDir(g) }, ...ls.filter((l) => l.key !== g)];
		if (!ls.length) ls = [{ key: "dateAdded", dir: "desc" }];
		return ls.slice(0, MAX_LEVELS);
	};
	const [groupBy, setGroupBySig] = createSignal<GroupBy>(initGroup);
	const [sortLevels, setSortLevelsSig] = createSignal<SortLevel[]>(
		normalise(
			Array.isArray(savedSort?.levels)
				? (savedSort!.levels as SortLevel[])
				: [
						{ key: "year", dir: "desc" },
						{ key: "dateAdded", dir: "desc" },
					],
			initGroup,
		),
	);
	createEffect(() => uiState.set("sort", { levels: sortLevels(), groupBy: groupBy() }));
	/** Replace every level; while grouped, the group field is forced to stay first. */
	const setSortLevels = (levels: SortLevel[]) => setSortLevelsSig(normalise(levels, untrack(groupBy)));
	/** Group the list; the group field becomes sort level 1 and the old levels follow it. */
	const setGroupBy = (g: GroupBy) =>
		batch(() => {
			setGroupBySig(g);
			setSortLevelsSig((l) => normalise(l, g));
		});
	const sortBy = (level: SortLevel) => {
		const g = untrack(groupBy);
		const cur = untrack(sortLevels);
		if (g === "none" || level.key === g) setSortLevels([level, ...cur.slice(1).filter((l) => l.key !== level.key)]);
		else setSortLevels([cur[0]!, level]);
	};

	const [viewMode, setViewModeSig] = createSignal<ViewMode>(uiState.get<string>("viewMode", "cards") === "table" ? "table" : "cards");
	const setViewMode = (m: ViewMode) => {
		setViewModeSig(m);
		uiState.set("viewMode", m);
	};

	// ---- the item query ----
	const [listFields, setListFieldsSig] = createSignal({ fields: "DOI,url", include: "creators,tags" });
	const setListFields = (fields: string, include: string) => {
		const c = untrack(listFields);
		if (c.fields !== fields || c.include !== include) setListFieldsSig({ fields, include });
	};
	/** Everything but fields/include: a change starts the list over (selection and scroll reset). */
	const baseQuery = createMemo<ItemQuery>(
		() => {
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
				then:
					ls
						.slice(1)
						.map((l) => `${l.key}:${l.dir}`)
						.join(",") || undefined,
			};
		},
		undefined as never,
		{ equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
	);
	const query = createMemo<ItemQuery>(() => ({
		...baseQuery(),
		fields: listFields().fields || undefined,
		include: listFields().include || undefined,
	}));
	/** The grouping field when the first sort level is it (groups stay contiguous), else null. */
	const groupField = createMemo(() => {
		const g = groupBy();
		const k = view().kind;
		return g !== "none" && sortLevels()[0]?.key === g && k !== "duplicates" ? g : null;
	});

	// ---- selection state (the actions are below) ----
	const [selected, setSelectedRaw] = createSignal<Set<string>>(new Set<string>());
	// Counts the changes made by the user or by a new list, so work that finishes later (a range waiting for its pages) can tell the
	// selection moved on. A counter, not a watch on `selected`: every update of that signal is a new Set, the completion's own too.
	let selVersion = 0;
	const setSelectedSig = (s: Set<string>) => {
		selVersion++;
		setSelectedRaw(s);
	};
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
			if (untrack(total) === 0) {
				setLoadingSig(true);
				return;
			}
			loadingTimer = setTimeout(() => {
				loadingTimer = undefined;
				if (pendingN > 0) setLoadingSig(true);
			}, 250);
		} else {
			if (loadingTimer) {
				clearTimeout(loadingTimer);
				loadingTimer = undefined;
			}
			if (untrack(loadingSig)) setLoadingSig(false);
		}
	};
	const [error, setErrorRaw] = createSignal<string | null>(null);
	// a refused connection means no library service is running: say that, not "ECONNREFUSED"
	const setError = (m: string | null) =>
		setErrorRaw(
			m && /ECONNREFUSED|Unable to connect|failed to fetch|connection refused/i.test(m)
				? "Can't reach the library. Start Zinc, then reopen this window."
				: m,
		);
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
	// last big jump (or immediately on endDragScroll), the pages then in view load, and requests for pages far from there are aborted.
	const FAST_JUMP_PAGES = process.env.ZN_NO_SETTLE ? Infinity : 2,
		SETTLE_MS = 60, // ZN_NO_SETTLE=1: the old fetch-everything behaviour, for A/B
		DRAG_FETCH_MS = 45;
	let fastUntil = 0;
	let draggingScroll = false;
	let lastDragFetchAt = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
	let dragFetchTimer: ReturnType<typeof setTimeout> | undefined;
	let lastRange: [number, number] = [0, 0];
	let centerPage = 0;
	let scrollDir = 1; // direction the visible range last moved in (1 = down)
	let lastVisible = { fp: -1, lp: -1, dir: 0 };
	onCleanup(() => {
		if (settleTimer) clearTimeout(settleTimer);
		if (prefetchTimer) clearTimeout(prefetchTimer);
		if (dragFetchTimer) clearTimeout(dragFetchTimer);
	});
	// Per-page reactivity: a row reads only the signal of its own page, so a page arriving (or an edit patching a row) re-runs the
	// rows of that page, not every mounted row. Signals are created on first read (at most one per page of the list).
	const pageSigs = new Map<number, [() => number, (f: (n: number) => number) => void]>();
	const pageVersion = (p: number): number => {
		let s = pageSigs.get(p);
		if (!s) {
			const [get, set] = createSignal(0);
			s = [get, set];
			pageSigs.set(p, s);
		}
		return s[0]();
	};
	const touchPage = (p: number) => {
		const s = pageSigs.get(p);
		if (s) {
			stats.pageTouches++;
			s[1]((n) => n + 1);
		}
	};
	const touchAllPages = () =>
		batch(() => {
			for (const p of [...pageSigs.keys()]) touchPage(p);
		});
	let dupCache: Promise<ItemRow[]> | null = null;
	// Pages whose request failed: they stay skeletons, so the list says so and offers Retry (a failed page is not asked for again by
	// the rows re-running, only by retryFailed() or a reset).
	const failed = new Set<number>();
	const [failedCount, setFailedCount] = createSignal(0);
	const syncFailed = () => setFailedCount(failed.size);

	/** The duplicate sets as flat rows (one per item, sets adjacent): the core lists sets, not items. */
	function duplicateRows(signal: AbortSignal): Promise<ItemRow[]> {
		dupCache ??= api
			.duplicates(signal)
			.then((r) =>
				r.sets.flatMap((s) =>
					s.keys.map((key): ItemRow => ({
						key,
						itemType: s.itemType ?? "journalArticle",
						title: s.title ?? "",
						creatorsSummary: s.creatorsSummary,
						year: s.year ?? null,
						publication: `Duplicate by ${s.reason}`,
						dateAdded: "",
						primaryAttachment: null,
						attachmentCount: 0,
						noteCount: 0,
						tags: [],
					})),
				),
			)
			.catch((e) => {
				dupCache = null;
				throw e;
			});
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

	const pending = new Map<number, Promise<void>>(); // page -> its request in flight
	// The keys of every page that arrived for this generation, kept when the rows are evicted: extending a long range by one row
	// must not ask for all of its pages again. Cleared by reset().
	const pageKeys = new Map<number, string[]>();
	/** Fetch a page; one already being fetched is not asked for twice, and the promise returned for it settles when that request does. */
	function loadPage(p: number, g: number): Promise<void> {
		if (g !== gen) return Promise.resolve();
		if (inflight.has(p)) return pending.get(p) ?? Promise.resolve();
		const run: Promise<void> = fetchIntoCache(p, g).finally(() => {
			if (pending.get(p) === run) pending.delete(p);
		});
		pending.set(p, run);
		return run;
	}
	async function fetchIntoCache(p: number, g: number) {
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
			if (hardCleared < hardGen) {
				// first page of a new list replaces the old list's rows
				for (const [k, v] of cache)
					if (v.gen < hardGen) {
						cache.delete(k);
						dropped.push(k);
					}
				hardCleared = hardGen;
			}
			cache.set(p, { gen: g, rows: res.items });
			pageKeys.set(
				p,
				res.items.map((r) => r.key),
			);
			failed.delete(p);
			evict();
			const ms = performance.now() - t0;
			stats.fetchMs += ms;
			stats.fetchMaxMs = Math.max(stats.fetchMaxMs, ms);
			batch(() => {
				setTotal(res.total);
				syncFailed();
				if (failed.size === 0) setError(null);
				setPagesLoaded((n) => n + 1);
				touchPage(p);
				for (const k of dropped) touchPage(k); // rows still showing the old list's page go to skeleton / refetch
			});
			mark("items-loaded");
			if (draggingScroll) pumpDragFetch(g);
			else if (performance.now() >= fastUntil) schedulePrefetch(g);
		} catch (e) {
			if (g === gen && (e as Error)?.name !== "AbortError") {
				failed.add(p);
				batch(() => {
					syncFailed();
					setError(String((e as Error)?.message ?? e));
				});
			}
		} finally {
			// only this request's own bookkeeping: an aborted one may already have been replaced by a new request for the page
			if (pageAbort.get(p) === mine) {
				pageAbort.delete(p);
				if (g === gen) inflight.delete(p);
			}
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
	function reset(hard: boolean, keepDuplicates = false) {
		gen++;
		abort.abort();
		abort = new AbortController();
		inflight.clear();
		pageAbort.clear();
		pageKeys.clear();
		fastUntil = 0;
		draggingScroll = false;
		lastDragFetchAt = 0;
		// a settle step armed by the old list's scrolling must not run against this one (it aborts pages outside the old position)
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = undefined;
		}
		if (prefetchTimer) {
			clearTimeout(prefetchTimer);
			prefetchTimer = undefined;
		}
		if (dragFetchTimer) {
			clearTimeout(dragFetchTimer);
			dragFetchTimer = undefined;
		}
		lastRange = [0, 0];
		lastVisible = { fp: -1, lp: -1, dir: 0 };
		if (!keepDuplicates) dupCache = null;
		if (failed.size) {
			failed.clear();
			syncFailed();
			setErrorRaw(null);
		}
		if (hard) {
			hardGen = gen;
			centerPage = 0;
			lastVisible = { fp: -1, lp: -1, dir: 0 };
			lastRange = [0, 0];
			batch(() => {
				setSelectedSig(new Set<string>());
				setActiveKey(null);
				setAnchor(-1);
				setFocusIndex(-1);
				setListVersion(gen);
			});
		}
		// the stale rows stay on screen until the fresh page lands; itemAt() asks for every page in view (soft reset: wake the rows)
		if (!hard) touchAllPages();
		void loadPage(hard ? 0 : Math.min(centerPage, Math.max(0, Math.ceil(untrack(total) / PAGE) - 1)), gen);
	}

	let groupSeq = 0;
	function loadGroups() {
		const f = untrack(groupField);
		const s = ++groupSeq;
		if (!f) {
			setGroups([]);
			return;
		}
		api.itemGroups(untrack(baseQuery), f)
			.then((r) => {
				if (s === groupSeq) setGroups(r.groups);
			})
			.catch(() => {
				if (s === groupSeq) setGroups([]);
			});
	}

	// A new view / filter / sort starts over; old rows stay visible until page 0 of the new list lands.
	createEffect(
		on(
			() => JSON.stringify([baseQuery(), view()]),
			() => reset(true),
		),
	);
	// What the visible list shows (fields / include) changed: refetch, keep selection and scroll.
	createEffect(on(listFields, () => reset(false), { defer: true }));
	createEffect(
		on(
			() => [JSON.stringify(baseQuery()), groupField(), itemsRev()] as const,
			() => loadGroups(),
		),
	);
	// browser-extension saves go to the selected collection (best effort; not while a script runs with writes disabled)
	createEffect(
		on(
			view,
			(v) => {
				if (writesOff) return;
				void api
					.postSelection(
						v.kind === "collection" || v.kind === "savedSearch"
							? { kind: v.kind === "savedSearch" ? "search" : "collection", key: v.key }
							: { kind: v.kind },
					)
					.catch(() => {});
			},
			{ defer: true },
		),
	);

	/** Ask again for the pages that failed: their rows wake up (itemAt) and the requests go out. */
	function retryFailed() {
		const pages = [...failed];
		if (!pages.length) return;
		failed.clear();
		batch(() => {
			syncFailed();
			setErrorRaw(null);
			for (const p of pages) touchPage(p);
		});
		for (const p of pages) void loadPage(p, gen);
	}

	function itemAt(i: number): ItemRow | undefined {
		stats.itemAt++;
		const p = Math.floor(i / PAGE);
		pageVersion(p); // re-run this row when ITS page arrives (not on every page of the list)
		listVersion();
		const e = cache.get(p);
		// (not during a fast move or scrollbar drag: the settle step / release loads the pages in view; this row re-runs when its page arrives)
		if (
			(!e || e.gen !== gen) &&
			!failed.has(p) &&
			i >= 0 &&
			i < Math.max(untrack(total), 1) &&
			!draggingScroll &&
			performance.now() >= fastUntil
		)
			queueMicrotask(() => void loadPage(p, gen));
		if (!e) stats.skeleton++;
		return e?.rows[i - p * PAGE]; // a stale row (older generation) is returned meanwhile
	}
	const peek = (i: number): ItemRow | undefined => {
		const p = Math.floor(i / PAGE);
		return cache.get(p)?.rows[i - p * PAGE];
	};
	function schedulePrefetch(g: number) {
		if (prefetchTimer || g !== gen || draggingScroll || performance.now() < fastUntil) return;
		prefetchTimer = setTimeout(() => {
			prefetchTimer = undefined;
			if (g !== gen || draggingScroll || performance.now() < fastUntil) return;
			const lastPage = Math.ceil(untrack(total) / PAGE) - 1;
			if (lastPage < 0) return;
			const [a, b] = lastRange;
			const fp = Math.max(0, Math.floor(a / PAGE)),
				lp = Math.max(fp, Math.floor(b / PAGE));
			// Wait until every visible page has landed before fetching off-screen pages ahead.
			for (let p = fp; p <= lp; p++) {
				const e = cache.get(p);
				if (!e || e.gen !== gen) return;
			}
			const candidates: number[] = [];
			for (let k = 1; k <= PREFETCH_AHEAD; k++) {
				const p = scrollDir >= 0 ? lp + k : fp - k;
				if (p >= 0 && p <= lastPage) candidates.push(p);
			}
			const behind = scrollDir >= 0 ? fp - 1 : lp + 1;
			if (behind >= 0 && behind <= lastPage) candidates.push(behind);
			for (const p of candidates) {
				if (inflight.size >= MAX_PREFETCH_INFLIGHT) break;
				const e = cache.get(p);
				if ((e && e.gen === gen) || inflight.has(p) || failed.has(p)) continue; // a failed page waits for Retry
				stats.prefetches++;
				void loadPage(p, gen);
			}
		}, 16);
	}
	function loadVisible(first: number, last: number) {
		const fp = Math.max(0, Math.floor(first / PAGE)),
			lp = Math.max(fp, Math.floor(last / PAGE));
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
		// Visible pages ALWAYS go first; prefetch runs after they arrive (or 16 ms later if already cached).
		let needVisible = false;
		for (let p = fp; p <= Math.min(lastPage, lp); p++) {
			const e = cache.get(p);
			if (failed.has(p)) continue; // a failed page waits for Retry
			if (!e || e.gen !== gen) {
				needVisible = true;
				if (!inflight.has(p)) void loadPage(p, gen);
			}
		}
		if (!needVisible) schedulePrefetch(gen);
	}
	function pumpDragFetch(g: number) {
		if (!draggingScroll || g !== gen) return;
		const lastPage = Math.ceil(untrack(total) / PAGE) - 1;
		if (lastPage < 0) return;
		const [a, b] = lastRange;
		const fp = Math.max(0, Math.floor(a / PAGE)),
			lp = Math.max(fp, Math.floor(b / PAGE));
		const c = Math.max(0, Math.floor((a + b) / 2 / PAGE));
		if (c !== centerPage) {
			scrollDir = c > centerPage ? 1 : -1;
			centerPage = c;
			evict();
		}
		abortOutside(fp, lp);
		const missing: number[] = [];
		for (let p = fp; p <= Math.min(lastPage, lp); p++) {
			const e = cache.get(p);
			if (failed.has(p) || inflight.has(p)) continue;
			if (!e || e.gen !== gen) missing.push(p);
		}
		if (!missing.length) return;
		const elapsed = performance.now() - lastDragFetchAt;
		if (elapsed < DRAG_FETCH_MS) {
			dragFetchTimer ??= setTimeout(() => {
				dragFetchTimer = undefined;
				pumpDragFetch(g);
			}, Math.max(1, DRAG_FETCH_MS - elapsed));
			return;
		}
		lastDragFetchAt = performance.now();
		lastVisible = { fp, lp, dir: scrollDir };
		for (const p of missing) void loadPage(p, gen);
	}
	function beginDragScroll() {
		draggingScroll = true;
		fastUntil = performance.now() + SETTLE_MS;
		lastDragFetchAt = 0;
		if (prefetchTimer) {
			clearTimeout(prefetchTimer);
			prefetchTimer = undefined;
		}
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = undefined;
		}
		if (dragFetchTimer) {
			clearTimeout(dragFetchTimer);
			dragFetchTimer = undefined;
		}
	}
	function endDragScroll(first?: number, last?: number) {
		if (!draggingScroll) return;
		draggingScroll = false;
		fastUntil = 0;
		lastDragFetchAt = 0;
		if (settleTimer) {
			clearTimeout(settleTimer);
			settleTimer = undefined;
		}
		if (dragFetchTimer) {
			clearTimeout(dragFetchTimer);
			dragFetchTimer = undefined;
		}
		if (first !== undefined && last !== undefined) lastRange = [first, last];
		const [a, b] = lastRange;
		const sfp = Math.max(0, Math.floor(a / PAGE)),
			slp = Math.max(sfp, Math.floor(b / PAGE));
		abortOutside(sfp - PREFETCH_AHEAD - 1, slp + PREFETCH_AHEAD + 1);
		lastVisible = { fp: -1, lp: -1, dir: 0 };
		loadVisible(a, b);
	}
	/** The visible item range: re-centres the cache and prefetches the pages ahead in the scroll direction. */
	function setVisible(first: number, last: number) {
		const fp = Math.max(0, Math.floor(first / PAGE)),
			lp = Math.max(fp, Math.floor(last / PAGE));
		lastRange = [first, last];
		if (draggingScroll) {
			fastUntil = performance.now() + SETTLE_MS;
			if (prefetchTimer) {
				clearTimeout(prefetchTimer);
				prefetchTimer = undefined;
			}
			if (settleTimer) {
				clearTimeout(settleTimer);
				settleTimer = undefined;
			}
			if (lastVisible.fp >= 0 && fp !== lastVisible.fp) scrollDir = fp > lastVisible.fp ? 1 : -1;
			pumpDragFetch(gen);
			return;
		}
		const bigJump = lastVisible.fp >= 0 && Math.abs(fp - lastVisible.fp) > FAST_JUMP_PAGES;
		if (bigJump) {
			// a big jump: fetch nothing until the range settles (see FAST_JUMP_PAGES)
			fastUntil = performance.now() + SETTLE_MS;
			lastVisible = { fp, lp, dir: lastVisible.fp >= 0 && fp < lastVisible.fp ? -1 : 1 };
			centerPage = Math.max(0, Math.floor((first + last) / 2 / PAGE));
			if (prefetchTimer) {
				clearTimeout(prefetchTimer);
				prefetchTimer = undefined;
			}
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = undefined;
				fastUntil = 0;
				const [a, b] = lastRange;
				const sfp = Math.max(0, Math.floor(a / PAGE)),
					slp = Math.max(sfp, Math.floor(b / PAGE));
				abortOutside(sfp - PREFETCH_AHEAD - 1, slp + PREFETCH_AHEAD + 1);
				lastVisible = { fp: -1, lp: -1, dir: 0 }; // force loadVisible below to load what is in view now
				loadVisible(a, b);
			}, SETTLE_MS);
			return;
		}
		if (performance.now() < fastUntil) {
			lastVisible = { fp, lp, dir: scrollDir };
			return;
		} // still settling
		loadVisible(first, last);
	}
	function indexOfKey(key: string): number {
		for (const [p, e] of cache) {
			const j = e.rows.findIndex((r) => r.key === key);
			if (j >= 0) return p * PAGE + j;
		}
		return -1;
	}
	function patchItem(key: string, patch: Partial<ItemRow>) {
		for (const [p, e] of cache) {
			const j = e.rows.findIndex((r) => r.key === key);
			if (j >= 0) {
				e.rows[j] = { ...e.rows[j]!, ...patch };
				touchPage(p);
			}
		}
	}

	/** Re-fetch collections + the list (after edits, imports, trash...). Selection and scroll stay. */
	function refresh() {
		void loadCollections();
		void reloadLibraries();
		batch(() => {
			setItemsRev((n) => n + 1);
			reset(false);
		});
	}
	function refreshItems(fields?: string[]) {
		batch(() => {
			setItemsRev((n) => n + 1);
			reset(false, !fields || !affectsDuplicates(fields));
		});
	}

	// ---- selection ----
	const isSelected = createSelector<Set<string>, string>(
		() => selected(),
		(key, s) => s.has(key),
	);
	const setSelected = (s: Set<string>) => setSelectedSig(new Set(s));

	function selectOnly(key: string | null, index = -1) {
		batch(() => {
			setSelectedSig(key ? new Set([key]) : new Set<string>());
			setActiveKey(key);
			setAnchor(index);
			setFocusIndex(index);
		});
	}

	const [scrollRequest, setScrollRequest] = createSignal<{ index: number; seq: number } | null>(null);
	let revealSeq = 0;
	async function revealItem(key: string): Promise<boolean> {
		const my = ++revealSeq;
		// where it is in the list on screen (the duplicates view and the full-text results are not plain listings: skip them)
		const plain = untrack(view).kind !== "duplicates" && !untrack(fulltext);
		let index = plain ? indexOfKey(key) : -1;
		if (index < 0 && plain) index = await api.itemIndex(key, untrack(baseQuery)).catch(() => -1);
		if (my !== revealSeq) return false; // a newer request took over while the lookup ran: leave the list to it
		if (index < 0) {
			// not in this view: My Library, with nothing filtering it out (the list starts over here, synchronously)
			clearTimeout(timer);
			batch(() => {
				setFulltextSig(false);
				setFilterSig("");
				setAppliedFilter("");
				setTagFilter([]);
				selectLibrary(1);
			});
			index = await api.itemIndex(key, untrack(baseQuery)).catch(() => -1);
		}
		if (my !== revealSeq) return false; // a newer request took over
		selectOnly(key, index);
		if (index >= 0) setScrollRequest({ index, seq: my });
		return index >= 0;
	}
	/** Keys of rows a..b that are cached. */
	function rangeKeys(a: number, b: number): string[] {
		const out: string[] = [];
		for (let i = a; i <= b; i++) {
			const r = peek(i);
			if (r) out.push(r.key);
		}
		return out;
	}
	/**
	 * Keys of rows a..b, fetching the pages that are not cached (and waiting for the ones already on their way). Each page is read the
	 * moment it arrives, so a range longer than the page cache holds still completes: the cache drops far pages as the others load.
	 * null when the list started over meanwhile (the keys would belong to the old one).
	 */
	async function keysOfRange(a: number, b: number): Promise<string[] | null> {
		const g = gen;
		const byPage = new Map<number, string[]>();
		const take = (p: number, keys: string[]) => {
			const from = Math.max(a, p * PAGE),
				to = Math.min(b, p * PAGE + keys.length - 1);
			byPage.set(p, keys.slice(from - p * PAGE, to - p * PAGE + 1));
		};
		const first = Math.floor(a / PAGE),
			last = Math.floor(b / PAGE);
		await Promise.all(
			Array.from({ length: last - first + 1 }, async (_, n) => {
				const p = first + n;
				if (!pageKeys.has(p)) await loadPage(p, g);
				if (g !== gen) return;
				let keys = pageKeys.get(p);
				if (!keys) {
					// its request was aborted (the list scrolled away from it) or failed: fetch it for this
					keys = (await fetchPage(p, abort.signal)).items.map((r) => r.key);
					if (g !== gen) return;
					pageKeys.set(p, keys);
				}
				take(p, keys);
			}),
		);
		if (g !== gen) return null;
		return [...byPage.entries()].sort((x, y) => x[0] - y[0]).flatMap(([, keys]) => keys);
	}
	/** keysOfRange, started again when the same list was only refreshed in place meanwhile; null once the caller's work is stale. */
	async function settledKeys(a: number, b: number, current: () => boolean): Promise<string[] | null> {
		while (current()) {
			const g = gen;
			try {
				const keys = await keysOfRange(a, b);
				if (keys) return keys;
			} catch (e) {
				if (g === gen) throw e; // not the refresh's own abort
			}
		}
		return null;
	}
	/**
	 * Rows a..b were just selected from what is cached; add the ones on pages that are not, when those arrive. Dropped when the list
	 * or the selection changed meanwhile: a later click wins. Call it after the selection was set.
	 */
	function completeRange(a: number, b: number) {
		if (rangeKeys(a, b).length > b - a) return; // every row of the range was cached
		const view0 = hardGen,
			v0 = selVersion;
		void settledKeys(a, b, () => view0 === hardGen && v0 === selVersion)
			.then((keys) => {
				if (!keys || view0 !== hardGen || v0 !== selVersion) return;
				const s2 = new Set(untrack(selected));
				for (const k of keys) s2.add(k);
				setSelectedRaw(s2);
			})
			.catch((e) => {
				if (view0 === hardGen) setError(String(e?.message ?? e));
			});
	}
	function selectClick(index: number, mods: Mods) {
		const it = peek(index);
		if (!it) return;
		const sel = new Set(selected());
		let range: [number, number] | undefined;
		if (mods.shift && anchor() >= 0) {
			const a = Math.min(anchor(), index),
				b = Math.max(anchor(), index);
			if (!mods.ctrl) sel.clear();
			for (const k of rangeKeys(a, b)) sel.add(k);
			setFocusIndex(index);
			range = [a, b];
		} else if (mods.ctrl) {
			if (!sel.delete(it.key)) sel.add(it.key);
			batch(() => {
				setAnchor(index);
				setFocusIndex(index);
			});
		} else {
			selectOnly(it.key, index);
			return;
		}
		batch(() => {
			setSelectedSig(sel);
			setActiveKey(it.key);
		});
		if (range) completeRange(range[0], range[1]); // pages that were not cached: the rest of the range follows when they arrive
	}
	let focusSeq = 0;
	/**
	 * Move the focus (and the selection) to row `next`. A row whose page is not cached yet (End, or Page Down past the loaded pages)
	 * is focused when its key arrives, unless another key press, click or list took over meanwhile.
	 */
	function focusRow(next: number, extend: boolean): boolean {
		const seq = ++focusSeq;
		const it = peek(next);
		if (it) {
			focusAt(next, it.key, extend);
			return true;
		}
		if (next < 0 || next >= untrack(total)) return false;
		const view0 = hardGen,
			v0 = selVersion;
		const current = () => seq === focusSeq && view0 === hardGen && v0 === selVersion;
		void settledKeys(next, next, current)
			.then((keys) => {
				if (keys?.[0] && current()) focusAt(next, keys[0], extend);
			})
			.catch((e) => {
				if (view0 === hardGen) setError(String(e?.message ?? e));
			});
		return true;
	}
	function focusAt(next: number, key: string, extend: boolean) {
		if (extend && anchor() >= 0) {
			const a = Math.min(anchor(), next),
				b = Math.max(anchor(), next);
			batch(() => {
				setSelectedSig(new Set(rangeKeys(a, b)));
				setActiveKey(key);
				setFocusIndex(next);
			});
			completeRange(a, b);
		} else selectOnly(key, next);
	}
	function selectAll() {
		const n = untrack(total);
		if (n === 0) return;
		const view0 = hardGen, // dropped when the list changes (another view, filter or sort) before the keys arrive,
			v0 = selVersion; // or when the user selects something else meanwhile
		const v = untrack(view);
		if (v.kind === "duplicates" || n <= PAGE) {
			void settledKeys(0, n - 1, () => view0 === hardGen && v0 === selVersion)
				.then((keys) => {
					if (keys && view0 === hardGen && v0 === selVersion) setSelectedRaw(new Set(keys));
				})
				.catch((e) => {
					if (view0 === hardGen) setError(String(e?.message ?? e));
				});
			return;
		}
		// the whole list: keys only, 1000 per request
		const q = { ...untrack(baseQuery), fields: undefined, include: undefined } as ItemQuery;
		void (async () => {
			const keys = new Set<string>();
			for (let off = 0; off < Math.min(n, 50_000); off += 1000) {
				const r = await api.items(q, off, 1000);
				if (view0 !== hardGen) return;
				r.items.forEach((x) => keys.add(x.key));
			}
			if (view0 === hardGen && v0 === selVersion) setSelectedRaw(keys);
		})().catch((e) => {
			if (view0 === hardGen) setError(String(e?.message ?? e));
		});
	}
	const keysFor = (key: string): string[] => (selected().has(key) ? [...selected()] : [key]);

	// ---- tabs (not persisted): the library plus one reader tab per open attachment, as ui/src/store.ts ----
	const [tabs, setTabs] = createSignal<Tab[]>([{ id: "library" }]);
	const [activeTab, setActiveTab] = createSignal("library");
	function openAttachment(attachmentKey: string, title: string, itemKey: string) {
		if (tabs().some((t) => t.id === attachmentKey)) return void setActiveTab(attachmentKey);
		const library = untrack(libraryId); // the reader follows this library's read-only state
		const openTab = (tab: Tab = { id: attachmentKey, kind: "reader", title, itemKey, library }) => {
			if (!tabs().some((t) => t.id === attachmentKey)) setTabs([...tabs(), tab]);
			setActiveTab(attachmentKey);
			if (itemKey) readState.markRead(itemKey);
		};
		// PDFs open in the native reader; snapshots and EPUBs in a web tab (Zotero's reader-host in the shared WebView2, src/webview) when
		// the core serves it, else in their default app.
		void api.item(attachmentKey).then(
			(d) => {
				const parent =
					itemKey ||
					(d.data && typeof d.data === "object" && "parentItem" in d.data && typeof d.data.parentItem === "string"
						? d.data.parentItem
						: "");
				if (parent) readState.markRead(parent);
				const ct = String((d.data as { contentType?: unknown }).contentType ?? "");
				if (!ct || /pdf/i.test(ct)) return openTab();
				// a linked URL has no file for the reader (the core opens it in the browser)
				const linked = (d.data as { linkMode?: unknown }).linkMode === "linked_url";
				const newTab = webTabOpener();
				if (isWebContent(ct) && !linked && newTab) return newTab(attachmentKey);
				if (isWebContent(ct) && !linked && webBase())
					return openTab({ id: attachmentKey, kind: "web", title, itemKey, attachmentKey, contentType: ct });
				// program/script files ask for confirmation first (ui/openExternal); loaded lazily to keep ui out of the store's imports
				return import("./ui/openExternal").then((m) => m.openAttachmentExternally(attachmentKey)).catch(() => openTab());
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
		tabs,
		activeTab,
		setActiveTab,
		openAttachment,
		closeTab,
		mode,
		setMode,
		collections,
		libraries,
		libraryId,
		selectLibrary,
		groupCollections,
		libraryOfCollection,
		libraryEditable,
		canEdit,
		libraryFilesEditable,
		reloadLibraries,
		refreshItems,
		failedPages: failedCount,
		retryFailed,
		selectedCollection,
		selectCollection,
		filter,
		setFilter,
		total,
		itemAt,
		listVersion,
		selectedItem,
		selectItem: (key) => selectOnly(key, key ? indexOfKey(key) : -1),
		qmode,
		setQMode,
		fulltext,
		setFulltext: setFulltextSig,
		loading: loadingSig,
		error,
		query,
		groups,
		pagesLoaded,
		// ListStore
		view,
		setView,
		tagFilter,
		setTagFilter: (t) => setTagFilter([...t]),
		selected,
		setSelected,
		viewMode,
		setViewMode,
		sortLevels,
		setSortLevels,
		groupBy,
		setGroupBy,
		refresh,
		// list internals
		setListFields,
		setVisible,
		peek,
		indexOfKey,
		patchItem,
		cachedPages: () => [...cache.keys()].sort((a, b) => a - b),
		anchor,
		focusIndex,
		selectOnly,
		revealItem,
		scrollRequest,
		selectClick,
		focusRow,
		selectAll,
		keysFor,
		sortBy,
		itemsRev,
		isSelected,
		beginDragScroll,
		endDragScroll,
	};
}

export const store: AppStore = createRoot(createStore);
