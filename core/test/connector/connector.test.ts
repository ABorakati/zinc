// Replays the requests the Zotero Connector browser extension sends (shapes taken from zotero-connectors'
// itemSaver.js / pageSaving.js / progressWindow) against the Zotero-port handlers.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { hooks } from "../../src/additems/files";
import { reparentItem } from "../../src/additems/files";
import { getItemDetail } from "../../src/db";
import { upsertGroupLibrary } from "../../src/libraries";
import { deps } from "../../src/connector/handlers";
import { SessionManager } from "../../src/connector/session";
import { getRev, resetConnectorState, setSelection } from "../../src/connector/state";
import { handleZRequest } from "../../src/zport";
import { call, buildFixture, type Fixture } from "../fixture";

let fx: Fixture;
let db: Database;
const server = null as unknown as Bun.Server<unknown>;
const origAfterImport = hooks.afterImport;
const origDeps = { ...deps };

beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	resetConnectorState();
	SessionManager.clear();
	hooks.afterImport = () => {};
});
afterEach(() => {
	hooks.afterImport = origAfterImport;
	Object.assign(deps, origDeps);
	db.close();
});
afterAll(() => {
	hooks.afterImport = origAfterImport;
});

const HEADERS = { "X-Zotero-Connector-API-Version": "3", "X-Zotero-Version": "5.0.0" };

function z(path: string, init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { ...HEADERS, ...init.headers };
	let body = init.body;
	if (init.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(init.json);
	}
	return handleZRequest(new Request(`http://127.0.0.1:23119${path}`, { method: init.method ?? "POST", headers, body }), db, server);
}
const zjson = async (path: string, json: unknown) => {
	const res = await z(path, { json });
	const text = await res.text();
	return { status: res.status, text, json: text ? JSON.parse(text) : undefined, res };
};

// An article as a translator hands it over (Zotero.Item.toArray()).
const article = (over: Record<string, unknown> = {}) => ({
	id: "item1",
	itemType: "journalArticle",
	title: "Outcomes after liver transplantation",
	creators: [
		{ firstName: "Jane", lastName: "Smith", creatorType: "author" },
		{ firstName: "Raj", lastName: "Patel", creatorType: "author" },
	],
	date: "2023-11-02",
	publicationTitle: "BMJ",
	volume: "383",
	DOI: "10.1136/bmj-2023-078378",
	url: "https://www.bmj.com/content/383/bmj-2023-078378",
	accessDate: "CURRENT_TIMESTAMP",
	tags: ["liver", { tag: "transplant", type: 0 }],
	notes: [{ note: "<p>Translator note</p>" }],
	attachments: [
		{ id: "att1", title: "Full Text PDF", url: "https://www.bmj.com/x.pdf", mimeType: "application/pdf", parentItem: "item1" },
		{
			id: "att2",
			title: "Publisher link",
			url: "https://www.bmj.com/content/383/bmj-2023-078378",
			mimeType: "text/html",
			snapshot: false,
			parentItem: "item1",
		},
	],
	seeAlso: [],
	...over,
});

const saveBody = (items: unknown[], sessionID = "S1") => ({ sessionID, uri: "https://www.bmj.com/content/383", items });

function children(key: string) {
	return (
		db.query("SELECT key, item_type, data, deleted FROM items WHERE parent_key = ? ORDER BY date_added, rowid").all(key) as {
			key: string;
			item_type: string;
			data: string;
			deleted: number;
		}[]
	).map((r) => ({
		...r,
		d: JSON.parse(r.data),
	}));
}
function topByTitle(title: string) {
	const r = db.query("SELECT key FROM items WHERE title = ? AND parent_key IS NULL").get(title) as { key: string } | null;
	return r ? getItemDetail(db, r.key)! : null;
}

