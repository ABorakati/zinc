// Fuzz: the core HTTP API's input validation, on a real server (Bun.serve on a free port, a fresh temp database), and the
// apiRequestRejected guard in server.ts.
//
// Properties: random JSON bodies, query strings and path keys never produce a 5xx (bad input is a 4xx), never crash or hang
// the server (it still answers afterwards), never corrupt the database; and the guard rejects every non-loopback Host,
// foreign Origin and non-JSON write, for random header values.
// Only the local, offline routes are exercised (no sync, full-text, translators, references or anything else that reaches the
// network or launches a program); `dir` and `basePath` are never sent, so nothing is written or read outside the temp folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createItem } from "../../src/db";
import { checkRequestOrigin } from "../../src/mcp/http";
import { apiRequestRejected, startServer } from "../../src/server";
import { tempDir } from "../fixture";
import { describeError, fc, fuzz, messyText } from "./harness";

let srv: ReturnType<typeof startServer>;
let base = "";
const keys = { item: "", item2: "", att: "", coll: "" };

beforeAll(() => {
	srv = startServer({ dbPath: join(tempDir(), "lib.sqlite"), port: 0 });
	base = srv.url;
	const a = createItem(srv.db, {
		itemType: "journalArticle",
		title: "First",
		creators: [{ creatorType: "author", firstName: "A", lastName: "B" }],
		date: "2020",
	});
	const b = createItem(srv.db, { itemType: "book", title: "Second", date: "2019", DOI: "10.1000/x" });
	const att = createItem(srv.db, {
		itemType: "attachment",
		linkMode: "linked_url",
		parentItem: a.data.key,
		title: "link",
		url: "https://example.org/",
	});
	const c = srv.db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'C') RETURNING key").get() as { key: string };
	Object.assign(keys, { item: a.data.key, item2: b.data.key, att: att.data.key, coll: c.key });
});
afterAll(() => {
	srv.stop();
});

// ---------------------------------------------------------------- generators

const junk = fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<unknown>;
const text = fc.oneof(fc.string({ unit: "grapheme", maxLength: 20 }), messyText(40));
const pathKey = fc.oneof(
	{ weight: 4, arbitrary: fc.constantFrom("ITEM", "ITEM2", "ATT", "COLL") },
	{
		weight: 1,
		arbitrary: fc.constantFrom("ZZZZZZZZ", "", "%", "..", "a/b", "x y", "‮", "A".repeat(2000), "%00", "%E0%A4%A", "' OR 1=1 --"),
	},
	{ weight: 1, arbitrary: text },
);
const realKey = (k: string): string =>
	k === "ITEM" ? keys.item : k === "ITEM2" ? keys.item2 : k === "ATT" ? keys.att : k === "COLL" ? keys.coll : k;

const strings = fc.array(fc.oneof(fc.constantFrom("ITEM", "ITEM2", "ATT", "COLL"), text), { maxLength: 4 });
const fillKeys = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? realKey(x) : x)));
const record = (extra: Record<string, fc.Arbitrary<unknown>>) =>
	fc.record(extra, { requiredKeys: [] }).chain((r) =>
		fc.oneof(
			fc.constant(r),
			fc.tuple(fc.constant(r), fc.dictionary(fc.string({ maxLength: 8 }), junk, { maxKeys: 3 })).map(([a, b]) => ({ ...b, ...a })),
		),
	);
const oneOfJunk = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<unknown> =>
	fc.oneof({ weight: 3, arbitrary: a as fc.Arbitrary<unknown> }, { weight: 1, arbitrary: junk });

