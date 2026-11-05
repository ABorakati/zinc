// POST /api/items/:key/duplicate and POST /api/add/create-parent.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../../src/api-types";
import { createItem, openDb } from "../../src/db";
import { hooks } from "../../src/additems/files";
import { call, tempDir } from "../fixture";

let db: Database;
let dir: string;
const origAfterImport = hooks.afterImport;

beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "lib.sqlite"));
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Coll')").run();
	db.query("INSERT INTO collections(key, name) VALUES('COLLBBB2', 'Other')").run();
	hooks.afterImport = () => {}; // no background extraction
});

afterEach(() => {
	hooks.afterImport = origAfterImport;
	db.close(true);
});

const post = async <T,>(path: string, body: unknown, status = 200): Promise<T> => {
	const res = await call(db, "POST", path, body);
	if (res.status !== status) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
};

const tagNames = (d: ItemDetail) => d.tags.map((t) => t.tag).sort();
const dataOf = (key: string): ZoteroItemData => {
	const row = db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string };
	return JSON.parse(row.data) as ZoteroItemData;
};
const parentOf = (key: string): string | null => {
	const row = db.query("SELECT parent_key FROM items WHERE key = ?").get(key) as { parent_key: string | null };
	return row.parent_key;
};
const pathOf = (key: string): string => {
	const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string };
	return row.path;
};

/** A journal article in a collection with creators, tags and a relation to another item. */
function article(title = "A paper"): ItemDetail {
	const other = createItem(db, { itemType: "book", title: "Related book" });
	const it = createItem(db, {
		itemType: "journalArticle",
		title,
		publicationTitle: "BMJ",
		date: "2023-11-02",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "Raj", lastName: "Patel" },
		],
		tags: [{ tag: "liver" }, { tag: "transplant", type: 1 }],
		collections: ["COLLAAA1"],
		relations: { "dc:relation": `http://zotero.org/users/local/ABCD2345/items/${other.data.key}` },
	});
	return it;
}

describe("POST /api/items/:key/duplicate", () => {
	test("copies item type, fields, creators, tags, collections and relations; copies no children", async () => {
		const src = article();
		createItem(db, { itemType: "note", note: "<p>child note</p>", parentItem: src.data.key });
		const copy = await post<ItemDetail>(`/api/items/${src.data.key}/duplicate`, {}, 201);

		expect(copy.data.key).not.toBe(src.data.key);
		expect(copy.data.itemType).toBe("journalArticle");
		expect(copy.data.title).toBe(src.data.title);
		expect(copy.data.publicationTitle).toBe("BMJ");
		expect(copy.data.date).toBe("2023-11-02");
		expect(copy.data.creators).toEqual(src.data.creators);
		expect(tagNames(copy)).toEqual(["liver", "transplant"]);
		expect(copy.tags.find((t) => t.tag === "transplant")?.type).toBe(1);
		expect(copy.collections).toEqual(["COLLAAA1"]);
		expect(copy.data.relations).toEqual(src.data.relations);
		expect(copy.children).toEqual([]);
		const source = (await call(db, "GET", `/api/items/${src.data.key}`).then((x) => x.json())) as ItemDetail;
		expect(source.children.length).toBe(1);
		// dates are the copy's own
		expect(copy.data.dateAdded).not.toBe(undefined);
		expect(copy.data.dateModified).not.toBe(undefined);
	});

	test("the copy has its own tags and collections", async () => {
		const src = article();
		db.query("INSERT INTO collection_items(collection_key, item_key) VALUES('COLLBBB2', ?)").run(src.data.key);
		const copy = await post<ItemDetail>(`/api/items/${src.data.key}/duplicate`, {}, 201);
		await post(`/api/items/${copy.data.key}/tags`, { tags: ["only-on-the-copy"] });
		const copy2 = await post<ItemDetail>(`/api/items/${copy.data.key}/duplicate`, {}, 201);
		expect(copy2.tags.map((t) => t.tag)).toContain("only-on-the-copy");
		expect(JSON.stringify(dataOf(src.data.key))).not.toContain("only-on-the-copy");
		expect(copy.collections.sort()).toEqual(["COLLAAA1", "COLLBBB2"]);
		// removing the copy from a collection leaves the original's rows alone
		db.query("DELETE FROM collection_items WHERE item_key = ?").run(copy.data.key);
		const rows = db.query("SELECT count(*) AS n FROM collection_items WHERE item_key = ?").get(src.data.key) as { n: number };
		expect(rows.n).toBe(2);
	});

	test("a standalone attachment's copy gets its own file", async () => {
		const att = await post<ItemDetail>("/api/add/file", {
			name: "scan.pdf",
			contentType: "application/pdf",
			dataBase64: Buffer.from("%PDF-1.4 duplicate me").toString("base64"),
		}, 201);
		const copy = await post<ItemDetail>(`/api/items/${att.data.key}/duplicate`, {}, 201);
		expect(copy.data.itemType).toBe("attachment");
		expect(copy.data.contentType).toBe("application/pdf");
		expect(copy.data.title).toBe("scan.pdf");
		expect(copy.data.linkMode).toBe("imported_file");
		expect(pathOf(copy.data.key)).not.toBe(pathOf(att.data.key));
		expect(existsSync(pathOf(copy.data.key))).toBe(true);
	});

	test("a standalone note is duplicated with its HTML", async () => {
		const note = createItem(db, { itemType: "note", note: "<p>hi <b>there</b></p>" });
		const copy = await post<ItemDetail>(`/api/items/${note.data.key}/duplicate`, {}, 201);
		expect(copy.data.itemType).toBe("note");
		expect(copy.data.note).toBe("<p>hi <b>there</b></p>");
	});

	test("child items and unknown keys are refused", async () => {
		const src = article();
		const note = createItem(db, { itemType: "note", note: "<p>x</p>", parentItem: src.data.key });
		expect((await call(db, "POST", `/api/items/${note.data.key}/duplicate`, {})).status).toBe(400);
		expect((await call(db, "POST", "/api/items/ZZZZZZZZ/duplicate", {})).status).toBe(404);
		expect((await call(db, "GET", `/api/items/${src.data.key}/duplicate`)).status).toBe(405);
	});
});