describe("ping", () => {
	test("GET answers like Zotero, POST returns prefs", async () => {
		const g = await z("/connector/ping", { method: "GET" });
		expect(g.status).toBe(200);
		expect(g.headers.get("content-type")).toContain("text/html");
		expect(await g.text()).toContain("Zotero is running");
		expect(g.headers.get("x-zotero-version")).toBeTruthy();
		const p = await zjson("/connector/ping", {});
		expect(p.status).toBe(200);
		expect(p.json.prefs).toMatchObject({
			automaticSnapshots: true,
			downloadAssociatedFiles: true,
			canUserAddNote: true,
			supportsTagsAutocomplete: true,
		});
		expect(p.json.prefs.translatorsHash).toBeUndefined();
	});

	test("web pages (Origin, no connector version header) are refused for saves", async () => {
		const res = await handleZRequest(
			new Request("http://127.0.0.1:23119/connector/saveItems", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
				body: JSON.stringify(saveBody([article()])),
			}),
			db,
			server,
		);
		expect(res.status).toBe(403);
		expect((db.query("SELECT count(*) AS n FROM items WHERE title = 'Outcomes after liver transplantation'").get() as any).n).toBe(0);
	});
});

describe("getSelectedCollection", () => {
	test("library by default, with the collection tree and tags", async () => {
		const r = await zjson("/connector/getSelectedCollection", {});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({
			libraryID: 1,
			libraryName: "My Library",
			libraryEditable: true,
			filesEditable: true,
			editable: true,
			id: null,
			name: "My Library",
		});
		expect(r.json.targets.map((t: any) => [t.id, t.level])).toEqual([
			["L1", 0],
			["CCOLLAAA1", 1],
			["CCOLLAAA2", 2],
		]);
		expect(r.json.targets.every((t: any) => t.filesEditable === true)).toBe(true);
		expect(r.json.tags.L1.map((t: any) => t.tag).sort()).toEqual(["imaging", "ml"]);
	});

	test("reports the collection the UI has selected (via /api/ui/selection)", async () => {
		const set = await call(db, "POST", "/api/ui/selection", { kind: "collection", key: "COLLAAA2" });
		expect(set.status).toBe(200);
		const r = await zjson("/connector/getSelectedCollection", {});
		expect(r.json).toMatchObject({ id: "CCOLLAAA2", name: "Sub" });
		const bad = await call(db, "POST", "/api/ui/selection", { kind: "collection" });
		expect(bad.status).toBe(400);
		await call(db, "POST", "/api/ui/selection", { kind: "trash" });
		expect((await zjson("/connector/getSelectedCollection", {})).json.id).toBeNull();
		expect(await (await call(db, "GET", "/api/ui/selection")).json()).toMatchObject({ selection: { kind: "trash" } });
	});
});

describe("a group library is not a save target", () => {
	test("when the UI has a (read-only) group collection open, saves go to My Library with a notice instead of failing", async () => {
		const lib = upsertGroupLibrary(db, { groupId: 777, name: "Read-only group", editable: false, filesEditable: false, version: 1 });
		db.run("INSERT INTO collections(key, name, library_id) VALUES('GROUPCOL1', 'Group coll', ?)", [lib.id]);
		await call(db, "POST", "/api/ui/selection", { kind: "collection", key: "GROUPCOL1" });
		const sel = await zjson("/connector/getSelectedCollection", {});
		expect(sel.status).toBe(200);
		expect(sel.json).toMatchObject({ id: null, name: "My Library", editable: true });
		expect(sel.json.notice).toContain("Read-only group");
		expect(sel.json.targets.some((t: any) => t.id === "CGROUPCOL1")).toBe(false);
		const saved = await zjson("/connector/saveItems", saveBody([article()], "G1"));
		expect(saved.status).toBe(201);
		const it = topByTitle(String(article().title))!;
		expect(it.collections).toEqual([]);
		// a target id of that collection (an extension with a stale picker) falls back too
		const upd = await zjson("/connector/updateSession", { sessionID: "G1", target: "CGROUPCOL1", tags: [] });
		expect(upd.status).toBe(200);
		expect(getItemDetail(db, it.data.key)!.collections).toEqual([]);
	});
});

