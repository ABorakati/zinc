// Items filed into several collections by an import, a PDF lookup or "create parent" keep items.data.collections in step.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ItemDetail } from "../../src/api-types";
import { addItemsToCollection, openDb } from "../../src/db";
import { hooks } from "../../src/additems/files";
import { net, setFetch } from "../../src/references/net";
import { saveImported } from "../../src/translate/service";
import { call, tempDir } from "../fixture";

let db: Database;
const origAfterImport = hooks.afterImport;
const origNet = { backoffMs: net.backoffMs, retries: net.retries };

const CROSSREF = {
	message: {
		type: "journal-article",
		title: ["Outcomes after liver transplantation"],
		author: [{ given: "Jane", family: "Smith" }],
		"container-title": ["BMJ"],
		issued: { "date-parts": [[2023, 11, 2]] },
		volume: "383",
		URL: "https://doi.org/10.1136/bmj-2023-078378",
	},
};

beforeEach(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
	net.backoffMs = 1;
	net.retries = 0;
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'One')").run();
	db.query("INSERT INTO collections(key, name) VALUES('COLLBBB2', 'Two')").run();
	hooks.afterImport = () => {};
	setFetch(async (input) =>
		/api\.crossref\.org\/works\/10\.1136\/bmj-2023-078378/i.test(input) ? Response.json(CROSSREF) : new Response("not found", { status: 404 }),
	);
});
afterEach(() => {
	setFetch();
	Object.assign(net, origNet);
	hooks.afterImport = origAfterImport;
	db.close(true);
});

const dataCollections = (key: string): string[] =>
	(JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data).collections as string[]).slice().sort();
const rowCollections = (key: string): string[] =>
	(db.query("SELECT collection_key FROM collection_items WHERE item_key = ?").all(key) as { collection_key: string }[])
		.map((r) => r.collection_key)
		.sort();

async function standalonePdf(): Promise<string> {
	const res = await call(db, "POST", "/api/add/file", {
		name: "scan.pdf",
		contentType: "application/pdf",
		dataBase64: Buffer.from("%PDF-1.4 scan").toString("base64"),
		collectionKey: "COLLAAA1",
	});
	expect(res.status).toBe(201);
	const key = ((await res.json()) as ItemDetail).data.key;
	addItemsToCollection(db, "COLLBBB2", [key]);
	return key;
}

describe("data.collections after multi-collection writes", () => {
	test("an item an import translator puts in two collections", () => {
		const res = saveImported(
			db,
			{
				items: [{ id: "1", itemType: "book", title: "Both" }],
				collections: [
					{ type: "collection", name: "A", children: [{ type: "item", id: "1" }] },
					{ type: "collection", name: "B", children: [{ type: "item", id: "1" }] },
				],
				translator: {} as never,
			},
			{ collectionKey: null, collectionName: null },
		);
		expect(res.errors).toEqual([]);
		expect(res.created).toBe(1);
		const key = res.itemKeys[0]!;
		expect(rowCollections(key).length).toBe(2);
		expect(dataCollections(key)).toEqual(rowCollections(key));
	});

	test("the parent made by create-parent for an attachment in two collections", async () => {
		const pdf = await standalonePdf();
		const res = await call(db, "POST", "/api/add/create-parent", { itemKey: pdf, text: "10.1136/bmj-2023-078378" });
		expect(res.status).toBe(201);
		const parent = ((await res.json()) as { parent: ItemDetail }).parent.data.key;
		expect(rowCollections(parent)).toEqual(["COLLAAA1", "COLLBBB2"]);
		expect(dataCollections(parent)).toEqual(["COLLAAA1", "COLLBBB2"]);
	});

	test("the parent found by retrieve-metadata for a PDF in two collections", async () => {
		const pdf = await standalonePdf();
		// the text is already indexed, so no document worker is needed
		db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, ?, 'test', ?)").run(
			pdf,
			"Outcomes after liver transplantation\ndoi: 10.1136/bmj-2023-078378",
			new Date().toISOString(),
		);
		const res = await call(db, "POST", "/api/add/retrieve-metadata", { attachmentKeys: [pdf], rename: false });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: { status: string; itemKey?: string; error?: string }[] };
		expect(body.results[0]).toMatchObject({ status: "retrieved" });
		const parent = body.results[0]!.itemKey!;
		expect(rowCollections(parent)).toEqual(["COLLAAA1", "COLLBBB2"]);
		expect(dataCollections(parent)).toEqual(["COLLAAA1", "COLLBBB2"]);
	});
});
