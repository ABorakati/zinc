// Unit tests for src/services (all 14 non-document methods + helpers + Zinc-not-running error paths).
// Uses fake-core.ts (Bun.serve({ port: 0 })) — never touches real library files or ports 23119 / 23120.

import { afterEach, describe, expect, test } from "bun:test";
import type { HostContext } from "../../src/contracts";
import {
	SETTINGS_STORAGE_KEY,
	ZincUnavailableError,
	createServiceMethods,
	dirOf,
	ftsMatchToQuery,
	identityAliases,
} from "../../src/services";
import { SAMPLE_EN_US_LOCALE, SAMPLE_VANCOUVER_CSL, startFakeCore, unusedLocalApiUrl } from "./fake-core";

const noopCtx: HostContext = { emit() {} };

const activeServers: { stop(): void }[] = [];
const savedGlobals: { Office?: unknown; localStorage?: unknown; window?: unknown } = {};

function trackServer<T extends { stop(): void }>(s: T): T {
	activeServers.push(s);
	return s;
}

afterEach(() => {
	while (activeServers.length > 0) activeServers.pop()!.stop();
	delete (globalThis as any).Office;
	delete (globalThis as any).localStorage;
	delete (globalThis as any).window;
	Object.assign(globalThis, savedGlobals);
});

function makeFakeLocalStorage(initial: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(initial));
	return {
		map,
		storage: {
			get length() {
				return map.size;
			},
			clear: () => map.clear(),
			getItem: (k: string) => map.get(k) ?? null,
			key: (i: number) => [...map.keys()][i] ?? null,
			removeItem: (k: string) => {
				map.delete(k);
			},
			setItem: (k: string, v: string) => {
				map.set(k, String(v));
			},
		} satisfies Storage,
	};
}

describe("pure helpers", () => {
	test("dirOf handles Windows, POSIX, root and bare names without node:path", () => {
		expect(dirOf("C:\\Users\\alice\\Zinc\\library.sqlite")).toBe("C:\\Users\\alice\\Zinc");
		expect(dirOf("C:\\library.sqlite")).toBe("C:\\");
		expect(dirOf("/Users/alice/Zinc/library.sqlite")).toBe("/Users/alice/Zinc");
		expect(dirOf("/library.sqlite")).toBe("/");
		expect(dirOf("library.sqlite")).toBe("");
		expect(dirOf("")).toBe("");
	});

	test("identityAliases matches Library.IdentityAliases for personal and group URIs", () => {
		expect(identityAliases("https://www.zotero.org/users/999/items/OLDK0001/", "LK1", "5106252")).toEqual([
			"http://zotero.org/users/999/items/OLDK0001",
			"http://zotero.org/users/local/LK1/items/OLDK0001",
			"http://zotero.org/users/5106252/items/OLDK0001",
		]);
		expect(identityAliases("http://zotero.org/groups/778899/items/GRP00001", "LK1", "5106252")).toEqual([
			"http://zotero.org/groups/778899/items/GRP00001",
		]);
		expect(identityAliases("https://example.com/not-zotero")).toEqual([]);
	});

	test("ftsMatchToQuery converts sidebar FTS5 expressions back into core search queries", () => {
		expect(ftsMatchToQuery('{title creators abstract publication tags} : ("liver" "trans"*)')).toBe('"liver" trans*');
		expect(ftsMatchToQuery('{title creators abstract publication tags} : ("liver")')).toBe('"liver"');
		expect(ftsMatchToQuery('{title creators abstract publication tags} : ("graft survival")')).toBe('"graft survival"');
		expect(ftsMatchToQuery('"multi word"*')).toBe('"multi" word*');
	});
});