describe("saveItems", () => {
	test("creates the item, creators, automatic tags, notes and link attachments in the selected collection", async () => {
		setSelection({ kind: "collection", key: "COLLAAA1" });
		const rev = getRev();
		const r = await zjson("/connector/saveItems", saveBody([article()]));
		expect(r.status).toBe(201);
		expect(r.text).toBe("");
		expect(getRev()).toBeGreaterThan(rev);

		const it = topByTitle("Outcomes after liver transplantation")!;
		expect(it.data.itemType).toBe("journalArticle");
		expect(it.data.creators).toEqual([
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "Raj", lastName: "Patel" },
		]);
		expect(it.data.publicationTitle).toBe("BMJ");
		expect(it.data.DOI).toBe("10.1136/bmj-2023-078378");
		expect(it.data.accessDate).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(it.collections).toEqual(["COLLAAA1"]);
		expect(it.tags).toEqual([
			{ tag: "liver", type: 1 },
			{ tag: "transplant", type: 1 },
		]);
		expect(it.data.id).toBeUndefined();
		expect(it.data.attachments).toBeUndefined();

		const kids = children(it.data.key);
		expect(kids.map((k) => k.item_type)).toEqual(["note", "attachment"]); // only the link-only attachment is created now
		expect(kids[0].d.note).toBe("<p>Translator note</p>");
		expect(kids[1].d).toMatchObject({
			linkMode: "linked_url",
			url: "https://www.bmj.com/content/383/bmj-2023-078378",
			title: "Publisher link",
			contentType: "text/html",
		});
		// shows up in the normal item list for the collection
		const list = await (await call(db, "GET", "/api/items?collection=COLLAAA1")).json();
		expect(list.items.some((i: any) => i.title === "Outcomes after liver transplantation")).toBe(true);
	});

	test("library target: no collection; duplicate session is 409; outdated connector is 400", async () => {
		const r = await zjson("/connector/saveItems", saveBody([article()], "S9"));
		expect(r.status).toBe(201);
		expect(topByTitle("Outcomes after liver transplantation")!.collections).toEqual([]);
		const dup = await zjson("/connector/saveItems", saveBody([article({ id: "x" })], "S9"));
		expect(dup.status).toBe(409);
		expect(dup.json).toEqual({ error: "SESSION_EXISTS" });
		const old = await z("/connector/saveItems", {
			json: saveBody([article()], "S10"),
			headers: { "X-Zotero-Connector-API-Version": "2" },
		});
		expect(old.status).toBe(400);
		expect(await old.json()).toEqual({ error: "CONNECTOR_VERSION_OUTDATED" });
	});

	test("maps base fields, parks unknown fields in Extra, fixes bad creator types, keeps single-field names", async () => {
		await zjson(
			"/connector/saveItems",
			saveBody(
				[
					{
						id: "c1",
						itemType: "conferencePaper",
						title: "A paper at a conference",
						publicationTitle: "Proc. of Things", // base field -> proceedingsTitle
						creators: [
							{ lastName: "ACME Consortium", fieldMode: 1, creatorType: "author" },
							{ firstName: "A", lastName: "B", creatorType: "bogus" },
						],
						numPages: "12", // not a conferencePaper field -> Extra
						extra: "PMID: 1",
						libraryCatalog: "Crossref",
						complete: true,
						mimeType: "x",
						attachments: [],
					},
				],
				"S2",
			),
		);
		const it = topByTitle("A paper at a conference")!;
		expect(it.data.proceedingsTitle).toBe("Proc. of Things");
		expect(it.data.publicationTitle).toBeUndefined();
		expect(it.data.libraryCatalog).toBe("Crossref");
		expect(it.data.extra).toBe("PMID: 1\n# of Pages: 12");
		expect(it.data.complete).toBeUndefined();
		expect(it.data.creators).toEqual([
			{ creatorType: "author", name: "ACME Consortium" },
			{ creatorType: "author", firstName: "A", lastName: "B" },
		]);
	});

	test("several items in one save", async () => {
		await zjson(
			"/connector/saveItems",
			saveBody([article({ id: "a", title: "One" }), article({ id: "b", title: "Two", DOI: "10.1/two" })], "S3"),
		);
		expect(topByTitle("One")).toBeTruthy();
		expect(topByTitle("Two")).toBeTruthy();
	});
});