describe("POST /api/add/create-parent", () => {
	async function standalonePdf(): Promise<ItemDetail> {
		return post<ItemDetail>("/api/add/file", {
			name: "scan.pdf",
			contentType: "application/pdf",
			dataBase64: Buffer.from("%PDF-1.4 scan").toString("base64"),
			collectionKey: "COLLAAA1",
		}, 201);
	}

	test("an identifier that is already in the library becomes the parent, which inherits the collections", async () => {
		const known = createItem(db, { itemType: "journalArticle", title: "The work", DOI: "10.1136/bmj-2023-078378" });
		const pdf = await standalonePdf();
		const r = await post<{ parent: ItemDetail; item: ItemDetail }>("/api/add/create-parent", { itemKey: pdf.data.key, text: "10.1136/bmj-2023-078378" }, 201);
		expect(r.parent.data.key).toBe(known.data.key);
		expect(r.item.data.parentItem).toBe(known.data.key);
		expect(r.parent.children.map((c) => c.key)).toEqual([pdf.data.key]);
		expect(r.item.collections).toEqual([]);
		expect(r.parent.collections).toEqual(["COLLAAA1"]);
		expect(parentOf(pdf.data.key)).toBe(known.data.key);
	});

	test("manual entry creates an empty parent of the chosen type under the child's collection", async () => {
		const pdf = await standalonePdf();
		const r = await post<{ parent: ItemDetail; item: ItemDetail }>("/api/add/create-parent", { itemKey: pdf.data.key, itemType: "book" }, 201);
		expect(r.parent.data.itemType).toBe("book");
		expect(r.parent.collections).toEqual(["COLLAAA1"]);
		expect(r.item.data.parentItem).toBe(r.parent.data.key);
		expect(r.parent.children.map((c) => c.key)).toEqual([pdf.data.key]);
		// the new parent is a top-level item; the attachment is not in the top-level list any more
		const keys = (db.query("SELECT key FROM items WHERE parent_key IS NULL").all() as { key: string }[]).map((x) => x.key);
		expect(keys).toContain(r.parent.data.key);
		expect(keys).not.toContain(pdf.data.key);
	});

	test("a standalone note can get a parent too", async () => {
		const note = createItem(db, { itemType: "note", note: "<p>standalone</p>" });
		const r = await post<{ parent: ItemDetail; item: ItemDetail }>("/api/add/create-parent", { itemKey: note.data.key, itemType: "document" }, 201);
		expect(r.parent.children.map((c) => c.key)).toEqual([note.data.key]);
	});

	test("refuses a regular item, a child item, an empty choice and an unknown identifier", async () => {
		const src = article();
		const pdf = await standalonePdf();
		const errMsg = async (body: unknown) => {
			const res = await call(db, "POST", "/api/add/create-parent", body);
			expect(res.status).toBe(400);
			return ((await res.json()) as { error: string }).error;
		};
		expect(await errMsg({ itemKey: src.data.key, itemType: "book" })).toContain("standalone attachment or note");
		const r = await post<{ parent: ItemDetail; item: ItemDetail }>("/api/add/create-parent", { itemKey: pdf.data.key, itemType: "book" }, 201);
		expect(await errMsg({ itemKey: pdf.data.key, itemType: "book" })).toContain("already has a parent");
		const note = createItem(db, { itemType: "note", note: "<p>n</p>" });
		expect(await errMsg({ itemKey: note.data.key })).toContain("itemType is required");
		expect(await errMsg({ itemKey: note.data.key, text: "not-an-identifier" })).toContain("not a recognised identifier");
		expect(await errMsg({ itemKey: note.data.key, itemType: "attachment" })).toContain("cannot be a parent");
		expect(r.item.data.parentItem).toBe(r.parent.data.key);
	});

	test("an attachment's data keeps the parent, and the item detail lists it", async () => {
		const pdf = await standalonePdf();
		const r = await post<{ parent: ItemDetail; item: ItemDetail }>("/api/add/create-parent", { itemKey: pdf.data.key, itemType: "journalArticle" }, 201);
		expect(dataOf(pdf.data.key).parentItem).toBe(r.parent.data.key);
		expect((await call(db, "GET", `/api/items/${r.parent.data.key}`).then((x) => x.json())) as ItemDetail).toMatchObject({
			children: [expect.objectContaining({ key: pdf.data.key })],
		});
	});
});
