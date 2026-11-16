// Fuzz: the sidebar's pure row model (collectionRows.ts). Any collection tree plus any (parsed) style/prefs file must give one
// consistent flat list: every collection once in its normal place, pinned copies on top, unique row ids, headers that agree with
// their members, and nothing thrown.
import { describe, expect, test } from "bun:test";
import type { Collection } from "../contracts";
import { buildRows, sortLevel, type Row, type RowInput } from "./collectionRows";
import { GROUP_KEYS, PALETTE, parseStyleData, SORT_KEYS, type GroupKey, type SortKey } from "./collectionStyle";
import { fc, fuzz } from "../fuzzHarness";

// keys include names that collide with Object.prototype members: lookups in `styles` / `stamps` must use own properties
const KEY_POOL = [
	"A",
	"B",
	"C",
	"D",
	"E",
	"F",
	"G",
	"H",
	"I",
	"J",
	"K",
	"L",
	"constructor",
	"toString",
	"__proto__",
	"hasOwnProperty",
	"",
	"a b",
	"x:y",
];
const NAMES = ["Alpha", "alpha", "Beta", "delta", "Gamma 10", "Gamma 2", "ÉCOLE", "école", "", "  ", "日本", "10", "9", "Zed"];

interface Spec {
	name: string;
	itemCount: number;
	dateAdded?: string;
	dateModified?: string;
	kids: Spec[];
}
const node = (kids: fc.Arbitrary<Spec[]>): fc.Arbitrary<Spec> =>
	fc.record({
		name: fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 6 })),
		itemCount: fc.integer({ min: 0, max: 50 }), // JSON from the core cannot carry NaN
		dateAdded: fc.option(
			fc.oneof(
				fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
				fc.constant("garbage"),
			),
			{ nil: undefined },
		),
		dateModified: fc.option(
			fc.oneof(
				fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
				fc.constant(""),
			),
			{ nil: undefined },
		),
		kids,
	});
// three levels deep, at most 3 children each
const spec: fc.Arbitrary<Spec> = node(fc.array(node(fc.array(node(fc.constant([])), { maxLength: 2 })), { maxLength: 3 }));

/** A forest with unique keys (the core's collections have unique keys), drawn from the pool plus numbered extras. */
const forest: fc.Arbitrary<{ roots: Collection[]; all: Collection[] }> = fc
	.tuple(fc.array(spec, { maxLength: 5 }), fc.shuffledSubarray(KEY_POOL, { minLength: KEY_POOL.length, maxLength: KEY_POOL.length }))
	.map(([specs, keys]) => {
		let n = 0;
		const all: Collection[] = [];
		const make = (s: Spec, parent: string | null): Collection => {
			const key = keys[n] ?? `K${n}`;
			n++;
			const c: Collection = {
				key,
				name: s.name,
				parentKey: parent,
				itemCount: s.itemCount,
				dateAdded: s.dateAdded,
				dateModified: s.dateModified,
			};
			all.push(c);
			if (s.kids.length) c.children = s.kids.map((k) => make(k, key));
			return c;
		};
		return { roots: specs.map((s) => make(s, null)), all };
	});

const styleFile = fc.record(
	{
		prefs: fc.record(
			{ sort: fc.constantFrom(...SORT_KEYS, "bogus"), group: fc.constantFrom(...GROUP_KEYS, "bogus") },
			{ requiredKeys: [] },
		),
		sections: fc.array(
			fc.oneof(fc.constantFrom("Reading", "Thesis", "", "__proto__", "constructor", "a"), fc.string({ maxLength: 4 })),
			{ maxLength: 4 },
		),
		collapsed: fc.array(fc.constantFrom("pinned", "all", "sec-default", "col-none", "sec:Reading", "col:blue", "nope"), {
			maxLength: 3,
		}),
		pins: fc.array(fc.constantFrom(...KEY_POOL, "missing"), { maxLength: 6 }),
		styles: fc.dictionary(
			fc.constantFrom(...KEY_POOL),
			fc.record(
				{
					color: fc.constantFrom(...PALETTE.map((p) => p.id), "nope", ""),
					icon: fc.constantFrom("book", ""),
					section: fc.constantFrom("Reading", "Thesis", "", "__proto__", "a"),
				},
				{ requiredKeys: [] },
			),
			{ maxKeys: 8 },
		),
		stamps: fc.dictionary(
			fc.constantFrom(...KEY_POOL),
			fc.record({ c: fc.integer({ min: 0, max: 1e12 }), m: fc.integer({ min: 0, max: 1e12 }), sig: fc.string({ maxLength: 3 }) }),
			{ maxKeys: 6 },
		),
	},
	{ requiredKeys: [] },
);

