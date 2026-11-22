// replaceAttachmentFile: a leftover backup that cannot be removed after the commit must not roll the new PDF back.
// Temp folders and temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "../../src/db";
import { createItem, openDb, upsertAnnotations } from "../../src/db";
import { replaceAttachmentFile } from "../../src/files/replace";

let dir: string;
let db: Database;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "zn-replace-"));
	db = openDb(join(dir, "library.sqlite"));
});
afterEach(() => {
	db.close(true);
});

const PDF = (extra = "") => Buffer.from(`%PDF-1.4\n${extra}%%EOF\n`).toString("base64");
const body = (obj: unknown) => new Request("http://x/", { method: "PUT", body: JSON.stringify(obj) });

function pdfWithAnnotations(): { key: string; path: string } {
	const parent = createItem(db, { itemType: "journalArticle", title: "Paper" }).data.key;
	const key = createItem(
		db,
		{ itemType: "attachment", linkMode: "imported_file", title: "paper.pdf", contentType: "application/pdf", parentItem: parent },
	).data.key;
	const path = join(dir, "storage", key, "paper.pdf");
	mkdirSync(join(dir, "storage", key), { recursive: true });
	writeFileSync(path, "%PDF-1.4 original");
	db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(path, key);
	const ann = (id: string, page: number) => ({
		id,
		type: "highlight",
		sortIndex: `${String(page).padStart(5, "0")}|000100|00200`,
		pageLabel: String(page + 1),
		position: { pageIndex: page, rects: [] },
		dateModified: "2024-01-01T00:00:00Z",
	});
	upsertAnnotations(db, key, [ann("ANNOAAA1", 0), ann("ANNOAAA2", 1), ann("ANNOAAA3", 2)] as never);
	return { key, path };
}

describe("a backup that cannot be removed after the commit", () => {
	test("keeps the new file and the new annotations, and reports success", async () => {
		const att = pdfWithAnnotations();
		// While the transaction is open, the backup copy is replaced by a non-empty folder of the same name, so that the
		// removal after the commit really fails (rmSync without recursive refuses a folder).
		const real = repo.deleteAnnotations;
		const spy = spyOn(repo, "deleteAnnotations").mockImplementation(((...args: Parameters<typeof real>) => {
			const folder = join(dir, "storage", att.key);
			for (const f of readdirSync(folder)) {
				if (f.endsWith(".zn-bak")) {
					rmSync(join(folder, f));
					mkdirSync(join(folder, f));
					writeFileSync(join(folder, f, "keep"), "x");
				}
			}
			return real(...args);
		}) as typeof real);
		try {
			const res = await replaceAttachmentFile(db, att.key, body({ dataBase64: PDF("shorter"), deletedPages: [1] }));
			expect(res.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}
		expect(readFileSync(att.path, "utf8")).toContain("shorter"); // the new document stays
		const rows = db.query("SELECT key FROM annotations WHERE attachment_key = ? ORDER BY key").all(att.key) as { key: string }[];
		expect(rows.map((r) => r.key)).toEqual(["ANNOAAA1", "ANNOAAA3"]); // and the annotations follow it
	});

	test("a failure before the commit still puts the original back", async () => {
		const att = pdfWithAnnotations();
		db.run("CREATE TRIGGER refuse_ann BEFORE UPDATE ON annotations BEGIN SELECT RAISE(ABORT, 'refused'); END");
		await expect(replaceAttachmentFile(db, att.key, body({ dataBase64: PDF("shorter"), deletedPages: [1] }))).rejects.toBeTruthy();
		expect(readFileSync(att.path, "utf8")).toBe("%PDF-1.4 original");
		expect(db.query("SELECT COUNT(*) AS n FROM annotations WHERE attachment_key = ?").get(att.key)).toEqual({ n: 3 });
	});
});

void repo;
