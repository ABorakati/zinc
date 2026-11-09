// Tag data for the Tags pane: the library's tags with counts, Zotero tag colours, and which tags are only automatic
// (ui/src/Tags.tsx + ui/src/cards/tags.ts). The big lists (tens of thousands of tags) load only once the pane is open.
import { createMemo, createRoot, createSignal } from "solid-js";
import { store } from "../store";
import { errMsg, sidebarApi, type TagColor } from "../sidebar/client";
import { toast } from "../ui";
import { setTagFilter, tagFilter } from "../sidebar/bridge";

/** Zotero's tag colour palette (ui/src/cards/tags.ts). */
export const TAG_PALETTE = [
	{ name: "Red", color: "#FF6666" }, { name: "Orange", color: "#FF8C19" }, { name: "Gray", color: "#999999" },
	{ name: "Green", color: "#5FB236" }, { name: "Teal", color: "#009980" }, { name: "Blue", color: "#2EA8E5" },
	{ name: "Navy", color: "#576DD9" }, { name: "Purple", color: "#A28AE5" }, { name: "Plum", color: "#A6507B" },
];

export interface TagCount { tag: string; count: number }

const [tags, setTags] = createSignal<TagCount[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [loading, setLoading] = createSignal(false);
const [colors, setColors] = createSignal<TagColor[]>([]);
const [automatic, setAutomatic] = createSignal<Map<string, number>>(new Map());

export { tags, loaded as tagsLoaded, loading as tagsLoading, colors as tagColors };

const byName = createRoot(() => createMemo(() => new Map(colors().map((c) => [c.name, c]))));
export const tagColor = (name: string): TagColor | undefined => byName().get(name);

let lastLoad = 0;
let tagSeq = 0;
/** (Re)load the tag list, the colours, and (when automatic tags are hidden) the automatic-only tags. */
export async function loadTags(opts: { wantAutomatic: boolean }): Promise<void> {
	const my = ++tagSeq;
	setLoading(true);
	try {
		const [list, cols, auto] = await Promise.all([
			sidebarApi.tags(store.libraryId()),
			sidebarApi.tagColors().catch(() => [] as TagColor[]),
			opts.wantAutomatic ? sidebarApi.automaticTags(store.libraryId()).catch(() => []) : Promise.resolve(null),
		]);
		if (my !== tagSeq) return;
		setTags(list);
		setColors([...cols].sort((a, b) => a.position - b.position));
		if (auto) setAutomatic(new Map(auto.map((a) => [a.tag, a.count])));
		setLoaded(true);
		lastLoad = Date.now();
	} catch (e) {
		if (my === tagSeq) toast("Could not load tags", { kind: "error", description: errMsg(e) });
	} finally {
		if (my === tagSeq) setLoading(false);
	}
}

/** Milliseconds since the tag list was last fetched. */
export const tagsAge = (): number => Date.now() - lastLoad;

/** A tag whose every use is automatic (hidden when "Show Automatic" is off). */
export const isAutomaticOnly = (t: TagCount): boolean => automatic().get(t.tag) === t.count;

/** Give a tag a colour (appended after the coloured ones), change it, or remove it (color null). */
export async function setTagColor(name: string, color: string | null): Promise<void> {
	const current = colors();
	const next =
		color === null
			? current.filter((c) => c.name !== name)
			: current.some((c) => c.name === name)
				? current.map((c) => (c.name === name ? { ...c, color } : c))
				: [...current, { name, color, position: current.length }];
	try {
		const saved = await sidebarApi.putTagColors(next.map((c, i) => ({ ...c, position: i })));
		setColors([...saved].sort((a, b) => a.position - b.position));
	} catch (e) {
		toast("Could not save tag colour", { kind: "error", description: errMsg(e) });
	}
}

/**
 * Select / deselect a tag in the filter. One tag at a time: the core's item query takes a single `tag`, so picking another tag
 * replaces the selection instead of showing several highlighted tags of which only the first filters.
 */
export function toggleTag(tag: string): void {
	const cur = tagFilter();
	setTagFilter(cur.includes(tag) ? [] : [tag]);
}