describe("settings.get and settings.set", () => {
	test("persists via Office.context.roamingSettings when available, enforces PageKeys and removal semantics", async () => {
		const bag = new Map<string, unknown>();
		let saveCalls = 0;
		(globalThis as any).Office = {
			AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
			context: {
				roamingSettings: {
					get: (k: string) => bag.get(k),
					set: (k: string, v: unknown) => bag.set(k, v),
					saveAsync: (cb: (r: { status: string }) => void) => {
						saveCalls++;
						cb({ status: "succeeded" });
					},
				},
			},
		};
		const methods = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		expect(await methods["settings.get"]!({})).toEqual({});

		const updated = await methods["settings.set"]!({
			style: "apa",
			locale: "en-GB",
			noteType: 2,
			autoUpdate: false,
			dbPath: "/tmp/lib.sqlite",
			userId: "5106252",
		});
		expect(updated).toEqual({
			style: "apa",
			locale: "en-GB",
			noteType: 2,
			autoUpdate: false,
			dbPath: "/tmp/lib.sqlite",
			userId: "5106252",
		});
		expect(saveCalls).toBe(1);
		expect(await methods["settings.get"]!({})).toEqual(updated);

		// Empty string and null delete keys just like Settings.Patch in Settings.cs
		const cleared = await methods["settings.set"]!({ locale: "", dbPath: null });
		expect(cleared).toEqual({
			style: "apa",
			noteType: 2,
			autoUpdate: false,
			userId: "5106252",
		});

		// Protected keys are rejected without mutating stored settings
		for (const forbidden of ["apiBase", "launcher", "detectedUserId", "mcp"]) {
			await expect(methods["settings.set"]!({ [forbidden]: "x" })).rejects.toThrow(
				`setting not changeable from the sidebar: ${forbidden}`,
			);
		}
		// Non-primitive values are rejected without mutating stored settings
		await expect(methods["settings.set"]!({ style: { nested: true } })).rejects.toThrow(
			"setting style must be a string, number or boolean",
		);
		await expect(methods["settings.set"]!({ noteType: Number.NaN })).rejects.toThrow(
			"setting noteType must be a string, number or boolean",
		);
		expect(await methods["settings.get"]!({})).toEqual(cleared);
	});

	test("propagates roamingSettings.saveAsync failures", async () => {
		(globalThis as any).Office = {
			context: {
				roamingSettings: {
					get: () => undefined,
					set: () => {},
					saveAsync: (cb: (r: { status: string; error: { message: string } }) => void) =>
						cb({ status: "failed", error: { message: "Quota exceeded" } }),
				},
			},
		};
		const methods = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		await expect(methods["settings.set"]!({ style: "nature" })).rejects.toThrow("Quota exceeded");
	});

	test("falls back to localStorage when roamingSettings is absent, tolerating corrupt JSON and reading apiBase", async () => {
		const core = trackServer(startFakeCore());
		const { map, storage } = makeFakeLocalStorage({ [SETTINGS_STORAGE_KEY]: "{not-json" });
		(globalThis as any).localStorage = storage;

		const methods = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		expect(await methods["settings.get"]!({})).toEqual({});

		// Pre-configured apiBase (with trailing slash) in localStorage directs HTTP calls to fake core
		map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ apiBase: `${core.url}/`, style: "vancouver" }));
		const zn = (await methods["zn.status"]!({})) as { up: boolean; api: string };
		expect(zn.up).toBe(true);
		expect(zn.api).toBe(core.url);

		await methods["settings.set"]!({ style: "nature" });
		expect(JSON.parse(map.get(SETTINGS_STORAGE_KEY)!)).toEqual({ apiBase: `${core.url}/`, style: "nature" });
	});
});

