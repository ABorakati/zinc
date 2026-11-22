// A plugin-controlled string must never change which core route a handler calls. Real handlers, a fake core on port 0 that records
// every request: a hostile key / id makes no request at all, a valid one makes exactly the expected request.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import library from "../../src/imports/library.host";
import attachments from "../../src/imports/attachments.host";
import fulltext from "../../src/imports/fulltext.host";
import cite from "../../src/imports/cite.host";
import * as C from "../../src/imports/data/core";
import { call, failure, fakeCtx, manifestOf } from "./core-fixture";

const ALL = ["library.read", "library.write", "library.trash", "library.erase", "library.files.read", "library.files.write", "library.files.paths", "library.files.open", "library.fulltext.read", "library.fulltext.write", "library.cite", "library.cite.styles"];

let server: ReturnType<typeof Bun.serve>;
let url: string;
let seen: string[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const u = new URL(req.url);
			seen.push(`${req.method} ${u.pathname}${u.search}`);
			const p = u.pathname;
			if (p === "/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "characters 0-2 of 2\n\nhi" }] } });
			if (/^\/api\/items\/[^/]+$/.test(p) && req.method === "GET")
				return Response.json({ data: { key: p.split("/").pop(), itemType: "attachment", linkMode: "imported_file", contentType: "application/pdf" }, children: [], collections: [], tags: [] });
			if (/^\/api\/attachments\/[^/]+\/file$/.test(p)) {
				if (req.method === "HEAD") return new Response(null, { headers: { "content-length": "3" } });
				const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
				return m ? new Response("abc".slice(+m[1], +m[2] + 1), { status: 206 }) : new Response("abc");
			}
			if (p === "/api/add/file") return Response.json({ data: { key: "NEWKEY12" } });
			if (/^\/api\/attachments\/[^/]+\/view-state$/.test(p)) return Response.json(req.method === "GET" ? { page: 1 } : {});
			if (/^\/api\/fulltext\/jobs\/[^/]+$/.test(p)) return Response.json({ id: "J1", done: true, items: [] });
			if (/^\/api\/searches\/[^/]+$/.test(p)) return Response.json({ key: "SRCH1234", name: "s", conditions: [], options: {}, dateModified: "x" });
			return Response.json({});
		},
	});
	url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
	seen = [];
});

const ctx = () => fakeCtx({ url }, manifestOf({ capabilities: ALL }));
const bytes = new Uint8Array([1, 2, 3]);
const importReq = (collections: string[]) => ({ parent: undefined, library: undefined, filename: "a.pdf", contentType: undefined, title: undefined, url: undefined, collections, data: bytes });

const HOSTILE_KEYS = [
	"../maintenance/empty-trash?",
	"AAAAAAA1/../../maintenance/empty-trash",
	"AAAAAAA1?x=1",
	"AAAAAAA1#f",
	"%2e%2e",
	"%2E%2E/x",
	"..\\x",
	"AAAAAAA1\\..\\x",
	".",
	"..",
	"",
	"a/b",
	"A".repeat(33),
	"key with space",
];
const HOSTILE_IDS = ["../x?", "J/../K", "%2e%2e", "%2E%2e", "J?x=1", "J#f", "..\\x", ".", "..", "", "a/b", "J\u0000"];