const toInput = (f: { roots: Collection[]; all: Collection[] }, file: unknown, over: Partial<RowInput> = {}): RowInput => {
	// through JSON like the real file, so "__proto__" keys become own properties
	const d = parseStyleData(JSON.parse(JSON.stringify(file)));
	return {
		collections: f.roots,
		sort: d.sort,
		group: d.group,
		styles: d.styles,
		stamps: d.stamps,
		sections: d.sections,
		pins: d.pins,
		expanded: new Set(f.all.map((c) => c.key)),
		collapsed: new Set(),
		...over,
	};
};

const ids = (rows: Row[]) => rows.map((r) => r.id);

function checkConsistent(i: RowInput, rows: Row[], all: Collection[]): void {
	// unique ids (the virtual list keys rows by id)
	expect(new Set(ids(rows)).size).toBe(rows.length);
	// pinned copies: exactly the pins that exist, in pin order, none of them with children shown under it
	const known = new Set(all.map((c) => c.key));
	const pinnedRows = rows.filter((r): r is Extract<Row, { kind: "collection" }> => r.kind === "collection" && !!r.pinnedCopy);
	const wantPins = i.pins.filter((k) => known.has(k));
	if (!i.collapsed.has("pinned")) expect(pinnedRows.map((r) => r.c.key)).toEqual(wantPins);
	else expect(pinnedRows.length).toBe(0);
	// each header's count is the number of members listed under it, and a collapsed header lists none
	let h = -1;
	const headers = rows.map((r, k) => (r.kind === "header" ? k : -1)).filter((k) => k >= 0);
	for (const [n, at] of headers.entries()) {
		h = at;
		const hr = rows[h] as Extract<Row, { kind: "header" }>;
		const end = headers[n + 1] ?? rows.length;
		const members = rows
			.slice(h + 1, end)
			.filter((r): r is Extract<Row, { kind: "collection" }> => r.kind === "collection" && r.depth === 0);
		expect(hr.collapsed).toBe(i.collapsed.has(hr.id));
		if (hr.collapsed) expect(end - h - 1).toBe(0);
		else if (hr.id === "pinned") expect(members.length).toBe(hr.count);
		else expect(members.length).toBe(hr.count);
	}
	// depth structure: a row is at most one deeper than the row before it
	let prev = -1;
	for (const r of rows) {
		if (r.kind === "header") {
			prev = -1;
			continue;
		}
		expect(r.depth).toBeGreaterThanOrEqual(0);
		if (!r.pinnedCopy) expect(r.depth).toBeLessThanOrEqual(prev + 1);
		prev = r.depth;
	}
}