describe("attachments", () => {
	const pdf = new TextEncoder().encode("%PDF-1.4\n% fake pdf body for tests\n%%EOF\n");

	async function saveOne(sessionID = "S1") {
		await zjson("/connector/saveItems", saveBody([article()], sessionID));
		return topByTitle("Outcomes after liver transplantation")!;
	}

	test("saveAttachment stores the PDF under the item as imported_url, naming it like Zotero", async () => {
		const it = await saveOne();
		const meta = {
			id: "att1",
			url: "https://www.bmj.com/x.pdf",
			contentType: "application/pdf",
			parentItemID: "item1",
			title: "Full Text PDF",
		};
		const res = await z("/connector/saveAttachment?sessionID=S1", {
			body: pdf,
			headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify(meta) },
		});
		expect(res.status).toBe(201);
		const att = children(it.data.key).find((k) => k.d.contentType === "application/pdf")!;
		expect(att.d).toMatchObject({
			linkMode: "imported_url",
			url: "https://www.bmj.com/x.pdf",
			title: "Full Text PDF",
			filename: "Smith and Patel - 2023 - Outcomes after liver transplantation.pdf",
		});
		const row = db.query("SELECT link_mode, path, url, content_type FROM attachments WHERE item_key = ?").get(att.key) as any;
		expect(row).toMatchObject({ link_mode: "imported_url", url: "https://www.bmj.com/x.pdf", content_type: "application/pdf" });
		expect(existsSync(row.path)).toBe(true);
		expect(readFileSync(row.path)).toEqual(Buffer.from(pdf));
		expect(row.path.replaceAll("\\", "/")).toContain(`/storage/${att.key}/`);
		// the file is served by the normal API
		const served = await call(db, "GET", `/api/attachments/${att.key}/file`);
		expect(served.status).toBe(200);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(pdf);
		const detail = getItemDetail(db, it.data.key)!;
		expect(detail.children.find((c) => c.key === att.key)?.hasFile).toBe(true);
	});

	test("RFC 2047 encoded titles are decoded; unknown session / missing metadata / missing parent", async () => {
		const it = await saveOne();
		const meta = {
			id: "att1",
			url: "https://www.bmj.com/x.pdf",
			contentType: "application/pdf",
			parentItemID: "item1",
			title: "=?UTF-8?Q?Full_Text_PDF_=E2=80=93_caf=C3=A9?=",
		};
		const ok = await z("/connector/saveAttachment?sessionID=S1", {
			body: pdf,
			headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify(meta) },
		});
		expect(ok.status).toBe(201);
		expect(children(it.data.key).some((k) => k.d.title === "Full Text PDF – café")).toBe(true);

		const noMeta = await z("/connector/saveAttachment?sessionID=S1", { body: pdf, headers: { "Content-Type": "application/pdf" } });
		expect(noMeta.status).toBe(400);
		expect(await noMeta.json()).toEqual({ error: "METADATA_NOT_PROVIDED" });
		const noSession = await z("/connector/saveAttachment", {
			body: pdf,
			headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify(meta) },
		});
		expect(noSession.status).toBe(400);
		expect(await noSession.json()).toEqual({ error: "SESSION_ID_NOT_PROVIDED" });
		const badSession = await z("/connector/saveAttachment?sessionID=nope", {
			body: pdf,
			headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify(meta) },
		});
		expect(await badSession.json()).toEqual({ error: "SESSION_NOT_FOUND" });
	});

	test("saveSnapshot creates a webpage item; saveSingleFile attaches the HTML", async () => {
		setSelection({ kind: "collection", key: "COLLAAA1" });
		const url = "https://example.org/a/page";
		const snap = await zjson("/connector/saveSnapshot", { sessionID: "W1", url, referrer: "", title: "An example page" });
		expect(snap.status).toBe(201);
		const page = topByTitle("An example page")!;
		expect(page.data).toMatchObject({ itemType: "webpage", url });
		expect(page.collections).toEqual(["COLLAAA1"]);

		const html = "<html><head><title>An example page</title></head><body>hello snapshot</body></html>";
		const sf = await zjson("/connector/saveSingleFile", { sessionID: "W1", snapshotContent: html, url, title: "Snapshot" });
		expect(sf.status).toBe(201);
		const att = children(page.data.key)[0];
		expect(att.d).toMatchObject({ linkMode: "imported_url", contentType: "text/html", title: "Snapshot", url });
		expect(att.d.filename).toBe("An example page.html");
		const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(att.key) as any;
		expect(readFileSync(row.path, "utf8")).toBe(html);

		const missing = await zjson("/connector/saveSingleFile", { sessionID: "nope", snapshotContent: html, url });
		expect(missing.json).toEqual({ error: "SESSION_NOT_FOUND" });
	});

	test("saveSingleFile after saveItems finds the item by data.items[0].id; empty content falls back to fetching the page", async () => {
		const it = await saveOne("S4");
		deps.fetch = async () => new Response("<html><body>fetched</body></html>");
		const sf = await zjson("/connector/saveSingleFile", {
			sessionID: "S4",
			snapshotContent: "",
			url: "https://www.bmj.com/content/383/bmj-2023-078378",
			title: "Snapshot",
			items: [{ id: "item1" }],
		});
		expect(sf.status).toBe(201);
		const snapshot = children(it.data.key).find((k) => k.d.contentType === "text/html" && k.d.linkMode === "imported_url")!;
		const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(snapshot.key) as any;
		expect(readFileSync(row.path, "utf8")).toContain("fetched");
		deps.fetch = async () => new Response("no", { status: 500 });
		const fail = await z("/connector/saveSingleFile", {
			json: {
				sessionID: "S4",
				snapshotContent: "",
				url: "https://www.bmj.com/content/383/bmj-2023-078378",
				items: [{ id: "item1" }],
			},
		});
		expect(fail.status).toBe(500);
	});

	test("the empty-snapshot fallback only fetches the saved page itself", async () => {
		await saveOne("S5");
		const fetched: string[] = [];
		deps.fetch = async (u) => (fetched.push(String(u)), new Response("<html>x</html>"));
		for (const url of ["http://127.0.0.1:23119/connector/ping", "file:///C:/Windows/win.ini", "https://evil.example/"]) {
			const r = await z("/connector/saveSingleFile", {
				json: { sessionID: "S5", snapshotContent: "", url, items: [{ id: "item1" }] },
			});
			expect(r.status).toBe(500);
		}
		expect(fetched).toEqual([]);
		const ok = await zjson("/connector/saveSingleFile", {
			sessionID: "S5",
			snapshotContent: "",
			url: "https://www.bmj.com/content/383/bmj-2023-078378#section",
			items: [{ id: "item1" }],
		});
		expect(ok.status).toBe(201);
		expect(fetched).toEqual(["https://www.bmj.com/content/383/bmj-2023-078378#section"]);
	});

	test("saveStandaloneAttachment (PDF tab) lands in the selected collection; getRecognizedItem follows the recognized parent", async () => {
		setSelection({ kind: "collection", key: "COLLAAA1" });
		let recognizedFor = "";
		deps.recognize = async (_d, key) => {
			recognizedFor = key;
			const p = (await import("../../src/db")).createItem(db, {
				itemType: "journalArticle",
				title: "Recognized paper",
				collections: ["COLLAAA1"],
			});
			reparentItem(db, key, p.data.key);
		};
		const meta = { url: "https://arxiv.org/pdf/1234.pdf", contentType: "application/pdf", title: "1234.pdf" };
		const res = await z("/connector/saveStandaloneAttachment?sessionID=P1", {
			body: pdf,
			headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify(meta) },
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ canRecognize: true });
		expect(recognizedFor).toBeTruthy();
		const rec = await zjson("/connector/getRecognizedItem", { sessionID: "P1" });
		expect(rec.status).toBe(200);
		expect(rec.json).toEqual({ title: "Recognized paper", itemType: "journalArticle" });
		// the attachment is now a child of the recognized item
		const parent = topByTitle("Recognized paper")!;
		expect(children(parent.data.key).map((k) => k.d.contentType)).toEqual(["application/pdf"]);
		expect((await zjson("/connector/getRecognizedItem", { sessionID: "nope" })).json).toEqual({ error: "SESSION_NOT_FOUND" });
	});

	test("standalone non-PDF is not recognizable; getRecognizedItem is 204", async () => {
		const meta = { url: "https://example.org/pic.png", contentType: "image/png", title: "pic" };
		const res = await z("/connector/saveStandaloneAttachment?sessionID=P2", {
			body: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
			headers: { "Content-Type": "image/png", "X-Metadata": JSON.stringify(meta) },
		});
		expect(await res.json()).toEqual({ canRecognize: false });
		const att = db
			.query("SELECT data FROM items WHERE item_type = 'attachment' AND json_extract(data, '$.url') = 'https://example.org/pic.png'")
			.get() as any;
		expect(JSON.parse(att.data)).toMatchObject({ linkMode: "imported_url", contentType: "image/png", filename: "pic.png" });
		expect((await z("/connector/getRecognizedItem", { json: { sessionID: "P2" } })).status).toBe(204);
	});
});

