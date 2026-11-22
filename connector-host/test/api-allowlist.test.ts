// The allow-list of the `api` host method (src/api.ts), run in this process against a throw-away library: the real forwardApi and the
// core's real handleApi, with the core's opener replaced by a stub so nothing is launched.
//   1. every call the library page and the reader tab make is let through (the table below is read from gpui-ui/src, gpui-ui/web
//      and reader-host/src; a call missing here is a feature that breaks);
//   2. every route that acts on this computer, or holds credentials or settings, is refused in every spelling, with no effect;
//   3. a write that could name a file or folder here is refused at any depth and in any content type, and one whose body cannot be
//      read is refused too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooks } from "../../core/src/additems/files";
import { setOpener } from "../../core/src/api";
import * as repo from "../../core/src/db";
import { ROUTES, apiRefusal, checkBody, forwardApi, localPathField, resolveApi } from "../src/api";

const ROOT = mkdtempSync(join(tmpdir(), "znh-allow-"));
const dbPath = join(ROOT, "library.sqlite");
const secret = join(ROOT, "secret.txt");
const outDir = join(ROOT, "out");
const opened: string[] = [];
let db: ReturnType<typeof repo.openDb>;
let itemKey = "";
let collKey = "";
let pdfKey = "";
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

beforeAll(() => {
	hooks.afterImport = () => {}; // no full-text extraction of what the tests add
	setOpener({
		reveal: (p) => void opened.push(`reveal ${p}`),
		openFile: (p) => void opened.push(`openFile ${p}`),
		openUrl: (u) => void opened.push(`openUrl ${u}`),
	});
	writeFileSync(secret, "secret");
	mkdirSync(outDir);
	db = repo.openDb(dbPath);
	collKey = repo.createCollection(db, "Fixture collection").key;
	itemKey = repo.createItem(db, { itemType: "journalArticle", title: "Fixture article", date: "2024" } as never).data.key;
	const pdf = join(ROOT, "source.pdf");
	writeFileSync(pdf, PDF);
	const { addFile } = require("../../core/src/additems/files") as typeof import("../../core/src/additems/files");
	pdfKey = addFile(db, { mode: "imported_file", path: pdf, name: "Fixture.pdf", contentType: "application/pdf", parentKey: itemKey } as never)
		.data.key;
});

afterAll(() => {
	setOpener();
	db.close(true);
	try {
		rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* Windows may hold the WAL a moment */
	}
});

interface Answer {
	status: number;
	json: any;
	text: string;
	headers: Record<string, string>;
}
async function call(method: string, path: string, body?: unknown, type = "application/json"): Promise<Answer> {
	const headers = new Headers();
	let init: BodyInit | undefined;
	if (body instanceof FormData) init = body;
	else if (body !== undefined) {
		headers.set("Content-Type", type);
		init = typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
	}
	const r = await forwardApi(() => db, { http: method, path, headers, body: init });
	const text = new TextDecoder().decode(r.body);
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	return { status: r.status, json, text, headers: r.headers };
}
const REFUSED = [400, 403, 405];
const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
const K = "ABCD1234";

