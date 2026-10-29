import { createSignal, createMemo, createRoot, createResource } from "solid-js";
import { api, type ItemQuery, type ItemSummary } from "./api";

export type View =
	| { kind: "library" }
	| { kind: "unfiled" }
	| { kind: "trash" }
	| { kind: "collection"; key: string };

export const PAGE = 100;

export interface Tab { id: string; title: string; attachmentKey: string }

function createStore() {
	const [view, setView] = createSignal<View>({ kind: "library" });
	const [tag, setTag] = createSignal<string | null>(null);
	const [filter, setFilter] = createSignal("");
	const [fulltext, setFulltext] = createSignal(false);
	const [sort, setSort] = createSignal<{ key: string; dir: "asc" | "desc" }>({ key: "dateAdded", dir: "desc" });

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

	const query = createMemo<ItemQuery>(() => {
		const v = view();
		const s = sort();
		return {
			collection: v.kind === "collection" ? v.key : undefined,
			unfiled: v.kind === "unfiled",
			trash: v.kind === "trash",
			tag: tag() ?? undefined,
			q: !fulltext() && filter().trim() ? filter().trim() : undefined,
			sort: s.key,
			dir: s.dir,
		};
	});

	function selectOnly(key: string | null, index = -1) {
		setSelected(key ? new Set([key]) : new Set<string>());
		setActiveKey(key);
		setAnchor(index);
		setFocusIndex(index);
	}

	function openAttachment(attachmentKey: string, title: string) {
		const existing = tabs().find((t) => t.attachmentKey === attachmentKey);
		if (existing) return setActiveTab(existing.id);
		const t: Tab = { id: "t" + attachmentKey, title, attachmentKey };
		setTabs([...tabs(), t]);
		setActiveTab(t.id);
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

	function openSummary(it: ItemSummary) {
		if (it.primaryAttachment) openAttachment(it.primaryAttachment.key, it.title);
	}

	return {
		view, setView, tag, setTag, filter, setFilter, fulltext, setFulltext, sort, setSort,
		selected, setSelected, activeKey, setActiveKey, anchor, setAnchor, focusIndex, setFocusIndex,
		tabs, activeTab, setActiveTab, openAttachment, closeTab, openItem, openSummary,
		collections, refetchCollections, collectionsRev, bumpCollections, tagsRev, bumpTags, itemsRev, bumpItems,
		query, selectOnly,
	};
}

export const store = createRoot(createStore);