const itemData = record({
	itemType: oneOfJunk(fc.constantFrom("journalArticle", "book", "note", "attachment", "webpage", "bogus")),
	title: oneOfJunk(text),
	creators: oneOfJunk(
		fc.array(record({ creatorType: oneOfJunk(text), firstName: oneOfJunk(text), lastName: oneOfJunk(text), name: oneOfJunk(text) }), {
			maxLength: 3,
		}),
	),
	tags: oneOfJunk(
		fc.array(oneOfJunk(fc.oneof(text, record({ tag: oneOfJunk(text), type: oneOfJunk(fc.integer({ min: 0, max: 2 })) }))), {
			maxLength: 3,
		}),
	),
	collections: oneOfJunk(strings),
	parentItem: oneOfJunk(fc.constantFrom("ITEM", "ATT", "", "nope")),
	date: oneOfJunk(text),
	DOI: oneOfJunk(text),
	url: oneOfJunk(text),
	extra: oneOfJunk(text),
	note: oneOfJunk(text),
	abstractNote: oneOfJunk(text),
	relations: oneOfJunk(record({ "dc:relation": junk })),
	deleted: oneOfJunk(fc.constantFrom(0, 1)),
	linkMode: oneOfJunk(text),
	contentType: oneOfJunk(text),
});
const conditions = fc.array(
	record({
		field: oneOfJunk(
			fc.constantFrom(
				"title",
				"creator",
				"tag",
				"collection",
				"year",
				"anyField",
				"DOI",
				"itemType",
				"dateAdded",
				"fulltext",
				"x; DROP TABLE items",
			),
		),
		operator: oneOfJunk(
			fc.constantFrom(
				"contains",
				"is",
				"isNot",
				"doesNotContain",
				"isLessThan",
				"isGreaterThan",
				"beginsWith",
				"isInTheLast",
				"bogus",
			),
		),
		value: junk,
		required: oneOfJunk(fc.boolean()),
	}),
	{ maxLength: 4 },
);

const body = fc.oneof(
	{ weight: 3, arbitrary: junk },
	{
		weight: 2,
		arbitrary: record({
			name: oneOfJunk(text),
			parentKey: oneOfJunk(fc.constantFrom("COLL", "nope", null)),
			data: oneOfJunk(itemData),
			keys: oneOfJunk(strings),
			tags: oneOfJunk(strings),
			ids: oneOfJunk(strings),
			text: oneOfJunk(text),
			format: oneOfJunk(fc.constantFrom("auto", "bibtex", "ris", "csljson", "rdf", "mods", "csv", "bogus")),
			collectionKey: oneOfJunk(fc.constantFrom("COLL", "nope")),
			includeNotes: oneOfJunk(fc.boolean()),
			conditions: oneOfJunk(conditions),
			options: oneOfJunk(record({ match: junk, includeParents: junk })),
			masterKey: oneOfJunk(fc.constantFrom("ITEM", "ITEM2")),
			otherKeys: oneOfJunk(strings),
			fieldChoices: junk,
			sort: oneOfJunk(text),
			limit: oneOfJunk(fc.integer({ min: -5, max: 99 })),
		}),
	},
	{ weight: 2, arbitrary: itemData.map((d) => ({ data: d })) },
	{
		weight: 1,
		arbitrary: fc.array(
			record({
				id: oneOfJunk(text),
				type: oneOfJunk(fc.constantFrom("highlight", "note")),
				position: junk,
				sortIndex: oneOfJunk(text),
				color: junk,
				text: junk,
				comment: junk,
				dateModified: junk,
			}),
			{ maxLength: 3 },
		),
	},
	{ weight: 1, arbitrary: fc.array(record({ name: oneOfJunk(text), color: oneOfJunk(text), position: junk }), { maxLength: 3 }) },
);

const queryNames = [
	"collection",
	"tag",
	"q",
	"sort",
	"dir",
	"then",
	"limit",
	"offset",
	"search",
	"qmode",
	"unfiled",
	"publications",
	"trash",
	"fields",
	"include",
	"by",
	"keys",
];
const queryValue = fc.oneof(
	fc.constantFrom(
		"",
		"0",
		"-1",
		"1e9",
		"NaN",
		"Infinity",
		"10",
		"title",
		"creator",
		"year",
		"desc",
		"asc",
		"ITEM",
		"COLL",
		"1",
		"title,date,creators",
		"itemType",
		"x'y",
		'"',
		"%",
		"a*",
		"*",
	),
	text,
);
const query = fc.array(fc.tuple(fc.oneof(fc.constantFrom(...queryNames), text), queryValue), { maxLength: 5 }).map((a) => {
	const p = new URLSearchParams();
	for (const [k, v] of a) p.append(k, realKey(v));
	return p.toString();
});