// ---------------------------------------------------------------------------------------------------------------------
// What the pages call. [method, path as sent (with its query), body]. Sources: gpui-ui/src/api.ts, itempane/net.ts, sidebar/client.ts,
// features/*/client.ts and ops.ts, reader/*, wasmplugins/reader/annotations.ts, platform.web.ts (file fetcher), shell/*,
// reader-host/src/host.js and citations.js (the reader tab).
// ---------------------------------------------------------------------------------------------------------------------
type Call = [method: string, path: string, body?: unknown];
const cond = { field: "title", operator: "contains", value: "x" };
const opts = { match: "all", includeParentsAndChildren: false, searchSubcollections: false, topLevelOnly: false, includeTrash: false };
const CLIENT_CALLS: Call[] = [
	["GET", "/api/libraries"],
	["GET", "/api/schema"],
	["GET", "/api/tags"],
	["GET", "/api/tags?library=2"],
	["GET", "/api/tag-colors"],
	["PUT", "/api/tag-colors", [{ name: "t", color: "#fff", position: 0 }]],
	["GET", "/api/search?q=liver&limit=200&offset=0"],
	["GET", "/api/search?q=liver&limit=200&offset=0&library=2"],
	["GET", `/api/items?sort=title&dir=asc&limit=100&offset=0`],
	[
		"GET",
		`/api/items?library=2&collection=${K}&search=${K}&tag=a%20b&unfiled=1&publications=1&trash=1&qmode=fields&q=x%C3%A9&sort=title&dir=desc&then=dateAdded%3Adesc%2Ctitle%3Aasc&limit=50&offset=50&fields=title%2Cdate&include=creators%2Ctags`,
	],
	["GET", "/api/items?limit=1"],
	["POST", "/api/items", { data: { itemType: "note", parentItem: K, note: "<p></p>" } }],
	["POST", "/api/items", { data: { itemType: "journalArticle", collections: [K] }, library: 2 }],
	["POST", "/api/items", { data: { itemType: "attachment", linkMode: "linked_url", url: "https://example.org", parentItem: K } }],
	["GET", "/api/items/groups?by=itemType&dir=asc&collection=" + K],
	["GET", `/api/items/index?key=${K}&sort=title&dir=asc&then=title%3Aasc&q=x`],
	["GET", `/api/items/${K}`],
	["PATCH", `/api/items/${K}`, { data: { title: "x", date: "2020" } }],
	["PATCH", `/api/items/${K}`, { data: { deleted: 1 } }],
	["PATCH", `/api/items/${K}`, { data: { inPublications: true } }],
	["PATCH", `/api/items/${K}`, { data: { note: "<p>x</p>" } }],
	["PATCH", `/api/items/${K}`, { data: { tags: [{ tag: "a", type: 0 }] } }],
	["POST", `/api/items/${K}/duplicate`, {}],
	["POST", `/api/items/${K}/tags`, { tags: ["a"] }],
	["DELETE", `/api/items/${K}/tags`, { tags: ["a"] }],
	["POST", `/api/items/${K}/related`, { keys: [K] }],
	["DELETE", `/api/items/${K}/related`, { keys: [K] }],
	["GET", "/api/collections"],
	["GET", "/api/collections?library=2"],
	["POST", "/api/collections", { name: "c", parentKey: K, library: 2 }],
	["PATCH", `/api/collections/${K}`, { name: "d", parentKey: null }],
	["DELETE", `/api/collections/${K}`],
	["POST", `/api/collections/${K}/items`, { keys: [K] }],
	["DELETE", `/api/collections/${K}/items`, { keys: [K] }],
	["GET", "/api/searches"],
	["POST", "/api/searches", { name: "s", conditions: [cond], options: opts }],
	["GET", `/api/searches/${K}`],
	["PATCH", `/api/searches/${K}`, { name: "t", conditions: [cond], options: opts }],
	["DELETE", `/api/searches/${K}`],
	["POST", "/api/searches/run", { conditions: [cond], options: opts, limit: 100, offset: 0, sort: "title", dir: "asc" }],
	["GET", `/api/attachments/${K}/file`],
	["HEAD", `/api/attachments/${K}/file`],
	["PUT", `/api/attachments/${K}/file`, { dataBase64: "JVBERi0=", deletedPages: [0] }],
	["GET", `/api/attachments/${K}/annotations`],
	[
		"PUT",
		`/api/attachments/${K}/annotations`,
		[{ id: "ANNOTA01", type: "ink", color: "#ffd400", position: { pageIndex: 0, paths: [[1, 2, 3, 4]], width: 2 }, comment: "" }],
	],
	["DELETE", `/api/attachments/${K}/annotations`, { ids: ["ANNOTA01"] }],
	["GET", `/api/attachments/${K}/view-state`],
	["PUT", `/api/attachments/${K}/view-state`, { pageIndex: 3, scale: 1.2 }],
	["GET", "/api/ui/selection"],
	["POST", "/api/ui/selection", { kind: "collection", key: K }],
	["GET", "/api/duplicates?summary=1"],
	["GET", "/api/duplicates"],
	["GET", `/api/duplicates/set?keys=${K}%2C${K}`],
	["POST", "/api/duplicates/merge", { masterKey: K, otherKeys: [K], fieldChoices: { title: K } }],
	["POST", "/api/duplicates/not-duplicates", { keys: [K, K] }],
	["GET", "/api/maintenance/trash"],
	["GET", "/api/maintenance/tags/automatic?library=1"],
	["POST", "/api/maintenance/empty-trash", {}],
	["POST", "/api/maintenance/empty-trash", { olderThanDays: 30 }],
	["POST", "/api/maintenance/erase", { keys: [K] }],
	["POST", "/api/maintenance/erase/preview", { keys: [K] }],
	["POST", "/api/maintenance/tags/rename", { from: "a", to: "b", library: 1 }],
	["POST", "/api/maintenance/tags/delete", { tags: ["a"], library: 1 }],
	["POST", "/api/maintenance/tags/delete-automatic", { library: 1 }],
	["POST", "/api/maintenance/rename-files", { attachmentKeys: [K] }],
	["POST", "/api/add/identifier", { text: "10.1000/xyz", collectionKey: K, autoTag: true, library: 2 }],
	["POST", "/api/add/link", { library: 1, url: "https://example.org", title: "t", parentKey: K }],
	["POST", "/api/add/retrieve-metadata", { attachmentKeys: [K], rename: true, autoTag: true }],
	["POST", "/api/add/create-parent", { itemKey: K, text: "10.1000/xyz" }],
	["POST", "/api/add/create-parent", { itemKey: K, itemType: "book" }],
	["POST", "/api/add/file", { name: "x.pdf", library: 1, contentType: "application/pdf", dataBase64: "JVBERi0=", mode: "imported_file", parentKey: K }],
	["POST", "/api/io/import", { text: "TY  - JOUR\nER  - \n", format: "auto", collectionName: "x", autoTag: true }],
	["POST", "/api/io/import", { text: "x", format: "auto", collectionName: null, collectionKey: K }],
	["POST", "/api/io/export", { keys: [K], format: "ris", includeNotes: true }],
	["POST", "/api/io/export", { collectionKey: K, format: "bibtex" }],
	["POST", "/api/translate/web", { url: "https://example.org/a", collectionKey: K }],
	["POST", "/api/translate/web/select", { session: "s", keys: ["a"], collectionKey: K }],
	["POST", "/api/translate/import", { text: "x", collectionName: null, collectionKey: K }],
	["POST", "/api/translate/export", { translatorID: "x", keys: [K], includeNotes: true, displayOptions: { a: true } }],
	["GET", "/api/translate/import-formats"],
	["GET", "/api/translate/export-formats"],
	["GET", "/api/cite/settings"],
	["PUT", "/api/cite/settings", { quickCopy: { style: "apa", mode: "citation" } }],
	["GET", "/api/cite/styles?q=apa&format=author-date&field=medicine&installed=1&quick=1&limit=100&offset=100"],
	["POST", "/api/cite/styles/install", { id: "apa" }],
	["GET", `/api/cite/styles/preview?id=apa&items=${K}%2C${K}`],
	["DELETE", "/api/cite/styles/american-medical-association"],
	["POST", "/api/cite/format", { keys: [K], style: "apa", locale: "en-US", mode: "bibliography", format: ["html", "text"] }],
	["GET", `/api/references/${K}`],
	["GET", `/api/references/${K}?refresh=1`],
	["GET", "/api/references/lookup?doi=10.1000%2Fxyz"],
	["GET", "/api/references/lookup?title=A%20title"],
	["POST", "/api/references/add", { doi: "10.1000/xyz", reference: { title: "t", doi: "10.1000/xyz" }, collectionKey: K, findFullText: true }],
	["POST", "/api/fulltext/find", { keys: [K], openAccessOnly: false }],
	["GET", "/api/fulltext/jobs/123e4567-e89b-12d3-a456-426614174000"],
	["POST", "/api/fulltext/jobs/123e4567-e89b-12d3-a456-426614174000/cancel", {}],
	["GET", "/api/bbt/settings"],
	["POST", "/api/bbt/settings", { patch: { citekeyFormat: "auth + year" } }],
	["POST", "/api/bbt/formula", { formula: "auth", itemKey: K }],
	["GET", `/api/bbt/keys?items=${K}%2C${K}`],
	["POST", "/api/bbt/pin", { itemKey: K, key: "k" }],
	["POST", "/api/bbt/unpin", { itemKey: K }],
	["POST", "/api/bbt/refresh", { items: [K] }],
	["POST", "/api/bbt/cite", { items: [K], format: "latex", command: "cite" }],
];

