// library, attachments, fulltext, schema, cite, sync-control and data-utils handlers against a throwaway core.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HandlerTable } from "../../src/imports/registry";
import library from "../../src/imports/library.host";
import attachments from "../../src/imports/attachments.host";
import fulltext from "../../src/imports/fulltext.host";
import schema from "../../src/imports/schema.host";
import syncControl from "../../src/imports/sync-control.host";
import dataUtils from "../../src/imports/data-utils.host";
import { call, failure, fakeCtx, manifestOf, startCore, type TestCore } from "./core-fixture";

let core: TestCore;
beforeAll(async () => {
	core = await startCore();
});
afterAll(() => core.stop());

const ALL = ["library.read", "library.write", "library.trash", "library.erase", "library.files.read", "library.files.write", "library.files.paths", "library.fulltext.read", "library.fulltext.write", "library.cite", "library.cite.styles"];
const reader = () => fakeCtx(core, manifestOf({ capabilities: ["library.read"] }));
const full = () => fakeCtx(core, manifestOf({ capabilities: ALL }));
const EXPAND = { creators: false, tags: false, collections: false };
const query = (over: Record<string, unknown> = {}) => ({
	library: undefined,
	scope: { tag: "all" },
	tags: [],
	text: undefined,
	textMode: "title-creator-year",
	search: undefined,
	fields: [],
	expand: EXPAND,
	sort: [{ field: "title", ascending: true }],
	limit: 0,
	offset: 0,
	...over,
});

describe("library: permissions", () => {
	test("every read refuses without library.read", async () => {
		const none = fakeCtx(core, manifestOf());
		for (const [fn, args] of [
			["list-libraries", []],
			["query-items", [query()]],
			["get-items", [["AAAAAAA1"], {}]],
			["list-collections", [undefined]],
			["list-tags", [undefined, undefined]],
		] as const) expect((await failure(call(library, none, fn, ...args)))?.tag).toBe("permission-denied");
	});

	test("writes need library.write, trash needs library.trash, erase needs library.erase (index is none)", async () => {
		const r = reader();
		const f = await failure(call(library, r, "apply", [{ tag: "create-item", val: { data: "{}" } }], {}));
		expect(f).toEqual({ index: undefined, error: { tag: "permission-denied", val: "library.write" } });
		const w = fakeCtx(core, manifestOf({ capabilities: ["library.read", "library.write"] }));
		expect((await failure(call(library, w, "apply", [{ tag: "trash-items", val: ["AAAAAAA1"] }], {})))?.error).toEqual({ tag: "permission-denied", val: "library.trash" });
		expect((await failure(call(library, w, "apply", [{ tag: "erase-items", val: ["AAAAAAA1"] }], {})))?.error).toEqual({ tag: "permission-denied", val: "library.erase" });
		expect((await failure(call(library, w, "set-tag-colors", undefined, [])))).toBeUndefined();
		expect((await failure(call(library, r, "empty-trash", undefined, undefined)))?.tag).toBe("permission-denied");
	});
});