describe("host.info and lib.uriBase", () => {
	test("host.info light=true skips item count and zn probe; full host.info includes both", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		const light = (await methods["host.info"]!({ light: true })) as any;
		expect(light).toEqual({
			version: "0.1.0",
			library: {
				dbPath: "C:\\FakeZinc\\library.sqlite",
				dbExists: true,
				dataDir: "C:\\FakeZinc",
				libraryKey: "LIBKEY99",
			},
			uri: {
				base: "http://zotero.org/users/5106252",
				userId: "5106252",
				source: "detected",
			},
			settings: { detectedUserId: "5106252" },
			zn: { up: false, api: core.url, launcher: "", launcherExists: false },
		});
		expect(core.requests.some((r) => r.pathname === "/api/ui/selection")).toBe(false);
		expect(core.requests.some((r) => r.pathname === "/api/library" && r.search === "?count=0")).toBe(true);

		const full = (await methods["host.info"]!({})) as any;
		expect(full.library.items).toBe(4); // AAAA1111, BBBB2222, PDFONLY1, GRP00001 (excludes attachment, note, trashed)
		expect(full.zn).toEqual({ up: true, api: core.url, launcher: "", launcherExists: false });
	});

	test("host.info falls back to /api/files/settings + /api/websync/status + /api/items when /api/library is 404", async () => {
		const core = trackServer(startFakeCore({ disableLibraryEndpoint: true }));
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });
		const info = (await methods["host.info"]!({})) as any;
		expect(info.library.dbExists).toBe(true);
		expect(info.library.dbPath).toBe("C:\\FakeZinc\\library.sqlite");
		expect(typeof info.library.items).toBe("number");
		expect(info.uri).toEqual({ base: "http://zotero.org/users/5106252", userId: "5106252", source: "detected" });
	});

	test("lib.uriBase honours settings.userId, detectedUserId, libraryKey, and znlocal0 when Zinc is down", async () => {
		const coreLocal = trackServer(startFakeCore({ userId: null, libraryKey: "MYLOCAL8" }));
		const mLocal = createServiceMethods(noopCtx, { defaultApiBase: coreLocal.url });
		expect(await mLocal["lib.uriBase"]!({})).toEqual({
			base: "http://zotero.org/users/local/MYLOCAL8",
			userId: null,
			source: "local",
		});

		await mLocal["settings.set"]!({ userId: "998877" });
		expect(await mLocal["lib.uriBase"]!({})).toEqual({
			base: "http://zotero.org/users/998877",
			userId: "998877",
			source: "settings",
		});

		// Zinc not running: neither host.info nor lib.uriBase throws
		const downUrl = unusedLocalApiUrl();
		const mDown = createServiceMethods(noopCtx, { defaultApiBase: downUrl });
		expect(await mDown["lib.uriBase"]!({})).toEqual({
			base: "http://zotero.org/users/local/znlocal0",
			userId: null,
			source: "local",
		});
		const downInfo = (await mDown["host.info"]!({})) as any;
		expect(downInfo.library.dbExists).toBe(false);
		expect(downInfo.library.error).toContain("Cannot reach Zinc");
		expect(downInfo.zn.up).toBe(false);
	});
});

describe("lib.search, lib.items, lib.byUri", () => {
	test("lib.search supports empty (recent across libraries), FTS match (+ year), DOI, and year queries", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		// Empty query: recent regular items across My Library + group library, newest first, no notes/attachments/trashed
		const recent = (await methods["lib.search"]!({ limit: 10 })) as any[];
		expect(recent.map((r) => r.key)).toEqual(["GRP00001", "BBBB2222", "AAAA1111", "PDFONLY1"]);
		expect(recent[2]).toEqual({
			key: "AAAA1111",
			title: "Outcomes after liver transplantation in the United Kingdom",
			creators: "Smith and Haddad",
			year: 2021,
			publication: "Transplantation",
			itemType: "journalArticle",
			doi: "10.1000/tx.2021.001",
		});

		// FTS match: excludes fulltext-only hits (PDFONLY1) and ranks metadata hits
		const fts = (await methods["lib.search"]!({
			match: '{title creators abstract publication tags} : ("liver"*)',
			limit: 30,
		})) as any[];
		expect(fts.map((r) => r.key)).toEqual(["AAAA1111", "BBBB2222"]);

		// FTS match + year filter
		const ftsYear = (await methods["lib.search"]!({
			match: '{title creators abstract publication tags} : ("liver"*)',
			year: 2019,
			limit: 30,
		})) as any[];
		expect(ftsYear.map((r) => r.key)).toEqual(["BBBB2222"]);

		// DOI shortcut (case-insensitive)
		const byDoi = (await methods["lib.search"]!({ doi: "10.1000/TX.2021.001", limit: 30 })) as any[];
		expect(byDoi.map((r) => r.key)).toEqual(["AAAA1111"]);

		// Year-only query
		const byYear = (await methods["lib.search"]!({ year: 2019, limit: 30 })) as any[];
		expect(byYear.map((r) => r.key)).toEqual(["BBBB2222"]);

		// Limit clamping (0 -> 1)
		const clamped = (await methods["lib.search"]!({ limit: 0 })) as any[];
		expect(clamped.length).toBe(1);
	});

	test("lib.items resolves regular, group, trashed, child->parent, missing, duplicate and invalid keys", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		expect(await methods["lib.items"]!({ keys: [] })).toEqual([]);
		expect(core.requests.length).toBe(0);

		const out = (await methods["lib.items"]!({
			keys: ["AAAA1111", "AAAA1111", "bad key!", "", "CHLD1111", "TRSH1111", "GRP00001", "ORPH1111", "ZZZZ9999"],
		})) as any[];

		expect(out.map((r) => ({ key: r.key, found: r.found, itemKey: r.itemKey, trashed: r.trashed, groupId: r.groupId }))).toEqual([
			{ key: "AAAA1111", found: true, itemKey: "AAAA1111", trashed: false, groupId: null },
			{ key: "CHLD1111", found: true, itemKey: "AAAA1111", trashed: false, groupId: null },
			{ key: "TRSH1111", found: true, itemKey: "TRSH1111", trashed: true, groupId: null },
			{ key: "GRP00001", found: true, itemKey: "GRP00001", trashed: false, groupId: 778899 },
			{ key: "ORPH1111", found: false, itemKey: undefined, trashed: undefined, groupId: undefined },
			{ key: "ZZZZ9999", found: false, itemKey: undefined, trashed: undefined, groupId: undefined },
		]);
		expect(out[0].data.title).toBe("Outcomes after liver transplantation in the United Kingdom");
		expect(out[1].itemType).toBe("journalArticle");
	});

	test("lib.byUri resolves merged items across identity aliases", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		expect(await methods["lib.byUri"]!({ uris: [] })).toEqual({});
		const map = await methods["lib.byUri"]!({
			uris: ["http://zotero.org/users/5106252/items/OLDK0001", "http://zotero.org/users/5106252/items/UNKNOWN1"],
		});
		expect(map).toEqual({
			"http://zotero.org/users/5106252/items/OLDK0001": "AAAA1111",
		});
	});

	test("lib.* methods throw ZincUnavailableError when Zinc is not running", async () => {
		const down = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		await expect(down["lib.search"]!({ limit: 5 })).rejects.toBeInstanceOf(ZincUnavailableError);
		await expect(down["lib.items"]!({ keys: ["AAAA1111"] })).rejects.toBeInstanceOf(ZincUnavailableError);
		await expect(down["lib.byUri"]!({ uris: ["http://zotero.org/users/1/items/AAAA1111"] })).rejects.toBeInstanceOf(
			ZincUnavailableError,
		);
	});
});

