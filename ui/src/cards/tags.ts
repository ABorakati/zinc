// Tag colours (Zotero's coloured tags) and the "Starred" tag used for the card star.
import { createMemo, createRoot, createSignal } from "solid-js";
import { toast } from "solid-sonner";
import { api, type ItemSummary, type TagColor } from "../api";
import { store } from "../store";
import { errMsg } from "~/lib/actions";
import type { ItemListHandle } from "./shared";

export const STAR_TAG = "Starred";

const [colors, setColors] = createSignal<TagColor[]>([]);
let requested = false;
/** Fetch the coloured tags once; failures leave every tag uncoloured. */
export function loadTagColors() {
	if (requested) return;
	requested = true;
	api.tagColors().then((c) => setColors([...c].sort((a, b) => a.position - b.position))).catch((e) => { requested = false; console.warn("tag colours unavailable", e); });
}

const byName = createRoot(() => createMemo(() => new Map(colors().map((c) => [c.name, c]))));
export const tagColor = (name: string) => byName().get(name);
export const tagColors = colors;

/** Zotero's tag colour palette. */
export const TAG_PALETTE = [
	{ name: "Red", color: "#FF6666" }, { name: "Orange", color: "#FF8C19" }, { name: "Gray", color: "#999999" },
	{ name: "Green", color: "#5FB236" }, { name: "Teal", color: "#009980" }, { name: "Blue", color: "#2EA8E5" },
	{ name: "Navy", color: "#576DD9" }, { name: "Purple", color: "#A28AE5" }, { name: "Plum", color: "#A6507B" },
];

/** Give a tag a colour (appended after the existing coloured tags), change it, or remove it (color null). */
export async function setTagColor(name: string, color: string | null) {
	const current = colors();
	const next = color === null
		? current.filter((c) => c.name !== name)
		: current.some((c) => c.name === name)
			? current.map((c) => (c.name === name ? { ...c, color } : c))
			: [...current, { name, color, position: current.length }];
	try {
		const saved = await api.putTagColors(next.map((c, i) => ({ ...c, position: i })));
		setColors([...saved].sort((a, b) => a.position - b.position));
	} catch (e) {
		toast.error("Could not save tag colour", { description: errMsg(e) });
	}
}

export const isStarred = (it: ItemSummary) => !!it.tags?.some((t) => t.tag === STAR_TAG);

/** The tags to show as badges: coloured ones first (by position), then - if wanted - the rest alphabetically. The star tag never is a badge. */
export function badgeTags(it: ItemSummary, showAll: boolean): { name: string; color?: string }[] {
	const out: { name: string; color?: string; pos: number }[] = [];
	for (const t of it.tags ?? []) {
		if (t.tag === STAR_TAG) continue;
		const c = byName().get(t.tag);
		if (c) out.push({ name: t.tag, color: c.color, pos: c.position });
		else if (showAll) out.push({ name: t.tag, pos: 1e9 });
	}
	return out.sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name));
}

/** Add/remove the Starred tag with an optimistic update of the cached row. */
export async function toggleStar(list: ItemListHandle, it: ItemSummary) {
	const was = isStarred(it);
	const before = it.tags ?? [];
	list.patch(it.key, { tags: was ? before.filter((t) => t.tag !== STAR_TAG) : [...before, { tag: STAR_TAG, type: 0 }] });
	try {
		await (was ? api.removeTags(it.key, [STAR_TAG]) : api.addTags(it.key, [STAR_TAG]));
		store.bumpTags();
	} catch (e) {
		list.patch(it.key, { tags: before });
		toast.error(was ? "Could not remove the star" : "Could not star the item", { description: errMsg(e) });
	}
}