describe("library: reading", () => {
	test("list-libraries, new-keys, search conditions", async () => {
		const libs = await call(library, reader(), "list-libraries");
		expect(libs).toEqual([{ id: 1, kind: "user", groupId: undefined, name: "My Library", editable: true, filesEditable: true }]);
		const keys = await call(library, fakeCtx(core), "new-keys", 50);
		expect(new Set(keys).size).toBe(50);
		expect(keys.every((k: string) => /^[2-9A-NP-Z]{8}$/.test(k))).toBe(true);
		expect((await call(library, fakeCtx(core), "list-search-conditions")).map((c: any) => c.name)).toContain("tag");
	});

	test("query-items: sort, fields, paging, scopes", async () => {
		const r = reader();
		const p = await call(library, r, "query-items", query({ fields: ["date"], limit: 2 }));
		expect(p.total).toBe(3n);
		expect(p.items.map((i: any) => i.key)).toEqual(["AAAAAAA1", "BBBBBBB2"]);
		const first = p.items[0];
		expect(first).toMatchObject({ library: 1, itemType: "journalArticle", title: "Deep learning for radiology", creatorsSummary: "Smith and Jones", year: 2020, inTrash: false, attachmentCount: 2, noteCount: 1, bestAttachment: "ATT00002" });
		expect(first.fields).toEqual([["date", "2020-05-01"]]);
		expect(first.dateModified).toBeTruthy();
		const desc = await call(library, r, "query-items", query({ sort: [{ field: "title", ascending: false }] }));
		expect(desc.items[0].key).toBe("DDDDDDD4");
		const page2 = await call(library, r, "query-items", query({ limit: 2, offset: 2 }));
		expect(page2.items).toHaveLength(1);
		const trash = await call(library, r, "query-items", query({ scope: { tag: "trash" } }));
		expect(trash.items.map((i: any) => [i.key, i.inTrash])).toEqual([["CCCCCCC3", true]]);
		const coll = await call(library, r, "query-keys", query({ scope: { tag: "collection", val: { key: "COLLAAA1", recursive: false } } }));
		expect(coll).toEqual(["AAAAAAA1"]);
		const recursive = await call(library, r, "query-keys", query({ scope: { tag: "collection", val: { key: "COLLAAA1", recursive: true } } }));
		expect(recursive).toEqual(["AAAAAAA1"]);
		expect(await call(library, r, "query-keys", query({ scope: { tag: "unfiled" } }))).toEqual(["BBBBBBB2", "DDDDDDD4"]);
		const kids = await call(library, r, "query-items", query({ scope: { tag: "children-of", val: "AAAAAAA1" } }));
		expect(kids.items.map((i: any) => i.key).sort()).toEqual(["ATT00001", "ATT00002", "NOTE0001"]);
		expect(await call(library, r, "count-items", query())).toBe(3n);
	});

	test("query-items: tags, text, ad-hoc search, expand", async () => {
		const r = reader();
		expect(await call(library, r, "query-keys", query({ tags: ["imaging"] }))).toEqual(["AAAAAAA1", "BBBBBBB2"]);
		expect(await call(library, r, "query-keys", query({ tags: ["imaging", "ml"] }))).toEqual(["AAAAAAA1"]);
		expect(await call(library, r, "query-keys", query({ text: "radiology" }))).toEqual(["AAAAAAA1"]);
		const search = { conditions: [{ condition: "itemType", operator: "is", value: "book", required: false }], options: { join: "all", includeParentsAndChildren: false, searchSubcollections: false, topLevelOnly: false, includeTrash: false } };
		expect(await call(library, r, "query-keys", query({ search }))).toEqual(["BBBBBBB2"]);
		expect((await failure(call(library, r, "query-keys", query({ search: { ...search, conditions: [{ condition: "groupStart", operator: "is", value: "", required: false }] } }))))?.tag).toBe("invalid-argument");
		const ex = await call(library, r, "query-items", query({ tags: ["imaging"], expand: { creators: true, tags: true, collections: true } }));
		expect(ex.items[0].creators).toEqual(["Smith A", "Jones B"]);
		expect(ex.items[0].tags.map((t: any) => t.name).sort()).toEqual(["imaging", "ml"]);
		expect(ex.items[0].collections).toEqual(["COLLAAA1"]);
	});

	test("get-items, get-summaries, get-children", async () => {
		const r = reader();
		const items = await call(library, r, "get-items", ["AAAAAAA1", "NOPE0000"], { includeChildren: true, includeTrashed: false });
		expect(items[1]).toBeUndefined();
		const a = JSON.parse(items[0]);
		expect(a).toMatchObject({ key: "AAAAAAA1", itemType: "journalArticle", title: "Deep learning for radiology" });
		expect(a.children.map((c: any) => c.key).sort()).toEqual(["ATT00001", "ATT00002", "NOTE0001"]);
		const s = await call(library, r, "get-summaries", ["BBBBBBB2", "NOPE0000"], ["date", "publisher"], { creators: true, tags: true, collections: true }, false);
		expect(s[1]).toBeUndefined();
		expect(s[0]).toMatchObject({ key: "BBBBBBB2", title: "Surgical anatomy", year: 2018, creators: ["Brown C"], fields: [["date", "2018"], ["publisher", undefined]] });
		const kids = await call(library, r, "get-children", "AAAAAAA1", false);
		expect(kids.map((k: any) => k.key).sort()).toEqual(["ATT00001", "ATT00002", "NOTE0001"]);
		expect(kids.find((k: any) => k.key === "NOTE0001").title).toBe("Great transformer paper & notes");
		expect(kids.find((k: any) => k.key === "NOTE0001").parentKey).toBe("AAAAAAA1");
		expect((await failure(call(library, r, "get-children", "NOPE0000", false)))?.tag).toBe("not-found");
	});

	test("collections, tags, facets, tag colours", async () => {
		const r = reader();
		const cols = await call(library, r, "list-collections", undefined);
		expect(cols.map((c: any) => [c.key, c.parent, c.itemCount])).toEqual([["COLLAAA1", undefined, 1], ["COLLAAA2", "COLLAAA1", 0]]);
		expect(await call(library, r, "get-collection-items", "COLLAAA1", true)).toEqual(["AAAAAAA1"]);
		expect((await failure(call(library, r, "get-collection-items", "NOPE0000", true)))?.tag).toBe("not-found");
		const tags = await call(library, r, "list-tags", undefined, undefined);
		expect(tags).toEqual([{ name: "imaging", kind: "manual", count: 2 }, { name: "ml", kind: "manual", count: 1 }]);
		const within = await call(library, r, "list-tags", undefined, query({ scope: { tag: "collection", val: { key: "COLLAAA1", recursive: false } } }));
		expect(within.map((t: any) => t.name)).toEqual(["imaging", "ml"]);
		expect(await call(library, r, "facets", query(), "itemType", 10)).toEqual([{ value: "journalArticle", count: 2n }, { value: "book", count: 1n }]);
		expect((await call(library, r, "facets", query(), "tag", 10))[0]).toEqual({ value: "imaging", count: 2n });
		expect((await call(library, r, "facets", query(), "year", 10)).map((f: any) => f.value).sort()).toEqual(["2018", "2020", "2022"]);
		const w = fakeCtx(core, manifestOf({ capabilities: ["library.read", "library.write"] }));
		await call(library, w, "set-tag-colors", undefined, [{ name: "ml", color: "#FF6666" }]);
		expect(await call(library, r, "get-tag-colors", undefined)).toEqual([{ name: "ml", color: "#FF6666" }]);
		expect((await failure(call(library, r, "find-by-relation", undefined, "dc:relation", undefined)))?.tag).toBe("unavailable");
	});
});

