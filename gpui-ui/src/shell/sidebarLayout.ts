// What the two sidebars show, and in which order: the left sidebar's groups (Library, Saved Searches, Collections, Group Libraries,
// Tags) and the item pane's sections (Details, Abstract, Notes, Files, Collections, Tags, Related). Settings > Appearance >
// Sidebars edits them (settings/defs/sidebars.tsx); Sidebar.tsx and itempane/index.tsx read them. Stored in ui-state.json.
import type { Accessor } from "solid-js";
import { persisted } from "./prefs";

export interface LayoutPart {
	id: string;
	label: string;
	icon: string;
	/** stays last: it can be hidden, not moved */
	pinnedLast?: boolean;
}
export interface Layout {
	/** every known id once, in display order */
	order: string[];
	/** ids not shown */
	hidden: string[];
}

export const LEFT_PARTS: LayoutPart[] = [
	{ id: "library", label: "Library", icon: "library" },
	{ id: "searches", label: "Saved Searches", icon: "search" },
	{ id: "collections", label: "Collections", icon: "folder" },
	{ id: "groups", label: "Group Libraries", icon: "users" },
	// its own pane at the foot of the sidebar, with the split handle above it
	{ id: "tags", label: "Tags", icon: "tag", pinnedLast: true },
];
export const RIGHT_PARTS: LayoutPart[] = [
	{ id: "info", label: "Details", icon: "info" },
	{ id: "abstract", label: "Abstract", icon: "align-left" },
	{ id: "notes", label: "Notes", icon: "sticky-note" },
	{ id: "attachments", label: "Files", icon: "paperclip" },
	{ id: "collections", label: "Collections", icon: "library" },
	{ id: "tags", label: "Tags", icon: "tag" },
	{ id: "related", label: "Related", icon: "link-2" },
];

const defaults = (parts: LayoutPart[]): Layout => ({ order: parts.map((p) => p.id), hidden: [] });

/** Any stored value -> a valid layout for `parts`: unknown ids dropped, duplicates removed, new ids added in their default place. */
export function normalize(value: unknown, parts: LayoutPart[]): Layout {
	const known = parts.map((p) => p.id);
	const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof Layout, unknown>>;
	const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && known.includes(s)) : []);
	const order = [...new Set(list(v.order))];
	known.forEach((id, i) => {
		if (order.includes(id)) return;
		// a section added in a later version goes after its default predecessor
		const prev = known
			.slice(0, i)
			.reverse()
			.find((p) => order.includes(p));
		order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
	});
	for (const p of parts)
		if (p.pinnedLast) {
			order.splice(order.indexOf(p.id), 1);
			order.push(p.id);
		}
	const hidden = [...new Set(list(v.hidden))];
	if (hidden.length >= known.length) hidden.pop(); // never everything
	return { order, hidden };
}

/** The layout with `id` moved one place up (-1) or down (+1); unchanged at the ends and for a pinned part. */
export function move(l: Layout, id: string, delta: -1 | 1, parts: LayoutPart[]): Layout {
	const pinned = new Set(parts.filter((p) => p.pinnedLast).map((p) => p.id));
	const i = l.order.indexOf(id);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= l.order.length || pinned.has(id) || pinned.has(l.order[j]!)) return l;
	const order = [...l.order];
	[order[i], order[j]] = [order[j]!, order[i]!];
	return { ...l, order };
}

/** The layout with `id` shown or hidden. The last shown part cannot be hidden. */
export function setShown(l: Layout, id: string, shown: boolean): Layout {
	const hidden = l.hidden.filter((h) => h !== id);
	if (!shown && hidden.length + 1 < l.order.length) hidden.push(id);
	return { ...l, hidden };
}

/** The ids to show, in order. */
export const visible = (l: Layout): string[] => l.order.filter((id) => !l.hidden.includes(id));

function side(key: string, parts: LayoutPart[]) {
	const [get, set] = persisted<Layout>(key, defaults(parts), (v) => normalize(v, parts));
	return {
		parts,
		layout: get as Accessor<Layout>,
		set: (l: Layout) => set(normalize(l, parts)),
		reset: () => set(defaults(parts)),
	};
}
export const leftLayout = side("shell.sidebarLayout", LEFT_PARTS);
export const rightLayout = side("shell.itempaneLayout", RIGHT_PARTS);