interface Route {
	method: string;
	path: string; // "~" is replaced by a key
	body?: boolean;
	query?: boolean;
}
const ROUTES: Route[] = [
	{ method: "GET", path: "/api/collections" },
	{ method: "POST", path: "/api/collections", body: true },
	{ method: "PATCH", path: "/api/collections/~", body: true },
	{ method: "DELETE", path: "/api/collections/~" },
	{ method: "POST", path: "/api/collections/~/items", body: true },
	{ method: "DELETE", path: "/api/collections/~/items", body: true },
	{ method: "GET", path: "/api/items", query: true },
	{ method: "POST", path: "/api/items", body: true },
	{ method: "GET", path: "/api/items/groups", query: true },
	{ method: "GET", path: "/api/items/~" },
	{ method: "PATCH", path: "/api/items/~", body: true },
	{ method: "POST", path: "/api/items/~/duplicate" },
	{ method: "POST", path: "/api/items/~/tags", body: true },
	{ method: "DELETE", path: "/api/items/~/tags", body: true },
	{ method: "POST", path: "/api/items/~/related", body: true },
	{ method: "DELETE", path: "/api/items/~/related", body: true },
	{ method: "GET", path: "/api/schema" },
	{ method: "GET", path: "/api/tags" },
	{ method: "GET", path: "/api/tag-colors" },
	{ method: "PUT", path: "/api/tag-colors", body: true },
	{ method: "GET", path: "/api/attachments/~/annotations" },
	{ method: "PUT", path: "/api/attachments/~/annotations", body: true },
	{ method: "DELETE", path: "/api/attachments/~/annotations", body: true },
	{ method: "GET", path: "/api/attachments/~/view-state" },
	{ method: "PUT", path: "/api/attachments/~/view-state", body: true },
	{ method: "GET", path: "/api/attachments/~/file" },
	{ method: "GET", path: "/api/search", query: true },
	{ method: "GET", path: "/api/searches" },
	{ method: "POST", path: "/api/searches", body: true },
	{ method: "GET", path: "/api/searches/~" },
	{ method: "PATCH", path: "/api/searches/~", body: true },
	{ method: "DELETE", path: "/api/searches/~" },
	{ method: "POST", path: "/api/searches/run", body: true },
	{ method: "GET", path: "/api/duplicates" },
	{ method: "GET", path: "/api/duplicates/set", query: true },
	{ method: "POST", path: "/api/duplicates/merge", body: true },
	{ method: "POST", path: "/api/duplicates/not-duplicates", body: true },
	{ method: "POST", path: "/api/io/export", body: true },
	{ method: "POST", path: "/api/io/import", body: true },
];
const route = fc.constantFrom(...ROUTES);
const rawBody = fc.oneof(messyText(60), fc.constantFrom("", "null", "[", '{"a":', "\u0000", "{}", "[]", '"x"', "123", '{"keys":null}'));

/** Never send fields that make a handler write or read at a path the test did not choose. */
const strip = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(strip);
	if (v && typeof v === "object")
		return Object.fromEntries(
			Object.entries(v)
				.filter(([k]) => k !== "dir" && k !== "basePath" && k !== "path")
				.map(([k, x]) => [k, strip(x)]),
		);
	return v;
};

async function send(r: Route, k: string, b: unknown, raw: string | null, q: string): Promise<Response> {
	const path = r.path.replace("~", encodeURIComponent(realKey(k).toWellFormed()));
	const url = `${base}${path}${r.query && q ? `?${q}` : ""}`;
	const init: RequestInit = { method: r.method, redirect: "manual", signal: AbortSignal.timeout(20_000) };
	if (r.body) {
		init.headers = { "Content-Type": "application/json" };
		init.body = raw ?? JSON.stringify(strip(fillKeys(b)));
	}
	return fetch(url, init);
}

// ---------------------------------------------------------------- properties