describe("library: apply", () => {
	test("one atomic batch: linked creates with new-keys, result lists the created keys", async () => {
		const w = full();
		const [item, note, coll] = await call(library, w, "new-keys", 3);
		const res = await call(library, w, "apply", [
			{ tag: "create-collection", val: { key: coll, library: undefined, name: "From plugin", parent: undefined } },
			{ tag: "create-item", val: { key: item, library: undefined, data: JSON.stringify({ itemType: "journalArticle", title: "Applied", tags: [{ tag: "applied" }] }) } },
			{ tag: "create-item", val: { key: note, library: undefined, data: JSON.stringify({ itemType: "note", note: "<p>n</p>", parentItem: item }) } },
			{ tag: "add-to-collection", val: { collection: coll, items: [item] } },
			{ tag: "add-tags", val: { items: [item], tags: [{ name: "x", kind: "automatic" }] } },
			{ tag: "update-collection", val: { key: coll, name: "Renamed", parent: undefined } },
			{ tag: "create-saved-search", val: { key: undefined, library: undefined, name: "Plugin search", definition: { conditions: [{ condition: "tag", operator: "is", value: "applied", required: false }], options: { join: "all", includeParentsAndChildren: false, searchSubcollections: false, topLevelOnly: false, includeTrash: false } } } },
		], { skipNotify: false });
		expect(res.changed).toBe(7);
		expect(res.created.slice(0, 3)).toEqual([coll, item, note]);
		const r = reader();
		const got = JSON.parse((await call(library, r, "get-items", [item], { includeChildren: false, includeTrashed: false }))[0]);
		expect(got.collections).toEqual([coll]);
		expect(got.tags.map((t: any) => t.tag).sort()).toEqual(["applied", "x"]);
		expect((await call(library, r, "list-collections", undefined)).find((c: any) => c.key === coll).name).toBe("Renamed");
		const searches = await call(library, r, "list-saved-searches", undefined);
		const s = searches.find((x: any) => x.name === "Plugin search");
		expect(s.definition.conditions).toEqual([{ condition: "tag", operator: "is", value: "applied", required: false }]);
		expect((await call(library, r, "get-saved-search", s.key)).key).toBe(s.key);
		expect(await call(library, r, "query-keys", query({ scope: { tag: "saved-search", val: s.key } }))).toEqual([item]);
		// the change log carries the plugin as origin
		const log = core.db.query("SELECT DISTINCT origin FROM change_log WHERE key = ?").all(item) as { origin: string }[];
		expect(log).toEqual([{ origin: "plugin:data-test@zinc.test" }]);
	});

	test("failure: all or nothing, error names the index and the case", async () => {
		const w = full();
		const before = (core.db.query("SELECT count(*) AS n FROM items").get() as any).n;
		const f = await failure(
			call(library, w, "apply", [
				{ tag: "create-item", val: { data: JSON.stringify({ itemType: "book", title: "ghost" }) } },
				{ tag: "update-item", val: { key: "AAAAAAA1", patch: JSON.stringify({ title: "x" }), expectedModified: "2000-01-01T00:00:00Z" } },
			], { skipNotify: false }),
		);
		expect(f).toEqual({ index: 1, error: { tag: "conflict", val: expect.stringContaining("changed since") } });
		expect((core.db.query("SELECT count(*) AS n FROM items").get() as any).n).toBe(before);
		const bad = await failure(call(library, w, "apply", [{ tag: "create-item", val: { data: "{not json" } }], { skipNotify: false }));
		expect(bad?.index).toBe(0);
		expect(bad?.error.tag).toBe("invalid-argument");
		const missing = await failure(call(library, w, "apply", [{ tag: "add-to-collection", val: { collection: "NOPE0000", items: ["AAAAAAA1"] } }], { skipNotify: false }));
		expect(missing?.error.tag).toBe("not-found");
	});

	test("trash, restore, erase, empty-trash, publications, related, rename-tag", async () => {
		const w = full();
		const [k] = await call(library, w, "new-keys", 1);
		await call(library, w, "apply", [{ tag: "create-item", val: { key: k, data: JSON.stringify({ itemType: "book", title: "Short lived", tags: [{ tag: "old" }] }) } }], { skipNotify: false });
		await call(library, w, "apply", [{ tag: "add-to-publications", val: [k] }, { tag: "add-related", val: { a: k, b: "BBBBBBB2" } }, { tag: "trash-items", val: [k] }], { skipNotify: false });
		const r = reader();
		expect(await call(library, r, "query-keys", query({ scope: { tag: "trash" } }))).toContain(k);
		expect((await call(library, r, "get-items", [k], { includeChildren: false, includeTrashed: false }))[0]).toBeUndefined();
		expect(JSON.parse((await call(library, r, "get-items", [k], { includeChildren: false, includeTrashed: true }))[0]).deleted).toBe(1);
		expect((await call(library, r, "get-summaries", [k], [], EXPAND, false))[0]).toBeUndefined();
		expect((await call(library, r, "get-summaries", [k], [], EXPAND, true))[0].inTrash).toBe(true);
		await call(library, w, "apply", [{ tag: "restore-items", val: [k] }], { skipNotify: false });
		expect(await call(library, r, "query-keys", query({ scope: { tag: "publications" } }))).toEqual([k]);
		expect(await call(library, w, "rename-tag", undefined, "old", "renewed")).toBe(1);
		expect((await call(library, r, "list-tags", undefined, undefined)).map((t: any) => t.name)).toContain("renewed");
		expect((await failure(call(library, w, "apply", [{ tag: "erase-items", val: [k] }], { skipNotify: false })))?.error.tag).toBe("conflict"); // not in the trash
		await call(library, w, "apply", [{ tag: "trash-items", val: [k] }, { tag: "erase-items", val: [k] }], { skipNotify: false });
		expect((await call(library, r, "get-items", [k], { includeChildren: false, includeTrashed: true }))[0]).toBeUndefined();
		expect(await call(library, w, "empty-trash", undefined, undefined)).toBeGreaterThanOrEqual(1); // CCCCCCC3 was in the trash
		expect((await call(library, r, "query-keys", query({ scope: { tag: "trash" } })))).toEqual([]);
	});

	test("find-duplicates and mark-not-duplicates answer", async () => {
		const w = full();
		expect(Array.isArray(await call(library, w, "find-duplicates", undefined))).toBe(true);
		await call(library, w, "mark-not-duplicates", ["AAAAAAA1", "BBBBBBB2"]);
	});
});

