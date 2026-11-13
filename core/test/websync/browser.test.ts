// websync in a browser worker: a fetch that behaves like a browser's (hidden redirects), the fileRedirect option, the data folder
// for the browser library, and the default key store hook. The browser itself is not involved: browserFetch copies its rules.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { getDefaultKeyStore, MemoryKeyStore, setDefaultKeyStore, bunKeyStore } from "../../src/websync/keystore";
import { downloadOne, importedAttachments, OPAQUE_REDIRECT_MESSAGE } from "../../src/websync/files";
import { BROWSER_DATA_DIR, BROWSER_DB_FILE, resolveDataDir, WebSyncService } from "../../src/websync/service";
import { tempDir } from "../fixture";
import { API_KEY, MockZotero } from "./mock";
import { stopAll } from "./rig";

afterEach(stopAll);

interface Seen {
	url: string;
	hasKey: boolean;
}

/**
 * fetch as a browser gives it to extension code: redirect "manual" returns an opaque response (type "opaqueredirect", status 0, no
 * headers); "follow" follows and re-sends the request headers to the redirect target (custom headers survive a cross-origin redirect)
 * unless the DNR rule is on, which removes Zotero-API-Key for every host but api.zotero.org (here: the mock's API origin).
 */
function browserFetch(apiOrigin: string, opts: { dnr: boolean }) {
	const seen: Seen[] = [];
	const real = globalThis.fetch;
	const f = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input);
		const headers = new Headers(init.headers);
		const send = (u: URL, h: Headers, redirect: RequestRedirect) => {
			const out = new Headers(h);
			// (the mock serves its file host on the API's origin under /blob and /upload: those count as another domain)
			const isApi = u.origin === apiOrigin && !/^\/(blob|upload)\//.test(u.pathname);
			if (opts.dnr && !isApi) out.delete("Zotero-API-Key");
			seen.push({ url: u.href, hasKey: out.has("Zotero-API-Key") });
			return real(u, { ...init, headers: out, redirect });
		};
		const first = await send(url, headers, "manual");
		if (first.status < 300 || first.status >= 400) return first;
		if ((init.redirect ?? "follow") === "manual") {
			const opaque = new Response(null, { status: 200 });
			Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
			Object.defineProperty(opaque, "status", { value: 0 });
			return opaque;
		}
		return send(new URL(first.headers.get("location")!, url), headers, "follow");
	};
	return { fetch: f as typeof fetch, seen };
}

function setup(o: { redirect?: "manual" | "follow"; dnr?: boolean } = {}) {
	const mock = new MockZotero();
	const dir = tempDir();
	const db = openDb(join(dir, "lib.sqlite"));
	const bf = browserFetch(new URL(mock.url).origin, { dnr: o.dnr ?? true });
	const keys = new MemoryKeyStore(null);
	const svc = new WebSyncService(db, {
		keyStore: keys,
		apiBase: () => mock.url, // (no process.env: a worker has none)
		fetch: bf.fetch,
		fileRedirect: o.redirect,
		dataDir: dir,
		pollMs: 0,
		initialSync: false,
		sleep: async () => {},
	});
	const stop = () => {
		mock.stop();
		db.close();
	};
	return { mock, dir, db, svc, keys, bf, stop };
}

const text = (s: string) => new TextEncoder().encode(s);

function library(mock: MockZotero) {
	mock.put("collection", "COLL0001", { name: "Reading" });
	mock.put("item", "PARENT01", { title: "Parent", collections: ["COLL0001"] });
	mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt" });
	mock.put("item", "PARENT02", { title: "Second" });
	mock.files.set("ATT00001", text("browser file"));
}