// [function, builder of the arguments from the hostile value]
type Case = [string, unknown, string, (h: string) => unknown[]];
const KEY_CASES: Case[] = [
	["attachments", attachments, "get-info", (h) => [[h]]],
	["attachments", attachments, "get-info", (h) => [["AAAAAAA1", h]]],
	["attachments", attachments, "best-attachment", (h) => [h]],
	["attachments", attachments, "best-attachments", (h) => [h]],
	["attachments", attachments, "read-file", (h) => [h, 0n, 10]],
	["attachments", attachments, "read-file-all", (h) => [h, 100n]],
	["attachments", attachments, "replace-file", (h) => [h, bytes, undefined]],
	["attachments", attachments, "reveal-file", (h) => [h]],
	["attachments", attachments, "open-file-external", (h) => [h]],
	["attachments", attachments, "storage-of", (h) => [h]],
	["attachments", attachments, "get-view-state", (h) => [h]],
	["attachments", attachments, "set-view-state", (h) => [h, '{"a":1}']],
	["attachments", attachments, "import-bytes", (h) => [importReq(["AAAAAAA1", h])]],
	["library", library, "get-items", (h) => [[h], {}]],
	["library", library, "get-items", (h) => [["AAAAAAA1", h], {}]],
	["library", library, "get-summaries", (h) => [[h], [], {}, false]],
	["library", library, "get-children", (h) => [h, false]],
	["library", library, "get-saved-search", (h) => [h]],
	["library", library, "query-items", (h) => [{ scope: { tag: "children-of", val: h }, tags: [], fields: [], expand: {}, sort: [], limit: 0, offset: 0 }]],
	["fulltext", fulltext, "get-content", (h) => [h]],
	["fulltext", fulltext, "get-index-state", (h) => [["AAAAAAA1", h]]],
];
const ID_CASES: Case[] = [
	["attachments", attachments, "get-find-job", (h) => [h]],
	["attachments", attachments, "cancel-find-job", (h) => [h]],
	["cite", cite, "remove-style", (h) => [h]],
];

describe("hostile keys and ids make no request", () => {
	for (const [name, h, fn, args] of KEY_CASES)
		test(`${name}.${fn}: keys`, async () => {
			for (const bad of HOSTILE_KEYS) {
				seen = [];
				const f = await failure(call(h as never, ctx(), fn, ...args(bad)));
				expect({ bad, tag: f?.tag, seen }).toEqual({ bad, tag: "invalid-argument", seen: [] });
			}
		});
	for (const [name, h, fn, args] of ID_CASES)
		test(`${name}.${fn}: ids`, async () => {
			for (const bad of HOSTILE_IDS) {
				seen = [];
				const f = await failure(call(h as never, ctx(), fn, ...args(bad)));
				expect({ bad, tag: f?.tag, seen }).toEqual({ bad, tag: "invalid-argument", seen: [] });
			}
		});
});

describe("valid keys and ids make exactly the expected request", () => {
	const K = "AAAAAAA1";
	const run = async (h: unknown, fn: string, ...args: unknown[]) => {
		seen = [];
		await call(h as never, ctx(), fn, ...args);
		return seen;
	};
	test("attachments", async () => {
		expect(await run(attachments, "get-info", [K])).toEqual([`GET /api/items/${K}`, `HEAD /api/attachments/${K}/file`]);
		expect(await run(attachments, "best-attachment", K)).toEqual([`GET /api/items/${K}`]);
		expect(await run(attachments, "read-file", K, 0n, 2)).toEqual([`GET /api/attachments/${K}/file`]);
		expect(await run(attachments, "read-file-all", K, 100n)).toEqual([`HEAD /api/attachments/${K}/file`, `GET /api/attachments/${K}/file`]);
		expect(await run(attachments, "replace-file", K, bytes, undefined)).toEqual([`GET /api/items/${K}`, `PUT /api/attachments/${K}/file`]);
		expect(await run(attachments, "reveal-file", K)).toEqual([`POST /api/attachments/${K}/reveal`]);
		expect(await run(attachments, "open-file-external", K)).toEqual([`POST /api/attachments/${K}/open-external`]);
		expect(await run(attachments, "storage-of", K)).toEqual([`GET /api/items/${K}`, `HEAD /api/attachments/${K}/file`]);
		expect(await run(attachments, "get-view-state", K)).toEqual([`GET /api/attachments/${K}/view-state`]);
		expect(await run(attachments, "set-view-state", K, '{"a":1}')).toEqual([`PUT /api/attachments/${K}/view-state`]);
		expect(await run(attachments, "get-find-job", "3f2b8c1e-aaaa-bbbb-cccc-0123456789ab")).toEqual(["GET /api/fulltext/jobs/3f2b8c1e-aaaa-bbbb-cccc-0123456789ab"]);
		expect(await run(attachments, "cancel-find-job", "J1")).toEqual(["POST /api/fulltext/jobs/J1/cancel"]);
		expect(await run(attachments, "import-bytes", importReq(["COLL0001", "COLL0002"]))).toEqual(["POST /api/add/file", "POST /api/collections/COLL0002/items"]);
	});
	test("the Range and HEAD behaviour of the file reads is kept", async () => {
		const c = ctx();
		expect(new TextDecoder().decode(await call(attachments, c, "read-file", K, 1n, 2))).toBe("bc");
		expect(new TextDecoder().decode(await call(attachments, c, "read-file-all", K, 100n))).toBe("abc");
		expect((await failure(call(attachments, c, "read-file-all", K, 2n)))?.tag).toBe("limit-exceeded");
		const info = await call(attachments, c, "get-info", [K]);
		expect(info[0]).toMatchObject({ key: K, fileExists: true, size: 3n });
	});
	test("library, fulltext and cite", async () => {
		expect(await run(library, "get-items", [K], {})).toEqual([`GET /api/items/${K}`]);
		expect(await run(library, "get-children", K, false)).toEqual([`GET /api/items/${K}`]);
		expect(await run(library, "get-saved-search", "SRCH1234")).toEqual(["GET /api/searches/SRCH1234"]);
		expect(await run(fulltext, "get-content", K)).toEqual([`GET /api/items/${K}`, "POST /mcp"]);
		expect(await run(cite, "remove-style", "apa")).toEqual(["DELETE /api/cite/styles/apa"]);
		expect(await run(cite, "remove-style", "my style")).toEqual(["DELETE /api/cite/styles/my%20style"]);
	});
});

