import { expect, test } from "bun:test";
import { join } from "node:path";
import { handleApi } from "../src/api";
import { listItems, openDb } from "../src/db";
import { rebuildSearchIndex, search } from "../src/search";
import { tempDir } from "./fixture";

const N = 30000;
const WORDS = [
	"alpha",
	"beta",
	"gamma",
	"delta",
	"kidney",
	"liver",
	"cohort",
	"trial",
	"imaging",
	"genome",
	"surgery",
	"outcome",
	"network",
	"protein",
	"cancer",
	"stroke",
];

function time<T>(fn: () => T): [T, number] {
	const t = performance.now();
	const r = fn();
	return [r, performance.now() - t];
}

// Wall-clock thresholds are calibrated on the dev machine; shared CI runners are slower and noisier, so they skip when CI is set.
test.skipIf(!!process.env.CI)("30k items: page listing and search under 50ms", async () => {
	const db = openDb(join(tempDir(), "perf.sqlite"));
	const ins = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified)
		 VALUES(?, 'journalArticle', NULL, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insAtt = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, data, date_added, date_modified) VALUES(?, 'attachment', ?, 'a', '{}', ?, ?)`,
	);
	const insAttRow = db.query(
		"INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES(?, 'imported_file', 'application/pdf', NULL)",
	);
	const insTag = db.query("INSERT INTO item_tags(item_key, tag) VALUES(?, ?)");
	const insCi = db.query("INSERT INTO collection_items VALUES('PERFCOL1', ?)");
	db.run("INSERT INTO collections(key, name) VALUES('PERFCOL1', 'perf')");
	const keyOf = (i: number) => "K" + i.toString(36).toUpperCase().padStart(7, "0");
	db.transaction(() => {
		for (let i = 0; i < N; i++) {
			const key = keyOf(i);
			const title = `${WORDS[i % 16]} ${WORDS[(i * 7) % 16]} study ${i}`;
			const added = new Date(1.6e12 + i * 60000).toISOString();
			const data = {
				key,
				itemType: "journalArticle",
				title,
				abstractNote: `${WORDS[(i * 3) % 16]} ${WORDS[(i * 5) % 16]} results`,
				creators: [{ creatorType: "author", lastName: "Author" + (i % 500) }],
			};
			ins.run(key, title, "Author" + (i % 500), 1980 + (i % 45), WORDS[i % 16], JSON.stringify(data), added, added);
			if (i % 2 === 0) {
				insAtt.run("A" + key.slice(1), key, added, added);
				insAttRow.run("A" + key.slice(1));
			}
			insTag.run(key, WORDS[i % 16]);
			if (i % 3 === 0) insCi.run(key);
		}
	})();
	rebuildSearchIndex(db);

	const sorts: [string, string][] = [
		["dateAdded", "desc"],
		["title", "asc"],
		["creator", "asc"],
		["year", "desc"],
	];
	const report: string[] = [];
	for (const [sort, dir] of sorts) {
		listItems(db, { sort, dir, limit: 100 }); // warm up
		const [r, ms] = time(() => listItems(db, { sort, dir, limit: 100, offset: 5000 }));
		report.push(`list ${sort}/${dir}: ${ms.toFixed(1)}ms`);
		console.log(report[report.length - 1]);
		expect(r.items).toHaveLength(100);
		expect(r.total).toBe(N);
		expect(ms).toBeLessThan(50);
	}
	listItems(db, { collection: "PERFCOL1", tag: "kidney", sort: "title", limit: 100 });
	const [f, fms] = time(() => listItems(db, { collection: "PERFCOL1", tag: "kidney", sort: "title", limit: 100 }));
	report.push(`list filtered: ${fms.toFixed(1)}ms (${f.total})`);
	console.log(report[report.length - 1]);
	expect(fms).toBeLessThan(50);

	search(db, "kidney"); // warm up
	for (const q of ["kidney", "kidney network", "cancer gam*"]) {
		const [s, ms] = time(() => search(db, q, { limit: 20 }));
		report.push(`search '${q}': ${ms.toFixed(1)}ms (${s.total} hits)`);
		expect(s.hits.length).toBeGreaterThan(0);
		expect(ms).toBeLessThan(50);
	}

	const t = performance.now();
	const res = await handleApi(new Request("http://x/api/items?limit=100&sort=title&dir=asc"), db);
	const body = (await res!.json()) as any;
	const apiMs = performance.now() - t;
	report.push(`api /items page: ${apiMs.toFixed(1)}ms`);
	expect(body.items).toHaveLength(100);
	expect(apiMs).toBeLessThan(50);
	console.log(report.join("\n"));
});
