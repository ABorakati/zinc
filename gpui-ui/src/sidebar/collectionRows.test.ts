// bun test src/sidebar/collectionRows.test.ts -- the pure row model: sort within levels, colour / section grouping, pinned section.
import { describe, expect, test } from "bun:test";
import type { Collection } from "../contracts";
import { buildRows, sortLevel, type Row, type RowInput } from "./collectionRows";

const c = (key: string, name: string, itemCount: number, children?: Collection[]): Collection => ({
	key, name, parentKey: null, itemCount, ...(children ? { children } : {}),
});
// Alpha(5) > [Zed(1), Bee(9)], Beta(20), Gamma(0) > [Inner(3)], delta(7)
const tree = (): Collection[] => [
	c("A", "Alpha", 5, [c("A1", "Zed", 1), c("A2", "Bee", 9)]),
	c("B", "Beta", 20),
	c("G", "Gamma", 0, [c("G1", "Inner", 3)]),
	c("D", "delta", 7),
];
const input = (o: Partial<RowInput> = {}): RowInput => ({
	collections: tree(), sort: "name-asc", group: "none", styles: {}, stamps: {}, sections: [], pins: [],
	expanded: new Set(["A", "G"]), collapsed: new Set(), ...o,
});
/** "Header" for headers, key for rows (depth as leading dots, p: for pinned copies). */
const show = (rows: Row[]) => rows.map((r) => (r.kind === "header" ? `[${r.label} ${r.count}${r.collapsed ? " collapsed" : ""}]` : `${".".repeat(r.depth)}${r.id.startsWith("p:") ? "p:" : ""}${r.c.key}`));

describe("sorting", () => {
	test("name A-Z is case-insensitive and keeps children under their parent", () => {
		expect(show(buildRows(input()))).toEqual(["A", ".A2", ".A1", "B", "D", "G", ".G1"]);
	});
	test("name Z-A reverses every level", () => {
		expect(show(buildRows(input({ sort: "name-desc" })))).toEqual(["G", ".G1", "D", "B", "A", ".A1", ".A2"]);
	});
	test("number of items sorts each level, most first, ties by name", () => {
		expect(show(buildRows(input({ sort: "items" })))).toEqual(["B", "D", "A", ".A2", ".A1", "G", ".G1"]);
		expect(sortLevel([c("x", "b", 2), c("y", "a", 2)], "items", {}).map((k) => k.key)).toEqual(["y", "x"]);
	});
	test("date created / modified: newest first, from stamps, ties by name", () => {
		const stamps = {
			A: { c: 10, m: 50, sig: "" }, B: { c: 30, m: 20, sig: "" }, G: { c: 30, m: 5, sig: "" }, D: { c: 0, m: 0, sig: "" },
		};
		expect(show(buildRows(input({ sort: "created", stamps, expanded: new Set() })))).toEqual(["B", "G", "A", "D"]);
		expect(show(buildRows(input({ sort: "modified", stamps, expanded: new Set() })))).toEqual(["A", "B", "G", "D"]);
	});
	test("a date from the core wins over the stamp", () => {
		const list = [{ ...c("x", "x", 0), dateAdded: "2024-01-02T00:00:00Z" }, { ...c("y", "y", 0), dateAdded: "2024-01-01T00:00:00Z" }];
		expect(sortLevel(list, "created", { y: { c: 9e12, m: 0, sig: "" } }).map((k) => k.key)).toEqual(["x", "y"]);
	});
	test("collapsed parents hide their children", () => {
		expect(show(buildRows(input({ expanded: new Set(["G"]) })))).toEqual(["A", "B", "D", "G", ".G1"]);
	});
});

describe("group by colour", () => {
	const styles = { A: { color: "rose" }, B: { color: "blue" }, D: { color: "rose" }, G1: { color: "green" } };
	test("a section per used colour in palette order, No colour last; children follow their parent", () => {
		const rows = buildRows(input({ group: "colour", styles }));
		expect(show(rows)).toEqual(["[Blue 1]", "B", "[Rose 2]", "A", ".A2", ".A1", "D", "[No colour 1]", "G", ".G1"]);
		expect(rows.find((r) => r.kind === "header" && r.label === "Rose")).toMatchObject({ color: "rose", id: "col:rose" });
	});
	test("sort applies inside each group; unknown colour ids count as no colour", () => {
		const rows = buildRows(input({ group: "colour", sort: "items", styles: { ...styles, B: { color: "nope" } }, expanded: new Set() }));
		expect(show(rows)).toEqual(["[Rose 2]", "D", "A", "[No colour 2]", "B", "G"]);
	});
	test("collapsing a group hides its rows but keeps the header", () => {
		const rows = buildRows(input({ group: "colour", styles, collapsed: new Set(["col:rose"]), expanded: new Set() }));
		expect(show(rows)).toEqual(["[Blue 1]", "B", "[Rose 2 collapsed]", "[No colour 1]", "G"]);
	});
});

describe("group by section", () => {
	const styles = { A: { section: "Thesis" }, D: { section: "Reading" }, B: { section: "Gone" } };
	test("sections in creation order, then Collections; a section the list lost counts as unsectioned", () => {
		const rows = buildRows(input({ group: "section", styles, sections: ["Reading", "Thesis"], expanded: new Set() }));
		expect(show(rows)).toEqual(["[Reading 1]", "D", "[Thesis 1]", "A", "[Collections 2]", "B", "G"]);
		expect(rows.find((r) => r.kind === "header" && r.label === "Thesis")).toMatchObject({ section: "Thesis", id: "sec:Thesis" });
	});
	test("an empty user section still shows; an empty Collections group does not", () => {
		const rows = buildRows(input({ group: "section", sections: ["Empty"], styles: { A: { section: "Empty" } } }));
		expect(show(buildRows(input({ group: "section", sections: ["Empty"] }))).slice(0, 2)).toEqual(["[Empty 0]", "[Collections 4]"]);
		expect(show(rows)[0]).toBe("[Empty 1]");
		const all = { A: { section: "S" }, B: { section: "S" }, G: { section: "S" }, D: { section: "S" } };
		expect(show(buildRows(input({ group: "section", sections: ["S"], styles: all, expanded: new Set() })))).toEqual(["[S 4]", "A", "B", "D", "G"]);
	});
});

describe("pinned", () => {
	test("a Pinned section above everything, in pin order, any level; the originals stay in place", () => {
		const rows = buildRows(input({ pins: ["D", "A1"], expanded: new Set(["A"]) }));
		expect(show(rows)).toEqual(["[Pinned 2]", "p:D", "p:A1", "[All collections 4]", "A", ".A2", ".A1", "B", "D", "G"]);
		expect(rows[1]).toMatchObject({ kind: "collection", pinnedCopy: true, depth: 0, id: "p:D" });
	});
	test("pinned rows come before grouped sections", () => {
		const rows = buildRows(input({ pins: ["B"], group: "colour", styles: { B: { color: "blue" } }, expanded: new Set() }));
		expect(show(rows)).toEqual(["[Pinned 1]", "p:B", "[Blue 1]", "B", "[No colour 3]", "A", "D", "G"]);
	});
	test("collapsed Pinned hides its rows; unknown / deleted pins are ignored; no pins, no section", () => {
		expect(show(buildRows(input({ pins: ["B"], collapsed: new Set(["pinned"]), expanded: new Set() })))).toEqual(["[Pinned 1 collapsed]", "[All collections 4]", "A", "B", "D", "G"]);
		expect(show(buildRows(input({ pins: ["nope"], expanded: new Set() })))).toEqual(["A", "B", "D", "G"]);
	});
});