describe("attachments", () => {
	test("get-info, best-attachments, read-file, read-file-all", async () => {
		const r = fakeCtx(core, manifestOf({ capabilities: ["library.read", "library.files.read"] }));
		const info = await call(attachments, r, "get-info", ["ATT00002", "ATT00001", "AAAAAAA1", "NOPE0000"]);
		expect(info[0]).toMatchObject({ key: "ATT00002", parent: "AAAAAAA1", linkMode: "imported-file", contentType: "application/pdf", fileExists: true, size: 1000n });
		expect(info[1]).toMatchObject({ key: "ATT00001", fileExists: false, size: undefined });
		expect(info[2]).toBeUndefined();
		expect(info[3]).toBeUndefined();
		expect(await call(attachments, r, "best-attachments", "AAAAAAA1")).toEqual(["ATT00002", "ATT00001"]);
		expect(await call(attachments, r, "best-attachment", "AAAAAAA1")).toBe("ATT00002");
		const chunk = await call(attachments, r, "read-file", "ATT00002", 10n, 5);
		expect([...chunk]).toEqual([10, 11, 12, 13, 14]);
		expect((await call(attachments, r, "read-file", "ATT00002", 995n, 100)).length).toBe(5);
		expect((await call(attachments, r, "read-file", "ATT00002", 5000n, 100)).length).toBe(0);
		expect((await call(attachments, r, "read-file-all", "ATT00002", 5000n)).length).toBe(1000);
		expect((await failure(call(attachments, r, "read-file-all", "ATT00002", 999n)))?.tag).toBe("limit-exceeded");
		expect((await failure(call(attachments, r, "read-file", "ATT00001", 0n, 10)))?.tag).toBe("not-found");
		expect((await failure(call(attachments, fakeCtx(core, manifestOf({ capabilities: ["library.read"] })), "read-file", "ATT00002", 0n, 10)))?.tag).toBe("permission-denied");
	});

	test("import-bytes, file-writer resource, view state", async () => {
		const w = full();
		const key = await call(attachments, w, "import-bytes", { parent: "BBBBBBB2", library: undefined, filename: "note.txt", contentType: "text/plain", title: "My note", url: undefined, collections: [], data: new TextEncoder().encode("hello bytes") });
		const [info] = await call(attachments, w, "get-info", [key]);
		expect(info).toMatchObject({ parent: "BBBBBBB2", linkMode: "imported-file", fileExists: true, size: 11n });
		expect(new TextDecoder().decode(await call(attachments, w, "read-file-all", key, 100n))).toBe("hello bytes");
		expect((await failure(call(attachments, w, "import-bytes", { filename: "../evil.txt", collections: [], data: new Uint8Array(1) })))?.tag).toBe("invalid-argument");

		const table = new HandlerTable([attachments]);
		const iface = attachments.interface;
		const req = { parent: "BBBBBBB2", library: undefined, filename: "big.bin", contentType: "application/octet-stream", title: undefined, url: undefined, collections: [], data: new Uint8Array(0) };
		await table.call(w, iface, "[constructor]file-writer", [1, req]);
		await table.call(w, iface, "[method]file-writer.append", [1, new Uint8Array([1, 2, 3])]);
		await table.call(w, iface, "[method]file-writer.append", [1, new Uint8Array([4, 5])]);
		const wk = await table.call(w, iface, "[method]file-writer.finish", [1]);
		expect([...(await call(attachments, w, "read-file-all", wk, 100n))]).toEqual([1, 2, 3, 4, 5]);
		// a writer dropped without finish makes nothing
		await table.call(w, iface, "[constructor]file-writer", [2, req]);
		await table.call(w, iface, "[method]file-writer.append", [2, new Uint8Array([9])]);
		await table.call(w, iface, "[resource-drop]file-writer", [2]);

		const noPerm = fakeCtx(core, manifestOf({ capabilities: ["library.read"] }));
		expect((await failure(call(attachments, noPerm, "import-bytes", { filename: "a.txt", collections: [], data: new Uint8Array(1) })))?.tag).toBe("permission-denied");

		expect(await call(attachments, w, "get-view-state", "ATT00002")).toBeUndefined();
		await call(attachments, w, "set-view-state", "ATT00002", JSON.stringify({ pageIndex: 3 }));
		expect(JSON.parse(await call(attachments, w, "get-view-state", "ATT00002"))).toEqual({ pageIndex: 3 });
	});

	test("what core cannot do is the WIT error, not a crash", async () => {
		const w = full();
		for (const [fn, args] of [
			["rename-file", ["ATT00002", "x.pdf", false]],
			["delete-file", ["ATT00002"]],
			["relink-file", ["ATT00002", "C:/x.pdf"]],
		] as const) expect((await failure(call(attachments, w, fn, ...args)))?.tag).toBe("unavailable");
	});
});

