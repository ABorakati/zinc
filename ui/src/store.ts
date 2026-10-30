import { createSignal, createMemo, createRoot, createResource, createEffect } from "solid-js";
import { api, type ItemQuery, type ItemSummary } from "./api";
import { openSummary as openItemSummary } from "./itemopen"; // circular with store, but only used inside functions

export type View =
	| { kind: "library" }
	| { kind: "unfiled" }
	| { kind: "trash" }
	| { kind: "collection"; key: string }
	| { kind: "search"; key: string };

/** Quick-search modes (toolbar search box), as Zotero: "Title, Creator, Year" | "All Fields & Tags" | "Everything". */
export type QMode = "titleCreatorYear" | "fields" | "everything";
const QMODE_KEY = "zn.qmode.v1";
function loadQMode(): QMode {
	try {
		const v = localStorage.getItem(QMODE_KEY);
		if (v === "fields" || v === "everything") return v;
	} catch { /* ignore */ }
	return "titleCreatorYear";
}

export const PAGE = 100;

const SORT_KEY = "zn.sort.v1";
function loadSort(): { key: string; dir: "asc" | "desc" } {
	try {
		const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null");
		if (s && typeof s.key === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(s.key) && (s.dir === "asc" || s.dir === "desc")) return { key: s.key, dir: s.dir };
	} catch { /* ignore */ }
	return { key: "dateAdded", dir: "desc" };
}

export type ViewMode = "table" | "cards";
const VIEWMODE_KEY = "zn.viewmode.v1";
function loadViewMode(): ViewMode {
	try { return localStorage.getItem(VIEWMODE_KEY) === "cards" ? "cards" : "table"; } catch { return "table"; }
}

/** A reader tab (attachmentKey set) or the single Settings tab. */
export interface Tab { id: string; title: string; attachmentKey: string; kind: "reader" | "settings" }
export const SETTINGS_TAB = "settings";

