// Auto-export: a file on disk follows a library or collection; atomic, debounced, only rewritten when the text changes.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addAutoExport, listAutoExports, removeAutoExport, runAutoExport, setSettings, startAutoExport } from "../../src/bbt";
import { addItemsToCollection, createCollection, createItem, openDb, patchItem } from "../../src/db";
import { tempDir } from "../fixture";
import { handleApi } from "../../src/api";

let db: Database;
let dir: string;
beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "lib.sqlite"));
	setSettings(db, { autoExportDelay: 0.05, autoExportIdle: 0.15 });
});

const paper = (title: string) => ({ itemType: "journalArticle", title, creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }], date: "2020" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("adding and running", () => {
	test("adding an auto-export writes the file straight away", () => {
		createItem(db, paper("Alpha beta gamma"));
		const ae = addAutoExport(db, { path: join(dir, "out", "lib.bib"), format: "betterbiblatex", scope: { type: "library" } });
		expect(ae.status).toBe("done");
		expect(ae.count).toBe(1);
		expect(ae.scopeName).toBe("My Library");
		expect(ae.lastExport).toBeTruthy();
		expect(readFileSync(ae.path, "utf8")).toContain("@article{smithAlphaBetaGamma2020,");
	});

	test("validation: format, absolute path, collection", () => {
		expect(() => addAutoExport(db, { path: join(dir, "a.bib"), format: "ris", scope: { type: "library" } })).toThrow("format");
		expect(() => addAutoExport(db, { path: "relative.bib", format: "betterbibtex", scope: { type: "library" } })).toThrow("absolute");
		expect(() => addAutoExport(db, { path: join(dir, "a.bib"), format: "betterbibtex", scope: { type: "collection", key: "NOPE" } })).toThrow("collection");
	});

	test("a collection scope only writes that collection (and its sub-collections)", () => {
		const a = createItem(db, paper("In collection")).data.key;
		createItem(db, paper("Outside"));
		const c = createCollection(db, "Thesis");
		addItemsToCollection(db, c.key, [a]);
		const ae = addAutoExport(db, { path: join(dir, "c.json"), format: "bettercsljson", scope: { type: "collection", key: c.key } });
		expect(ae.scopeName).toBe("Thesis");
		expect(JSON.parse(readFileSync(ae.path, "utf8"))).toHaveLength(1);
	});

	test("list, export now, remove", () => {
		const ae = addAutoExport(db, { path: join(dir, "x.bib"), format: "betterbibtex", scope: { type: "library" } });
		expect(listAutoExports(db).map((e) => e.id)).toEqual([ae.id]);
		rmSync(ae.path);
		expect(runAutoExport(db, ae.id).status).toBe("done");
		expect(existsSync(ae.path)).toBe(true); // a missing file is written again
		expect(removeAutoExport(db, ae.id)).toBe(true);
		expect(listAutoExports(db)).toEqual([]);
		expect(removeAutoExport(db, ae.id)).toBe(false);
	});

	test("a write failure is reported in the status, not thrown", () => {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const ae = addAutoExport(db, { path: join(blocker, "sub", "lib.bib"), format: "betterbibtex", scope: { type: "library" } });
		expect(ae.status).toBe("error");
		expect(ae.error).toBeTruthy();
	});

	test("writes are atomic: no temp files are left, and an unchanged export does not touch the file", async () => {
		createItem(db, paper("Alpha"));
		const ae = addAutoExport(db, { path: join(dir, "lib.bib"), format: "betterbiblatex", scope: { type: "library" } });
		expect(readdirSync(dirname(ae.path)).filter((f) => f.endsWith(".bbt-tmp"))).toEqual([]);
		const before = statSync(ae.path).mtimeMs;
		await sleep(30);
		runAutoExport(db, ae.id);
		expect(statSync(ae.path).mtimeMs).toBe(before);
	});
});