describe("fulltext, schema, cite, sync-control", () => {
	test("fulltext", async () => {
		const r = fakeCtx(core, manifestOf({ capabilities: ["library.read", "library.fulltext.read"] }));
		expect((await call(fulltext, r, "get-content", "ATT00002")).text).toBe("convolutional segmentation of pulmonary nodules in lung scans");
		expect(await call(fulltext, r, "get-content", "ATT00001")).toBeUndefined();
		expect(await call(fulltext, r, "get-index-state", ["ATT00002", "ATT00001", "AAAAAAA1"])).toEqual(["indexed", "unindexed", "unavailable"]);
		const hits = await call(fulltext, r, "search", "pulmonary", undefined, 10, 0);
		expect(hits.map((h: any) => h.key)).toEqual(["AAAAAAA1"]);
		expect(hits[0].snippet).toContain("pulmonary");
		expect((await failure(call(fulltext, r, "set-content", "ATT00002", "x")))?.tag).toBe("permission-denied");
		expect((await failure(call(fulltext, full(), "set-content", "ATT00002", "x")))?.tag).toBe("unavailable");
	});

	test("schema", async () => {
		const s = await call(schema, fakeCtx(core), "get-schema");
		const ja = s.itemTypes.find((t: any) => t.name === "journalArticle");
		expect(ja.fields.find((f: any) => f.name === "date")).toMatchObject({ isDate: true, label: "Date" });
		expect(ja.fields.find((f: any) => f.name === "abstractNote").isMultiline).toBe(true);
		expect(ja.creatorTypes.find((c: any) => c.primary).name).toBe("author");
		expect(s.itemTypes.find((t: any) => t.name === "book").fields.find((f: any) => f.name === "publisher")).toBeTruthy();
	});

	test("cite: installed styles and Quick Copy settings", async () => {
		const handler = (await import("../../src/imports/cite.host")).default;
		const c = fakeCtx(core, manifestOf({ capabilities: ["library.cite", "library.cite.styles"] }));
		const page = await call(handler, c, "list-styles", "", true, 100, 0);
		expect(page.styles.every((s: any) => s.installed)).toBe(true);
		const qc = await call(handler, c, "get-quick-copy-settings");
		expect(qc.style).toBeTruthy();
		expect((await failure(call(handler, fakeCtx(core), "get-quick-copy-settings")))?.tag).toBe("permission-denied");
	});

	test("sync-control", async () => {
		const st = await call(syncControl, reader(), "get-state");
		expect(st).toEqual({ route: "off", running: false, lastSynced: undefined, conflicts: 0 });
		expect((await failure(call(syncControl, reader(), "sync-now", undefined)))?.tag).toBe("permission-denied");
	});
});

