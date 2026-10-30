// Replays a full browser-extension save through the COMPILED host over native-messaging frames, against a copy of a
// library (a fresh temp library by default; set ZNH_SOURCE_DB to a library file to test against a copy of it).
// Build first: `bun run build`.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/src/db";
import { HOST_EXE, HostClient } from "./client";

const ROOT = process.env.ZNH_TEST_DIR ?? mkdtempSync(join(tmpdir(), "znh-"));
mkdirSync(ROOT, { recursive: true });
const SOURCE = process.env.ZNH_SOURCE_DB;

/** A fresh library copy in its own folder (attachment storage sits next to the database). */
function makeLibrary(name: string): string {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "library.sqlite");
	if (SOURCE) {
		const src = new Database(SOURCE, { readonly: true });
		src.run(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
		src.close(true);
	}
	const db = openDb(path);
	db.close(true);
	return path;
}

const article = (id = "item1", over: Record<string, unknown> = {}) => ({
	id,
	itemType: "journalArticle",
	title: `Outcomes after liver transplantation ${id}`,
	creators: [
		{ firstName: "Jane", lastName: "Smith", creatorType: "author" },
		{ firstName: "Raj", lastName: "Patel", creatorType: "author" },
	],
	date: "2023-11-02",
	publicationTitle: "BMJ",
	volume: "383",
	DOI: `10.1136/bmj-${id}`,
	url: "https://www.bmj.com/content/383/" + id,
	accessDate: "CURRENT_TIMESTAMP",
	tags: ["liver", { tag: "transplant", type: 0 }],
	notes: [{ note: "<p>Translator note</p>" }],
	attachments: [
		{ id: "att1", title: "Full Text PDF", url: "https://www.bmj.com/x.pdf", mimeType: "application/pdf", parentItem: id },
		{ id: "att2", title: "Publisher link", url: "https://www.bmj.com/content/383/" + id, mimeType: "text/html", snapshot: false, parentItem: id },
	],
	seeAlso: [],
	...over,
});

