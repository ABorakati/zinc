import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleMcp } from "../../src/mcp/http";
import { createMcpServer } from "../../src/mcp/server";
import { buildFixture, type Fixture } from "../fixture";

let fx: Fixture;
let client: Client;

beforeAll(async () => {
	fx = buildFixture();
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await createMcpServer(fx.db).connect(st);
	client = new Client({ name: "test", version: "0" });
	await client.connect(ct);
});

afterAll(async () => {
	await client.close();
	fx.db.close(true);
});

async function tool(name: string, args: Record<string, unknown> = {}) {
	const r = (await client.callTool({ name, arguments: args })) as {
		content: { type: string; text: string }[];
		isError?: boolean;
	};
	const t = r.content[0].text;
	let json: any;
	try {
		json = JSON.parse(t);
	} catch {}
	return { text: t, json, isError: !!r.isError };
}

describe("tools/list", () => {
	test("lists all tools with annotations", async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"add_tags", "add_to_collection", "create_collection", "get_annotations", "get_file_path", "get_fulltext",
				"get_item", "list_collections", "list_items", "remove_from_collection", "remove_tags", "restore_item",
				"search_library", "trash_item", "update_item",
			].sort(),
		);
		const by = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(by.search_library.annotations?.readOnlyHint).toBe(true);
		expect(by.trash_item.annotations?.destructiveHint).toBe(true);
		expect(by.add_tags.annotations?.readOnlyHint).toBe(false);
	});
});

describe("read tools", () => {
	test("search_library strips marks and reports matchedIn", async () => {
		const r = await tool("search_library", { query: "pulmonary nodules" });
		expect(r.json.total).toBe(1);
		const h = r.json.hits[0];
		expect(h.key).toBe("AAAAAAA1");
		expect(h.matchedIn).toContain("fulltext");
		expect(h.snippet).toContain("**");
		expect(h.snippet).not.toContain("<mark>");
	});

	test("search_library paginates and handles no hits", async () => {
		const r = await tool("search_library", { query: "imaging", limit: 1 });
		expect(r.json.total).toBeGreaterThanOrEqual(2);
		expect(r.json.returned).toBe(1);
		const none = await tool("search_library", { query: "qqqqzzzz" });
		expect(none.json.total).toBe(0);
	});

	test("list_items filters and paginates", async () => {
		const all = await tool("list_items", {});
		expect(all.json.total).toBe(3); // trashed item excluded
		const tagged = await tool("list_items", { tag: "imaging", sort: "title", dir: "asc" });
		expect(tagged.json.items.map((i: any) => i.key)).toEqual(["AAAAAAA1", "BBBBBBB2"]);
		const col = await tool("list_items", { collection: "COLLAAA1" });
		expect(col.json.total).toBe(1);
		const trash = await tool("list_items", { trash: true });
		expect(trash.json.items[0].key).toBe("CCCCCCC3");
		const page = await tool("list_items", { limit: 1, offset: 1 });
		expect(page.json.returned).toBe(1);
		expect(page.json.offset).toBe(1);
	});

	test("get_item returns metadata, children, collection names", async () => {
		const r = await tool("get_item", { key: "AAAAAAA1" });
		expect(r.json.title).toBe("Deep learning for radiology");
		expect(r.json.tags).toEqual(["imaging", "ml"]);
		expect(r.json.collections).toEqual([{ key: "COLLAAA1", name: "Radiology" }]);
		const note = r.json.children.find((c: any) => c.itemType === "note");
		expect(note.text).toBe("Great transformer paper & notes");
		const pdf = r.json.children.find((c: any) => c.key === "ATT00002");
		expect(pdf.path).toBe(fx.pdfPath);
		expect(pdf.hasFile).toBe(true);
		expect(pdf.annotationCount).toBe(1);
		const missing = await tool("get_item", { key: "NOPE0000" });
		expect(missing.isError).toBe(true);
	});

	test("get_fulltext via parent key, paging, and no-text message", async () => {
		const r = await tool("get_fulltext", { key: "AAAAAAA1", maxChars: 10 });
		expect(r.text).toContain("attachment ATT00002");
		expect(r.text).toContain("characters 0-10 of");
		expect(r.text).toContain("offset=10");
		expect(r.text).toContain("convolutio");
		const next = await tool("get_fulltext", { key: "ATT00002", offset: 10, maxChars: 5 });
		expect(next.text).toContain("characters 10-15");
		const none = await tool("get_fulltext", { key: "BBBBBBB2" });
		expect(none.text).toContain("No full text is indexed");
		expect(none.isError).toBe(false);
	});

	test("get_annotations by attachment and by parent", async () => {
		const a = await tool("get_annotations", { key: "ATT00002" });
		expect(a.json.total).toBe(1);
		expect(a.json.annotations[0].id).toBe("ANNO0001");
		const p = await tool("get_annotations", { key: "AAAAAAA1" });
		expect(p.json.total).toBe(1);
	});

	test("list_collections returns a tree", async () => {
		const r = await tool("list_collections");
		expect(r.json.total).toBe(2);
		expect(r.json.collections[0].key).toBe("COLLAAA1");
		expect(r.json.collections[0].itemCount).toBe(1);
		expect(r.json.collections[0].children[0].key).toBe("COLLAAA2");
	});

	test("get_file_path picks the PDF and reports missing files", async () => {
		const r = await tool("get_file_path", { key: "AAAAAAA1" });
		expect(r.json.path).toBe(fx.pdfPath);
		const miss = await tool("get_file_path", { key: "DDDDDDD4" });
		expect(miss.text).toContain("does not exist");
		const noatt = await tool("get_file_path", { key: "BBBBBBB2" });
		expect(noatt.text).toContain("no attachments");
	});
});

