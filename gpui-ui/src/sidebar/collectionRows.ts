// Pure row model of the Collections group: collections + sort / group prefs + per-collection styles -> the flat list of rows the
// sidebar's virtual list draws (group headers and collection rows, in order). No Solid, no I/O: unit-tested in collectionRows.test.ts.
import type { Collection } from "../contracts";
import { PALETTE, paletteHex, type CollectionStyle, type GroupKey, type SortKey, type Stamp } from "./collectionStyle";

export interface RowInput {
	/** The collection tree (roots with children). */
	collections: Collection[];
	sort: SortKey;
	group: GroupKey;
	styles: Record<string, CollectionStyle>;
	stamps: Record<string, Stamp>;
	/** User-made sections in order (used by group "section"). */
	sections: string[];
	/** Pinned keys in pin order. */
	pins: string[];
	/** Collections whose children are shown. */
	expanded: ReadonlySet<string>;
	/** Collapsed header ids (see Header.id). */
	collapsed: ReadonlySet<string>;
}

export interface HeaderRow {
	kind: "header";
	/** `pinned`, `all`, `sec:<name>`, `sec-default`, `col:<colour id>`, `col-none`. */
	id: string;
	label: string;
	/** Palette id for the dot of a colour group. */
	color?: string;
	/** Top-level collections in the group (pinned: pinned collections). */
	count: number;
	collapsed: boolean;
	/** Section name, for sections the user can rename / delete. */
	section?: string;
}
export interface CollectionRow {
	kind: "collection";
	/** Unique row id: `c:<key>`, or `p:<key>` for the copy in the Pinned section. */
	id: string;
	c: Collection;
	depth: number;
	/** This row is the copy in the Pinned section (no children shown under it). */
	pinnedCopy?: boolean;
}
export type Row = HeaderRow | CollectionRow;

const byName = (a: Collection, b: Collection) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** One level of siblings, sorted (a new array). Ties fall back to the name. */
export function sortLevel(list: readonly Collection[], sort: SortKey, stamps: Record<string, Stamp>): Collection[] {
	const created = (c: Collection) => c.dateAdded ? Date.parse(c.dateAdded) || 0 : stamps[c.key]?.c ?? 0;
	const modified = (c: Collection) => c.dateModified ? Date.parse(c.dateModified) || 0 : stamps[c.key]?.m ?? 0;
	const out = [...list];
	switch (sort) {
		case "name-asc": return out.sort(byName);
		case "name-desc": return out.sort((a, b) => byName(b, a));
		case "created": return out.sort((a, b) => created(b) - created(a) || byName(a, b));
		case "modified": return out.sort((a, b) => modified(b) - modified(a) || byName(a, b));
		case "items": return out.sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0) || byName(a, b));
	}
}

function flatten(list: readonly Collection[], out = new Map<string, Collection>()): Map<string, Collection> {
	for (const c of list) {
		out.set(c.key, c);
		if (c.children) flatten(c.children, out);
	}
	return out;
}

export function buildRows(i: RowInput): Row[] {
	const out: Row[] = [];
	const walk = (list: readonly Collection[], depth: number) => {
		for (const c of sortLevel(list, i.sort, i.stamps)) {
			out.push({ kind: "collection", id: `c:${c.key}`, c, depth });
			if (i.expanded.has(c.key) && c.children?.length) walk(c.children, depth + 1);
		}
	};

	// Pinned: any level, in pin order, as plain rows (their children are not repeated under the copy).
	const all = flatten(i.collections);
	// a repeated key would draw the same pinned row (and row id) twice
	const pinned = [...new Set(i.pins)].map((k) => all.get(k)).filter((c): c is Collection => !!c);
	if (pinned.length) {
		const collapsed = i.collapsed.has("pinned");
		out.push({ kind: "header", id: "pinned", label: "Pinned", count: pinned.length, collapsed });
		if (!collapsed) for (const c of pinned) out.push({ kind: "collection", id: `p:${c.key}`, c, depth: 0, pinnedCopy: true });
	}

	const roots = i.collections;
	if (i.group === "none") {
		if (pinned.length) {
			const collapsed = i.collapsed.has("all");
			out.push({ kind: "header", id: "all", label: "All collections", count: roots.length, collapsed });
			if (!collapsed) walk(roots, 0);
		} else walk(roots, 0);
		return out;
	}

	const group = (id: string, label: string, members: Collection[], extra: Partial<HeaderRow> = {}, keepEmpty = false) => {
		if (!members.length && !keepEmpty) return;
		const collapsed = i.collapsed.has(id);
		out.push({ kind: "header", id, label, count: members.length, collapsed, ...extra });
		if (!collapsed) walk(members, 0);
	};

	if (i.group === "colour") {
		const colourOf = (c: Collection) => (paletteHex(i.styles[c.key]?.color) ? i.styles[c.key]!.color! : "");
		for (const p of PALETTE) group(`col:${p.id}`, p.name, roots.filter((c) => colourOf(c) === p.id), { color: p.id });
		group("col-none", "No colour", roots.filter((c) => !colourOf(c)));
	} else {
		// "" is the default group, not a section (it would list every unsectioned collection twice); repeated names would repeat the group
		const sections = [...new Set(i.sections.filter((s) => s !== ""))];
		const sectionOf = (c: Collection) => (sections.includes(i.styles[c.key]?.section ?? "") ? i.styles[c.key]!.section! : "");
		// a user-made section shows even when empty (otherwise a new one could not be seen); the default group only when used
		for (const s of sections) group(`sec:${s}`, s, roots.filter((c) => sectionOf(c) === s), { section: s }, true);
		group("sec-default", "Collections", roots.filter((c) => !sectionOf(c)));
	}
	return out;
}
