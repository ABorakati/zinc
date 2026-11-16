// Web-facing hardening: the Zotero port refuses web pages, Better BibTeX refuses any browser, state-changing JSON-RPC is POST-only,
// auto-export targets are vetted, web-saved attachments cannot keep executable extensions, "open externally" refuses them, import only
// copies files from beside the import file, and citation keys stay inside their library. Nothing here listens on a real port.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setOpener } from "../../src/api";
import { addAutoExport, checkExportTarget } from "../../src/bbt/autoexport";
import { itemsForCitekey, getKeyInfo } from "../../src/bbt/keys";
import { attachmentFileName, storeWebAttachment } from "../../src/connector/attachments";
import { openDb } from "../../src/db";
import { importText } from "../../src/io/import";
import { isExecutableName, neutraliseExecutableName } from "../../src/io/dangerous";
import { handleZRequest } from "../../src/zport";
import { buildFixture, call, insertAttachment, insertItem, tempDir, type Fixture } from "../fixture";

const server = {} as Bun.Server<unknown>;
const BASE = "http://127.0.0.1:23119";
let db: Database;

beforeEach(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
	insertItem(db, {
		key: "AAAAAAA1",
		itemType: "journalArticle",
		title: "Deep learning for radiology",
		creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
		date: "2020-05-01",
		dateAdded: "2024-01-01T00:00:00Z",
	});
});
afterEach(() => db.close());

const z = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
	handleZRequest(new Request(BASE + path, { headers, ...init }), db, server);
const CONNECTOR = { "X-Zotero-Connector-API-Version": "3", "Content-Type": "application/json" };

