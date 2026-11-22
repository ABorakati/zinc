// The Office.js Word add-in's access to /api: its task pane (an https page) may call this server across origins, for GET and
// POST only; every other web page is still refused. And POST /api/items/by-uri, which the add-in uses to follow merged items.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db";
import { identityAliases } from "../src/items-by-uri";
import { startServer } from "../src/server";
import { insertItem, tempDir } from "./fixture";

const PANE = "https://localhost:44321";
let srv: ReturnType<typeof startServer>;
let base: string;

beforeAll(() => {
	const dir = tempDir();
	const dbPath = join(dir, "lib.sqlite");
	const db = openDb(dbPath);
	insertItem(db, {
		key: "NEWKEY01",
		itemType: "journalArticle",
		title: "The kept copy of a merged duplicate",
		relations: { "dc:replaces": ["http://zotero.org/users/5106252/items/OLDKEY01"] },
	} as any);
	insertItem(db, { key: "PLAIN001", itemType: "journalArticle", title: "Unrelated" } as any);
	db.close();
	srv = startServer({ dbPath, port: 0 });
	base = srv.url;
});
afterAll(() => srv.stop());

const preflight = (origin: string, method: string, extra: Record<string, string> = {}) =>
	fetch(`${base}/api/items/by-uri`, {
		method: "OPTIONS",
		headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "content-type", ...extra },
	});
const post = (origin: string | null, path: string, body: unknown) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
		body: JSON.stringify(body),
	});

describe("task pane cross-origin access", () => {
	test("the preflight is granted to the task pane only, for GET and POST, with Private Network Access", async () => {
		const ok = await preflight(PANE, "POST", { "Access-Control-Request-Private-Network": "true" });
		expect(ok.status).toBe(204);
		expect(ok.headers.get("access-control-allow-origin")).toBe(PANE);
		expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST");
		expect(ok.headers.get("access-control-allow-headers")).toBe("Content-Type");
		expect(ok.headers.get("access-control-allow-private-network")).toBe("true");
		const noPna = await preflight(PANE, "GET");
		expect(noPna.headers.get("access-control-allow-private-network")).toBeNull();
		expect((await preflight(PANE, "DELETE")).status).toBe(403);
		const other = await preflight("https://evil.example", "POST");
		expect(other.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("responses carry the task pane's origin, and no one else's", async () => {
		const pane = await fetch(`${base}/api/libraries`, { headers: { Origin: PANE } });
		expect(pane.status).toBe(200);
		expect(pane.headers.get("access-control-allow-origin")).toBe(PANE);
		expect(pane.headers.get("vary")).toContain("Origin");
		const web = await fetch(`${base}/api/libraries`, { headers: { Origin: "https://evil.example" } });
		expect(web.headers.get("access-control-allow-origin")).toBeNull();
		const same = await fetch(`${base}/api/libraries`);
		expect(same.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("a POST from the task pane is allowed; from another web page, or a non-POST change, it is refused", async () => {
		expect((await post(PANE, "/api/items/by-uri", { uris: [] })).status).toBe(200);
		expect((await post("https://evil.example", "/api/items/by-uri", { uris: [] })).status).toBe(403);
		const del = await fetch(`${base}/api/items/PLAIN001`, { method: "DELETE", headers: { Origin: PANE } });
		expect(del.status).toBe(403); // only GET and POST across origins
		const put = await fetch(`${base}/api/collections`, {
			method: "PUT",
			headers: { Origin: PANE, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(put.status).toBe(403);
		expect((await fetch(`${base}/api/items/PLAIN001`)).status).toBe(200); // still there
	});
});

describe("POST /api/items/by-uri", () => {
	test("a cited URI whose key was merged away maps to the item that replaced it", async () => {
		const r = await post(PANE, "/api/items/by-uri", {
			uris: ["http://zotero.org/users/5106252/items/OLDKEY01", "http://zotero.org/users/5106252/items/NOTHERE1", "not a uri", 42],
		});
		expect(await r.json()).toEqual({ "http://zotero.org/users/5106252/items/OLDKEY01": "NEWKEY01" });
	});

	test("a citation made with the local library URI finds it through the account's alias", async () => {
		const r = await post(PANE, "/api/items/by-uri", {
			uris: ["http://zotero.org/users/local/abcdEFGH/items/OLDKEY01"],
			userId: "5106252",
		});
		expect(await r.json()).toEqual({ "http://zotero.org/users/local/abcdEFGH/items/OLDKEY01": "NEWKEY01" });
	});

	test("bad bodies and methods", async () => {
		expect(await (await post(PANE, "/api/items/by-uri", { uris: "x" })).json()).toEqual({});
		expect((await fetch(`${base}/api/items/by-uri`)).status).toBe(405);
	});

	test("identity aliases", () => {
		expect(identityAliases("http://zotero.org/users/5106252/items/ABCD1234", "LOCALKEY", "5106252")).toEqual([
			"http://zotero.org/users/5106252/items/ABCD1234",
			"http://zotero.org/users/local/LOCALKEY/items/ABCD1234",
		]);
		expect(identityAliases("https://www.zotero.org/groups/77/items/ABCD1234/", "LOCALKEY", "1")).toEqual([
			"http://zotero.org/groups/77/items/ABCD1234",
		]);
		expect(identityAliases("http://example.com/items/ABCD1234", null, null)).toEqual([]);
	});
});