describe("resolvers", () => {
	test("hasAttachmentResolvers needs a DOI; saveAttachmentFromResolver returns the attached title", async () => {
		await zjson(
			"/connector/saveItems",
			saveBody([article(), article({ id: "nodoi", title: "No doi here", DOI: undefined, url: "" })], "R1"),
		);
		expect((await zjson("/connector/hasAttachmentResolvers", { sessionID: "R1", itemID: "item1" })).json).toBe(true);
		expect((await zjson("/connector/hasAttachmentResolvers", { sessionID: "R1", itemID: "nodoi" })).json).toBe(false);
		deps.findFullText = async (d, key) => {
			const { addFile } = await import("../../src/additems/files");
			return addFile(
				d,
				{ mode: "imported_file", name: "oa.pdf", contentType: "application/pdf", parentKey: key },
				new Uint8Array([1, 2, 3]),
			).data.key;
		};
		const ok = await z("/connector/saveAttachmentFromResolver", { json: { sessionID: "R1", itemID: "item1" } });
		expect(ok.status).toBe(201);
		expect(ok.headers.get("content-type")).toContain("text/plain");
		expect(await ok.text()).toBe("oa.pdf");
		deps.findFullText = async () => null;
		const fail = await z("/connector/saveAttachmentFromResolver", { json: { sessionID: "R1", itemID: "item1" } });
		expect(fail.status).toBe(500);
		expect(await fail.text()).toBe("Failed to save an attachment");
	});
});