describe("data-utils", () => {
	const du = (fn: string, ...a: unknown[]) => call(dataUtils, fakeCtx(undefined), fn, ...a);
	test("dates", async () => {
		expect(await du("parse-date", "2024-03-07")).toEqual({ year: 2024, month: 2, day: 7, part: undefined, order: "ymd" });
		expect(await du("parse-date", "March 7, 2024")).toMatchObject({ year: 2024, month: 2, day: 7, order: "mdy" });
		expect(await du("parse-date", "7 March 2024")).toMatchObject({ year: 2024, month: 2, day: 7, order: "dmy" });
		expect(await du("parse-date", "Spring 2020")).toMatchObject({ year: 2020, part: "Spring" });
		expect(await du("to-iso-date", "March 2022")).toBe("2022-03");
		expect(await du("to-iso-date", "2018")).toBe("2018");
		expect(await du("to-iso-date", "not a date")).toBeUndefined();
		expect(await du("display-date", "2024-03-07 March 7, 2024")).toBe("March 7, 2024");
	});
	test("titles, creators, extra, identifiers", async () => {
		expect(await du("note-to-title", "<p>First <b>line</b></p><p>second</p>")).toBe("First line");
		expect(await du("display-title", JSON.stringify({ itemType: "note", note: "<h1>Heading</h1><p>x</p>" }))).toBe("Heading");
		expect(await du("first-creator", JSON.stringify({ creators: [{ creatorType: "author", lastName: "A" }, { creatorType: "author", lastName: "B" }, { creatorType: "author", lastName: "C" }] }))).toBe("A et al.");
		expect(await du("first-creator", JSON.stringify({ creators: [{ creatorType: "editor", name: "Ed" }, { creatorType: "author", lastName: "Au" }] }))).toBe("Au");
		expect(await du("sort-title", "The Anatomy of Melancholy")).toBe("Anatomy of Melancholy");
		expect(await du("parse-extra", "PMID: 123\ntex.foo: bar\n\nA free note")).toEqual({ fields: [{ name: "PMID", value: "123" }, { name: "tex.foo", value: "bar" }], rest: "A free note" });
		const ids = await du("extract-identifiers", "see https://doi.org/10.1000/xyz123, arXiv:2101.01234v2 and PMC1234567, ISBN 978-0-306-40615-7, ISSN 0378-5955");
		expect(ids).toEqual([
			{ kind: "doi", value: "10.1000/xyz123" },
			{ kind: "arxiv", value: "2101.01234v2" },
			{ kind: "pmcid", value: "PMC1234567" },
			{ kind: "isbn", value: "9780306406157" },
			{ kind: "issn", value: "0378-5955" },
		]);
	});
	test("CSL JSON round trip", async () => {
		const item = { key: "ABCD2345", itemType: "journalArticle", title: "T", date: "2020-05-01", publicationTitle: "J", volume: "3", DOI: "10.1/x", creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }, { creatorType: "editor", name: "Org" }] };
		const csl = JSON.parse(await du("item-to-csl-json", JSON.stringify(item)));
		expect(csl).toMatchObject({ id: "ABCD2345", type: "article-journal", title: "T", "container-title": "J", volume: "3", DOI: "10.1/x", issued: { "date-parts": [[2020, 5, 1]] }, author: [{ family: "Smith", given: "Ann" }], editor: [{ literal: "Org" }] });
		const back = JSON.parse(await du("item-from-csl-json", JSON.stringify(csl)));
		expect(back).toMatchObject({ itemType: "journalArticle", title: "T", publicationTitle: "J", date: "2020-05-01", DOI: "10.1/x" });
		expect(back.creators).toContainEqual({ creatorType: "author", firstName: "Ann", lastName: "Smith" });
		expect((await failure(du("item-to-csl-json", "[]")))?.tag).toBe("invalid-argument");
	});
});

