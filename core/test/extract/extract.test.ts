import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { ExtractError, extractFulltext, shutdownExtractPool } from "../../src/extract";
import { rebuildSearchIndex, search } from "../../src/search";
import { insertAttachment, insertItem, tempDir } from "../fixture";

// Smallest useful PDF: one page of Helvetica text, xref offsets computed.
function tinyPdf(lines: string[]): Uint8Array {
	const stream = `BT /F1 14 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

function setup() {
	const dir = tempDir();
	const db = openDb(join(dir, "lib.sqlite"));
	insertItem(db, { key: "PAPER001", itemType: "journalArticle", title: "A paper with no indexed text" });
	rebuildSearchIndex(db);
	return { dir, db };
}

afterAll(() => shutdownExtractPool());

describe("extractFulltext", () => {
	test("extracts PDF text, stores it, and makes the parent item searchable", async () => {
		const { dir, db } = setup();
		const pdf = join(dir, "a.pdf");
		writeFileSync(pdf, tinyPdf(["Hepatic xenotransplantation outcomes", "in the quokka cohort"]));
		insertAttachment(db, "ATTPDF01", "PAPER001", "application/pdf", pdf);

		expect(search(db, "quokka").total).toBe(0);
		const r = await extractFulltext(db, "ATTPDF01");
		expect(r.skipped).toBeUndefined();
		expect(r.pages).toBe(1);
		expect(r.chars).toBeGreaterThan(30);

		const row = db.query("SELECT content, source FROM fulltext WHERE attachment_key = 'ATTPDF01'").get() as { content: string; source: string };
		expect(row.source).toBe("document-worker");
		expect(row.content).toContain("xenotransplantation");
		const hits = search(db, "quokka cohort");
		expect(hits.total).toBe(1);
		expect(hits.hits[0].key).toBe("PAPER001");
		db.close(true);
	});

	test("skips already-indexed unless forced", async () => {
		const { dir, db } = setup();
		const pdf = join(dir, "b.pdf");
		writeFileSync(pdf, tinyPdf(["wombat habitats"]));
		insertAttachment(db, "ATTPDF02", "PAPER001", "application/pdf", pdf);
		await extractFulltext(db, "ATTPDF02");
		expect((await extractFulltext(db, "ATTPDF02")).skipped).toBe("already-indexed");
		writeFileSync(pdf, tinyPdf(["platypus habitats"]));
		const forced = await extractFulltext(db, "ATTPDF02", { force: true });
		expect(forced.skipped).toBeUndefined();
		expect(search(db, "platypus").total).toBe(1);
		expect(search(db, "wombat").total).toBe(0);
		db.close(true);
	});

	test("skip reasons: no-file, missing file, unsupported, unknown attachment", async () => {
		const { dir, db } = setup();
		insertAttachment(db, "ATTNOPTH", "PAPER001", "application/pdf", null);
		insertAttachment(db, "ATTGONE1", "PAPER001", "application/pdf", join(dir, "gone.pdf"));
		const xls = join(dir, "x.xls");
		writeFileSync(xls, "data");
		insertAttachment(db, "ATTXLS01", "PAPER001", "application/vnd.ms-excel", xls);
		expect((await extractFulltext(db, "ATTNOPTH")).skipped).toBe("no-file");
		expect((await extractFulltext(db, "ATTGONE1")).skipped).toBe("no-file");
		expect((await extractFulltext(db, "ATTXLS01")).skipped).toBe("unsupported");
		expect((await extractFulltext(db, "NOSUCH01")).skipped).toBe("no-file");
		db.close(true);
	});

	test("content type with parameters is recognised", async () => {
		const { dir, db } = setup();
		const pdf = join(dir, "c.pdf");
		writeFileSync(pdf, tinyPdf(["marsupial anatomy"]));
		insertAttachment(db, "ATTPDF03", "PAPER001", "application/pdf;charset=UTF-8", pdf);
		expect((await extractFulltext(db, "ATTPDF03")).chars).toBeGreaterThan(5);
		db.close(true);
	});

	test("corrupt PDF throws ExtractError and writes nothing", async () => {
		const { dir, db } = setup();
		const pdf = join(dir, "bad.pdf");
		writeFileSync(pdf, "<!DOCTYPE html><html>not a pdf</html>");
		insertAttachment(db, "ATTBAD01", "PAPER001", "application/pdf", pdf);
		const err = await extractFulltext(db, "ATTBAD01").catch((e) => e);
		expect(err).toBeInstanceOf(ExtractError);
		expect(["corrupt", "worker"]).toContain((err as ExtractError).code);
		expect(db.query("SELECT 1 FROM fulltext WHERE attachment_key = 'ATTBAD01'").get()).toBeNull();
		// the pool recovers: next job still works
		const good = join(dir, "good.pdf");
		writeFileSync(good, tinyPdf(["still alive"]));
		insertAttachment(db, "ATTPDF04", "PAPER001", "application/pdf", good);
		expect((await extractFulltext(db, "ATTPDF04")).chars).toBeGreaterThan(5);
		db.close(true);
	});

	test("HTML snapshots are stripped to text", async () => {
		const { dir, db } = setup();
		const html = join(dir, "s.html");
		writeFileSync(html, "<html><head><style>p{}</style></head><body><p>Axolotl <b>regeneration</b> study</p></body></html>");
		insertAttachment(db, "ATTHTML1", "PAPER001", "text/html", html);
		const r = await extractFulltext(db, "ATTHTML1");
		expect(r.pages).toBeUndefined();
		expect(search(db, "axolotl regeneration").total).toBe(1);
		db.close(true);
	});

	test("runs several extractions concurrently", async () => {
		const { dir, db } = setup();
		const keys: string[] = [];
		for (let i = 0; i < 6; i++) {
			const p = join(dir, `m${i}.pdf`);
			writeFileSync(p, tinyPdf([`concurrent document number${i}x`]));
			const k = `ATTMANY${i}`;
			keys.push(k);
			insertAttachment(db, k, "PAPER001", "application/pdf", p);
		}
		const rs = await Promise.all(keys.map((k) => extractFulltext(db, k)));
		expect(rs.every((r) => r.chars > 10)).toBe(true);
		db.close(true);
	});
});
