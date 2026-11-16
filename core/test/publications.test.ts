import { beforeEach, describe, expect, test } from "bun:test";
import { buildFixture, call, insertItem, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
	fx = buildFixture();
	insertItem(fx.db, {
		key: "PPPPPPP1",
		itemType: "journalArticle",
		title: "Pub Beta",
		creators: [{ creatorType: "author", lastName: "Zed" }],
		date: "2020",
		inPublications: true,
		dateAdded: "2024-06-01T00:00:00Z",
	});
	insertItem(fx.db, {
		key: "PPPPPPP2",
		itemType: "book",
		title: "Pub Alpha",
		creators: [{ creatorType: "author", lastName: "Abel" }],
		date: "2018",
		inPublications: true,
		dateAdded: "2024-06-02T00:00:00Z",
	});
	insertItem(
		fx.db,
		{ key: "PPPPPPP3", itemType: "journalArticle", title: "Pub Trashed", inPublications: true, dateAdded: "2024-06-03T00:00:00Z" },
		undefined,
		1,
	);
	insertItem(fx.db, {
		key: "PPPPPPP4",
		itemType: "journalArticle",
		title: "Not Published",
		inPublications: false,
		dateAdded: "2024-06-04T00:00:00Z",
	});
	// A flagged child note never counts: My Publications is top-level regular items only.
	insertItem(
		fx.db,
		{ key: "PPPPPPP5", itemType: "note", note: "<p>child</p>", parentItem: "PPPPPPP1", inPublications: true },
		"PPPPPPP1",
	);
	// And neither does a flagged standalone note.
	insertItem(fx.db, { key: "PPPPPPP6", itemType: "note", note: "<p>standalone</p>", inPublications: true });
});

const j = async (r: Response) => (await r.json()) as any;
const list = async (q: string) => await j(await call(fx.db, "GET", `/api/items?${q}`));
const groups = async (q: string) => await j(await call(fx.db, "GET", `/api/items/groups?${q}`));
const keys = (r: any) => r.items.map((i: any) => i.key);

describe("publications filter", () => {
	test("lists only flagged, non-trashed, regular top-level items with a total", async () => {
		const r = await list("publications=1&sort=title&dir=asc");
		expect(keys(r)).toEqual(["PPPPPPP2", "PPPPPPP1"]);
		expect(r.total).toBe(2);
	});

	test("without the option nothing changes", async () => {
		const all = await list("limit=1000");
		expect(keys(all)).toContain("PPPPPPP4");
		expect(keys(all)).toContain("BBBBBBB2");
	});

	test("sorting, paging and search within the view", async () => {
		expect(keys(await list("publications=1&sort=year&dir=desc"))).toEqual(["PPPPPPP1", "PPPPPPP2"]);
		expect(keys(await list("publications=1&sort=title&dir=asc&limit=1&offset=1"))).toEqual(["PPPPPPP1"]);
		const q = await list("publications=1&q=alpha");
		expect(keys(q)).toEqual(["PPPPPPP2"]);
		expect(q.total).toBe(1);
		expect((await list("publications=1&q=surgical")).total).toBe(0);
	});

	test("groups endpoint honours the filter", async () => {
		const g = await groups("by=year&dir=desc&publications=1");
		expect(g.groups).toEqual([
			{ value: "2020", count: 1 },
			{ value: "2018", count: 1 },
		]);
		const t = await groups("by=itemType&publications=1");
		expect(t.groups.reduce((n: number, x: any) => n + x.count, 0)).toBe(2);
	});

	test("combines with a collection filter", async () => {
		fx.db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'PPPPPPP1')").run();
		expect(keys(await list("publications=1&collection=COLLAAA1"))).toEqual(["PPPPPPP1"]);
	});
});

describe("inPublications via PATCH", () => {
	test("setting and clearing the flag moves the item in and out of the view", async () => {
		const patch = async (data: object) => await call(fx.db, "PATCH", "/api/items/BBBBBBB2", { data });
		expect((await patch({ inPublications: true })).status).toBe(200);
		expect(keys(await list("publications=1"))).toContain("BBBBBBB2");
		const detail = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(detail.data.inPublications).toBe(true);
		expect((await patch({ inPublications: false })).status).toBe(200);
		expect(keys(await list("publications=1"))).not.toContain("BBBBBBB2");
		const after = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect("inPublications" in after.data).toBe(false);
	});
});
