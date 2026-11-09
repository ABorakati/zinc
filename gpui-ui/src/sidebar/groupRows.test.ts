// bun test src/sidebar/groupRows.test.ts -- the pure row model of the "Group Libraries" block.
import { describe, expect, test } from "bun:test";
import type { Collection, Library } from "../contracts";
import { buildGroupRows, libraryRowKey, type GroupRow, type GroupRowInput } from "./groupRows";

const lib = (id: number, name: string, editable = true, type: Library["type"] = "group"): Library => ({ id, type, name, editable, filesEditable: editable, ...(type === "group" ? { groupId: 1000 + id } : {}) });
const c = (key: string, name: string, children?: Collection[]): Collection => ({ key, name, parentKey: null, itemCount: 1, ...(children ? { children } : {}) });
const input = (o: Partial<GroupRowInput> = {}): GroupRowInput => ({
	libraries: [lib(1, "My Library", true, "user"), lib(2, "Lab"), lib(3, "Journal club", false)],
	trees: { 2: [c("A", "Papers", [c("A1", "2025"), c("A2", "2026", [c("A21", "Drafts")])]), c("B", "Data")], 3: [] },
	open: true,
	expanded: new Set<string>(),
	...o,
});
const show = (rows: GroupRow[]) => rows.map((r) => (r.kind === "header" ? "[Group Libraries]" : r.kind === "library" ? `${r.lib.name}${r.hasCollections ? "+" : ""}${r.open ? "*" : ""}` : `${".".repeat(r.depth)}${r.c.name}`));

describe("Group Libraries rows", () => {
	test("nothing when the account has no groups (My Library alone is not a group)", () => {
		expect(buildGroupRows(input({ libraries: [lib(1, "My Library", true, "user")] }))).toEqual([]);
		expect(buildGroupRows(input({ libraries: [] }))).toEqual([]);
	});
	test("a header and one row per group, in the order given; My Library is left out", () => {
		expect(show(buildGroupRows(input()))).toEqual(["[Group Libraries]", "Lab+", "Journal club"]);
	});
	test("a closed section is just its header", () => {
		expect(show(buildGroupRows(input({ open: false })))).toEqual(["[Group Libraries]"]);
	});
	test("an expanded group shows its collections, and expanded collections their children", () => {
		const e = (...k: string[]) => new Set(k);
		expect(show(buildGroupRows(input({ expanded: e(libraryRowKey(2)) })))).toEqual(["[Group Libraries]", "Lab+*", ".Papers", ".Data", "Journal club"]);
		expect(show(buildGroupRows(input({ expanded: e(libraryRowKey(2), "A") })))).toEqual(["[Group Libraries]", "Lab+*", ".Papers", "..2025", "..2026", ".Data", "Journal club"]);
		expect(show(buildGroupRows(input({ expanded: e(libraryRowKey(2), "A", "A2") })))).toEqual(["[Group Libraries]", "Lab+*", ".Papers", "..2025", "..2026", "...Drafts", ".Data", "Journal club"]);
		// a collection key expanded while its group is closed shows nothing
		expect(show(buildGroupRows(input({ expanded: e("A") })))).toEqual(["[Group Libraries]", "Lab+", "Journal club"]);
	});
	test("rows carry what the drawing needs: the library (for read-only), ids unique across groups", () => {
		const rows = buildGroupRows(input({ expanded: new Set([libraryRowKey(2)]) }));
		const ro = rows.find((r) => r.kind === "library" && r.lib.id === 3)!;
		expect(ro.kind === "library" && ro.lib.editable).toBe(false);
		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
		const first = rows.find((r) => r.kind === "collection")!;
		expect(first.kind === "collection" && first.lib.id).toBe(2);
		expect(first.kind === "collection" && first.hasChildren).toBe(true);
	});
	test("a group whose tree has not loaded yet has no expander and no rows", () => {
		expect(show(buildGroupRows(input({ trees: {}, expanded: new Set([libraryRowKey(2)]) })))).toEqual(["[Group Libraries]", "Lab*", "Journal club"]);
	});
});