/** A PDF-looking file of `size` bytes, with a recognisable pattern so truncation is detected. */
function fakePdf(size: number): Uint8Array {
	const b = new Uint8Array(size);
	const head = new TextEncoder().encode("%PDF-1.4\n");
	b.set(head);
	for (let i = head.length; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
	return b;
}

/** A real one-page PDF whose text layer says `text` (hand-built, with a correct xref table). */
function tinyPdf(text: string): Uint8Array {
	const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
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
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

const count = (db: Database, sql: string, ...p: any[]) => (db.query(sql).get(...p) as { n: number }).n;

beforeAll(() => {
	if (!existsSync(HOST_EXE)) throw new Error(`build the host first: ${HOST_EXE} is missing`);
});
afterAll(() => {
	if (!process.env.ZNH_TEST_DIR) rmSync(ROOT, { recursive: true, force: true });
});

describe("native host: a full save", () => {
	const dbPath = makeLibrary("full");
	let collKey = "";
	let h: HostClient;
	const pdf = fakePdf(9 * 1024 * 1024); // > 2 upload chunks

	beforeAll(() => {
		const db = openDb(dbPath);
		collKey = (db.query("SELECT key FROM collections WHERE name = 'ZNH test'").get() as { key: string } | null)?.key ?? "";
		if (!collKey) {
			collKey = "ZNHTEST1";
			db.run("INSERT INTO collections(key, name) VALUES(?, 'ZNH test')", [collKey]);
		}
		db.close(true);
		h = new HostClient({ ZN_DB: dbPath });
	});
	afterAll(async () => {
		await h.close();
	});

	test("hello, ping and getSelectedCollection (library by default)", async () => {
		const hello = await h.helloMsg();
		expect(hello.db).toBe(dbPath);
		const ping = await h.call("ping", { json: {} });
		expect(ping.status).toBe(200);
		expect(ping.json.prefs.supportsAttachmentUpload).toBe(true);
		expect(ping.headers["X-Zotero-Version"]).toBeTruthy();
		const sel = await h.call("getSelectedCollection", { json: {} });
		expect(sel.status).toBe(200);
		expect(sel.json.id).toBeNull();
		expect(sel.json.targets[0].id).toBe("L1");
		expect(sel.json.targets.some((t: any) => t.id === `C${collKey}`)).toBe(true);
	});

	test("saveItems, saveAttachment (chunked PDF), updateSession, saveSingleFile", async () => {
		const items = [article("item1")];
		const saved = await h.call("saveItems", { json: { sessionID: "S1", uri: "https://www.bmj.com/content/383", items } });
		expect(saved.status).toBe(201);

		const meta = JSON.stringify({ id: "att1", url: "https://www.bmj.com/x.pdf", contentType: "application/pdf", parentItemID: "item1", title: "Full Text PDF" });
		const att = await h.call("saveAttachment", { bytes: pdf, headers: { "Content-Type": "application/pdf", "X-Metadata": meta }, query: "sessionID=S1" });
		expect(att.status).toBe(201);

		const upd = await h.call("updateSession", { json: { sessionID: "S1", target: `C${collKey}`, tags: ["from-ext"], note: "my note" } });
		expect(upd.status).toBe(200);

		const html = "<html><body><h1>Snapshot</h1></body></html>";
		const single = await h.call("saveSingleFile", {
			headers: { "Content-Type": "application/json" },
			json: { sessionID: "S1", items, snapshotContent: html, url: "https://www.bmj.com/content/383/item1", title: "Snapshot" },
		});
		expect(single.status).toBe(201);

		const db = openDb(dbPath);
		try {
			const top = db.query("SELECT key, title FROM items WHERE title LIKE 'Outcomes after liver transplantation item1' AND parent_key IS NULL").get() as { key: string; title: string };
			expect(top).toBeTruthy();
			// collection, tags
			expect(count(db, "SELECT count(*) n FROM collection_items WHERE item_key = ? AND collection_key = ?", top.key, collKey)).toBe(1);
			const tags = (db.query("SELECT tag FROM item_tags WHERE item_key = ?").all(top.key) as { tag: string }[]).map((t) => t.tag);
			expect(tags).toEqual(expect.arrayContaining(["liver", "transplant", "from-ext"]));
			// attachments: PDF + snapshot (the publisher link is saved by link only, not here)
			const atts = db.query("SELECT a.item_key, a.content_type, a.path FROM attachments a JOIN items i ON i.key = a.item_key WHERE i.parent_key = ?").all(top.key) as { item_key: string; content_type: string; path: string }[];
			const pdfAtt = atts.find((a) => a.content_type === "application/pdf")!;
			expect(pdfAtt).toBeTruthy();
			const onDisk = readFileSync(pdfAtt.path);
			expect(onDisk.length).toBe(pdf.length);
			expect(Buffer.compare(onDisk, Buffer.from(pdf))).toBe(0);
			expect(pdfAtt.path.startsWith(join(ROOT, "full"))).toBe(true); // storage sits next to the DB copy
			const snap = atts.find((a) => a.content_type === "text/html" && a.path)!;
			expect(readFileSync(snap.path, "utf8")).toContain("<h1>Snapshot</h1>");
			// notes: translator note + the user's typed note
			const notes = (db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0").all(top.key) as { data: string }[]).map((r) => JSON.parse(r.data).note as string);
			expect(notes.some((n) => n.includes("Translator note"))).toBe(true);
			expect(notes.some((n) => n.includes("my note"))).toBe(true);
			// sync outbox recorded the writes by trigger
			expect(count(db, "SELECT count(*) n FROM sync_outbox WHERE type = 'item' AND key = ?", top.key)).toBeGreaterThan(0);
			expect(count(db, "SELECT count(*) n FROM sync_outbox WHERE type = 'item' AND key = ?", pdfAtt.item_key)).toBeGreaterThan(0);
		} finally {
			db.close(true);
		}
		expect(h.maxFrame).toBeLessThanOrEqual(1_000_000);
	});

	test("the target chosen in the progress window becomes the next save target, across host restarts", async () => {
		await h.close();
		h = new HostClient({ ZN_DB: dbPath });
		const sel = await h.call("getSelectedCollection", { json: {} });
		expect(sel.json.id).toBe(`C${collKey}`);
		expect(sel.json.name).toBe("ZNH test");
		const saved = await h.call("saveItems", { json: { sessionID: "S2", items: [article("item2")] } });
		expect(saved.status).toBe(201);
		const db = openDb(dbPath);
		const k = (db.query("SELECT key FROM items WHERE title = 'Outcomes after liver transplantation item2'").get() as { key: string }).key;
		expect(count(db, "SELECT count(*) n FROM collection_items WHERE item_key = ? AND collection_key = ?", k, collKey)).toBe(1);
		db.close(true);
		// back to My Library
		expect((await h.call("updateSession", { json: { sessionID: "S2", target: "L1" } })).status).toBe(200);
		await h.close();
		h = new HostClient({ ZN_DB: dbPath });
		expect((await h.call("getSelectedCollection", { json: {} })).json.id).toBeNull();
	});

	test("a session survives a host restart (saveItems -> restart -> saveAttachment -> updateSession)", async () => {
		expect((await h.call("saveItems", { json: { sessionID: "S3", items: [article("item3")] } })).status).toBe(201);
		await h.close();
		h = new HostClient({ ZN_DB: dbPath });
		const meta = JSON.stringify({ id: "att1", url: "https://www.bmj.com/x.pdf", contentType: "application/pdf", parentItemID: "item3", title: "Full Text PDF" });
		const att = await h.call("saveAttachment", { bytes: fakePdf(5000), headers: { "Content-Type": "application/pdf", "X-Metadata": meta }, query: "sessionID=S3" });
		expect(att.status).toBe(201);
		expect((await h.call("updateSession", { json: { sessionID: "S3", target: "L1", tags: ["restarted"] } })).status).toBe(200);
		const db = openDb(dbPath);
		const k = (db.query("SELECT key FROM items WHERE title = 'Outcomes after liver transplantation item3'").get() as { key: string }).key;
		expect(count(db, "SELECT count(*) n FROM item_tags WHERE item_key = ? AND tag = 'restarted'", k)).toBe(1);
		expect(count(db, "SELECT count(*) n FROM items WHERE parent_key = ? AND item_type = 'attachment'", k)).toBeGreaterThanOrEqual(1);
		db.close(true);
	});

	test("a saved PDF is full-text indexed by the host (worker pool from the zotero-next checkout)", async () => {
		const id = "item-ft";
		expect((await h.call("saveItems", { json: { sessionID: "SFT", items: [article(id)] } })).status).toBe(201);
		const meta = JSON.stringify({ id: "att1", url: "https://www.bmj.com/ft.pdf", contentType: "application/pdf", parentItemID: id, title: "FT" });
		const att = await h.call("saveAttachment", { bytes: tinyPdf("Zebra pangolin xylophone"), headers: { "Content-Type": "application/pdf", "X-Metadata": meta }, query: "sessionID=SFT" });
		expect(att.status).toBe(201);
		const db = openDb(dbPath);
		const parent = (db.query("SELECT key FROM items WHERE title LIKE '%item-ft'").get() as { key: string }).key;
		const attKey = (db.query("SELECT a.item_key AS key FROM attachments a JOIN items i ON i.key = a.item_key WHERE i.parent_key = ? AND a.path IS NOT NULL").get(parent) as { key: string }).key;
		let content = "";
		for (let i = 0; i < 80 && !content; i++) {
			await Bun.sleep(500);
			content = (db.query("SELECT content FROM fulltext WHERE attachment_key = ?").get(attKey) as { content: string } | null)?.content ?? "";
		}
		db.close(true);
		if (!content) console.error("host stderr:", h.stderr.join(""));
		expect(content).toContain("pangolin");
	}, 60_000);

	test("errors look like Zotero's; unknown methods are 404 so the extension falls back to the repo", async () => {
		const s = await h.call("updateSession", { json: { sessionID: "nope", target: "L1" } });
		expect(s.status).toBe(400);
		expect(s.json.error).toBe("SESSION_NOT_FOUND");
		const t = await h.call("getTranslators", { json: {} });
		expect(t.status).toBe(404);
		expect(t.headers["X-Zotero-Version"]).toBeTruthy();
		const old = await h.call("saveItems", { json: { sessionID: "S9", items: [] }, headers: { "X-Zotero-Connector-API-Version": "2" } });
		expect(old.status).toBe(400);
		expect(old.json.error).toBe("CONNECTOR_VERSION_OUTDATED");
	});

	test("a response over 1 MB is chunked", async () => {
		const db = openDb(dbPath);
		const holder = (db.query("SELECT key FROM items WHERE parent_key IS NULL LIMIT 1").get() as { key: string }).key;
		const ins = db.prepare("INSERT OR IGNORE INTO item_tags(item_key, tag, type) VALUES(?, ?, 0)");
		db.transaction(() => {
			for (let i = 0; i < 30000; i++) ins.run(holder, `bulk-tag-${i}-${"x".repeat(30)}`);
		})();
		db.close(true);
		const sel = await h.call("getSelectedCollection", { json: {} });
		expect(sel.bytes.length).toBeGreaterThan(1_000_000);
		expect(sel.json.tags.L1.length).toBeGreaterThan(30000);
		expect(h.maxFrame).toBeLessThanOrEqual(1_000_000);
	});
});

describe("native host: concurrent writes with a running core server", () => {
	test("host saves while the app's server writes the same database", async () => {
		const dbPath = makeLibrary("concurrent");
		const PORT = 23138;
		const server = Bun.spawn(["bun", join(import.meta.dir, "../../core/src/server.ts"), "--db", dbPath, "--port", String(PORT)], { stdout: "ignore", stderr: "ignore" });
		const base = `http://127.0.0.1:${PORT}`;
		try {
			for (let i = 0; i < 100; i++) {
				try {
					if ((await fetch(`${base}/api/collections`)).ok) break;
				} catch {
					await Bun.sleep(100);
				}
			}
			const h = new HostClient({ ZN_DB: dbPath, ZNH_APP_PORT: String(PORT) });
			const N = 25;
			const before = openDb(dbPath);
			const base0 = {
				articles: count(before, "SELECT count(*) n FROM items WHERE item_type = 'journalArticle'"),
				atts: count(before, "SELECT count(*) n FROM attachments"),
				dirs: existsSync(join(ROOT, "concurrent", "storage")) ? readdirSync(join(ROOT, "concurrent", "storage")).length : 0,
			};
			before.close(true);
			const serverWrites = (async () => {
				for (let i = 0; i < N; i++) {
					const r = await fetch(`${base}/api/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { itemType: "book", title: `Server book ${i}` } }) });
					if (!r.ok) throw new Error(`server write ${i}: ${r.status} ${await r.text()}`);
				}
			})();
			const hostWrites = (async () => {
				for (let i = 0; i < N; i++) {
					const id = `c${i}`;
					const r = await h.call("saveItems", { json: { sessionID: `CC${i}`, items: [article(id, { attachments: [{ id: "a", title: "PDF", url: "https://x.test/a.pdf", mimeType: "application/pdf", parentItem: id }] })] } });
					if (r.status !== 201) throw new Error(`host write ${i}: ${r.status} ${r.text}`);
					const meta = JSON.stringify({ id: "a", url: "https://x.test/a.pdf", contentType: "application/pdf", parentItemID: id, title: "PDF" });
					const a = await h.call("saveAttachment", { bytes: fakePdf(20000 + i), headers: { "Content-Type": "application/pdf", "X-Metadata": meta }, query: `sessionID=CC${i}` });
					if (a.status !== 201) throw new Error(`host attachment ${i}: ${a.status} ${a.text}`);
				}
			})();
			await Promise.all([serverWrites, hostWrites]);
			await h.close();
			const db = openDb(dbPath);
			expect(count(db, "SELECT count(*) n FROM items WHERE title LIKE 'Server book %'")).toBe(N);
			expect(count(db, "SELECT count(*) n FROM items WHERE item_type = 'journalArticle'")).toBe(base0.articles + N);
			expect(count(db, "SELECT count(*) n FROM attachments")).toBe(base0.atts + N + 0);
			expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
			db.close(true);
			expect(readdirSync(join(ROOT, "concurrent", "storage")).length).toBe(base0.dirs + N);
		} finally {
			server.kill();
		}
	}, 120_000);
});
