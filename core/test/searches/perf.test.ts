import { expect, test } from "bun:test";
import { join } from "node:path";
import { listItems, openDb } from "../../src/db";
import type { SearchCondition, SearchOptions } from "../../src/searches/types";
import { tempDir } from "../fixture";

const N = Number(process.env.SEARCH_PERF_N ?? 30000);
const WORDS = ["alpha", "beta", "gamma", "delta", "kidney", "liver", "cohort", "trial", "imaging", "genome", "surgery", "outcome", "network", "protein", "cancer", "stroke"];

const cond = (field: string, operator: SearchCondition["operator"], value: string): SearchCondition => ({ field, operator, value });

// Wall-clock thresholds are calibrated on the dev machine; shared CI runners are slower and noisier, so they skip when CI is set.
test.skipIf(!!process.env.CI)("30k items: typical advanced searches stay under 200ms", () => {
	const db = openDb(join(tempDir(), "sperf.sqlite"));
	const ins = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified)
		 VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insChild = db.query(
		`INSERT INTO items(key, item_type, parent_key, title, data, date_added, date_modified) VALUES(?, ?, ?, 'child', ?, ?, ?)`,
	);
	const insAtt = db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES(?, 'imported_file', ?, NULL)");
	const insTag = db.query("INSERT INTO item_tags(item_key, tag) VALUES(?, ?)");
	const insFt = db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, ?, 'zotero-cache', '2024-01-01T00:00:00Z')");
	const insCi = db.query("INSERT INTO collection_items VALUES(?, ?)");
	db.run("INSERT INTO collections(key, name) VALUES('PERFCOL1', 'perf')");
	db.run("INSERT INTO collections(key, name, parent_key) VALUES('PERFCOL2', 'perf sub', 'PERFCOL1')");
	const keyOf = (i: number) => "K" + i.toString(36).toUpperCase().padStart(7, "0");
	db.transaction(() => {
		for (let i = 0; i < N; i++) {
			const key = keyOf(i);
			const w = (m: number) => WORDS[(i * m) % 16];
			const title = `${w(1)} ${w(7)} study ${i}`;
			const added = new Date(1.6e12 + i * 600000).toISOString().replace(/\.\d{3}Z$/, "Z");
			const type = i % 5 === 0 ? "book" : "journalArticle";
			const year = 1980 + (i % 45);
			const data = {
				key,
				itemType: type,
				title,
				abstractNote: `${w(3)} ${w(5)} results in ${w(11)} patients`,
				date: `${year}-0${1 + (i % 9)}-1${i % 10}`,
				publicationTitle: "Journal of " + w(2),
				DOI: `10.1000/${i}`,
				creators: [
					{ creatorType: "author", firstName: "First" + (i % 97), lastName: "Author" + (i % 500) },
					{ creatorType: "author", firstName: "Co", lastName: "Writer" + (i % 300) },
				],
			};
			ins.run(key, type, title, "Author" + (i % 500) + " et al.", year, "Journal of " + w(2), JSON.stringify(data), added, added);
			insTag.run(key, w(1));
			if (i % 4 === 0) insTag.run(key, "tag" + (i % 50));
			if (i % 3 === 0) insCi.run(i % 2 ? "PERFCOL1" : "PERFCOL2", key);
			if (i % 2 === 0) {
				const ak = "A" + key.slice(1);
				insChild.run(ak, "attachment", key, JSON.stringify({ key: ak, itemType: "attachment", title: "child" }), added, added);
				insAtt.run(ak, i % 4 === 0 ? "application/pdf" : "text/html");
				insFt.run(ak, `${w(1)} ${w(9)} full text content number ${i}`);
			}
			if (i % 3 === 0) {
				const nk = "N" + key.slice(1);
				insChild.run(nk, "note", key, JSON.stringify({ key: nk, itemType: "note", note: `<p>note about ${w(4)} ${i}</p>` }), added, added);
			}
		}
	})();
	const t0 = performance.now();
	// Set-based index build (search.ts's per-item rebuild is quadratic on this synthetic shape).
	db.run("CREATE TEMP TABLE t_tags AS SELECT item_key AS k, group_concat(tag, ' ') AS v FROM item_tags GROUP BY item_key");
	db.run("CREATE TEMP TABLE t_notes AS SELECT parent_key AS k, group_concat(json_extract(data, '$.note'), ' ') AS v FROM items WHERE item_type = 'note' GROUP BY parent_key");
	db.run("CREATE TEMP TABLE t_ft AS SELECT a.parent_key AS k, group_concat(f.content, ' ') AS v FROM fulltext f JOIN items a ON a.key = f.attachment_key GROUP BY a.parent_key");
	for (const t of ["t_tags", "t_notes", "t_ft"]) db.run(`CREATE INDEX ${t}_k ON ${t}(k)`);
	db.run(
		`INSERT INTO search(rowid, title, creators, abstract, publication, tags, notes, fulltext)
		 SELECT i.rowid, i.title, '', json_extract(i.data, '$.abstractNote'), i.publication,
			COALESCE(tg.v, ''), COALESCE(nt.v, ''), COALESCE(ft.v, '')
		 FROM items i LEFT JOIN t_tags tg ON tg.k = i.key LEFT JOIN t_notes nt ON nt.k = i.key LEFT JOIN t_ft ft ON ft.k = i.key
		 WHERE i.parent_key IS NULL`,
	);
	process.stderr.write(`index rebuild ${(performance.now() - t0).toFixed(0)}ms\n`);

	const all: Partial<SearchOptions> = { match: "all" };
	const cases: { name: string; conditions: SearchCondition[]; options?: Partial<SearchOptions>; min?: number }[] = [
		{ name: "title contains", conditions: [cond("title", "contains", "kidney")] },
		{ name: "creator is", conditions: [cond("creator", "is", "Author42")] },
		{ name: "creator contains", conditions: [cond("creator", "contains", "Writer7")] },
		{ name: "tag + year", conditions: [cond("tag", "is", "cancer"), cond("year", "isAfter", "2000")] },
		{ name: "tag isNot", conditions: [cond("tag", "isNot", "cancer")] },
		{ name: "collection + subcollections", conditions: [cond("collection", "is", "PERFCOL1")], options: { searchSubcollections: true } },
		{ name: "date isAfter", conditions: [cond("date", "isAfter", "2010-03")] },
		{ name: "dateAdded isInTheLast", conditions: [cond("dateAdded", "isInTheLast", "50 years")] },
		{ name: "publicationTitle contains", conditions: [cond("publicationTitle", "contains", "kidney")] },
		{ name: "DOI is", conditions: [cond("DOI", "is", "10.1000/12345")] },
		{ name: "itemType + title", conditions: [cond("itemType", "is", "book"), cond("title", "contains", "genome")] },
		{ name: "anyField contains", conditions: [cond("anyField", "contains", "patients")] },
		{ name: "anyField rare", conditions: [cond("anyField", "contains", "Author499")] },
		{ name: "fulltext", conditions: [cond("fulltextContent", "contains", "kidney")] },
		{ name: "note", conditions: [cond("note", "contains", "network")] },
		{ name: "attachmentFileType", conditions: [cond("attachmentFileType", "is", "pdf")] },
		{ name: "any of 3", conditions: [cond("title", "contains", "liver"), cond("tag", "is", "tag7"), cond("creator", "is", "Writer9")], options: { match: "any" } },
		{ name: "title + family lift", conditions: [cond("title", "contains", "child")], options: { includeParentsAndChildren: true } },
	];
	const lines: string[] = [];
	for (const c of cases) {
		const def = { conditions: c.conditions, options: { ...all, ...c.options } as SearchOptions };
		listItems(db, { searchDef: def, sort: "title", limit: 100 }); // warm up (also creates indexes)
		const t = performance.now();
		const r = listItems(db, { searchDef: def, sort: "dateAdded", dir: "desc", limit: 100, offset: 0 });
		const ms = performance.now() - t;
		lines.push(`${c.name.padEnd(30)} total=${String(r.total).padStart(6)}  ${ms.toFixed(1)}ms`);
		process.stderr.write(lines[lines.length - 1] + "\n");
		expect(r.total).toBeGreaterThan(0);
		expect(ms).toBeLessThan(200);
	}
	console.log("advanced search perf on " + N + " items:\n" + lines.join("\n"));

	// quick search modes
	for (const [q, mode] of [["kidney", "fields"], ["genome", "everything"], ["protein imaging", "everything"]] as const) {
		listItems(db, { q, qmode: mode, limit: 100 });
		const t = performance.now();
		const r = listItems(db, { q, qmode: mode, limit: 100 });
		const ms = performance.now() - t;
		console.log(`quick ${mode.padEnd(10)} "${q}" total=${r.total} ${ms.toFixed(1)}ms`);
		expect(ms).toBeLessThan(200);
	}
}, 120000);
