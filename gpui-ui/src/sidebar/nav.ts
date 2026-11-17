// Arrow-key navigation of the sidebar's rows (Zotero's collection tree keys): Up / Down move to the previous / next row and show
// it, Home / End the first / last row; Left collapses an expanded row or moves to its parent, Right expands a closed row or moves
// to its first child; F2 renames and Delete deletes the row's collection or saved search. Pure: the rows say what they are through `nav`; Sidebar.tsx does the moving. Unit-tested in nav.test.ts.

export interface Nav {
	/** Is this row's view the one the item list shows? */
	selected(): boolean;
	/** Show this row's view (what a click on the row does). */
	activate(): void;
	/** Rows with children: are they shown? Absent on a row without children. */
	expanded?(): boolean;
	/** Show / hide the children. */
	toggle?(): void;
	/** Entry id of the row this one is nested under. */
	parent?: string;
	/** F2 (Zotero: "Edit Collection Names"): start renaming. Absent where a row cannot be renamed here. */
	rename?(): void;
	/** Delete: delete the collection / saved search (asks first). */
	remove?(): void;
}

export interface NavEntry {
	id: string;
	nav?: Nav;
}

export type NavStep = { go: number } | { toggle: number } | { rename: number } | { remove: number } | null;

/** The row the keys move from: the row last moved to while it is still selected (a pinned collection is listed twice), else the first selected row; -1 for none. */
export function currentIndex(list: readonly NavEntry[], lastId: string | null): number {
	if (lastId) {
		const i = list.findIndex((e) => e.id === lastId);
		if (i >= 0 && list[i]!.nav?.selected()) return i;
	}
	return list.findIndex((e) => !!e.nav?.selected());
}

/** Normalise a key name: "ArrowDown" -> "down". */
export const navKeyName = (key: string): string => {
	const k = key.toLowerCase();
	return k.startsWith("arrow") ? k.slice(5) : k;
};

/** What `key` does from row `from` (-1: no row selected). null: the key is not a navigation key. */
export function navStep(list: readonly NavEntry[], from: number, key: string): NavStep {
	const rows: number[] = [];
	list.forEach((e, i) => {
		if (e.nav) rows.push(i);
	});
	if (!rows.length) return null;
	const k = navKeyName(key);
	const pos = rows.indexOf(from);
	const at = (p: number): NavStep => ({ go: rows[Math.max(0, Math.min(rows.length - 1, p))]! });
	switch (k) {
		case "down":
			return pos < 0 ? at(0) : at(pos + 1);
		case "up":
			return pos < 0 ? at(rows.length - 1) : at(pos - 1);
		case "home":
			return at(0);
		case "end":
			return at(rows.length - 1);
		case "left": {
			if (pos < 0) return null;
			const n = list[from]!.nav!;
			if (n.expanded?.()) return { toggle: from };
			if (n.parent) {
				const p = list.findIndex((e) => e.id === n.parent && !!e.nav);
				if (p >= 0) return { go: p };
			}
			return { go: from };
		}
		case "right": {
			if (pos < 0) return null;
			const n = list[from]!.nav!;
			if (n.expanded && !n.expanded()) return { toggle: from };
			const next = rows[pos + 1];
			if (n.expanded?.() && next !== undefined && list[next]!.nav!.parent === list[from]!.id) return { go: next };
			return { go: from };
		}
		case "f2":
			return pos >= 0 && list[from]!.nav!.rename ? { rename: from } : null;
		case "delete":
			return pos >= 0 && list[from]!.nav!.remove ? { remove: from } : null;
		default:
			return null;
	}
}