describe("rewrite on change", () => {
	test("the file is rewritten, debounced, after the library changes", async () => {
		const a = createItem(db, paper("Alpha")).data.key;
		const ae = addAutoExport(db, { path: join(dir, "lib.bib"), format: "betterbiblatex", scope: { type: "library" } });
		const sched = startAutoExport(db, { pollMs: 10, runAtStart: false });
		try {
			let writes = 0;
			const mtimes = new Set<number>();
			patchItem(db, a, { title: "Bravo" });
			patchItem(db, a, { title: "Charlie" });
			patchItem(db, a, { title: "Delta" }); // three quick edits...
			await sleep(10);
			expect(readFileSync(ae.path, "utf8")).toContain("Alpha"); // not rewritten yet: waiting for the quiet period
			expect(listAutoExports(db)[0]!.status).toBe("pending");
			for (let i = 0; i < 60 && !readFileSync(ae.path, "utf8").includes("Delta"); i++) {
				await sleep(20);
				mtimes.add(statSync(ae.path).mtimeMs);
				writes++;
			}
			const text = readFileSync(ae.path, "utf8");
			expect(text).toContain("title = {Delta}");
			expect(text).toContain("@article{smithDelta2020,");
			expect(mtimes.size).toBeLessThanOrEqual(2); // ...give one rewrite, not three
			expect(writes).toBeGreaterThan(0);
			await sleep(40);
			expect(listAutoExports(db)[0]!.status).toBe("done");
		} finally {
			sched.stop();
		}
	});

	test("adding an item, adding it to a collection, and deleting all trigger a rewrite", async () => {
		const c = createCollection(db, "Coll");
		const ae = addAutoExport(db, { path: join(dir, "c.bib"), format: "betterbibtex", scope: { type: "collection", key: c.key } });
		const sched = startAutoExport(db, { pollMs: 10, runAtStart: false });
		const waitFor = async (pred: () => boolean) => {
			for (let i = 0; i < 100 && !pred(); i++) await sleep(20);
			expect(pred()).toBe(true);
		};
		try {
			expect(readFileSync(ae.path, "utf8")).toBe("");
			const a = createItem(db, paper("Alpha")).data.key;
			addItemsToCollection(db, c.key, [a]);
			await waitFor(() => readFileSync(ae.path, "utf8").includes("@article{smithAlpha2020,"));
			patchItem(db, a, { deleted: 1 });
			await waitFor(() => readFileSync(ae.path, "utf8") === "");
		} finally {
			sched.stop();
		}
	});

	test("an idle export waits for the longer quiet period", async () => {
		const a = createItem(db, paper("Alpha")).data.key;
		const ae = addAutoExport(db, { path: join(dir, "idle.bib"), format: "betterbibtex", scope: { type: "library" }, trigger: "idle" });
		expect(ae.trigger).toBe("idle");
		const sched = startAutoExport(db, { pollMs: 10, runAtStart: false });
		try {
			patchItem(db, a, { title: "Bravo" });
			await sleep(90); // longer than the change delay (50 ms) but shorter than the idle delay (150 ms)
			expect(readFileSync(ae.path, "utf8")).toContain("Alpha");
			await sleep(250);
			expect(readFileSync(ae.path, "utf8")).toContain("Bravo");
		} finally {
			sched.stop();
		}
	});

	test("changes made by raw SQL (sync) are noticed too", async () => {
		const a = createItem(db, paper("Alpha")).data.key;
		const ae = addAutoExport(db, { path: join(dir, "s.bib"), format: "betterbibtex", scope: { type: "library" } });
		const sched = startAutoExport(db, { pollMs: 10, runAtStart: false });
		try {
			db.query("UPDATE items SET data = json_set(data, '$.title', 'Synced title') WHERE key = ?").run(a);
			for (let i = 0; i < 100 && !readFileSync(ae.path, "utf8").includes("Synced"); i++) await sleep(20);
			expect(readFileSync(ae.path, "utf8")).toContain("Synced");
		} finally {
			sched.stop();
		}
	});
});

describe("HTTP API (/api/bbt)", () => {
	const call = (path: string, method = "GET", body?: unknown) =>
		handleApi(new Request(`http://127.0.0.1/api/bbt/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), db).then((r) => r!.json() as Promise<any>);

	test("settings, formula check, keys, pin/unpin/refresh, cite and auto-exports", async () => {
		const a = createItem(db, paper("Alpha beta gamma")).data.key;
		expect((await call("settings")).citekeyFormat).toBe("auth.lower + shorttitle(3,3) + year");
		const bad = await handleApi(new Request("http://x/api/bbt/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patch: { citekeyFormat: "auth.nope" } }) }), db);
		expect(bad!.status).toBe(400);
		expect((await call("formula", "POST", { formula: "auth.upper + year", itemKey: a })).preview).toBe("SMITH2020");
		expect((await call("formula", "POST", { formula: "(" })).ok).toBe(false);
		expect((await call(`keys?items=${a}`)).keys[a]).toEqual({ key: "smithAlphaBetaGamma2020", pinned: false });
		expect(await call("pin", "POST", { itemKey: a })).toEqual({ key: "smithAlphaBetaGamma2020", pinned: true });
		expect(await call("unpin", "POST", { itemKey: a })).toEqual({ key: "smithAlphaBetaGamma2020", pinned: false });
		const r = await call("settings", "POST", { patch: { citekeyFormat: "auth.lower + year" } });
		expect(r.staleKeys).toBe(1);
		expect((await call("refresh", "POST", { items: [a] })).updated).toBe(1);
		expect((await call(`keys?items=${a}`)).keys[a].key).toBe("smith2020");
		expect((await call("cite", "POST", { items: [a], format: "pandoc" })).text).toBe("[@smith2020]");
		expect((await call("cite", "POST", { items: [a] })).text).toBe("\\cite{smith2020}");
		const ae = await call("autoexports", "POST", { path: join(dir, "api.bib"), format: "betterbiblatex", scope: { type: "library" } });
		expect(ae.status).toBe("done");
		expect((await call("autoexports")).exports).toHaveLength(1);
		expect((await call("autoexports/run", "POST", { id: ae.id })).status).toBe("done");
		expect((await call("autoexports/remove", "POST", { id: ae.id })).removed).toBe(true);
	});
});
