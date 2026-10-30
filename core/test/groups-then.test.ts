import { beforeEach, describe, expect, test } from "bun:test";
import { buildFixture, call, insertItem, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
	fx = buildFixture();
	// Extra top-level items with ties, case differences and NULL years / publications.
	insertItem(fx.db, { key: "EEEEEEE5", itemType: "journalArticle", title: "Beta", creators: [{ creatorType: "author", lastName: "Zed" }], date: "2020", publicationTitle: "alpha journal", tags: [{ tag: "grp" }], dateAdded: "2024-05-01T00:00:00Z" });
	insertItem(fx.db, { key: "FFFFFFF6", itemType: "journalArticle", title: "alpha", creators: [{ creatorType: "author", lastName: "Zed" }], date: "2020", publicationTitle: "Alpha Journal", tags: [{ tag: "grp" }], dateAdded: "2024-05-02T00:00:00Z" });
	insertItem(fx.db, { key: "GGGGGGG7", itemType: "book", title: "Gamma", creators: [{ creatorType: "author", lastName: "Abel" }], dateAdded: "2024-05-03T00:00:00Z" });
	insertItem(fx.db, { key: "HHHHHHH8", itemType: "book", title: "Delta", creators: [{ creatorType: "author", lastName: "Abel" }], date: "1999", dateAdded: "2024-05-04T00:00:00Z" });
	fx.db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'EEEEEEE5')").run();
	fx.db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'GGGGGGG7')").run();
});

const j = async (r: Response) => (await r.json()) as any;
const list = async (q: string) => await j(await call(fx.db, "GET", `/api/items?${q}`));
const groups = async (q: string) => await j(await call(fx.db, "GET", `/api/items/groups?${q}`));

describe("multi-level sort (then)", () => {
	test("orders by primary then secondary keys", async () => {
		const r = await list("sort=creator&dir=asc&then=title:desc&limit=1000");
		const rows = r.items.map((i: any) => [i.creatorsSummary ?? i.creators_summary, i.title]);
		// Abel: Gamma, Delta (title desc) come before the later creators.
		const abel = r.items.filter((i: any) => i.key === "GGGGGGG7" || i.key === "HHHHHHH8").map((i: any) => i.title);
		expect(abel).toEqual(["Gamma", "Delta"]);
		const zed = r.items.filter((i: any) => i.key === "EEEEEEE5" || i.key === "FFFFFFF6").map((i: any) => i.title);
		expect(zed).toEqual(["Beta", "alpha"]);
		expect(rows.length).toBe(r.total);
	});
	test("dir defaults to asc and differs from desc", async () => {
		const asc = (await list("sort=creator&dir=asc&then=title&limit=1000")).items.map((i: any) => i.key);
		const asc2 = (await list("sort=creator&dir=asc&then=title:asc&limit=1000")).items.map((i: any) => i.key);
		const desc = (await list("sort=creator&dir=asc&then=title:desc&limit=1000")).items.map((i: any) => i.key);
		expect(asc).toEqual(asc2);
		expect(asc).not.toEqual(desc);
		const pos = (ks: string[], k: string) => ks.indexOf(k);
		expect(pos(asc, "FFFFFFF6")).toBeLessThan(pos(asc, "EEEEEEE5")); // alpha < Beta
		expect(pos(desc, "EEEEEEE5")).toBeLessThan(pos(desc, "FFFFFFF6"));
	});
	test("works with filters and without then is unchanged", async () => {
		const a = await list("sort=year&dir=asc&then=title:asc&tag=grp");
		expect(a.items.map((i: any) => i.key)).toEqual(["FFFFFFF6", "EEEEEEE5"]);
		const plain = (await list("sort=title&dir=asc&limit=1000")).items.map((i: any) => i.key);
		const withThen = (await list("sort=title&dir=asc&then=year:asc&limit=1000")).items.map((i: any) => i.key);
		expect(withThen.length).toBe(plain.length);
	});
	test("invalid then is 400", async () => {
		for (const t of ["nope", "title:sideways", "title:asc:x", "title;drop", "title,year,creator,dateAdded"]) {
			expect((await call(fx.db, "GET", `/api/items?then=${encodeURIComponent(t)}`)).status).toBe(400);
		}
		// 3 extra levels is the max
		expect((await call(fx.db, "GET", "/api/items?then=title,year,creator")).status).toBe(200);
	});
});

