// LIVE check against the internet (not part of `bun test`):  bun core/test/fulltext/live.ts [libraryCopySource]
// Copies the real library DB to a temp dir (the original is never written), picks 3 items that have no PDF but a DOI of
// a known open-access publisher, runs Find Full Text (open access only) and verifies the PDFs and rows.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../../src/db";
import { fulltextService } from "../../src/fulltext/service";

const SRC = process.argv[2] ?? "C:/Users/abora/zotero-next/data/library.sqlite";
const dir = mkdtempSync(join(tmpdir(), "zn-ft-live-"));
const dbPath = join(dir, "library.sqlite");
copyFileSync(SRC, dbPath);
console.log("temp library:", dbPath);

const db: Database = openDb(dbPath);
// DOI prefixes of publishers that are open access: PLOS, eLife, BMC/Springer OA journals, Frontiers, MDPI, Sci Rep.
const PREFIXES = ["10.1371/", "10.7554/", "10.1186/", "10.3389/", "10.3390/", "10.1038/s41598"];
const picked: { key: string; doi: string; title: string }[] = [];
for (const p of PREFIXES) {
	const rows = db
		.query(
			`SELECT i.key, json_extract(i.data,'$.DOI') doi, i.title FROM items i
			 WHERE i.parent_key IS NULL AND i.deleted = 0 AND i.item_type NOT IN ('attachment','note','annotation')
			 AND json_extract(i.data,'$.DOI') LIKE ? || '%'
			 AND NOT EXISTS (SELECT 1 FROM items c JOIN attachments a ON a.item_key = c.key
			                 WHERE c.parent_key = i.key AND c.deleted = 0 AND a.link_mode <> 'linked_url' AND a.content_type = 'application/pdf')
			 ORDER BY i.date_added DESC LIMIT 1`,
		)
		.all(p) as { key: string; doi: string; title: string }[];
	if (rows[0]) picked.push(rows[0]);
	if (picked.length === 3) break;
}
console.log("picked:", picked);
if (picked.length < 3) throw new Error("not enough candidate items");

const before = (db.query("SELECT count(*) n FROM attachments").get() as { n: number }).n;
const svc = fulltextService(db, { dataDir: dir });
const id = await svc.start(
	picked.map((p) => p.key),
	true,
);
const t0 = Date.now();
const seen = new Map<string, string>();
svc.subscribe(id, (j) => {
	for (const i of j.items) {
		const s = `${i.state}${i.source ? ` [${i.source}]` : ""}${i.message ? ` ${i.message}` : ""}`;
		if (seen.get(i.key) !== s) {
			seen.set(i.key, s);
			console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${i.key}: ${s}`);
		}
	}
});
const job = await svc.waitJob(id);
await svc.idle();
console.log(JSON.stringify(job, null, 1));

let ok = true;
for (const it of job.items) {
	if (it.state !== "attached") {
		console.log("NOT ATTACHED:", it.key, it.state, it.message);
		ok = false;
		continue;
	}
	const att = db.query("SELECT * FROM attachments WHERE item_key = ?").get(it.attachmentKey!) as any;
	const row = db.query("SELECT parent_key, item_type FROM items WHERE key = ?").get(it.attachmentKey!) as any;
	const fine = att && existsSync(att.path) && readFileSync(att.path).subarray(0, 5).toString() === "%PDF-" && row.parent_key === it.key;
	const ft = db.query("SELECT length(content) n FROM fulltext WHERE attachment_key = ?").get(it.attachmentKey!) as { n: number } | null;
	console.log(`${it.key} -> ${it.attachmentKey} ${att?.path} ${att ? statSync(att.path).size : 0} bytes, parent ok=${row?.parent_key === it.key}, fulltext chars=${ft?.n ?? "none"}`);
	if (!fine) ok = false;
}
const after = (db.query("SELECT count(*) n FROM attachments").get() as { n: number }).n;
console.log(`attachments rows ${before} -> ${after}; ${ok ? "LIVE CHECK PASSED" : "LIVE CHECK FAILED"}; temp dir ${dir}`);
await svc.dispose();
db.close(true);
process.exit(ok ? 0 : 1);
