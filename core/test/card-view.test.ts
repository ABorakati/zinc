import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatCreatorInitials, listItems, openDb } from "../src/db";
import { buildFixture, call, insertItem, tempDir } from "./fixture";

const j = async (r: Response) => (await r.json()) as any;

describe("items include=creators,tags", () => {
	test("creators formatted as 'Family G', in order; tags with type", async () => {
		const fx = buildFixture();
		const r = await j(await call(fx.db, "GET", "/api/items?include=creators,tags&sort=title&dir=asc"));
		const a = r.items.find((i: any) => i.key === "AAAAAAA1");
		expect(a.creators).toEqual(["Smith A", "Jones B"]);
		expect(a.tags).toEqual([
			{ tag: "imaging", type: 0 },
			{ tag: "ml", type: 0 },
		]);
		const none = r.items.find((i: any) => i.key === "DDDDDDD4");
		expect(none.creators).toEqual(["Lee", "Kim", "Park"]); // no first names: family only
		expect(none.tags).toEqual([]);
	});

	test("single-field, hyphenated, multi-part and institutional names", async () => {
		const fx = buildFixture();
		insertItem(fx.db, {
			key: "EEEEEEE5",
			itemType: "journalArticle",
			title: "Names",
			creators: [
				{ creatorType: "author", firstName: "Eli", lastName: "Amsalem" },
				{ creatorType: "author", name: "World Health Organization" },
				{ creatorType: "author", firstName: "Jean-Pierre", lastName: "Sartre" },
				{ creatorType: "author", firstName: "mary ann", lastName: "van der Berg" },
				{ creatorType: "editor", firstName: "Ed", lastName: "Editor" },
			],
		});
		const r = await j(await call(fx.db, "GET", "/api/items?include=creators"));
		const e = r.items.find((i: any) => i.key === "EEEEEEE5");
		expect(e.creators).toEqual(["Amsalem E", "World Health Organization", "Sartre JP", "van der Berg MA", "Editor E"]);
		expect(e.tags).toBeUndefined();
	});

	test("absent without include; invalid include rejected", async () => {
		const fx = buildFixture();
		const r = await j(await call(fx.db, "GET", "/api/items"));
		expect(r.items[0].creators).toBeUndefined();
		expect(r.items[0].tags).toBeUndefined();
		expect((await call(fx.db, "GET", "/api/items?include=nope")).status).toBe(400);
	});

	test("formatCreatorInitials", () => {
		expect(formatCreatorInitials({ firstName: "Amy", lastName: "Kiefer" })).toBe("Kiefer A");
		expect(formatCreatorInitials({ lastName: "Solo" })).toBe("Solo");
		expect(formatCreatorInitials({ name: "  Acme Inc " })).toBe("Acme Inc");
		expect(formatCreatorInitials({ firstName: "Émile", lastName: "Zola" })).toBe("Zola É");
	});
});

describe("tag colours", () => {
	test("empty by default; PUT replaces, renumbers positions, GET returns them", async () => {
		const fx = buildFixture();
		expect(await j(await call(fx.db, "GET", "/api/tag-colors"))).toEqual([]);
		const put = await j(
			await call(fx.db, "PUT", "/api/tag-colors", [
				{ name: "ml", color: "#FF6666", position: 7 },
				{ name: "imaging", color: "#2ea8e5" },
			]),
		);
		expect(put).toEqual([
			{ name: "ml", color: "#FF6666", position: 0 },
			{ name: "imaging", color: "#2ea8e5", position: 1 },
		]);
		expect(await j(await call(fx.db, "GET", "/api/tag-colors"))).toEqual(put);
		expect(await j(await call(fx.db, "PUT", "/api/tag-colors", []))).toEqual([]);
		expect(await j(await call(fx.db, "GET", "/api/tag-colors"))).toEqual([]);
	});

	test("validation: bad colour, duplicates, empty name, non-array", async () => {
		const fx = buildFixture();
		const put = (b: unknown) => call(fx.db, "PUT", "/api/tag-colors", b);
		expect((await put([{ name: "a", color: "red" }])).status).toBe(400);
		expect((await put([{ name: "a", color: "#12345" }])).status).toBe(400);
		expect((await put([{ name: "a", color: "#fff" }, { name: "a", color: "#000000" }])).status).toBe(400);
		expect((await put([{ name: " ", color: "#fff" }])).status).toBe(400);
		expect((await put({ name: "a", color: "#fff" })).status).toBe(400);
		expect((await call(fx.db, "POST", "/api/tag-colors", [])).status).toBe(405);
		// failed PUTs leave the stored value untouched
		expect(await j(await call(fx.db, "GET", "/api/tag-colors"))).toEqual([]);
	});
});

test("30k items: page of 100 with include=creators,tags is fast", () => {
	const N = 30000;
	const db = openDb(join(tempDir(), "card-perf.sqlite"));
	const ins = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified)
		 VALUES(?, 'journalArticle', NULL, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tag = db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, ?, 0)");
	db.transaction(() => {
		for (let i = 0; i < N; i++) {
			const key = "K" + i.toString(36).toUpperCase().padStart(7, "0");
			const added = new Date(1.6e12 + i * 60000).toISOString();
			const data = {
				key,
				itemType: "journalArticle",
				title: `study ${i}`,
				abstractNote: "word ".repeat(120),
				creators: Array.from({ length: 6 }, (_, k) => ({ creatorType: "author", firstName: "Given", lastName: `Author${(i + k) % 900}` })),
			};
			ins.run(key, data.title, "Author" + (i % 900), 1980 + (i % 45), "J", JSON.stringify(data), added, added);
			for (let t = 0; t < 3; t++) tag.run(key, `tag${(i + t) % 200}`);
		}
	})();
	listItems(db, { limit: 100, include: ["creators", "tags"] }); // warm up
	const t0 = performance.now();
	const r = listItems(db, { limit: 100, offset: 5000, include: ["creators", "tags"] });
	const ms = performance.now() - t0;
	console.log(`list 100 + include=creators,tags: ${ms.toFixed(1)}ms`);
	expect(r.items).toHaveLength(100);
	expect(r.items[0].creators).toHaveLength(6);
	expect(r.items[0].tags).toHaveLength(3);
	expect(ms).toBeLessThan(30);
	db.close(true);
});