describe("buildRows", () => {
	test("regression: an empty section name and repeated sections / pins do not list a collection twice", () => {
		const roots: Collection[] = [
			{ key: "A", name: "Alpha", parentKey: null, itemCount: 1 },
			{ key: "B", name: "Beta", parentKey: null, itemCount: 2 },
		];
		const i: RowInput = {
			collections: roots,
			sort: "name-asc",
			group: "section",
			styles: { A: { section: "S" } },
			stamps: {},
			sections: ["", "S", "S"],
			pins: ["A", "A"],
			expanded: new Set(),
			collapsed: new Set(),
		};
		const rows = buildRows(i);
		expect(new Set(ids(rows)).size).toBe(rows.length);
		expect(rows.filter((r) => r.kind === "collection" && !r.pinnedCopy).map((r) => r.id)).toEqual(["c:A", "c:B"]);
		expect(rows.filter((r) => r.kind === "collection" && r.pinnedCopy).map((r) => r.id)).toEqual(["p:A"]);
	});

	fuzz(
		"every collection appears exactly once, in its normal place, for any prefs",
		[forest, styleFile],
		(f, file) => {
			const i = toInput(f, file);
			const rows = buildRows(i);
			checkConsistent(i, rows, f.all);
			const normal = rows.filter((r): r is Extract<Row, { kind: "collection" }> => r.kind === "collection" && !r.pinnedCopy);
			expect(normal.map((r) => r.c.key).sort()).toEqual(f.all.map((c) => c.key).sort());
			// children follow their parent at depth + 1 (everything is expanded)
			for (const [k, r] of normal.entries()) {
				for (const child of r.c.children ?? []) {
					const at = normal.findIndex((x) => x.c.key === child.key);
					expect(at).toBeGreaterThan(k);
					expect(normal[at]!.depth).toBe(r.depth + 1);
				}
			}
		},
		{ normal: 300 },
	);

	fuzz(
		"with the default prefs the list is the sorted depth-first walk",
		[forest, fc.constantFrom(...SORT_KEYS)],
		(f, sort: SortKey) => {
			const i = toInput(f, {}, { sort, group: "none" as GroupKey });
			const rows = buildRows(i);
			const want: string[] = [];
			const walk = (list: readonly Collection[]) => {
				for (const c of sortLevel(list, sort, {})) {
					want.push(c.key);
					if (c.children?.length) walk(c.children);
				}
			};
			walk(f.roots);
			expect(rows.every((r) => r.kind === "collection")).toBe(true);
			expect(rows.map((r) => (r as Extract<Row, { kind: "collection" }>).c.key)).toEqual(want);
		},
		{ normal: 300 },
	);

	fuzz(
		"collapsing headers and folding nodes keeps the list consistent and a subset of the full one",
		[
			forest,
			styleFile,
			fc.subarray(KEY_POOL),
			fc.subarray(["pinned", "all", "sec-default", "col-none", "sec:Reading", "sec:Thesis", "col:blue", "col:rose"]),
		],
		(f, file, expanded, collapsed) => {
			const i = toInput(f, file, { expanded: new Set(expanded), collapsed: new Set(collapsed) });
			const rows = buildRows(i);
			checkConsistent(i, rows, f.all);
			const full = new Set(buildRows(toInput(f, file)).map((r) => r.id));
			for (const r of rows) if (r.kind === "collection" && !r.pinnedCopy) expect(full.has(r.id)).toBe(true);
		},
		{ normal: 300 },
	);

	fuzz(
		"sections and pins given with duplicates still give unique rows",
		[
			forest,
			fc.array(fc.constantFrom("a", "b", "a"), { maxLength: 4 }),
			fc.array(fc.constantFrom(...KEY_POOL), { maxLength: 5 }),
			fc.constantFrom(...GROUP_KEYS),
		],
		(f, sections, pins, group) => {
			// buildRows' contract is unique sections and pins (parseStyleData dedupes); a caller that forgets must still not draw a collection twice
			const i: RowInput = {
				collections: f.roots,
				sort: "name-asc",
				group,
				styles: {},
				stamps: {},
				sections,
				pins,
				expanded: new Set(),
				collapsed: new Set(),
			};
			const rows = buildRows(i);
			expect(new Set(ids(rows)).size).toBe(rows.length);
		},
		{ normal: 200 },
	);

	fuzz(
		"sortLevel is a permutation and idempotent",
		[forest, fc.constantFrom(...SORT_KEYS), styleFile],
		(f, sort, file) => {
			const stamps = toInput(f, file).stamps;
			const once = sortLevel(f.roots, sort, stamps);
			expect(once.map((c) => c.key).sort()).toEqual(f.roots.map((c) => c.key).sort());
			expect(sortLevel(once, sort, stamps).map((c) => c.key)).toEqual(once.map((c) => c.key));
		},
		{ normal: 300 },
	);

	fuzz("parseStyleData accepts any JSON", [fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<unknown>], (v) => {
		const d = parseStyleData(v);
		expect(SORT_KEYS).toContain(d.sort);
		expect(GROUP_KEYS).toContain(d.group);
		expect(new Set(d.pins).size).toBe(d.pins.length);
		expect(new Set(d.sections).size).toBe(d.sections.length);
	});
});