describe("what the library page and the reader tab call is let through", () => {
	test.each(CLIENT_CALLS.map((c, i) => [i, `${c[0]} ${c[1]}`, c] as const))("%#: %s", async (_i, _name, [method, path, body]) => {
		const r = resolveApi(method, path);
		expect("error" in r ? r.error : null).toBeNull();
		if (!("error" in r) && method !== "GET" && method !== "HEAD" && r.rule.body !== "none" && body !== undefined) {
			expect(await checkBody(r.rule, new TextEncoder().encode(JSON.stringify(body)), "application/json")).toMatchObject({
				contentType: "application/json",
			});
		}
	});

	test("the answers are the core's: reads, edits, annotations, view state, uploads, text import and export", async () => {
		const list = await call("GET", "/api/items?sort=title&dir=asc&limit=100");
		expect(list.status).toBe(200);
		expect(list.json.total).toBe(1);
		expect((await call("GET", `/api/items/${itemKey}`)).json.data.title).toBe("Fixture article");
		expect((await call("PATCH", `/api/items/${itemKey}`, { data: { title: "Edited" } })).status).toBe(200);
		expect((await call("POST", `/api/items/${itemKey}/tags`, { tags: ["t"] })).status).toBe(200);
		const made = await call("POST", "/api/collections", { name: "Made" });
		expect(made.status).toBe(201);
		expect((await call("POST", `/api/collections/${made.json.key}/items`, { keys: [itemKey] })).status).toBe(200);
		expect((await call("DELETE", `/api/collections/${made.json.key}/items`, { keys: [itemKey] })).status).toBe(200);
		expect((await call("DELETE", `/api/collections/${made.json.key}`)).status).toBe(200);
		expect((await call("GET", "/api/collections")).json.length).toBe(1);
		expect((await call("GET", `/api/items/index?key=${itemKey}&sort=title&dir=asc`)).json.index).toBe(0);
		expect((await call("GET", "/api/items/groups?by=itemType&dir=asc")).status).toBe(200);
		expect((await call("GET", "/api/libraries")).status).toBe(200);
		expect((await call("GET", "/api/schema")).status).toBe(200);
		expect((await call("GET", "/api/tags")).json[0].tag).toBe("t");
		expect((await call("PUT", "/api/tag-colors", [{ name: "t", color: "#ff0000", position: 0 }])).status).toBe(200);
		expect((await call("GET", "/api/search?q=Edited&limit=10&offset=0")).status).toBe(200);
		const s = await call("POST", "/api/searches", { name: "S", conditions: [cond], options: opts });
		expect(s.status).toBe(201);
		expect((await call("POST", "/api/searches/run", { conditions: [cond], options: opts, limit: 10, offset: 0 })).status).toBe(200);
		expect((await call("PATCH", `/api/searches/${s.json.key}`, { name: "S2" })).status).toBe(200);
		expect((await call("DELETE", `/api/searches/${s.json.key}`)).status).toBe(200);
		expect((await call("GET", "/api/duplicates?summary=1")).status).toBe(200);
		expect((await call("GET", "/api/maintenance/trash")).status).toBe(200);
		expect((await call("GET", "/api/cite/settings")).status).toBe(200);
		expect((await call("POST", "/api/ui/selection", { kind: "collection", key: collKey })).json.ok).toBe(true);
		expect((await call("GET", "/api/ui/selection")).json.selection.key).toBe(collKey);

		const ann = { id: "ANNOTA01", type: "ink", color: "#ffd400", sortIndex: "00000|000100|00072", position: { pageIndex: 0, paths: [[1, 2, 3, 4]], width: 2 }, text: "", comment: "c", pageLabel: "1", dateModified: new Date().toISOString() };
		expect((await call("PUT", `/api/attachments/${pdfKey}/annotations`, [ann])).status).toBe(200);
		expect((await call("GET", `/api/attachments/${pdfKey}/annotations`)).json[0].comment).toBe("c");
		expect((await call("DELETE", `/api/attachments/${pdfKey}/annotations`, { ids: ["ANNOTA01"] })).status).toBe(200);
		expect((await call("PUT", `/api/attachments/${pdfKey}/view-state`, { pageIndex: 3 })).status).toBe(200);
		expect((await call("GET", `/api/attachments/${pdfKey}/view-state`)).json.pageIndex).toBe(3);

		const file = await call("GET", `/api/attachments/${pdfKey}/file`);
		expect(file.status).toBe(200);
		expect(file.text.startsWith("%PDF-")).toBe(true);
		expect((await call("HEAD", `/api/attachments/${pdfKey}/file`)).text).toBe("");
		const next = new TextEncoder().encode("%PDF-1.7\nreplaced\n%%EOF\n");
		expect((await call("PUT", `/api/attachments/${pdfKey}/file`, { dataBase64: b64(next) })).status).toBe(200);
		expect((await call("GET", `/api/attachments/${pdfKey}/file`)).text).toContain("replaced");

		// uploaded bytes, as JSON and as a multipart `file`
		const up = await call("POST", "/api/add/file", { name: "note.txt", contentType: "text/plain", dataBase64: b64(new TextEncoder().encode("hi")), mode: "imported_file", parentKey: itemKey });
		expect(up.status).toBe(201);
		const form = new FormData();
		form.append("file", new Blob(["multipart bytes"], { type: "text/plain" }), "m.txt");
		form.append("mode", "imported_file");
		form.append("parentKey", itemKey);
		const mp = await call("POST", "/api/add/file", form);
		expect(mp.status).toBe(201);
		expect(mp.json.data.filename).toBe("m.txt");

		// text in, text out
		const ris = "TY  - JOUR\nTI  - Imported\nPY  - 2025\nER  - \n";
		expect((await call("POST", "/api/io/import", { text: ris, format: "ris", collectionName: null })).json.created).toBe(1);
		expect((await call("POST", "/api/io/export", { keys: [itemKey], format: "ris" })).json.text).toContain("Edited");
		expect((await call("POST", `/api/items/${itemKey}/duplicate`, {})).status).toBe(201);
		expect((await call("POST", "/api/bbt/formula", { formula: "auth + year" })).status).toBe(200);
		expect((await call("GET", "/api/bbt/settings")).status).toBe(200);
		expect(opened).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// What is refused. Each is a route of the core (read in core/src/api.ts and the feature handlers), with a body where it takes one.
// ---------------------------------------------------------------------------------------------------------------------
const DANGEROUS: Call[] = [
	["POST", "/api/open-url", { url: "https://example.org" }],
	["POST", "/api/ui/reveal", { key: K }],
	["POST", `/api/attachments/${K}/reveal`, {}],
	["POST", `/api/attachments/${K}/open-external`, {}],
	["POST", `/api/attachments/${K}/open-external?confirm=1`, { confirm: true }],
	["GET", "/api/files/settings"],
	["GET", "/api/files/zotero"],
	["PUT", "/api/files/zotero", { dir: "C:\\x" }],
	["POST", "/api/files/zotero/validate", { dir: "C:\\x" }],
	["PUT", "/api/files/base-dir", { mode: "custom", path: "C:\\x" }],
	["POST", "/api/files/base-dir/convert", { direction: "relative" }],
	["PUT", "/api/files/storage", { mode: "custom" }],
	["POST", "/api/files/storage/preset", { dir: "C:\\x" }],
	["POST", "/api/files/storage/move", { confirm: true }],
	["POST", "/api/files/organize", { action: "move", keys: [K], dir: "C:\\x" }],
	["POST", "/api/files/attach-newest", { parentKey: K }],
	["GET", "/api/io/mendeley"],
	["POST", "/api/io/mendeley", {}],
	["GET", "/api/sync/status"],
	["POST", "/api/sync/now", {}],
	["GET", "/api/websync/status"],
	["POST", "/api/websync/start", {}],
	["GET", "/api/integrations"],
	["POST", "/api/integrations/chrome/open?browser=chrome", {}],
	["POST", "/api/integrations/word/install", {}],
	["GET", "/api/bbt/autoexports"],
	["POST", "/api/bbt/autoexports", { path: join(outDir, "auto.bib"), format: "bibtex" }],
	["POST", "/api/bbt/autoexports/remove", { id: 1 }],
	["POST", "/api/bbt/autoexports/run", { id: 1 }],
	["GET", "/api/fulltext/settings"],
	["PUT", "/api/fulltext/settings", { unpaywallEmail: "a@b.co" }],
	["POST", "/api/fulltext/sign-in", {}],
	["GET", "/api/fulltext/sign-in/status"],
	["GET", "/api/fulltext/institutions?q=x"],
	["GET", "/api/fulltext/jobs/abc/events"],
	["GET", "/api/translate/status"],
	["GET", "/api/cite/locales/en-US"],
	["GET", "/api/cite/styles/apa"],
	["POST", "/api/items/by-uri", { uris: [] }],
	["GET", "/api/changes?since=0"],
	["GET", "/api/changes/head"],
	["GET", "/api/changes/stream"],
	["POST", "/api/batch", { changes: [] }],
	["GET", "/api/plugin-prefs/a/b"],
	["PUT", "/api/plugin-prefs/a/b", { tag: "x" }],
	["GET", "/api"],
	["GET", "/api/"],
	["GET", "/api/no-such-route"],
	["GET", "/connector/ping"],
];

/** The same request path in the spellings the core and a plain prefix test can read differently. */
function spellings(p: string): string[] {
	const rest = p.slice("/api/".length);
	if (!rest) return [p];
	const segs = rest.split("/");
	const last = segs[segs.length - 1]!;
	const hex = (s: string) => [...s].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
	const withLast = (l: string) => "/api/" + [...segs.slice(0, -1), l].join("/");
	return [
		p,
		p + "/",
		p + "//",
		p + "/.",
		"/api//" + rest,
		"//api/" + rest,
		"/api/./" + rest,
		"/api/x/../" + rest,
		"/api/%2e%2e/" + rest,
		"/api/%2E/" + rest,
		"/api/" + rest.replace(/\//g, "/./"),
		withLast(hex(last[0]!) + last.slice(1)),
		withLast(hex(last[0]!).toUpperCase() + last.slice(1)),
		withLast(hex(last)),
		withLast(last + "%2F"),
		withLast(last + "%5C"),
		withLast(last + "%00"),
		withLast(last + "%2e"),
		withLast(last + ";x"),
		withLast("%25" + hex(last[0]!).slice(1) + last.slice(1)),
		"/api%2F" + rest,
		"/api\\" + rest,
		"\\api\\" + rest,
		"/api/" + segs.join("\\"),
		p + "\u0000",
		p + " ",
		" " + p,
		p + "?path=C%3A%5Cx",
		p + "?dir=C%3A%5Cx&basePath=C%3A%5Cx",
		p + "#frag",
		"/API/" + rest,
		"/api/" + rest.toUpperCase(),
		"http://127.0.0.1" + p,
	];
}

const METHOD_SPECIFIC = new Set(["GET /api/cite/styles/apa"]); // DELETE of the same path is listed
/** What a closed route looks like: the ones that act on this computer, hold credentials or settings, or write a path. */
const CLOSED =
	/^\/api\/(open-url|ui\/reveal|files(\/|$)|sync(\/|$)|websync(\/|$)|integrations|io\/mendeley|bbt\/autoexports|fulltext\/(settings|sign-in|institutions)|fulltext\/jobs\/[^/]+\/events|translate\/status|changes|batch|attachments\/[^/]+\/(reveal|open-external))/;

/** The routes the handlers of the core document in their header comments ("//   GET|PUT /api/x/:key ..."), read from the sources. */
function documentedCoreRoutes(): { methods: string[]; path: string }[] {
	const out: { methods: string[]; path: string }[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.ts$/.test(e.name) && !/\.test\./.test(e.name)) {
				for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
					const m =
						/^\s*\/\/\s*(?:[-*]\s*)?((?:GET|POST|PUT|PATCH|DELETE|HEAD)(?:\s*[|,/]\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD))*)\s+(\/api\/[A-Za-z0-9_\-/:.<>]*)/.exec(
							line,
						);
					if (!m) continue;
					const path = m[2]!.replace(/:\w+|<\w+>/g, "ABCD1234").replace(/\/+$/, "") || "/api";
					out.push({ methods: m[1]!.split(/[^A-Z]+/).filter(Boolean), path });
				}
			}
		}
	};
	walk(join(import.meta.dir, "..", "..", "core", "src"));
	return out;
}

describe("routes that act on this computer, and credentials and settings, are refused in every spelling", () => {
	test("none of them is listed, in any spelling (the method of the entry; every method for the ones with no listed path)", () => {
		for (const [method, path] of DANGEROUS) {
			const bare = path.split("?")[0]!;
			const methods = METHOD_SPECIFIC.has(`${method} ${bare}`) ? [method] : ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
			for (const s of path.startsWith("/api/") ? spellings(bare) : [path]) {
				for (const m of methods) expect([m, s, "error" in resolveApi(m, s)]).toEqual([m, s, true]);
			}
		}
	});

	test("sent through the host: refused before the core, with no effect on this computer", async () => {
		const items = count("SELECT count(*) n FROM items");
		const atts = count("SELECT count(*) n FROM attachments");
		const files = readdirSync(ROOT).sort();
		for (const [method, path, body] of DANGEROUS) {
			const bare = path.split("?")[0]!;
			for (const s of path.startsWith("/api/") ? spellings(bare) : [path]) {
				const r = await call(method, s, body);
				expect([method, s, REFUSED.includes(r.status), typeof r.json?.error]).toEqual([method, s, true, "string"]);
			}
		}
		expect(opened).toEqual([]);
		expect(count("SELECT count(*) n FROM items")).toBe(items);
		expect(count("SELECT count(*) n FROM attachments")).toBe(atts);
		expect(readdirSync(ROOT).sort()).toEqual(files);
		expect(readdirSync(outDir)).toEqual([]);
		expect(readFileSync(secret, "utf8")).toBe("secret");
	});

	test("every route the core documents under a closed prefix is refused, for every method it documents", () => {
		const documented = documentedCoreRoutes();
		expect(documented.length).toBeGreaterThan(60);
		let closed = 0;
		for (const { methods, path } of documented) {
			if (!CLOSED.test(path)) continue;
			closed++;
			for (const m of methods) expect([m, path, "error" in resolveApi(m, path)]).toEqual([m, path, true]);
		}
		expect(closed).toBeGreaterThan(25);
	});

	test("every route that is listed is one the pages call, and every documented route that is listed is among them", () => {
		const used = new Set<string>();
		for (const [method, path] of CLIENT_CALLS) {
			const r = resolveApi(method, path);
			if (!("error" in r)) used.add(`${method} ${r.rule.path}`);
		}
		for (const rule of ROUTES) for (const m of rule.methods) expect([m, rule.path, used.has(`${m} ${rule.path}`)]).toEqual([m, rule.path, true]);
		for (const { methods, path } of documentedCoreRoutes()) {
			for (const m of methods) {
				const r = resolveApi(m, path);
				if (!("error" in r)) expect([m, path, used.has(`${m} ${r.rule.path}`)]).toEqual([m, path, true]);
			}
		}
	});

	test("the three that were reachable before: a trailing slash, an encoded letter, a local-path add", async () => {
		const atts = count("SELECT count(*) n FROM attachments");
		expect((await call("POST", "/api/open-url/", { url: "https://example.org" })).status).toBe(400);
		expect((await call("POST", "/api/%6Fpen-url", { url: "https://example.org" })).status).toBe(403);
		expect((await call("POST", "/api/add/file/", { name: "x", path: secret, mode: "linked_file" })).status).toBe(400);
		expect((await call("POST", "/api/add/%66ile", { name: "x", path: secret, mode: "linked_file" })).status).toBe(403);
		expect((await call("POST", "/api/bbt/autoexports", { path: join(outDir, "a.bib"), format: "bibtex" })).status).toBe(403);
		expect((await call("GET", "/api/files/settings")).status).toBe(403);
		expect(existsSync(join(outDir, "a.bib"))).toBe(false);
		expect(opened).toEqual([]);
		expect(count("SELECT count(*) n FROM attachments")).toBe(atts);
	});
});

describe("the request the core sees is the one that was checked", () => {
	test("a spelling that means a listed route reaches the core as that route", () => {
		for (const s of ["/api/%69tems", "/api/items?limit=%31", "/api/items/ABCD1234"]) {
			const r = resolveApi("GET", s);
			expect("error" in r).toBe(false);
		}
		const r = resolveApi("GET", "/api/%69tems?q=a+b&limit=%31");
		expect(r).toMatchObject({ url: "http://127.0.0.1/api/items?q=a+b&limit=1" });
		expect(resolveApi("GET", "/api/items/ABCD1234")).toMatchObject({ url: "http://127.0.0.1/api/items/ABCD1234" });
	});

	test("these are malformed, not canonicalised: empty segment, trailing slash, dot segment, encoded or raw slash and backslash, NUL, bad escape", () => {
		for (const s of [
			"/api//items",
			"/api/items/",
			"/api/items//",
			"/api/./items",
			"/api/items/.",
			"/api/%2e/items",
			"/api/items/%2e%2e",
			"/api/x/%2E%2E/items",
			"/api/items%2FABCD1234",
			"/api/items%5CABCD1234",
			"/api\\items",
			"/api/items\\ABCD1234",
			"/api/items%00",
			"/api/items\u0000",
			"/api/items/%zz",
			"/api/items/%",
			"/api/items/%E0%A4%A",
			"/api/items#x",
			"/api/ite ms",
			"/api/itéms",
			"api/items",
			"/apix/items",
		]) {
			expect(resolveApi("GET", s)).toMatchObject({ status: 400 });
		}
	});

	test("a query parameter the route does not take, a repeated one, and a malformed one are refused", () => {
		expect(resolveApi("GET", "/api/items?path=C%3A%5Cx")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", "/api/items?limit=1&limit=2")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", "/api/items?limit=%zz")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", "/api/items?limit=%00")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", "/api/items?=1")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", `/api/items/${K}?x=1`)).toMatchObject({ status: 400 });
		expect(resolveApi("POST", "/api/ui/selection?x=1")).toMatchObject({ status: 400 });
	});

	test("a listed path with another method is 405, an unlisted one 403, a non-/api path 400", () => {
		expect(resolveApi("POST", `/api/attachments/${K}/annotations`)).toMatchObject({ status: 405 });
		expect(resolveApi("DELETE", "/api/items")).toMatchObject({ status: 405 });
		expect(resolveApi("HEAD", "/api/items")).toMatchObject({ status: 405 });
		expect(resolveApi("GET", "/api/open-url")).toMatchObject({ status: 403 });
		expect(resolveApi("GET", "/connector/ping")).toMatchObject({ status: 400 });
		expect(resolveApi("GET", undefined)).toMatchObject({ status: 400 });
		expect(apiRefusal("get", "/api/items")).toBeNull();
	});

	test("keys and ids are matched strictly", () => {
		for (const bad of ["a b", "a.b", "a-b", "ABCD1234ABCD1234ABCD1234ABCD1234X", "%41%2eB"]) {
			expect(resolveApi("GET", `/api/items/${bad.replace(" ", "%20")}`)).toMatchObject({ status: 403 });
		}
		expect(resolveApi("DELETE", "/api/cite/styles/..%2Fapa")).toMatchObject({ status: 400 });
		expect(resolveApi("DELETE", "/api/cite/styles/a..b")).not.toHaveProperty("status");
		expect(resolveApi("DELETE", "/api/cite/styles/.hidden")).toMatchObject({ status: 403 });
	});

	test("the core is given the canonical request: a spelling of a listed route is answered as that route, the body as it was sent", async () => {
		const list = await call("GET", "/api/%69tems?limit=%31&sort=title&dir=asc");
		expect(list.status).toBe(200);
		expect(list.json.items.length).toBe(1);
		expect((await call("GET", `/api/%69tems/${itemKey}`)).json.data.key).toBe(itemKey);
		// the declared type is not what makes the core read JSON: the same bytes, parsed here and there
		const r = await call("PATCH", `/api/items/${itemKey}`, '{"data":{"title":"Same bytes"}}', "text/plain");
		expect(r.status).toBe(200);
		expect((await call("GET", `/api/items/${itemKey}`)).json.data.title).toBe("Same bytes");
	});
});

