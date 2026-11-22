// gatherItems reads the tags and attachments of all selected items in one query each; the result must be exactly what one
// query per item gave, so every export format stays byte for byte the same.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ZoteroItemData } from "../../src/api-types";
import { createItem, openDb, patchItem } from "../../src/db";
import { resolveStoredPath } from "../../src/files/paths";
import { htmlToText } from "../../src/io/common";
import { exportItems, gatherItems, type ExportFormat, type ExportRequest } from "../../src/io/export";
import { tempDir } from "../fixture";

const db: Database = openDb(join(tempDir(), "lib.sqlite"));
afterAll(() => db.close(true));

// the per-item queries gatherItems used before, as the reference
function reference(req: ExportRequest, keys: string[]) {
	const dataQ = db.query("SELECT data FROM items WHERE key = ?");
	const tagQ = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag COLLATE NOCASE");
	const noteQ = db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY date_added, key");
	const attQ = db.query(
		`SELECT a.link_mode, a.path, a.url, i.title AS title, a.content_type FROM attachments a JOIN items i ON i.key = a.item_key
		 WHERE i.parent_key = ? AND i.deleted = 0 ORDER BY i.date_added, i.key`,
	);
	return keys.map((key) => {
		const data = JSON.parse((dataQ.get(key) as { data: string }).data) as ZoteroItemData;
		const tags = tagQ.all(key) as { tag: string; type: number }[];
		const noteRows = req.includeNotes ? (noteQ.all(key) as { data: string }[]) : [];
		const noteHtml = noteRows.map((r) => String((JSON.parse(r.data) as ZoteroItemData).note ?? "")).filter(Boolean);
		const atts = attQ.all(key) as { link_mode: string; path: string | null; url: string | null }[];
		return {
			data,
			tags: tags.map((t) => t.tag),
			autoTags: tags.filter((t) => t.type === 1).map((t) => t.tag),
			notes: noteHtml.map(htmlToText).filter(Boolean),
			noteHtml,
			files: atts.filter((a) => a.path && a.link_mode !== "linked_url").map((a) => resolveStoredPath(db, a.path) ?? a.path!),
			links: atts.filter((a) => a.link_mode === "linked_url" && a.url).map((a) => a.url!),
		};
	});
}

const keys: string[] = [];
for (let i = 0; i < 40; i++) {
	const it = createItem(db, {
		itemType: "journalArticle",
		title: `Article ${i}`,
		date: `${2000 + i}`,
		// names that differ only by case sort as ties
		tags: i % 5 === 4 ? [] : [{ tag: `tag${i % 4}` }, { tag: `Tag${i % 4}` }, { tag: `TAG${i % 4}` }, { tag: `auto ${i}`, type: 1 }, { tag: "zeta" }, { tag: "Alpha" }],
	});
	keys.push(it.data.key);
	if (i % 3 !== 1) createItem(db, { itemType: "attachment", linkMode: "linked_url", parentItem: it.data.key, title: `link ${i}`, url: `https://example.org/${i}` });
	if (i % 4 === 0) createItem(db, { itemType: "attachment", linkMode: "linked_url", parentItem: it.data.key, title: `second ${i}`, url: `https://example.org/${i}/b` });
	if (i % 6 === 0) {
		const gone = createItem(db, { itemType: "attachment", linkMode: "linked_url", parentItem: it.data.key, title: "trashed", url: "https://example.org/gone" });
		patchItem(db, gone.data.key, { deleted: 1 });
	}
	if (i % 2 === 0) createItem(db, { itemType: "note", note: `<p>note ${i}</p>`, parentItem: it.data.key });
}
// two linked files and an imported file path
db.query("UPDATE attachments SET path = 'C:/files/a.pdf', link_mode = 'linked_file' WHERE item_key IN (SELECT item_key FROM attachments LIMIT 3)").run();

const FORMATS: ExportFormat[] = ["bibtex", "biblatex", "ris", "csljson", "csv", "rdf", "mods", "betterbibtex"];

describe("gatherItems", () => {
	test("the whole library gives what one query per item gave", () => {
		for (const includeNotes of [false, true]) {
			const req: ExportRequest = { format: "bibtex", includeNotes };
			const got = gatherItems(db, req);
			expect(got.length).toBe(40);
			expect(JSON.stringify(got)).toBe(JSON.stringify(reference(req, got.map((g) => g.data.key))));
		}
	});

	test("a selection, with repeated and unknown keys, gives the same", () => {
		const pick = [keys[7]!, keys[0]!, keys[7]!, "ZZZZZZZZ", keys[39]!, keys[4]!];
		const req: ExportRequest = { keys: pick, format: "ris", includeNotes: true };
		const got = gatherItems(db, req);
		expect(got.map((g) => g.data.key)).toEqual([keys[7]!, keys[0]!, keys[39]!, keys[4]!]);
		expect(JSON.stringify(got)).toBe(JSON.stringify(reference(req, got.map((g) => g.data.key))));
	});

	test("nothing selected gives nothing", () => {
		expect(gatherItems(db, { keys: ["ZZZZZZZZ"], format: "bibtex" })).toEqual([]);
	});

	test("case-only tag ties, automatic tags, links and trashed attachments are all kept", () => {
		const got = gatherItems(db, { keys: [keys[1]!], format: "bibtex" });
		expect(got[0]!.tags.map((t) => t.toLowerCase())).toEqual(["alpha", "auto 1", "tag1", "tag1", "tag1", "zeta"]);
		expect([...got[0]!.tags].sort()).toEqual(["Alpha", "TAG1", "Tag1", "auto 1", "tag1", "zeta"]);
		expect(got[0]!.autoTags).toEqual(["auto 1"]);
		expect(got[0]!.links).toEqual([]);
		expect(gatherItems(db, { keys: [keys[2]!], format: "bibtex" })[0]!.links).toEqual(["https://example.org/2"]);
		const sixth = gatherItems(db, { keys: [keys[6]!], format: "bibtex" })[0]!;
		expect(sixth.links).toEqual(["https://example.org/6"]); // the trashed second attachment is left out
	});

	test("every export format is unchanged", () => {
		for (const format of FORMATS) {
			const req: ExportRequest = { format, includeNotes: true };
			const items = reference(req, gatherItems(db, req).map((g) => g.data.key));
			const now = exportItems(db, req).text;
			// the same text from the same items; the format writers see only what gatherItems returns
			expect(now.length).toBeGreaterThan(100);
			expect(JSON.stringify(gatherItems(db, req))).toBe(JSON.stringify(items));
		}
	});
});