describe("HTTP API input validation", () => {
	fuzz(
		"random bodies, queries and keys never give a 5xx",
		[route, pathKey, body, fc.option(rawBody, { nil: null, freq: 6 }), query],
		async (r, k, b, raw, q) => {
			const res = await send(r, k, b, raw, q);
			const txt = await res.text();
			if (res.status >= 500)
				throw new Error(
					`${r.method} ${r.path.replace("~", k)} -> ${res.status}: ${txt.slice(0, 300)}\nbody: ${raw ?? JSON.stringify(strip(fillKeys(b))).slice(0, 600)}\nquery: ${q}`,
				);
			if (res.status >= 200 && res.status < 300 && res.headers.get("content-type")?.includes("json")) JSON.parse(txt);
		},
		{ normal: 400, timeBoxMs: 10_000 },
	);

	fuzz(
		"the server survives, answers, and the database is intact",
		[fc.constant(0)],
		async (_n: number) => {
			const res = await fetch(`${base}/api/collections`);
			expect(res.status).toBe(200);
			expect(Array.isArray(await res.json())).toBe(true);
			const item = await fetch(`${base}/api/items/${keys.item}`);
			expect(item.status).toBe(200);
			expect((srv.db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((x) => x.integrity_check)).toEqual([
				"ok",
			]);
			expect(srv.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		},
		{ normal: 1 },
	);

	fuzz(
		"random methods and paths under /api are 4xx, never 5xx",
		[
			fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"),
			fc.array(pathKey, { minLength: 1, maxLength: 4 }),
			fc.constantFrom(
				"collections",
				"items",
				"tags",
				"attachments",
				"search",
				"searches",
				"duplicates",
				"schema",
				"tag-colors",
				"nonsense",
			),
		],
		async (method, segs, first) => {
			const res = await fetch(`${base}/api/${first}/${segs.map((s) => encodeURIComponent(realKey(s).toWellFormed())).join("/")}`, {
				method,
				headers: method === "GET" || method === "HEAD" ? {} : { "Content-Type": "application/json" },
				body: method === "GET" || method === "HEAD" ? undefined : "{}",
			});
			await res.text();
			if (res.status >= 500) throw new Error(`${method} /api/${first}/${segs.join("/")} -> ${res.status}`);
		},
		{ normal: 200 },
	);
});

// ---------------------------------------------------------------- the request guard

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const hostName = fc.oneof(
	fc.constantFrom(
		"evil.com",
		"127.0.0.1.evil.com",
		"localhost.evil.com",
		"localhost.",
		"0.0.0.0",
		"127.0.0.2",
		"[::2]",
		"::1",
		"10.0.0.1",
		"evil.com:80",
		"xn--e1afmkfd.xn--p1ai",
		"127.0.0.1@evil.com",
		"localhost%00",
		"LOCALHOST.evil.com",
	),
	fc.domain(),
	fc.ipV4(),
	text,
);
const maybePort = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });

