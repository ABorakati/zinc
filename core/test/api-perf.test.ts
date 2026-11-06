import { expect, test } from "bun:test";
import { join } from "node:path";
import { listItems, openDb } from "../src/db";
import { tempDir } from "./fixture";

const N = 30000;

// Wall-clock thresholds are calibrated on the dev machine; shared CI runners are slower and noisier, so they skip when CI is set.
test.skipIf(!!process.env.CI)("30k items: json-field sorts and fields= under 150ms per page", () => {
	const db = openDb(join(tempDir(), "perf3.sqlite"));
	const ins = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified)
		 VALUES(?, 'journalArticle', NULL, ?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		for (let i = 0; i < N; i++) {
			const key = "K" + i.toString(36).toUpperCase().padStart(7, "0");
			const added = new Date(1.6e12 + i * 60000).toISOString();
			const data = {
				key,
				itemType: "journalArticle",
				title: `study ${i}`,
				date: `${1980 + (i % 45)}-0${1 + (i % 9)}`,
				volume: i % 3 === 0 ? String(i % 200) : undefined,
				DOI: `10.1000/${(i * 7919) % 100000}`,
				abstractNote: "word ".repeat(60),
				creators: [{ creatorType: "author", lastName: "Author" + (i % 500) }],
			};
			ins.run(key, data.title, "Author" + (i % 500), 1980 + (i % 45), "J" + (i % 40), JSON.stringify(data), added, added);
		}
	})();

	const cases: [string, string][] = [["DOI", "asc"], ["volume", "desc"], ["date", "asc"], ["itemType", "asc"], ["publication", "desc"], ["noteCount", "desc"]];
	for (const [sort, dir] of cases) {
		listItems(db, { sort, dir, limit: 100, fields: ["DOI", "volume", "date"] }); // warm up
		const t = performance.now();
		const r = listItems(db, { sort, dir, limit: 100, offset: 5000, fields: ["DOI", "volume", "date"] });
		const ms = performance.now() - t;
		console.log(`list ${sort}/${dir} + fields: ${ms.toFixed(1)}ms`);
		expect(r.items).toHaveLength(100);
		expect(r.items[0].fields).toBeDefined();
		expect(ms).toBeLessThan(150);
	}
	db.close(true);
});