describe("a write that could name a file or folder here is refused, at any depth and in any content type", () => {
	const file = secret;
	const bodies: [string, unknown][] = [
		["path", { name: "x", path: file }],
		["Path (case)", { name: "x", Path: file }],
		["base_path", { text: "x", base_path: ROOT }],
		["basePath", { text: "x", basePath: ROOT }],
		["dir", { format: "ris", dir: ROOT }],
		["localPath", { localPath: file }],
		["filePath", { filePath: file }],
		["folder", { folder: ROOT }],
		["directory", { directory: ROOT }],
		["destination", { destination: ROOT }],
		["nested in data", { data: { itemType: "attachment", path: file } }],
		["nested twice", { data: { a: { b: { path: file } } } }],
		["in an array", [{ id: "A", position: { x: 1 } }, { path: file }]],
		["in a nested array", { items: [[{ dir: ROOT }]] }],
		["path with a null value", { path: null }],
		["path with an empty value", { path: "" }],
		["mode linked_file", { name: "x", mode: "linked_file" }],
		["linkMode linked_file", { data: { itemType: "attachment", linkMode: "linked_file" } }],
		["mode LINKED_FILE", { mode: "LINKED_FILE" }],
	];
	const writes: [string, string][] = [
		["POST", "/api/add/file"],
		["POST", "/api/io/import"],
		["POST", "/api/io/export"],
		["POST", "/api/translate/import"],
		["POST", "/api/translate/export"],
		["POST", "/api/items"],
		["PATCH", `/api/items/${K}`],
		["POST", "/api/searches"],
		["PUT", "/api/cite/settings"],
		["PUT", `/api/attachments/${K}/view-state`],
		["PUT", `/api/attachments/${K}/annotations`],
		["POST", "/api/bbt/settings"],
		["POST", "/api/references/add"],
	];

	test("every write route, every body shape, every content type", async () => {
		const items = count("SELECT count(*) n FROM items");
		const atts = count("SELECT count(*) n FROM attachments");
		for (const [method, path] of writes) {
			for (const [name, body] of bodies) {
				for (const type of ["application/json", "text/plain", "application/octet-stream", "APPLICATION/JSON; charset=utf-8"]) {
					const r = await call(method, path, JSON.stringify(body), type);
					expect([method, path, name, type, r.status]).toEqual([method, path, name, type, 403]);
				}
				const noType = await forwardApi(() => db, { http: method, path, headers: new Headers(), body: JSON.stringify(body) });
				expect([method, path, name, noType.status]).toEqual([method, path, name, 403]);
			}
		}
		expect(count("SELECT count(*) n FROM items")).toBe(items);
		expect(count("SELECT count(*) n FROM attachments")).toBe(atts);
		expect(readdirSync(outDir)).toEqual([]);
	});

	test("a spelling of the path that still reaches a listed route does not skip the check", async () => {
		const atts = count("SELECT count(*) n FROM attachments");
		for (const p of ["/api/add/%66ile", "/api/%61dd/file", "/api/add/%46ile".replace("%46", "%66")]) {
			expect((await call("POST", p, { name: "x", path: file, mode: "imported_file" })).status).toBe(403);
		}
		expect(count("SELECT count(*) n FROM attachments")).toBe(atts);
	});

	test("multipart: a field of those names, or mode linked_file, is refused; the file part is not", async () => {
		const atts = count("SELECT count(*) n FROM attachments");
		for (const field of ["path", "basePath", "dir", "PATH", "local_path"]) {
			const form = new FormData();
			form.append("file", new Blob(["x"]), "x.txt");
			form.append(field, file);
			expect((await call("POST", "/api/add/file", form)).status).toBe(403);
		}
		const linked = new FormData();
		linked.append("file", new Blob(["x"]), "x.txt");
		linked.append("mode", "linked_file");
		expect((await call("POST", "/api/add/file", linked)).status).toBe(403);
		// a path sent without a file part
		const only = new FormData();
		only.append("path", file);
		only.append("mode", "imported_file");
		expect((await call("POST", "/api/add/file", only)).status).toBe(403);
		// a multipart type on a route the core reads as JSON is not parsed as a form (it is JSON or nothing)
		const form = new FormData();
		form.append("path", file);
		expect((await call("POST", "/api/io/import", form)).status).toBe(400);
		expect(count("SELECT count(*) n FROM attachments")).toBe(atts);
	});

	test("a body that cannot be read is refused, never passed on", async () => {
		const before = count("SELECT count(*) n FROM items");
		for (const [method, path] of writes) {
			for (const bad of ["{", "{\"path\": ", "not json", "\u0000", "{'path': 'x'}", "[1,", "{\"a\":1}{\"path\":\"x\"}"]) {
				const r = await call(method, path, bad);
				expect([method, path, bad, r.status]).toEqual([method, path, bad, 400]);
			}
		}
		// multipart declared, JSON sent
		const r = await call("POST", "/api/add/file", JSON.stringify({ path: file }), "multipart/form-data; boundary=x");
		expect(r.status).toBe(400);
		// a body nested past the limit
		let deep: unknown = { path: file };
		for (let i = 0; i < 80; i++) deep = { a: deep };
		expect((await call("POST", "/api/io/import", deep)).status).toBe(403);
		expect(count("SELECT count(*) n FROM items")).toBe(before);
	});

	test("an empty body is not a way round it: the core has nothing to read", async () => {
		const r = await forwardApi(() => db, { http: "POST", path: "/api/add/file", headers: new Headers({ "Content-Type": "application/json" }), body: "" });
		expect(r.status).toBe(400);
	});

	test("a body on a route that reads none is not passed on", async () => {
		const fresh = repo.createCollection(db, "Gone soon").key;
		const r = await call("DELETE", `/api/collections/${fresh}`, { path: file });
		expect(r.status).toBe(200); // the route reads no body: dropped, not refused
		expect(existsSync(file)).toBe(true);
	});

	test("localPathField: the body fields that name a file or folder, with a legitimate annotation and item body left alone", () => {
		expect(localPathField({ position: { pageIndex: 0, paths: [[1, 2]], rects: [[1, 2, 3, 4]] } })).toBeNull();
		expect(localPathField([{ id: "A", type: "ink", position: { paths: [[1]] } }])).toBeNull();
		expect(localPathField({ data: { title: "path to the dir", url: "https://example.org/path", mode: "imported_file" } })).toBeNull();
		expect(localPathField({ conditions: [{ condition: "title", value: "path" }] })).toBeNull();
		expect(localPathField({ a: { b: [{ c: { basePath: "x" } }] } })).toBe("basePath");
		expect(localPathField(null)).toBeNull();
		expect(localPathField("path")).toBeNull();
	});
});