function createStore() {
	const [view, setView] = createSignal<View>({ kind: "library" });
	const [tag, setTag] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal("");
	const [fulltext, setFulltext] = createSignal(false);
	const [sort, setSort] = createSignal<{ key: string; dir: "asc" | "desc" }>(loadSort());
	createEffect(() => { try { localStorage.setItem(SORT_KEY, JSON.stringify(sort())); } catch { /* ignore */ } });

	const [viewMode, setViewMode] = createSignal<ViewMode>(loadViewMode());
	createEffect(() => { try { localStorage.setItem(VIEWMODE_KEY, viewMode()); } catch { /* ignore */ } });

	const [qmode, setQMode] = createSignal<QMode>(loadQMode());
	createEffect(() => { try { localStorage.setItem(QMODE_KEY, qmode()); } catch { /* ignore */ } });

	const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
	const [activeKey, setActiveKey] = createSignal<string | null>(null); // item shown in pane
	const [anchor, setAnchor] = createSignal(-1);
	const [focusIndex, setFocusIndex] = createSignal(-1);

	const [tabs, setTabs] = createSignal<Tab[]>([]);
	const [activeTab, setActiveTab] = createSignal("library");

	// bump to force collection/tag re-fetch
	const [collectionsRev, setCollectionsRev] = createSignal(0);
	const [tagsRev, setTagsRev] = createSignal(0);
	const [itemsRev, setItemsRev] = createSignal(0);
	const bumpCollections = () => setCollectionsRev((n) => n + 1);
	const bumpTags = () => setTagsRev((n) => n + 1);
	const bumpItems = () => setItemsRev((n) => n + 1);

	const [collections, { refetch: refetchCollections }] = createResource(collectionsRev, () => api.collections());

		// Browser-extension saves (core: /connector/*) go to the collection selected here, and bump a revision the
		// UI polls so new items show up. Best effort: failures are ignored.
		createEffect(() => {
			const v = view();
			void fetch("/api/ui/selection", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(v.kind === "collection" || v.kind === "search" ? { kind: v.kind, key: v.key } : { kind: v.kind }),
			}).catch(() => {});
		});
		if (typeof document !== "undefined") {
			let lastRev: number | null = null;
			let lastExt: number | null = null;
			let lastReveal: number | null = null;
			// "Open in zotero-next" from the Word sidebar (POST /api/ui/reveal): show the item in the library tab.
			const doReveal = (key: string, title: string) => {
				store_revealItem(key, title);
			};
			setInterval(() => {
				// the reveal check also runs while the window is hidden/minimized, the list refresh only when visible
				fetch("/api/ui/selection").then((r) => r.json()).then((s: { rev?: number; ext?: number; reveal?: { key: string; title: string; seq: number; at?: number } | null }) => {
					if (typeof s.rev !== "number") return;
					const rv = s.reveal;
					if (rv && typeof rv.seq === "number") {
						// on the first poll only a reveal from the last minute counts (the sidebar may have started this app for it)
						const fresh = lastReveal !== null || (typeof rv.at === "number" && Date.now() - rv.at < 60_000);
						if (rv.seq !== lastReveal && fresh) doReveal(rv.key, rv.title);
						lastReveal = rv.seq;
					} else if (lastReveal === null) lastReveal = 0;
					if (document.hidden) return;
					// rev: saves through the app's own connector; ext: writes by other processes (browser host, MCP)
					const changed = (lastRev !== null && s.rev !== lastRev) || (lastExt !== null && s.ext !== undefined && s.ext !== lastExt);
					if (changed) { bumpItems(); bumpCollections(); bumpTags(); }
					lastRev = s.rev;
					if (s.ext !== undefined) lastExt = s.ext;
				}).catch(() => {});
			}, 1500);
		}

	const query = createMemo<ItemQuery>(() => {
		const v = view();
		const s = sort();
		return {
			collection: v.kind === "collection" ? v.key : undefined,
			search: v.kind === "search" ? v.key : undefined,
			qmode: qmode() !== "titleCreatorYear" ? qmode() : undefined,
			unfiled: v.kind === "unfiled",
			trash: v.kind === "trash",
			tag: tag() ?? undefined,
			q: !fulltext() && filter().trim() ? filter().trim() : undefined,
			sort: s.key,
			dir: s.dir,
		};
	});

	/** Show an item in the library tab: library view, no tag/filter, the item selected (the title filter puts it in the list). */
	function store_revealItem(key: string, title: string) {
		setActiveTab("library");
		setView({ kind: "library" });
		setTag(null);
		setFulltext(false);
		setFilter(title.trim() ? `"${title.replace(/"/g, " ").trim()}"` : "");
		selectOnly(key, 0);
		try { window.focus(); } catch { /* ignore */ }
	}

	function selectOnly(key: string | null, index = -1) {
		setSelected(key ? new Set([key]) : new Set<string>());
		setActiveKey(key);
		setAnchor(index);
		setFocusIndex(index);
	}

	function openAttachment(attachmentKey: string, title: string) {
		const existing = tabs().find((t) => t.attachmentKey === attachmentKey);
		if (existing) return setActiveTab(existing.id);
		const t: Tab = { id: "t" + attachmentKey, title, attachmentKey, kind: "reader" };
		setTabs([...tabs(), t]);
		setActiveTab(t.id);
	}

	/** Open (or focus) the Settings tab; there is only ever one. */
	function openSettings() {
		if (!tabs().some((t) => t.id === SETTINGS_TAB)) setTabs([...tabs(), { id: SETTINGS_TAB, title: "Settings", attachmentKey: "", kind: "settings" }]);
		setActiveTab(SETTINGS_TAB);
	}

	function closeTab(id: string) {
		if (id === "library") return;
		const list = tabs();
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) return;
		const next = list.filter((t) => t.id !== id);
		setTabs(next);
		if (activeTab() === id) setActiveTab(next[Math.min(i, next.length - 1)]?.id ?? "library");
	}

	/** Open the best attachment for an item key (used from search hits). */
	async function openItem(key: string, title: string) {
		const d = await api.item(key);
		const att = d.children.find((c) => c.itemType === "attachment" && c.hasFile &&
			/pdf|epub/i.test(c.contentType ?? "")) ?? d.children.find((c) => c.itemType === "attachment" && c.hasFile);
		if (att) openAttachment(att.key, title || att.title);
	}

	/** Double-click / Enter on an item: attachment in a reader tab, else a link in the browser (see itemopen.ts). */
	function openSummary(it: ItemSummary) {
		void openItemSummary(it);
	}

	return {
		qmode, setQMode, viewMode, setViewMode, view, setView, tag, setTag, filter, setFilter, fulltext, setFulltext, sort, setSort,
		selected, setSelected, activeKey, setActiveKey, anchor, setAnchor, focusIndex, setFocusIndex,
		tabs, activeTab, setActiveTab, openAttachment, openSettings, closeTab, openItem, openSummary,
		collections, refetchCollections, collectionsRev, bumpCollections, tagsRev, bumpTags, itemsRev, bumpItems,
		query, selectOnly,
	};
}

export const store = createRoot(createStore);