describe("write tools", () => {
	test("create_collection, add/remove items", async () => {
		const c = await tool("create_collection", { name: "Agents", parentKey: "COLLAAA1" });
		expect(c.json.name).toBe("Agents");
		const key = c.json.key;
		await tool("add_to_collection", { collectionKey: key, itemKeys: ["BBBBBBB2", "DDDDDDD4"] });
		expect((await tool("list_items", { collection: key })).json.total).toBe(2);
		await tool("remove_from_collection", { collectionKey: key, itemKeys: ["DDDDDDD4"] });
		expect((await tool("list_items", { collection: key })).json.total).toBe(1);
		const bad = await tool("add_to_collection", { collectionKey: key, itemKeys: ["NOPE0000"] });
		expect(bad.isError).toBe(true);
		const badParent = await tool("create_collection", { name: "x", parentKey: "NOPE0000" });
		expect(badParent.isError).toBe(true);
	});

	test("add_tags / remove_tags re-index search", async () => {
		expect((await tool("search_library", { query: "newtagword" })).json.total).toBe(0);
		const a = await tool("add_tags", { itemKey: "BBBBBBB2", tags: ["newtagword", "imaging"] });
		expect(a.json.tags).toEqual(["imaging", "newtagword"]);
		expect((await tool("search_library", { query: "newtagword" })).json.total).toBe(1);
		await tool("remove_tags", { itemKey: "BBBBBBB2", tags: ["newtagword"] });
		expect((await tool("search_library", { query: "newtagword" })).json.total).toBe(0);
	});

	test("update_item patches fields, re-indexes, refuses protected fields", async () => {
		const r = await tool("update_item", { key: "BBBBBBB2", fields: { title: "Surgical atlas", DOI: "10.1/abc" } });
		expect(r.json.title).toBe("Surgical atlas");
		expect(r.json.DOI).toBe("10.1/abc");
		expect((await tool("search_library", { query: "atlas" })).json.total).toBe(1);
		for (const f of ["key", "itemType", "tags", "deleted"]) {
			const bad = await tool("update_item", { key: "BBBBBBB2", fields: { [f]: "x" } });
			expect(bad.isError).toBe(true);
		}
		expect((await tool("update_item", { key: "BBBBBBB2", fields: {} })).isError).toBe(true);
		expect((await tool("update_item", { key: "NOPE0000", fields: { title: "x" } })).isError).toBe(true);
	});

	test("trash_item and restore_item", async () => {
		await tool("trash_item", { key: "DDDDDDD4" });
		expect((await tool("search_library", { query: "zebra" })).json.total).toBe(0);
		expect((await tool("list_items", { trash: true })).json.total).toBe(2);
		await tool("restore_item", { key: "DDDDDDD4" });
		expect((await tool("search_library", { query: "genetics" })).json.total).toBe(1);
	});
});

describe("HTTP endpoint", () => {
	const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "127.0.0.1:23120" };
	const rpc = (body: unknown, extra: Record<string, string> = {}) =>
		new Request("http://127.0.0.1:23120/mcp", {
			method: "POST",
			headers: { ...headers, ...extra },
			body: JSON.stringify(body),
		});

	test("initialize, tools/list, tools/call", async () => {
		const init = await handleMcp(
			rpc({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
			}),
			fx.db,
		);
		expect(init!.status).toBe(200);
		expect(((await init!.json()) as any).result.serverInfo.name).toBe("zotero-next");

		const list = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), fx.db);
		expect(((await list!.json()) as any).result.tools.length).toBe(15);

		const call = await handleMcp(
			rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_collections", arguments: {} } }),
			fx.db,
		);
		const body = (await call!.json()) as any;
		expect(JSON.parse(body.result.content[0].text).total).toBeGreaterThanOrEqual(2);
	});

	test("rejects foreign and cross-origin requests", async () => {
		const ping = { jsonrpc: "2.0", id: 9, method: "tools/list" };
		const evil = await handleMcp(rpc(ping, { Origin: "http://evil.example" }), fx.db);
		expect(evil!.status).toBe(403);
		const otherPort = await handleMcp(rpc(ping, { Origin: "http://127.0.0.1:9999" }), fx.db);
		expect(otherPort!.status).toBe(403);
		const rebind = await handleMcp(rpc(ping, { Host: "evil.example" }), fx.db);
		expect(rebind!.status).toBe(403);
		const same = await handleMcp(rpc(ping, { Origin: "http://127.0.0.1:23120" }), fx.db);
		expect(same!.status).toBe(200);
	});

	test("other methods and paths", async () => {
		const get = await handleMcp(new Request("http://127.0.0.1:23120/mcp", { headers: { Host: "127.0.0.1:23120" } }), fx.db);
		expect(get!.status).toBe(405);
		expect(await handleMcp(new Request("http://127.0.0.1:23120/api/items"), fx.db)).toBeNull();
	});
});