describe("Zotero port origin policy", () => {
	test("a web page is refused even with the connector headers, and gets no CORS grant", async () => {
		const res = await z(
			"/connector/getSelectedCollection",
			{ ...CONNECTOR, Origin: "https://evil.example" },
			{ method: "POST", body: "{}" },
		);
		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("preflight from a web page or a sandboxed frame is refused", async () => {
		for (const origin of ["https://evil.example", "null", "http://localhost:3000"]) {
			const pre = await z("/connector/saveItems", { Origin: origin, "Access-Control-Request-Method": "POST" }, { method: "OPTIONS" });
			expect(pre.status).toBe(403);
			expect(pre.headers.get("access-control-allow-origin")).toBeNull();
		}
	});

	test("a cross-site fetch without Origin (img/script tag) is refused", async () => {
		expect((await z("/connector/ping", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" })).status).toBe(403);
	});

	test("the connector extension origins are accepted and reflected", async () => {
		for (const origin of ["chrome-extension://abcdefgh", "moz-extension://1234-5678", "safari-web-extension://AB-CD"]) {
			const res = await z("/connector/ping", { ...CONNECTOR, Origin: origin }, { method: "POST", body: "{}" });
			expect(res.status).toBe(200);
			expect(res.headers.get("access-control-allow-origin")).toBe(origin);
			const pre = await z("/connector/saveItems", { Origin: origin }, { method: "OPTIONS" });
			expect(pre.status).toBe(200);
			expect(pre.headers.get("access-control-allow-origin")).toBe(origin);
		}
	});

	test("programs without Origin keep working, and get no wildcard", async () => {
		const res = await z("/connector/ping", CONNECTOR, { method: "POST", body: "{}" });
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("opening /connector/ping in a tab (navigation) still works", async () => {
		const res = await z("/connector/ping", {
			"Sec-Fetch-Site": "cross-site",
			"Sec-Fetch-Mode": "navigate",
			"User-Agent": "Mozilla/5.0",
		});
		expect(res.status).toBe(200);
	});

	test("a rebinding Host is refused", async () => {
		expect((await z("/connector/ping", { Host: "evil.example:23119" })).status).toBe(403);
	});

	test("word-processor origins reach only the integration routes", async () => {
		const origin = "https://zotero.github.io";
		const pre = await z("/connector/document/execCommand", { Origin: origin }, { method: "OPTIONS" });
		expect(pre.status).toBe(200);
		expect(pre.headers.get("access-control-allow-origin")).toBe(origin);
		expect((await z("/connector/saveItems", { ...CONNECTOR, Origin: origin }, { method: "POST", body: "{}" })).status).toBe(403);
		expect((await z("/zotero-next/integration/dialogs", { Origin: origin })).status).toBe(403);
		expect((await z("/connector/document/execCommand", { Origin: "https://evil.example" }, { method: "OPTIONS" })).status).toBe(403);
	});
});

describe("Better BibTeX endpoints", () => {
	const rpcBody = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
	const post = (body: string, headers: Record<string, string> = {}) =>
		z("/better-bibtex/json-rpc", { "Content-Type": "application/json", ...headers }, { method: "POST", body });

	test("any Origin (even null or an extension) and cross-site fetches are refused", async () => {
		const browserHeaders: Record<string, string>[] = [
			{ Origin: "null" },
			{ Origin: "https://evil.example" },
			{ Origin: "chrome-extension://abc" },
			{ "Sec-Fetch-Site": "cross-site" },
			{ "Sec-Fetch-Site": "same-site" },
		];
		for (const h of browserHeaders) {
			expect((await z("/better-bibtex/cayw?probe", h)).status).toBe(403);
		}
		expect((await z("/better-bibtex/cayw?probe")).status).toBe(200); // editors and CLIs
		expect((await z("/better-bibtex/cayw?probe", { "Sec-Fetch-Site": "none" })).status).toBe(200); // typed into the address bar
	});

	test("state-changing JSON-RPC cannot be run by GET", async () => {
		const dir = tempDir();
		const target = join(dir, "pwn.bib");
		const q = encodeURIComponent(rpcBody("autoexport.add", ["/Thesis", "betterbibtex", target, {}, true]));
		const res = await z(`/better-bibtex/json-rpc?${q}`);
		const body = (await res.json()) as any;
		expect(body.error?.message).toContain("POST");
		expect(existsSync(target)).toBe(false);
		const batch = await z(
			`/better-bibtex/json-rpc?${encodeURIComponent(JSON.stringify([JSON.parse(rpcBody("collection.scanAUX", ["/x", "a.aux"]))]))}`,
		);
		expect(((await batch.json()) as any)[0].error.message).toContain("POST");
	});

	test("state-changing JSON-RPC needs a JSON content type on POST", async () => {
		const dir = tempDir();
		const body = rpcBody("autoexport.add", ["/Thesis", "betterbibtex", join(dir, "refs.bib"), {}, true]);
		expect((await post(body, { "Content-Type": "text/plain" })).status).toBe(415);
		expect((await post(body, { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
		const ok = (await (await post(body)).json()) as any;
		expect(ok.error).toBeUndefined();
		expect(existsSync(join(dir, "refs.bib"))).toBe(true);
	});

	test("read-only JSON-RPC still works over GET", async () => {
		const res = await z(`/better-bibtex/json-rpc?${encodeURIComponent(rpcBody("api.ready", []))}`);
		expect(res.status).toBe(200);
	});

	test("autoexport.add refuses scripts and system folders", async () => {
		const bad = (await (
			await post(rpcBody("autoexport.add", ["/", "betterbibtex", join(tempDir(), "startup.bat"), {}, true]))
		).json()) as any;
		expect(bad.error).toBeDefined();
	});
});

describe("auto-export targets", () => {
	const w = (s: string) => s.replaceAll("/", String.fromCharCode(92));
	// The target rules are Windows path rules (drive letters, UNC, device names, streams); other platforms read these strings as relative names.
	test.skipIf(process.platform !== "win32")("system folders, UNC and device paths, odd extensions and streams are refused", () => {
		expect(() => checkExportTarget(w("C:/Windows/System32/refs.bib"))).toThrow("system");
		expect(() => checkExportTarget(w("C:/Users/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/r.bib"))).toThrow(
			"startup",
		);
		expect(() => checkExportTarget(w("//server/share/refs.bib"))).toThrow("network");
		expect(() => checkExportTarget(w("//./pipe/refs.bib"))).toThrow("network");
		expect(() => checkExportTarget(w("C:/Users/x/run.bat"))).toThrow("must end in");
		expect(() => checkExportTarget(w("C:/Users/x/refs.bib") + ":stream")).toThrow("invalid");
		expect(checkExportTarget(join(tempDir(), "refs.bib"))).toContain("refs.bib");
	});

	test("an existing file that is not a bibliography is not overwritten; an existing .bib is", () => {
		const dir = tempDir();
		const cfg = join(dir, "notes.txt");
		writeFileSync(cfg, "my precious notes");
		const ae = addAutoExport(db, { path: cfg, format: "betterbibtex", scope: { type: "library" } });
		expect(ae.status).toBe("error");
		expect(readFileSync(cfg, "utf8")).toBe("my precious notes");
		const bib = join(dir, "old.bib");
		writeFileSync(bib, "@article{old, title={Old}}");
		expect(addAutoExport(db, { path: bib, format: "betterbibtex", scope: { type: "library" } }).status).toBe("done");
	});
});

describe("executable attachments", () => {
	test("executable and script names are recognised and neutralised", () => {
		for (const n of ["setup.exe", "run.BAT", "x.hta", "a.vbs", "a.js", "evil.lnk", "x.exe.", "m.docm", "s.ps1"])
			expect(isExecutableName(n)).toBe(true);
		for (const n of ["paper.pdf", "notes.txt", "page.html", "image.png", "data.json"]) expect(isExecutableName(n)).toBe(false);
		expect(neutraliseExecutableName("setup.exe")).toBe("setup.exe.txt");
		expect(neutraliseExecutableName("paper.pdf")).toBe("paper.pdf");
		expect(
			attachmentFileName({ title: "Tool", url: "https://x.example/download/tool.hta", contentType: "application/octet-stream" }),
		).toBe("Tool.hta.txt");
	});

	test("a web-saved executable is stored with a harmless name", () => {
		const key = storeWebAttachment(db, {
			parentKey: "AAAAAAA1",
			bytes: new TextEncoder().encode("MZ..."),
			url: "https://x.example/a/payload.exe",
			contentType: "application/octet-stream",
		});
		const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string | null };
		expect(row.path ?? "").not.toMatch(/\.exe$/i);
		expect(row.path ?? "").toMatch(/\.txt$/i);
		const key2 = storeWebAttachment(db, {
			parentKey: "AAAAAAA1",
			bytes: new TextEncoder().encode("x"),
			url: "https://x.example/a",
			contentType: "application/octet-stream",
			filename: "run.cmd",
		});
		expect((db.query("SELECT path FROM attachments WHERE item_key = ?").get(key2) as { path: string }).path).toMatch(/\.cmd\.txt$/);
	});
});

describe("open externally", () => {
	let fx: Fixture;
	const opened: string[] = [];
	beforeEach(() => {
		fx = buildFixture();
		opened.length = 0;
		setOpener({
			reveal: (p) => opened.push(`reveal:${p}`),
			openFile: (p) => opened.push(`file:${p}`),
			openUrl: (u) => opened.push(`url:${u}`),
		});
	});
	afterEach(() => setOpener());

	test("an executable is not launched without an explicit confirm", async () => {
		const exe = join(tempDir(), "tool.bat");
		writeFileSync(exe, "echo hi");
		insertAttachment(fx.db, "ATTEXE01", "AAAAAAA1", "application/octet-stream", exe);
		const refused = await call(fx.db, "POST", "/api/attachments/ATTEXE01/open-external");
		expect(refused.status).toBe(409);
		expect(opened).toEqual([]);
		expect((await call(fx.db, "POST", "/api/attachments/ATTEXE01/open-external", { confirm: true })).status).toBe(200);
		expect(opened).toEqual([`file:${exe}`]);
	});

	test("reveal is always allowed; a PDF opens as before", async () => {
		expect((await call(fx.db, "POST", "/api/attachments/ATT00002/open-external")).status).toBe(200);
		expect(opened).toEqual([`file:${fx.pdfPath}`]);
	});
});

describe("import attachments", () => {
	const rdf = (file: string) => `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#" xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:link="http://purl.org/rss/1.0/modules/link/" xmlns:z="http://www.zotero.org/namespaces/export#">
  <bib:Article rdf:about="#item_1"><z:itemType>journalArticle</z:itemType><dc:title>T one</dc:title>
    <link:link><z:Attachment><z:path>${file}</z:path><dc:title>PDF</dc:title><link:type>application/pdf</link:type></z:Attachment></link:link>
  </bib:Article>
</rdf:RDF>`;
	test("only files inside the import folder are copied", () => {
		const base = tempDir();
		const outside = tempDir();
		writeFileSync(join(base, "inside.pdf"), "%PDF-1.4 inside");
		writeFileSync(join(outside, "secret.pdf"), "%PDF-1.4 secret");
		mkdirSync(join(base, "sub"), { recursive: true });
		writeFileSync(join(base, "sub", "deep.pdf"), "%PDF-1.4 deep");

		const run = (file: string, basePath: string | undefined) => {
			const d = openDb(join(tempDir(), "i.sqlite"));
			const r = importText(d, { text: rdf(file), format: "rdf", basePath, collectionName: null } as any);
			d.close();
			return r;
		};
		expect(run("inside.pdf", base).attachments).toBe(1);
		expect(run("sub/deep.pdf", base).attachments).toBe(1);
		expect(run(join(base, "inside.pdf").replaceAll(String.fromCharCode(92), "/"), base).attachments).toBe(1);

		const abs = run(join(outside, "secret.pdf").replaceAll(String.fromCharCode(92), "/"), base);
		expect(abs.attachments).toBe(0);
		expect(abs.errors.join("\n")).toContain("outside the folder");
		expect(run("../" + outside.split(/[\\/]/).pop() + "/secret.pdf", base).attachments).toBe(0);
		expect(run("file:///" + join(outside, "secret.pdf").replaceAll(String.fromCharCode(92), "/"), base).attachments).toBe(0);
		expect(run(join(outside, "secret.pdf").replaceAll(String.fromCharCode(92), "/"), undefined).attachments).toBe(0);
		expect(run("//server/share/x.pdf", base).attachments).toBe(0);
	});
});

describe("citation keys per library", () => {
	test("the same key in another library neither forces a postfix nor leaks into lookups", () => {
		db.query("INSERT OR IGNORE INTO libraries(id, type, name) VALUES(2, 'group', 'G')").run();
		insertItem(db, {
			key: "GGGGGGG1",
			itemType: "journalArticle",
			title: "Deep learning for radiology",
			creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
			date: "2020-05-01",
			dateAdded: "2024-02-01T00:00:00Z",
		});
		db.query("UPDATE items SET library_id = 2 WHERE key = 'GGGGGGG1'").run();
		const mine = getKeyInfo(db, "AAAAAAA1")!.key;
		const theirs = getKeyInfo(db, "GGGGGGG1")!.key;
		expect(theirs).toBe(mine);
		expect(itemsForCitekey(db, mine)).toEqual(["AAAAAAA1"]);
		expect(itemsForCitekey(db, mine, 2)).toEqual(["GGGGGGG1"]);
	});

	test("a read-only connection does not write key rows", () => {
		const path = join(tempDir(), "ro.sqlite");
		const w = openDb(path);
		insertItem(w, {
			key: "RRRRRRR1",
			itemType: "book",
			title: "Read only",
			creators: [{ creatorType: "author", lastName: "Doe" }],
			date: "2019",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		w.close();
		const { Database } = require("bun:sqlite");
		const ro = new Database(path, { readonly: true });
		expect(() => getKeyInfo(ro, "RRRRRRR1")).not.toThrow();
		ro.close();
		const q = new Database(path);
		q.exec("PRAGMA query_only = ON");
		expect(() => getKeyInfo(q, "RRRRRRR1")).not.toThrow();
		q.close();
	});
});