describe("attachments.import-from-url", () => {
	test("downloads through the net allowlist (redirect hops included) and stores the file", async () => {
		const srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const u = new URL(req.url);
				if (u.pathname === "/go") return new Response(null, { status: 302, headers: { Location: "/files/paper.txt" } });
				if (u.pathname === "/away") return new Response(null, { status: 302, headers: { Location: `http://localhost:${srv.port}/files/paper.txt` } });
				return new Response("remote bytes", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
			},
		});
		try {
			const base = `http://127.0.0.1:${srv.port}`;
			const c = fakeCtx(core, manifestOf({ capabilities: ["library.read", "library.files.write", "library.files.read"], netHosts: [base] }));
			const key = await call(attachments, c, "import-from-url", { parent: "BBBBBBB2", library: undefined, url: `${base}/go`, title: "Remote", contentType: undefined, collections: [] });
			const [info] = await call(attachments, c, "get-info", [key]);
			expect(info).toMatchObject({ parent: "BBBBBBB2", contentType: "text/plain", filename: "paper.txt", url: `${base}/go`, fileExists: true, size: 12n });
			expect((await failure(call(attachments, c, "import-from-url", { url: `${base}/away`, collections: [] })))?.tag).toBe("permission-denied"); // hop leaves the allowlist
			const none = fakeCtx(core, manifestOf({ capabilities: ["library.files.write"] }));
			expect((await failure(call(attachments, none, "import-from-url", { url: `${base}/go`, collections: [] })))?.tag).toBe("permission-denied");
		} finally {
			srv.stop(true);
		}
	});
});