describe("apiRequestRejected", () => {
	// header values a real client cannot send (non-Latin-1, control characters) make the Request constructor throw: not a case
	const build = (method: string, path: string, headers: Record<string, string>, withBody: boolean) => {
		try {
			return new Request(`http://127.0.0.1:23120${path}`, {
				method,
				headers,
				body: withBody && method !== "GET" && method !== "HEAD" ? "{}" : undefined,
			});
		} catch {
			return fc.pre(false) as never;
		}
	};

	fuzz(
		"a Host that is not loopback is always rejected",
		[
			hostName,
			maybePort,
			fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH"),
			fc.constantFrom("/api/items", "/api/", "/api/io/import", "/api/websync/connect"),
		],
		(h, p, method, path) => {
			const host = p ? `${h}:${p}` : h;
			const hostOnly = host.replace(/:\d+$/, "").toLowerCase();
			// an empty Host is not something a browser sends (and fetch of http://:80 is not a URL)
			fc.pre(!LOOPBACK.includes(hostOnly) && hostOnly.trim() !== "");
			const req = build(method, path, { host, "content-type": "application/json" }, true);
			expect(apiRequestRejected(req)).not.toBeNull();
		},
		{ normal: 400 },
	);

	fuzz(
		"loopback hosts pass for reads, with any port, in any case",
		[fc.constantFrom(...LOOPBACK), maybePort, fc.boolean()],
		(h, p, upper) => {
			const host = `${upper ? h.toUpperCase() : h}${p ? `:${p}` : ""}`;
			expect(apiRequestRejected(build("GET", "/api/items", { host }, false))).toBeNull();
		},
	);

	fuzz(
		"a write from another origin or with a non-JSON body is rejected",
		[
			fc.constantFrom("POST", "PUT", "PATCH", "DELETE"),
			fc.oneof(
				fc.constantFrom(
					"null",
					"http://evil.com",
					"https://127.0.0.1:23120",
					"http://127.0.0.1:23121",
					"http://localhost:23120",
					"file://",
					"http://127.0.0.1.evil.com:23120",
					"http://127.0.0.1:23120/x",
				),
				text,
			),
			fc.constantFrom(
				"text/plain",
				"application/x-www-form-urlencoded",
				"multipart/form-data; boundary=x",
				"application/jsonx",
				"text/json",
				"",
				"application/json+evil",
				"application/octet-stream",
				"application/json",
			),
			fc.constantFrom("/api/items", "/api/io/import", "/api/websync/key"),
		],
		(method, origin, type, path) => {
			fc.pre(origin.trim() !== ""); // browsers never send an empty Origin (and header values are trimmed)
			const sameOrigin = origin === "http://127.0.0.1:23120";
			const jsonType = type.split(";")[0]!.trim().toLowerCase() === "application/json";
			const headers: Record<string, string> = { host: "127.0.0.1:23120", origin };
			if (type) headers["content-type"] = type;
			const rejected = apiRequestRejected(build(method, path, headers, true));
			if (!sameOrigin) expect(rejected).not.toBeNull();
			else if (!jsonType) expect(rejected).not.toBeNull();
			else expect(rejected).toBeNull();
		},
		{ normal: 300 },
	);

	fuzz(
		"anything outside /api is not this guard's business; reads and writes inside it follow the rules, whatever the path looks like",
		[fc.array(pathKey, { maxLength: 3 }), fc.constantFrom("GET", "POST", "DELETE")],
		(segs, method) => {
			const path = `/${segs.map((s) => encodeURIComponent(s.toWellFormed())).join("/")}`;
			const req = build(method, path, { host: "evil.com", origin: "http://evil.com", "content-type": "text/plain" }, true);
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return;
			}
			const inApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
			expect(apiRequestRejected(req) !== null).toBe(inApi);
		},
		{ normal: 200 },
	);

	fuzz(
		"encoded and dotted paths cannot reach /api around the guard",
		[
			fc.constantFrom(
				"/api/items",
				"/%61pi/items",
				"/./api/items",
				"/x/../api/items",
				"//api/items",
				"/api%2fitems",
				"/API/items",
				"/api/../api/items",
				"/api\\items",
				"/api;x/items",
			),
		],
		(path) => {
			const req = build("POST", path, { host: "evil.com", "content-type": "application/json" }, true);
			const url = new URL(req.url);
			const reachesHandleApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
			// whatever handleApi would see as /api must have been rejected for this foreign Host
			if (reachesHandleApi) expect(apiRequestRejected(req)).not.toBeNull();
		},
	);

	fuzz(
		"the /mcp guard rejects non-loopback hosts and foreign origins too",
		[
			hostName,
			maybePort,
			fc.option(fc.oneof(fc.constantFrom("http://evil.com", "null", "http://127.0.0.1:23121"), text), { nil: undefined }),
		],
		(h, p, origin) => {
			const host = p ? `${h}:${p}` : h;
			const hostOnly = host.replace(/:\d+$/, "").toLowerCase();
			fc.pre(
				!LOOPBACK.includes(hostOnly) &&
					!["::1"].includes(hostOnly) &&
					host.trim() !== "" &&
					!host.includes(":") === !host.startsWith("["),
			);
			const headers: Record<string, string> = { host };
			if (origin !== undefined) headers.origin = origin;
			let req: Request;
			try {
				req = new Request("http://127.0.0.1:23120/mcp", { method: "POST", headers, body: "{}" });
			} catch {
				return;
			}
			try {
				expect(checkRequestOrigin(req)).not.toBeNull();
			} catch (e) {
				throw new Error(`host ${JSON.stringify(host)} origin ${JSON.stringify(origin)}: ${describeError(e)}`, { cause: e });
			}
		},
		{ normal: 300 },
	);

	test("regression: shapes the fuzzer sent that used to be a 500 are a 400", async () => {
		const call = async (method: string, path: string, body: unknown) =>
			(await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
		// the fuzz run above may have deleted the shared collection: make one
		const coll = (await (
			await fetch(`${base}/api/collections`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "regression" }),
			})
		).json()) as { key: string };
		expect(await call("PATCH", `/api/items/${keys.item}`, { data: { collections: {} } })).toBe(400);
		expect(await call("PATCH", `/api/items/${keys.item}`, { data: { tags: [null] } })).toBe(400);
		expect(await call("POST", "/api/items", { data: { itemType: "book", creators: "x" } })).toBe(400);
		expect(await call("POST", "/api/items", { data: { itemType: "book", title: { a: 1 } } })).toBe(400);
		expect(await call("POST", "/api/collections", { name: {} })).toBe(400);
		expect(await call("POST", "/api/collections", "x")).toBe(400);
		expect(await call("PATCH", `/api/collections/${coll.key}`, 123)).toBe(400);
		expect(await call("PATCH", `/api/collections/${coll.key}`, { parentKey: {} })).toBe(400);
	});

	test("regression: a request with no Host header is not a browser request and passes (documented)", () => {
		expect(apiRequestRejected(new Request("http://127.0.0.1:23120/api/items"))).toBeNull();
	});
});