describe("websync with a browser-like fetch", () => {
	test("follow: pulls a library, downloads a file into <storage>/<KEY>/<name>, and the API key never reaches the file host", async () => {
		const t = setup({ redirect: "follow" });
		try {
			await t.svc.setKey(API_KEY);
			library(t.mock);
			await t.svc.setOptions({ files: "download" });
			await t.svc.syncNow();
			await t.svc.fileJobDone;
			expect((await t.svc.status()).lastError).toBeUndefined();
			expect((t.db.query("SELECT count(*) AS n FROM items WHERE library_id = 1").get() as { n: number }).n).toBe(3);
			expect(readFileSync(join(t.dir, "storage", "ATT00001", "one.txt"), "utf8")).toBe("browser file");
			expect((await t.svc.status()).fileJob).toMatchObject({ total: 1, done: 1, failed: 0, running: false });
			const blob = t.bf.seen.filter((s) => s.url.includes("/blob/"));
			expect(blob).toHaveLength(1);
			expect(blob[0].hasKey).toBe(false);
			expect(t.bf.seen.filter((s) => !s.url.includes("/blob/")).every((s) => s.hasKey)).toBe(true);
		} finally {
			t.stop();
		}
	});

	test("follow without the DNR rule would leak the key (why the rule is required)", async () => {
		const t = setup({ redirect: "follow", dnr: false });
		try {
			await t.svc.setKey(API_KEY);
			library(t.mock);
			await t.svc.setOptions({ files: "download" });
			await t.svc.syncNow();
			await t.svc.fileJobDone;
			expect(t.bf.seen.find((s) => s.url.includes("/blob/"))!.hasKey).toBe(true);
		} finally {
			t.stop();
		}
	});

	test("manual (the default): the hidden redirect fails with a clear error, nothing is written", async () => {
		const t = setup(); // fileRedirect unset = "manual"
		try {
			await t.svc.setKey(API_KEY);
			library(t.mock);
			await t.svc.setOptions({ files: "download" });
			await t.svc.syncNow();
			await t.svc.fileJobDone;
			expect((await t.svc.status()).fileJob).toMatchObject({ total: 1, done: 0, failed: 1 });
			expect(existsSync(join(t.dir, "storage", "ATT00001"))).toBe(false);
			// the job only counts failures; the error itself is what downloadOne throws
			const att = importedAttachments(t.db).find((a) => a.key === "ATT00001")!;
			const ctx = { db: t.db, client: t.svc.client, userId: 42, storageDir: join(t.dir, "storage") };
			await expect(downloadOne(ctx, att)).rejects.toThrow(OPAQUE_REDIRECT_MESSAGE);
			expect(OPAQUE_REDIRECT_MESSAGE).toMatch(/opaqueredirect.*fileRedirect.*"follow".*Zotero-API-Key/);
		} finally {
			t.stop();
		}
	});

	test("manual: the files check still counts a hidden redirect as 'on the server'", async () => {
		const t = setup();
		try {
			await t.svc.setKey(API_KEY);
			library(t.mock);
			t.db.run("UPDATE attachments SET path = NULL WHERE item_key = 'ATT00001'");
			await t.svc.pull();
			const c = await t.svc.checkFiles();
			expect(c).toMatchObject({ imported: 1, missingLocally: 1, onServer: 1, unknown: 0 });
		} finally {
			t.stop();
		}
	});

	test("upload round trip: a local file goes to the file host without the API key and is registered", async () => {
		const t = setup({ redirect: "follow" });
		try {
			await t.svc.setKey(API_KEY);
			t.mock.put("item", "PARENT01", { title: "P" });
			t.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt" });
			mkdirSync(join(t.dir, "storage", "ATT00001"), { recursive: true });
			writeFileSync(join(t.dir, "storage", "ATT00001", "one.txt"), "local bytes");
			await t.svc.setOptions({ files: "sync" });
			await t.svc.syncNow();
			await t.svc.fileJobDone;
			expect((await t.svc.status()).lastError).toBeUndefined();
			expect(new TextDecoder().decode(t.mock.files.get("ATT00001"))).toBe("local bytes");
			const up = t.bf.seen.find((s) => s.url.includes("/upload/"))!;
			expect(up.hasKey).toBe(false);
		} finally {
			t.stop();
		}
	});
});

describe("data folder", () => {
	const stub = (filename: string) => ({ filename }) as never;

	test("the browser library's database maps to /opfs/zinc, whatever the cwd", () => {
		expect(BROWSER_DB_FILE).toBe("/opfs/zinc/library.sqlite");
		expect(resolveDataDir(stub(BROWSER_DB_FILE))).toBe("/opfs/zinc");
		expect(BROWSER_DATA_DIR + "/storage").toBe("/opfs/zinc/storage");
		const svc = new WebSyncService(stub(BROWSER_DB_FILE), { keyStore: new MemoryKeyStore() });
		expect((svc as unknown as { storageDir: string }).storageDir.replaceAll("\\", "/")).toBe("/opfs/zinc/storage");
	});

	test("an explicit dataDir wins; other files keep their own folder; a worker never calls process.cwd", () => {
		expect(resolveDataDir(stub(BROWSER_DB_FILE), "/x/y")).toBe("/x/y");
		expect(resolveDataDir(stub("/data/lib/library.sqlite")).replaceAll("\\", "/")).toBe("/data/lib");
		const g = globalThis as { WorkerGlobalScope?: unknown };
		const cwd = process.cwd;
		process.cwd = () => {
			throw new Error("process.cwd called in a browser");
		};
		g.WorkerGlobalScope = class {};
		try {
			expect(resolveDataDir(stub(":memory:"))).toBe("/opfs/zinc");
		} finally {
			delete g.WorkerGlobalScope;
			process.cwd = cwd;
		}
	});
});

describe("default key store", () => {
	test("setDefaultKeyStore replaces the keychain for services that name no key store", async () => {
		const before = getDefaultKeyStore();
		expect(before).toBe(bunKeyStore);
		const mem = new MemoryKeyStore("abc");
		setDefaultKeyStore(mem);
		try {
			const dir = tempDir();
			const db = openDb(join(dir, "lib.sqlite"));
			const svc = new WebSyncService(db, { initialSync: false, pollMs: 0 });
			expect((await svc.status()).account.keySet).toBe(true);
			await svc.clearKey();
			expect(mem.value).toBeNull();
			db.close();
		} finally {
			setDefaultKeyStore(before);
		}
	});
});
