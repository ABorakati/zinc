// GET /api/items/index (db.ts itemIndex): an item's position in a listing must be exactly where GET /api/items puts it, for every
// sort, filter and view the list uses; -1 when the listing does not contain the item. "Open in Zinc" scrolls to that row.
import { beforeEach, describe, expect, test } from "bun:test";
import { buildFixture, call, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
	fx = buildFixture();
});

const j = async (r: Response) => (await r.json()) as any;

const QUERIES = [
	"",
	"sort=title&dir=asc",
	"sort=title&dir=desc",
	"sort=creator&dir=asc&then=year:desc",
	"sort=year&dir=desc",
	"sort=dateAdded&dir=asc",
	"collection=COLLAAA1",
	"q=a",
	"unfiled=1",
	"trash=1",
];

describe("GET /api/items/index", () => {
	for (const q of QUERIES) {
		test(`matches the listing: ${q || "(default)"}`, async () => {
			const list = await j(await call(fx.db, "GET", `/api/items?${q}&limit=1000`));
			expect(list.items.length).toBe(list.total);
			for (const [i, it] of (list.items as { key: string }[]).entries()) {
				const r = await j(await call(fx.db, "GET", `/api/items/index?${q}&key=${it.key}`));
				expect(r.index).toBe(i);
			}
		});
	}

	test("an item the listing does not contain is -1", async () => {
		const all = (await j(await call(fx.db, "GET", "/api/items?limit=1000"))).items as { key: string }[];
		const inColl = new Set(
			((await j(await call(fx.db, "GET", "/api/items?collection=COLLAAA1&limit=1000"))).items as { key: string }[]).map((x) => x.key),
		);
		const outside = all.find((x) => !inColl.has(x.key));
		expect(outside).toBeDefined();
		expect((await j(await call(fx.db, "GET", `/api/items/index?collection=COLLAAA1&key=${outside!.key}`))).index).toBe(-1);
		expect((await j(await call(fx.db, "GET", "/api/items/index?key=ZZZZZZZZ"))).index).toBe(-1);
	});

	test("bad input is a 400, not a guess", async () => {
		expect((await call(fx.db, "GET", "/api/items/index")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/index?key=a'b")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/index?key=AAAAAAA1&sort=nope")).status).toBe(400);
		expect((await call(fx.db, "POST", "/api/items/index?key=AAAAAAA1")).status).toBe(405);
	});
});