describe("core() refuses a path the URL parser would change", () => {
	const bad = [
		"/api/items/../maintenance/empty-trash",
		"/api/items/%2e%2e/maintenance",
		"/api/items/%2E%2E/maintenance",
		"/api/items/.%2e/x",
		"/api/items/./x",
		"/api/items/..",
		"/api/items\\..\\x",
		"/api/items/a\\b",
		"/api/items/a#b",
		"/api/items/a?x=1#b",
		"@evil.test/x",
		"api/items/x",
		"",
		"/api/items/x\n/y",
	];
	test("zero requests, invalid-argument", async () => {
		for (const p of bad) {
			seen = [];
			const f = await failure(C.core(ctx(), p));
			expect({ p, tag: f?.tag, seen }).toEqual({ p, tag: "invalid-argument", seen: [] });
			expect((await failure(C.coreFetch(ctx(), p)))?.tag).toBe("invalid-argument");
		}
	});
	test("a clean path and a query still go through", async () => {
		await C.core(ctx(), "/api/items/AAAAAAA1");
		await C.core(ctx(), "/api/items" + C.qs({ q: "a b&c=d#e", limit: 5 }));
		expect(seen).toEqual(["GET /api/items/AAAAAAA1", "GET /api/items?q=a+b%26c%3Dd%23e&limit=5"]);
	});
});

describe("segment helpers", () => {
	test("keySeg accepts core's key shapes and nothing else", () => {
		for (const k of ["AAAAAAA1", "abcDEF12", "a", "A_b-c", "x".repeat(32)]) expect(C.keySeg(k)).toBe(k);
		for (const k of ["", ".", "..", "a.b", "a/b", "a?b", "a#b", "a%2e", "a b", "x".repeat(33), 5, undefined, null, {}]) expect(() => C.keySeg(k as never)).toThrow();
	});
	test("idSeg encodes what is left", () => {
		expect(C.idSeg("my style")).toBe("my%20style");
		expect(C.idSeg("é")).toBe("%C3%A9");
		for (const k of ["", ".", "..", "a/b", "a\\b", "a?b", "a#b", "%2e%2e", "a\u0000b", "x".repeat(257), 5, undefined]) expect(() => C.idSeg(k as never)).toThrow();
	});
	test("qs keeps a value inside its own parameter", () => {
		expect(C.qs({ q: "a&b=c", tag: "x#y" })).toBe("?q=a%26b%3Dc&tag=x%23y");
	});
});
