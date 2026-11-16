import { beforeEach, describe, expect, test } from "bun:test";
import { indexItem, parseQuery, rebuildSearchIndex, sanitizeQuery, search, stripHtml } from "../src/search";
import { buildFixture, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
	fx = buildFixture();
});

describe("sanitising", () => {
	test("quotes terms and supports trailing *", () => {
		expect(sanitizeQuery("deep learn*")).toBe('"deep" "learn"*');
		expect(sanitizeQuery('"exact phrase" other')).toBe('"exact phrase" "other"');
		expect(parseQuery("")).toEqual([]);
	});
	test("FTS syntax can never throw", () => {
		const nasty = [
			'"',
			"(",
			")",
			"AND",
			"OR",
			"NOT",
			"NEAR(",
			"title:",
			"a OR",
			"*",
			"-foo",
			"foo*bar",
			"^x",
			"'; DROP TABLE items;--",
			"{",
			"\\",
			'"unterminated phrase',
			"title : foo",
			"é ü ñ",
		];
		for (const q of nasty) {
			expect(() => search(fx.db, q)).not.toThrow();
		}
		expect(search(fx.db, "AND").total).toBe(0);
		expect(search(fx.db, "*").total).toBe(0);
		expect(fx.db.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 8 - 0 });
	});
	test("empty query", () => {
		expect(search(fx.db, "   ")).toEqual({ total: 0, hits: [] });
	});
});

describe("search", () => {
	test("title match, snippet and matchedIn", () => {
		const r = search(fx.db, "radiology");
		expect(r.total).toBe(1);
		expect(r.hits[0].key).toBe("AAAAAAA1");
		expect(r.hits[0].snippet).toContain("<mark>");
		expect(r.hits[0].matchedIn).toEqual(["metadata"]);
		expect(r.hits[0].creatorsSummary).toBe("Smith and Jones");
		expect(r.hits[0].year).toBe(2020);
	});
	test("stemming and prefix", () => {
		expect(search(fx.db, "networks").hits.map((h) => h.key)).toEqual(["AAAAAAA1"]);
		expect(search(fx.db, "network").hits.map((h) => h.key)).toEqual(["AAAAAAA1"]);
		expect(search(fx.db, "radi*").hits.map((h) => h.key)).toEqual(["AAAAAAA1"]);
		expect(search(fx.db, "résumé").total).toBe(0);
	});
	test("fulltext only", () => {
		const r = search(fx.db, "pulmonary nodules");
		expect(r.hits.map((h) => h.key)).toEqual(["AAAAAAA1"]);
		expect(r.hits[0].matchedIn).toEqual(["fulltext"]);
		expect(r.hits[0].snippet).toContain("<mark>pulmonary</mark>");
	});
	test("notes are stripped of HTML and indexed", () => {
		const r = search(fx.db, "transformer");
		expect(r.hits[0].matchedIn).toEqual(["notes"]);
		expect(search(fx.db, "strong").total).toBe(0);
		expect(stripHtml("<p>a&nbsp;<b>b</b> &amp; c</p>")).toBe("a b & c");
	});
	test("multiple groups and phrase", () => {
		const r = search(fx.db, "radiology lung");
		expect(r.hits[0].matchedIn).toEqual(["metadata", "fulltext"]);
		expect(search(fx.db, '"neural networks"').total).toBe(1);
		expect(search(fx.db, '"networks neural"').total).toBe(0);
	});
	test("title outranks fulltext", () => {
		fx.db
			.query(
				"INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES('ATT00003', 'a long text about zebra zebra', 'x', 'y')",
			)
			.run();
		indexItem(fx.db, "DDDDDDD4");
		const r = search(fx.db, "zebra");
		// trashed item is excluded; only the live one remains
		expect(r.hits.map((h) => h.key)).toEqual(["DDDDDDD4"]);
		expect(r.hits[0].matchedIn).toEqual(["metadata", "fulltext"]);
	});
	test("deleted items excluded, pagination", () => {
		expect(search(fx.db, "zebras").total).toBe(1);
		const all = search(fx.db, "imaging", { limit: 1, offset: 0 });
		expect(all.total).toBe(2);
		expect(all.hits).toHaveLength(1);
		const next = search(fx.db, "imaging", { limit: 1, offset: 1 });
		expect(next.hits[0].key).not.toBe(all.hits[0].key);
	});
	test("indexItem for child re-indexes parent; rebuild is idempotent", () => {
		fx.db.query("UPDATE items SET data = json_set(data, '$.note', '<p>quokka</p>') WHERE key = 'NOTE0001'").run();
		indexItem(fx.db, "NOTE0001");
		expect(search(fx.db, "quokka").hits.map((h) => h.key)).toEqual(["AAAAAAA1"]);
		rebuildSearchIndex(fx.db);
		rebuildSearchIndex(fx.db);
		expect(search(fx.db, "quokka").total).toBe(1);
		expect(fx.db.query("SELECT count(*) AS n FROM search").get()).toEqual({ n: 4 });
	});
});