describe("style.search, style.xml, locale.xml", () => {
	test("style.search maps CiteStyleInfo to C# shape for empty (quick=1) and query searches", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		const defaults = await methods["style.search"]!({ q: "", limit: 40 });
		expect(defaults).toEqual([
			{ id: "vancouver", title: "Vancouver", format: "numeric", dependent: false, installed: true },
			{
				id: "apa",
				title: "American Psychological Association 7th edition",
				format: "author-date",
				dependent: false,
				installed: true,
			},
		]);
		expect(core.requests.at(-1)?.search).toBe("?quick=1&limit=40");

		const queried = await methods["style.search"]!({ q: "lancet", limit: 10 });
		expect(queried).toEqual([{ id: "the-lancet", title: "The Lancet", format: null, dependent: true, installed: false }]);
		expect(core.requests.at(-1)?.search).toBe("?q=lancet&limit=10");
	});

	test("style.xml validates style ids, returns CSL XML, and surfaces 404 / down errors", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		await expect(methods["style.xml"]!({ id: "../evil" })).rejects.toThrow("invalid style id: ../evil");
		await expect(methods["style.xml"]!({})).rejects.toThrow("invalid style id: ");
		expect(core.requests.length).toBe(0);

		const res = await methods["style.xml"]!({ id: "vancouver" });
		expect(res).toEqual({ id: "vancouver", xml: SAMPLE_VANCOUVER_CSL });

		await expect(methods["style.xml"]!({ id: "nonexistent-style" })).rejects.toThrow('style "nonexistent-style" not found');

		const down = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		await expect(down["style.xml"]!({ id: "vancouver" })).rejects.toBeInstanceOf(ZincUnavailableError);
		await expect(down["style.search"]!({ q: "" })).rejects.toBeInstanceOf(ZincUnavailableError);
	});

	test("locale.xml returns XML for known locales, null for invalid/missing locales, and throws when Zinc is down", async () => {
		const core = trackServer(startFakeCore());
		const methods = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		expect(await methods["locale.xml"]!({ lang: "bad_locale!" })).toEqual({ lang: "bad_locale!", xml: null });
		expect(await methods["locale.xml"]!({})).toEqual({ lang: null, xml: null });
		expect(core.requests.length).toBe(0);

		expect(await methods["locale.xml"]!({ lang: "en-US" })).toEqual({ lang: "en-US", xml: SAMPLE_EN_US_LOCALE });
		expect(await methods["locale.xml"]!({ lang: "af-ZA" })).toEqual({ lang: "af-ZA", xml: null });

		const down = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		await expect(down["locale.xml"]!({ lang: "en-US" })).rejects.toBeInstanceOf(ZincUnavailableError);
	});
});