describe("GET /api/items/groups", () => {
	const ORDERS: Array<[string, string]> = [
		["year", "year"],
		["itemType", "itemType"],
		["publication", "publication"],
	];

	async function check(by: string, dir: string, filter = "") {
		const g = await groups(`by=${by}&dir=${dir}${filter}`);
		const l = await list(`sort=${by}&dir=${dir}&limit=1000&fields=${by === "year" ? "date" : by === "itemType" ? "itemType" : "publicationTitle"}${filter}`);
		const sum = g.groups.reduce((n: number, x: any) => n + x.count, 0);
		expect(sum).toBe(l.total);
		// Cumulative offsets: the first item of each group in the list must belong to that group.
		let off = 0;
		for (const grp of g.groups) {
			const it = l.items[off];
			const f = it.fields ?? {};
			if (by === "year") {
				const y = f.date ? String(new Date(f.date).getUTCFullYear()) : null;
				if (grp.value !== null) expect(y).toBe(grp.value);
				else expect(f.date ?? null).toBeNull();
			} else if (by === "itemType") expect(f.itemType.toLowerCase()).toBe(grp.value!.toLowerCase());
			else if (grp.value === null) expect(f.publicationTitle ?? null).toBeNull();
			else expect(String(f.publicationTitle).toLowerCase()).toBe(grp.value.toLowerCase());
			off += grp.count;
		}
		return g.groups;
	}

	test("year desc/asc: sums equal total, order matches list, null years placed like the list", async () => {
		const desc = await check("year", "desc");
		expect(desc[desc.length - 1].value).toBeNull(); // NULL last in DESC
		expect(desc.slice(0, -1).map((x: any) => x.value)).toEqual(["2022", "2020", "2018", "1999"]);
		expect(desc.find((x: any) => x.value === "2020").count).toBe(3);
		const asc = await check("year", "asc");
		expect(asc[0].value).toBeNull(); // NULL first in ASC
		expect(asc.map((x: any) => x.value)).toEqual([null, "1999", "2018", "2020", "2022"].slice(0, asc.length));
	});

	test("itemType and publication (nulls last, case-insensitive merge)", async () => {
		for (const [by] of ORDERS.slice(1)) {
			await check(by, "asc");
			await check(by, "desc");
		}
		const p = await groups("by=publication&dir=asc");
		expect(p.groups[p.groups.length - 1].value).toBeNull();
		const pd = await groups("by=publication&dir=desc");
		expect(pd.groups[pd.groups.length - 1].value).toBeNull();
		const alpha = p.groups.filter((x: any) => (x.value ?? "").toLowerCase() === "alpha journal");
		expect(alpha.length).toBe(1);
		expect(alpha[0].count).toBe(2);
	});

	test("with tag and collection filters", async () => {
		const t = await check("year", "desc", "&tag=imaging");
		expect(t.reduce((n: number, x: any) => n + x.count, 0)).toBe(2);
		const c = await check("year", "asc", "&collection=COLLAAA1");
		expect(c.reduce((n: number, x: any) => n + x.count, 0)).toBe(3);
		const both = await check("itemType", "asc", "&tag=grp&collection=COLLAAA1");
		expect(both).toEqual([{ value: "journalArticle", count: 1 }]);
		const trash = await groups("by=year&trash=1");
		expect(trash.groups.reduce((n: number, x: any) => n + x.count, 0)).toBe((await list("trash=1")).total);
		const q = await check("year", "desc", "&q=alpha");
		expect(q.length).toBeGreaterThan(0);
	});

	test("routing and validation", async () => {
		expect((await call(fx.db, "GET", "/api/items/groups?by=nope")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/groups")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/groups?by=year&dir=up")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/AAAAAAA1")).status).toBe(200);
	});
});