describe("updateSession", () => {
	test("moves the saved items to another collection, adds tags (keeping automatic ones) and a note, then removes the note", async () => {
		await zjson("/connector/saveItems", saveBody([article()], "U1"));
		const key = topByTitle("Outcomes after liver transplantation")!.data.key;
		const upd = await zjson("/connector/updateSession", {
			sessionID: "U1",
			target: "CCOLLAAA2",
			tags: ["alpha", "beta, gamma"],
			note: "My *comment*",
		});
		expect(upd.status).toBe(200);
		expect(upd.json).toEqual({});
		let it = getItemDetail(db, key)!;
		expect(it.collections).toEqual(["COLLAAA2"]);
		expect(it.tags).toEqual(
			expect.arrayContaining([
				{ tag: "liver", type: 1 },
				{ tag: "transplant", type: 1 },
				{ tag: "alpha", type: 0 },
				{ tag: "beta, gamma", type: 0 },
			]),
		);
		expect(it.tags).toHaveLength(4);
		const note = children(key).find((k) => k.item_type === "note" && String(k.d.note).includes("comment"))!;
		expect(note.d.note).toBe("<p>My *comment*</p>");

		// later change: back to the library, other tags, edited note -> same note item is updated
		await zjson("/connector/updateSession", { sessionID: "U1", target: "L1", tags: ["alpha"], note: "Edited" });
		it = getItemDetail(db, key)!;
		expect(it.collections).toEqual([]);
		expect(it.tags.map((t) => t.tag).sort()).toEqual(["alpha", "liver", "transplant"]);
		const notes = children(key).filter((k) => k.item_type === "note" && !k.deleted);
		expect(notes.map((n) => n.d.note).sort()).toEqual(["<p>Edited</p>", "<p>Translator note</p>"]);
		expect(notes.find((n) => n.d.note === "<p>Edited</p>")!.key).toBe(note.key);

		// erased note is removed (the translator's own note stays)
		await zjson("/connector/updateSession", { sessionID: "U1", target: "L1", tags: [], note: "" });
		const after = children(key).filter((k) => k.item_type === "note" && !k.deleted);
		expect(after.map((n) => n.d.note)).toEqual(["<p>Translator note</p>"]);
		expect(
			getItemDetail(db, key)!
				.tags.map((t) => t.tag)
				.sort(),
		).toEqual(["liver", "transplant"]);
	});

	test("old connectors send tags as one comma separated string; errors match Zotero", async () => {
		await zjson("/connector/saveItems", saveBody([article()], "U2"));
		const key = topByTitle("Outcomes after liver transplantation")!.data.key;
		await zjson("/connector/updateSession", { sessionID: "U2", target: "L1", tags: "one,two", note: "" });
		expect(getItemDetail(db, key)!.tags.map((t) => t.tag)).toEqual(expect.arrayContaining(["one", "two"]));
		expect((await zjson("/connector/updateSession", { target: "L1" })).json).toEqual({ error: "SESSION_ID_NOT_PROVIDED" });
		expect((await zjson("/connector/updateSession", { sessionID: "zzz", target: "L1" })).json).toEqual({ error: "SESSION_NOT_FOUND" });
		const nc = await zjson("/connector/updateSession", { sessionID: "U2", target: "CNOSUCH123" });
		expect(nc.status).toBe(400);
		expect(nc.json).toEqual({ error: "COLLECTION_NOT_FOUND" });
	});

	test("a snapshot and its attachment follow the session too", async () => {
		await zjson("/connector/saveSnapshot", { sessionID: "U3", url: "https://example.org/p", title: "Page" });
		await zjson("/connector/updateSession", { sessionID: "U3", target: "CCOLLAAA1", tags: ["web"], note: "" });
		const page = topByTitle("Page")!;
		expect(page.collections).toEqual(["COLLAAA1"]);
		expect(page.tags).toEqual([{ tag: "web", type: 0 }]);
	});
});

