// What each card row shows and how dense it is (ui/src/cards/layout.ts); persisted in ui-state.json ("cards").
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { uiState } from "../store";
import { getMetaField, isKnownMeta } from "./fields";

export type CreatorsMode = "full" | "short" | "summary" | "off";
export type Density = "comfortable" | "compact";

export interface CardLayout {
	star: boolean;
	tags: boolean;
	allTags: boolean; // also show tags that have no colour
	creators: CreatorsMode;
	meta: string[]; // ordered line-3 fields
	icons: boolean;
	density: Density;
}

export const DEFAULT_LAYOUT: CardLayout = {
	star: true, tags: true, allTags: false, creators: "full", meta: ["publication", "year", "itemType"], icons: true, density: "comfortable",
};

function load(): CardLayout {
	const s = uiState.get<Partial<CardLayout> | null>("cards", null);
	if (s && typeof s === "object") {
		const d = DEFAULT_LAYOUT;
		return {
			star: typeof s.star === "boolean" ? s.star : d.star,
			tags: typeof s.tags === "boolean" ? s.tags : d.tags,
			allTags: typeof s.allTags === "boolean" ? s.allTags : d.allTags,
			creators: s.creators === "full" || s.creators === "short" || s.creators === "summary" || s.creators === "off" ? s.creators : d.creators,
			meta: Array.isArray(s.meta) ? [...new Set(s.meta.filter((x): x is string => typeof x === "string" && isKnownMeta(x)))] : [...d.meta],
			icons: typeof s.icons === "boolean" ? s.icons : d.icons,
			density: s.density === "compact" ? "compact" : "comfortable",
		};
	}
	return { ...DEFAULT_LAYOUT, meta: [...DEFAULT_LAYOUT.meta] };
}

export const cardLayout = createRoot(() => {
	const [layout, setLayout] = createSignal<CardLayout>(load());
	createEffect(() => uiState.set("cards", layout()));

	const set = <K extends keyof CardLayout>(k: K, v: CardLayout[K]) => setLayout((l) => ({ ...l, [k]: v }));
	const metaFields = createMemo(() => layout().meta.map(getMetaField));
	/** Zotero data fields the shown meta fields need (`fields=`). */
	const fieldsParam = createMemo(() => [...new Set([...metaFields().flatMap((m) => m.fields), "url", "DOI"])].sort().join(","));
	/** `include=` extras the card needs. */
	const includeParam = createMemo(() => {
		const l = layout();
		const inc: string[] = [];
		if (l.creators === "full" || l.creators === "short") inc.push("creators");
		if (l.star || l.tags) inc.push("tags");
		return inc.join(",");
	});

	return {
		layout, set, metaFields, fieldsParam, includeParam,
		addMeta: (id: string) => setLayout((l) => (l.meta.includes(id) ? l : { ...l, meta: [...l.meta, id] })),
		removeMeta: (id: string) => setLayout((l) => ({ ...l, meta: l.meta.filter((x) => x !== id) })),
		moveMeta: (id: string, delta: number) => setLayout((l) => {
			const i = l.meta.indexOf(id), j = i + delta;
			if (i < 0 || j < 0 || j >= l.meta.length) return l;
			const m = [...l.meta];
			[m[i], m[j]] = [m[j]!, m[i]!];
			return { ...l, meta: m };
		}),
		reset: () => setLayout({ ...DEFAULT_LAYOUT, meta: [...DEFAULT_LAYOUT.meta] }),
	};
});
