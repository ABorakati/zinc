// Pure row model of the "Group Libraries" block (Groups.tsx draws it): the heading, one row per group library, and under an
// expanded group its collection tree. No Solid, no I/O: unit-tested in groupRows.test.ts.
import type { Collection, Library } from "../contracts";

export type GroupRow =
	| { kind: "header"; id: "g:header"; open: boolean }
	| { kind: "library"; id: string; lib: Library; hasCollections: boolean; open: boolean }
	| { kind: "collection"; id: string; lib: Library; c: Collection; depth: number; hasChildren: boolean; open: boolean };

export interface GroupRowInput {
	/** Every library, My Library included (only the groups are drawn). */
	libraries: readonly Library[];
	/** Each group's collection tree (roots with children), by library id. */
	trees: Readonly<Record<number, readonly Collection[]>>;
	/** Section open? */
	open: boolean;
	/** Expanded rows: `lib:<id>` for a group, a collection key for a collection. */
	expanded: ReadonlySet<string>;
}

export const libraryRowKey = (id: number): string => `lib:${id}`;

export function buildGroupRows(i: GroupRowInput): GroupRow[] {
	const groups = i.libraries.filter((l) => l.type === "group");
	if (!groups.length) return [];
	const out: GroupRow[] = [{ kind: "header", id: "g:header", open: i.open }];
	if (!i.open) return out;
	for (const lib of groups) {
		const tree = i.trees[lib.id] ?? [];
		const open = i.expanded.has(libraryRowKey(lib.id));
		out.push({ kind: "library", id: `g:${lib.id}`, lib, hasCollections: tree.length > 0, open });
		if (!open) continue;
		const walk = (list: readonly Collection[], depth: number) => {
			for (const c of list) {
				const hasChildren = !!c.children?.length;
				const isOpen = i.expanded.has(c.key);
				out.push({ kind: "collection", id: `gc:${c.key}`, lib, c, depth, hasChildren, open: isOpen });
				if (isOpen && hasChildren) walk(c.children!, depth + 1);
			}
		};
		walk(tree, 1);
	}
	return out;
}