describe("zn.status, zn.lookup, zn.reveal", () => {
	test("zn.status and zn.lookup handle running, missing, and down states without throwing", async () => {
		const core = trackServer(startFakeCore());
		const up = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		expect(await up["zn.status"]!({})).toEqual({ up: true, api: core.url, launcher: "", launcherExists: false });
		expect(await up["zn.lookup"]!({ doi: "" })).toBeNull();
		expect(await up["zn.lookup"]!({ doi: "10.1000/unknown" })).toBeNull();
		const detail = (await up["zn.lookup"]!({ doi: "10.1000/tx.2021.001" })) as any;
		expect(detail.abstract).toContain("Fetched online abstract");

		const downUrl = unusedLocalApiUrl();
		const down = createServiceMethods(noopCtx, { defaultApiBase: downUrl });
		expect(await down["zn.status"]!({})).toEqual({ up: false, api: downUrl, launcher: "", launcherExists: false });
		expect(await down["zn.lookup"]!({ doi: "10.1000/tx.2021.001" })).toBeNull();
	});

	test("zn.reveal posts {key, open: true}, handles missing items, old Zinc 404, and Zinc not running", async () => {
		const core = trackServer(startFakeCore());
		const up = createServiceMethods(noopCtx, { defaultApiBase: core.url });

		expect(await up["zn.reveal"]!({ key: "AAAA1111" })).toEqual({ ok: true, started: false });
		expect(core.requests.at(-1)?.body).toEqual({ key: "AAAA1111", open: true });

		expect(await up["zn.reveal"]!({ key: "ZZZZ9999" })).toEqual({
			ok: false,
			started: false,
			error: "item not found",
		});

		const oldCore = trackServer(startFakeCore({ oldRevealNotFound: true }));
		const oldSvc = createServiceMethods(noopCtx, { defaultApiBase: oldCore.url });
		expect(await oldSvc["zn.reveal"]!({ key: "AAAA1111" })).toEqual({
			ok: false,
			started: false,
			error: "the running Zinc is too old to reveal items (update/restart it)",
		});

		const down = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		const downRes = (await down["zn.reveal"]!({ key: "AAAA1111" })) as { ok: boolean; started: boolean; error?: string };
		expect(downRes.ok).toBe(false);
		expect(downRes.started).toBe(false);
		expect(downRes.error).toContain("Zinc is not running");
	});
});

describe("app.openUrl", () => {
	test("uses Office.context.ui.openBrowserWindow when available, else window.open, and rejects non-http(s) URLs", async () => {
		const officeOpened: string[] = [];
		(globalThis as any).Office = {
			context: { ui: { openBrowserWindow: (u: string) => officeOpened.push(u) } },
		};
		const methods = createServiceMethods(noopCtx, { defaultApiBase: unusedLocalApiUrl() });
		expect(await methods["app.openUrl"]!({ url: "https://doi.org/10.1000/tx.2021.001" })).toEqual({ ok: true });
		expect(await methods["app.openUrl"]!({ url: "http://example.org/paper" })).toEqual({ ok: true });
		expect(officeOpened).toEqual(["https://doi.org/10.1000/tx.2021.001", "http://example.org/paper"]);

		// Fallback to window.open when Office.context.ui.openBrowserWindow is unavailable
		delete (globalThis as any).Office;
		const winOpened: unknown[][] = [];
		(globalThis as any).window = { open: (...args: unknown[]) => winOpened.push(args) };
		expect(await methods["app.openUrl"]!({ url: "https://zotero.org" })).toEqual({ ok: true });
		expect(winOpened).toEqual([["https://zotero.org", "_blank", "noopener,noreferrer"]]);

		// Reject non-http(s) schemes and malformed URLs
		for (const bad of ["", "javascript:alert(1)", "file:///C:/Windows/win.ini", "ftp://example.com/a", "data:text/html,hi"]) {
			await expect(methods["app.openUrl"]!({ url: bad })).rejects.toThrow("only http(s) links can be opened");
		}
		await expect(methods["app.openUrl"]!({ url: "https://example.com/has space" })).rejects.toThrow("invalid url");
	});
});