describe("import, styles, misc", () => {
	test("import (RIS) creates items in the selected collection and answers with the items", async () => {
		setSelection({ kind: "collection", key: "COLLAAA1" });
		const ris = "TY  - JOUR\nTI  - Imported via RIS\nAU  - Doe, John\nPY  - 2021\nJO  - Journal of Tests\nKW  - imported\nER  - \n";
		const res = await z("/connector/import?session=I1", {
			body: ris,
			headers: { "Content-Type": "application/x-research-info-systems" },
		});
		expect(res.status).toBe(201);
		const out = await res.json();
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ title: "Imported via RIS", itemType: "journalArticle" });
		const it = topByTitle("Imported via RIS")!;
		expect(it.collections).toEqual(["COLLAAA1"]);
		expect(it.tags).toEqual([{ tag: "imported", type: 1 }]);
		expect(
			(await z("/connector/import?session=I2", { body: "not a bibliography", headers: { "Content-Type": "text/plain" } })).status,
		).toBe(400);
	});

	test("installStyle stores the CSL file", async () => {
		const csl = `<?xml version="1.0" encoding="utf-8"?><style xmlns="http://purl.org/net/xbiblio/csl" version="1.0"><info><title>Test &amp; Style</title><id>http://www.zotero.org/styles/test-style</id></info><citation><layout><text variable="title"/></layout></citation></style>`;
		const res = await z("/connector/installStyle?origin=https%3A%2F%2Fexample.org", {
			body: csl,
			headers: { "Content-Type": "application/vnd.citationstyles.style+xml" },
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ name: "Test & Style" });
		const { citeService } = await import("../../src/cite/api");
		expect(citeService(db).store.installedIds()).toContain("test-style");
		const bad = await z("/connector/installStyle", { body: "<html/>", headers: { "Content-Type": "text/xml" } });
		expect(bad.status).toBe(400);
	});

	test("delaySync is 204, unknown endpoints 404, bad JSON 400, preflight allowed", async () => {
		expect((await z("/connector/delaySync", { json: {} })).status).toBe(204);
		expect((await z("/connector/nothing", { json: {} })).status).toBe(404);
		const bad = await z("/connector/updateSession", { body: "{nope", headers: { "Content-Type": "application/json" } });
		expect(bad.status).toBe(400);
		const pre = await handleZRequest(new Request("http://127.0.0.1:23119/connector/saveItems", { method: "OPTIONS" }), db, server);
		expect(pre.status).toBe(200);
	});
});
