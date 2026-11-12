// Headless check of the browser library's first run, import and export (docs/design/browser-edition.md, step B5):
//   bun web/browser-welcome-check.ts [--dist <dir>] [--chrome <exe>] [--work <dir>] [--keep] [--shots-only]
// --dist: a build of `bun web/build.ts --target extension` (default gpui-ui/dist-extension).
//
// Same set-up as web/browser-library-check.ts: a minimal test extension (its own generated key, permissions offscreen, unlimitedStorage
// and storage, web/browser-db/test-background.js as its service worker, library/ linked to the build), Chrome for Testing with a fresh
// profile per phase, CDP port 9355, everything under the work folder (default %TEMP%\zinc-w2-w). No native host, nothing of the user's.
//
// Phases (each on its own fresh profile):
//   A  the welcome screen shows (screenshots light and dark); a click on "Start with an empty library" sets firstRunDone and shows the
//      app; after a reload the screen does not come back; a click on "Sign in to zotero.org" opens Settings > Sync.
//   B  import a Zinc library folder (the demo library of web/demo-library.ts: items, collections, an attachment) through the programmatic
//      entry; counts and the attachment's bytes must match the fixture; search works; no sync changes were queued; the temporary copy is
//      gone. Then Export library: the download is captured, unzipped here, opened with the core (openDb), counts and the file compared.
//   C  import a Zotero data folder (a small zotero.sqlite built here, with a 1.3 MB attachment so the upload goes over `up` frames); the
//      counts must equal what the core's importer produces for the same folder when run in Bun.
// The folder dialog (showDirectoryPicker) cannot be driven headless: the check gives the import a real FileSystemDirectoryHandle on a
// folder in the page's own OPFS instead, which exercises everything but the dialog.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { unzipSync } from "fflate";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = resolve(arg("dist") ?? join(ROOT, "gpui-ui", "dist-extension"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-w2-w"));
const KEEP = process.argv.includes("--keep");
const SHOTS_ONLY = process.argv.includes("--shots-only");
const CDP_PORT = 9355;
const FIXTURE_PORT = 9356;

// the extension's own key and id: generated here, so nothing is read from the connector's folder
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const KEY = der.toString("base64");
const EXT_ID = [...createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
const PAGE = `chrome-extension://${EXT_ID}/library/library.html?mode=browser`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}

if (!existsSync(join(DIST, "library.html")) || !existsSync(join(DIST, "db-worker.js")) || !existsSync(join(DIST, "offscreen.html"))) throw new Error(`build first: bun web/build.ts --target extension (${DIST})`);
const ext = join(WORK, "ext");
/** Chrome processes of this check (their command line names the work folder) that outlived a run and still hold its profile. */
function killStragglers() {
	const like = WORK.replaceAll("'", "''");
	spawnSync("pwsh", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${like}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
}
killStragglers();
if (existsSync(join(ext, "library"))) spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
for (const d of ["shots", "ext", "downloads", "fixtures", "export"]) mkdirSync(join(WORK, d), { recursive: true });
copyFileSync(join(import.meta.dir, "browser-db", "test-background.js"), join(ext, "test-background.js"));
writeFileSync(join(ext, "manifest.json"), JSON.stringify({
	name: "Zinc browser welcome check", manifest_version: 3, version: "1.0", key: KEY,
	permissions: ["offscreen", "unlimitedStorage", "storage"], background: { service_worker: "test-background.js" },
	content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
}, null, 2));
spawnSync("cmd", ["/c", "mklink", "/J", join(ext, "library"), DIST], { stdio: "ignore" });
if (!existsSync(join(ext, "library", "library.html"))) throw new Error("could not link library/ to the build");

// ---- fixtures (built here, in Bun; never a real library)
const ZINC = join(WORK, "fixtures", "zinc");
const ZOTERO = join(WORK, "fixtures", "Zotero");
const REF = join(WORK, "fixtures", "ref");
function buildFixtures() {
	// a Zinc library folder: the browser demo's library (18 papers, 10 collections, a note, one attachment with its PDF in storage/)
	const r = spawnSync("bun", ["web/demo-library.ts", ZINC], { cwd: join(ROOT, "gpui-ui"), encoding: "utf8" });
	if (r.status !== 0) throw new Error(`demo library failed: ${r.stderr || r.stdout}`);
	rmSync(join(ZINC, "collection-style.json"), { force: true });
	// a Zotero data folder: the importer's test fixture (core/test/import/zotero.test.ts), with a big attachment
	mkdirSync(join(ZOTERO, "storage", "ATT00001"), { recursive: true });
	mkdirSync(join(ZOTERO, "storage", "ATT00002"), { recursive: true });
	const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(crypto.getRandomValues(new Uint8Array(1_300_000)))]);
	// the file is spelled differently on disk and in the database, as Zotero allows on Windows and macOS: the browser's file store keeps the case it is given
	writeFileSync(join(ZOTERO, "storage", "ATT00001", "Paper One.PDF"), pdf);
	writeFileSync(join(ZOTERO, "storage", "ATT00001", ".zotero-ft-cache"), "hello full text");
	const db = new Database(join(ZOTERO, "zotero.sqlite"), { create: true });
	db.exec(`
	CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
	CREATE TABLE feeds (libraryID INTEGER PRIMARY KEY);
	CREATE TABLE itemTypesCombined (itemTypeID INT PRIMARY KEY, typeName TEXT);
	CREATE TABLE fieldsCombined (fieldID INT PRIMARY KEY, fieldName TEXT);
	CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
	CREATE TABLE charsets (charsetID INTEGER PRIMARY KEY, charset TEXT);
	CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT, dateModified TEXT, libraryID INT, key TEXT, version INT);
	CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value UNIQUE);
	CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
	CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
	CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
	CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
	CREATE TABLE itemTags (itemID INT, tagID INT, type INT);
	CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT, key TEXT, version INT);
	CREATE TABLE collectionItems (collectionID INT, itemID INT);
	CREATE TABLE relationPredicates (predicateID INTEGER PRIMARY KEY, predicate TEXT);
	CREATE TABLE itemRelations (itemID INT, predicateID INT, object TEXT);
	CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
	CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, charsetID INT, path TEXT, storageModTime INT, storageHash TEXT);
	CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT, type INT, authorName TEXT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, position TEXT);
	CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
	CREATE TABLE publicationsItems (itemID INTEGER PRIMARY KEY);
	CREATE TABLE syncedSettings (setting TEXT, libraryID INT, value, version INT, synced INT);
	INSERT INTO syncedSettings VALUES ('tagColors',1,'[{"name":"ml","color":"#FF6666"},{"name":"Starred","color":"#FFD400"}]',1,1);
	INSERT INTO libraries VALUES (1,'user'),(2,'group');
	INSERT INTO itemTypesCombined VALUES (1,'annotation'),(3,'attachment'),(22,'journalArticle'),(28,'note'),(8,'bookSection');
	INSERT INTO fieldsCombined VALUES (1,'title'),(2,'date'),(3,'publicationTitle'),(4,'url'),(5,'bookTitle');
	INSERT INTO creatorTypes VALUES (1,'author'),(2,'editor');
	INSERT INTO charsets VALUES (1,'utf-8');
	INSERT INTO items VALUES
	 (1,22,'2020-01-02 03:04:05','2021-01-02 03:04:05',1,'ITEM0001',100),
	 (2,3,'2020-01-02 03:04:06','2020-01-02 03:04:06',1,'ATT00001',101),
	 (3,3,'2020-01-02 03:04:07','2020-01-02 03:04:07',1,'ATT00002',102),
	 (4,28,'2020-01-02 03:04:08','2020-01-02 03:04:08',1,'NOTE0001',103),
	 (5,1,'2020-01-02 03:04:09','2020-01-02 03:04:09',1,'ANNOT001',104),
	 (6,8,'2020-02-02 03:04:09','2020-02-02 03:04:09',1,'ITEM0002',105),
	 (8,22,'2020-03-02 03:04:09','2020-03-02 03:04:09',2,'GROUP001',107);
	INSERT INTO itemDataValues VALUES (1,'Deep learning in surgery'),(2,'2019-05-00 May 2019'),(3,'J Surg'),(4,'https://example.org/x'),(5,'Some Book'),(6,'A chapter'),(7,'paper');
	INSERT INTO itemData VALUES (1,1,1),(1,2,2),(1,3,3),(1,4,4),(6,1,6),(6,5,5),(2,1,7);
	INSERT INTO creators VALUES (1,'Ada','Smith',0),(2,'Bo','Jones',0),(3,NULL,'WHO',1),(4,'Ed','Editor',0);
	INSERT INTO itemCreators VALUES (1,1,1,0),(1,2,1,1),(1,4,2,2),(6,3,1,0),(6,1,1,1),(6,2,1,2);
	INSERT INTO tags VALUES (1,'ml'),(2,'auto'),(3,'hl');
	INSERT INTO itemTags VALUES (1,1,0),(1,2,1),(5,3,0);
	INSERT INTO collections VALUES (1,'Parent',NULL,1,'COLL0001',5),(2,'Child',1,1,'COLL0002',6);
	INSERT INTO collectionItems VALUES (2,1),(1,1);
	INSERT INTO relationPredicates VALUES (1,'dc:relation');
	INSERT INTO itemRelations VALUES (1,1,'http://zotero.org/users/1/items/AAAAAAAA');
	INSERT INTO itemNotes VALUES (4,1,'<div>My note</div>','My note');
	INSERT INTO itemAttachments VALUES
	 (2,1,0,'application/pdf',1,'storage:paper one.pdf',1700000000000,'abc123'),
	 (3,1,1,'text/html',NULL,'storage:gone.html',NULL,NULL);
	INSERT INTO itemAnnotations VALUES (5,2,1,NULL,'highlighted','my comment','#ffd400','3','00000|000001|00002','{"pageIndex":2,"rects":[[1,2,3,4]]}');
	INSERT INTO deletedItems VALUES (6);
	INSERT INTO publicationsItems VALUES (1);
	`);
	db.close();
	return { zoteroPdf: sha(pdf) };
}

/** What a library file holds, for comparing the browser's copy with the original. */
function countsOf(path: string) {
	const d = new Database(path, { readonly: true });
	const one = (s: string) => (d.query(s).get() as { n: number }).n;
	const c = {
		items: one("SELECT count(*) n FROM items"), topLevel: one("SELECT count(*) n FROM items WHERE parent_key IS NULL"), collections: one("SELECT count(*) n FROM collections"),
		attachments: one("SELECT count(*) n FROM attachments"), annotations: one("SELECT count(*) n FROM annotations"), fulltext: one("SELECT count(*) n FROM fulltext"),
		tags: one("SELECT count(*) n FROM item_tags"), collectionItems: one("SELECT count(*) n FROM collection_items"),
	};
	d.close();
	return c;
}

// ---- Chrome and the DevTools protocol (as in browser-library-check.ts)
let chrome: ChildProcess | null = null;
const launch = (profile: string): ChildProcess => spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, profile)}`,
	`--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
	"--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=1400,900", "about:blank",
], { stdio: "ignore" });

class Cdp {
	ws!: WebSocket;
	private nextId = 1;
	private pending = new Map<number, (v: any) => void>();
	listeners: ((m: any) => void)[] = [];
	static async connect(): Promise<Cdp> {
		let ver: { webSocketDebuggerUrl: string } | undefined;
		for (let i = 0; i < 150 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json() as typeof ver; } catch { await sleep(200); } }
		if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
		const c = new Cdp();
		c.ws = new WebSocket(ver.webSocketDebuggerUrl);
		await new Promise((r) => (c.ws.onopen = r));
		c.ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)!(m); c.pending.delete(m.id); } else for (const l of c.listeners) l(m); };
		return c;
	}
	send(method: string, params: object = {}, sessionId?: string): Promise<any> {
		return new Promise((r) => { const id = this.nextId++; this.pending.set(id, r); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
	}
}

const problems: string[] = [];
const IGNORED = /Failed to load resource.*(favicon|403)|sync\/status|structure unavailable|reading view needs layout analysis|Automatic fallback to software WebGL|GPU stall/i;
class Session {
	constructor(readonly cdp: Cdp, readonly sid: string, readonly label: string) {
		cdp.listeners.push((m) => {
			if (m.sessionId !== sid) return;
			const add = (s: string) => { if (!IGNORED.test(s)) problems.push(`[${label}] ${s.slice(0, 400)}`); };
			if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; add(`exception: ${d.exception?.description ?? d.text}`); }
			if (m.method === "Log.entryAdded" && (m.params.entry.level === "error" || m.params.entry.source === "security")) add(`log(${m.params.entry.source}): ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
			if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) add(`console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
		});
	}
	static async attach(cdp: Cdp, targetId: string, label: string): Promise<Session> {
		const { result: { sessionId } } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const s = new Session(cdp, sessionId, label);
		for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await cdp.send(d, {}, sessionId);
		return s;
	}
	send(method: string, params: object = {}) { return this.cdp.send(method, params, this.sid); }
	async evalIn<T>(expression: string): Promise<T> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	}
	async waitFor(expression: string, ms: number): Promise<boolean> {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { try { if (await this.evalIn<boolean>(expression)) return true; } catch { /* loading */ } }
		return false;
	}
	async shot(name: string) {
		const s = await this.send("Page.captureScreenshot", { format: "png" });
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	}
	async click(x: number, y: number) {
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
	}
}

async function openLibrary(cdp: Cdp, label: string): Promise<{ tab: Session; ms: number }> {
	const { result: { targetId } } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const tab = await Session.attach(cdp, targetId, label);
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	const t0 = performance.now();
	await tab.send("Page.navigate", { url: PAGE });
	if (!(await tab.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0", 90_000))) {
		throw new Error(`${label}: the library tab did not load. ${await tab.evalIn<string>("(document.body?.innerText ?? '').slice(0, 200)").catch(() => "")} Problems: ${problems.slice(-4).join(" | ")}`);
	}
	return { tab, ms: performance.now() - t0 };
}

/** The database worker (a child target of the offscreen document): its console errors are part of the check, and it can be queried. */
async function workerSession(cdp: Cdp): Promise<Session | undefined> {
	const { result: { targetInfos } } = await cdp.send("Target.getTargets");
	const off = targetInfos.find((t: any) => t.url.endsWith("/library/offscreen.html") && t.type !== "iframe");
	if (!off) return undefined;
	const offSession = await Session.attach(cdp, off.targetId, "offscreen");
	const got = new Promise<string | null>((res) => {
		const t = setTimeout(() => res(null), 4000);
		cdp.listeners.push((m) => { if (m.method === "Target.attachedToTarget" && m.sessionId === offSession.sid && m.params.targetInfo.type === "worker") { clearTimeout(t); res(m.params.sessionId); } });
	});
	await offSession.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	const sid = await got;
	if (!sid) return undefined;
	const w = new Session(cdp, sid, "db-worker");
	await cdp.send("Runtime.enable", {}, sid);
	return w;
}

async function quit(cdp: Cdp): Promise<void> {
	const proc = chrome!;
	const exited = new Promise<void>((r) => proc.once("exit", () => r()));
	await cdp.send("Browser.close").catch(() => {});
	await Promise.race([exited, sleep(15_000)]);
	if (proc.pid && proc.exitCode === null) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
	try { cdp.ws.close(); } catch { /* gone */ }
	// helper processes that outlive the browser still hold the profile: only this check's (their command line names the work folder)
	killStragglers();
	await sleep(1500);
}

const q = (s: unknown) => JSON.stringify(s);

/** A web server for the fixture folders (the page copies them into its OPFS to get real directory handles); CORS open, localhost only. */
const server = Bun.serve({
	port: FIXTURE_PORT, hostname: "127.0.0.1",
	fetch(req) {
		const p = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
		if (p.includes("..") || !/^(zinc|Zotero)\//.test(p)) return new Response("no", { status: 404 });
		const f = join(WORK, "fixtures", p);
		return existsSync(f) ? new Response(Bun.file(f), { headers: { "Access-Control-Allow-Origin": "*" } }) : new Response("missing", { status: 404 });
	},
});
function filesOf(dir: string, rel = ""): string[] {
	return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesOf(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]);
}
/** Copy a fixture folder into the page's OPFS (fx-<name>) so the page holds a real FileSystemDirectoryHandle on it. */
const stage = (tab: Session, name: "zinc" | "Zotero", dir: string) => tab.evalIn<number>(`(async () => {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry("fx-${name}", { recursive: true }).catch(() => {});
	const top = await root.getDirectoryHandle("fx-${name}", { create: true });
	let n = 0;
	for (const rel of ${q(filesOf(dir))}) {
		const parts = rel.split("/"); let d = top;
		for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
		const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
		await w.write(new Uint8Array(await (await fetch("http://127.0.0.1:${FIXTURE_PORT}/${name}/" + rel.split("/").map(encodeURIComponent).join("/"))).arrayBuffer()));
		await w.close(); n++;
	}
	return n;
})()`);
const importFrom = (tab: Session, name: string) => tab.evalIn<any>(`(async () => { const root = await navigator.storage.getDirectory(); const h = await root.getDirectoryHandle("fx-${name}"); const t0 = performance.now(); const r = await znLibrary.importFolder(h); return { ...r, wallMs: performance.now() - t0 }; })().catch((e) => ({ error: String(e && e.message || e) }))`);
/** The attachment's file as the library serves it, fetched over the same port the page uses; its SHA-256 and size are computed in the page. */
const attHash = (tab: Session, key: string) => tab.evalIn<{ status: number; hash: string; size: number }>(`(async () => {
	const port = chrome.runtime.connect({ name: "zinc-db" });
	const parts = []; let head = null;
	const done = new Promise((resolve) => port.onMessage.addListener((m) => {
		if (m.t === "res") { head = m; if (!m.n) resolve(); } else if (m.t === "rc") { parts[m.seq] = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)); if (parts.filter(Boolean).length === head.n) resolve(); }
	}));
	port.postMessage({ t: "req", id: 1, method: "api", http: "GET", path: "/api/attachments/${key}/file", headers: {} });
	await done; port.disconnect();
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
	const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
	return { status: head.status, size: all.length, hash: [...h].map((b) => b.toString(16).padStart(2, "0")).join("") };
})()`);

// where the cards are on the 1280x800 welcome screen (found from a screenshot; the page is centred, so they do not move)
const CARDS = { empty: { x: 640, y: 272 }, signIn: { x: 640, y: 366 } };

let phaseNo = 0;
async function phase<T>(name: string, fn: (cdp: Cdp, tab: Session, worker: Session | undefined) => Promise<T>): Promise<T> {
	const profile = `profile-${name}`;
	chrome = launch(profile);
	const cdp = await Cdp.connect();
	try {
		const { tab, ms } = await openLibrary(cdp, `tab-${name}`);
		measures[`phase${++phaseNo}${name}FirstLoadMs`] = Math.round(ms);
		const worker = await workerSession(cdp);
		return await fn(cdp, tab, worker);
	} finally {
		await quit(cdp);
		chrome = null;
		await sleep(500);
		if (!KEEP) try { rmSync(join(WORK, profile), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch (e) { console.log(`could not delete ${profile} yet: ${(e as Error).message}`); }
	}
}

try {
	const fx = buildFixtures();
	const zincCounts = countsOf(join(ZINC, "library.sqlite"));
	// what the core's own importer makes of the Zotero fixture, run here in Bun: the browser's import must agree
	{
		const { importZotero } = await import("../../core/src/import/zotero");
		await importZotero({ zoteroDir: ZOTERO, targetDbPath: join(REF, "library.sqlite"), baseAttachmentPath: "", searchRoots: false, fuzzyMatch: false });
	}
	const zoteroRef = countsOf(join(REF, "library.sqlite"));
	console.log("fixtures: zinc", JSON.stringify(zincCounts), "zotero (core importer in Bun)", JSON.stringify(zoteroRef));
	const zincAttachment = (() => { const d = new Database(join(ZINC, "library.sqlite"), { readonly: true }); const r = d.query("SELECT item_key AS key FROM attachments").get() as { key: string }; d.close(); return r.key; })();
	const zincPdf = readFileSync(join(ZINC, "storage", zincAttachment, "Demo review.pdf"));

	// ================= A: the welcome screen, start empty, sign in
	await phase("A", async (cdp, tab, worker) => {
		const sizes = await tab.evalIn<string>("JSON.stringify({ shown: znLibrary.welcomeShown(), total: znLibrary.store.total(), done: null })");
		const done0 = await tab.evalIn<boolean>("znLibrary.readFirstRunDone()");
		check("fresh profile: the empty library shows the welcome screen, firstRunDone is not set", JSON.parse(sizes).shown === true && done0 === false && JSON.parse(sizes).total === 0, `${sizes}, firstRunDone ${done0}`);
		await tab.evalIn("znLibrary.setTheme('light')");
		await sleep(1200);
		await tab.shot("1-welcome-light");
		await tab.evalIn("znLibrary.setTheme('dark')");
		await sleep(1200);
		await tab.shot("2-welcome-dark");
		await tab.evalIn("znLibrary.setTheme('light')");
		await sleep(800);
		if (SHOTS_ONLY) return;
		// click the first card, "Start with an empty library"
		await tab.click(CARDS.empty.x, CARDS.empty.y);
		const gone = await tab.waitFor("znLibrary.welcomeShown() === false", 5000);
		const done1 = await tab.evalIn<boolean>("znLibrary.readFirstRunDone()");
		check("clicking Start with an empty library sets firstRunDone and shows the app", gone && done1 === true, `welcome gone ${gone}, firstRunDone ${done1}`);
		await sleep(800);
		await tab.shot("3-app-after-start-empty-light");
		await tab.send("Page.reload");
		await sleep(300);
		const back = await tab.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0", 60_000);
		await sleep(1000);
		const shown = back ? await tab.evalIn<boolean>("znLibrary.welcomeShown()") : null;
		check("after a reload the welcome screen does not come back", back && shown === false, `welcome shown after reload: ${shown}`);
		// the Export library row is in Settings (browser mode only)
		check("Settings has the Export library row in browser mode", await tab.evalIn<boolean>("znLibrary.hasExportSetting"), "registered by the page");
		// reset the flag and reload: the screen is back, and "Sign in" leads to Settings > Sync
		await tab.evalIn(`new Promise((r) => chrome.storage.local.set({ zincBrowserLibrary: {} }, r))`);
		await tab.send("Page.reload");
		await sleep(300);
		await tab.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0 && znLibrary.welcomeShown()", 60_000);
		await sleep(800);
		await tab.click(CARDS.signIn.x, CARDS.signIn.y);
		const left = await tab.waitFor("znLibrary.welcomeShown() === false && znLibrary.store.activeTab() !== 'library'", 5000);
		await sleep(1000);
		await tab.shot("4-sign-in-opens-settings-light");
		check("clicking Sign in to zotero.org opens Settings (the Sync section) and sets firstRunDone", left && (await tab.evalIn<boolean>("znLibrary.readFirstRunDone()")), `active tab ${await tab.evalIn("znLibrary.store.activeTab()")}`);
	});
	if (SHOTS_ONLY) { writeFileSync(join(WORK, "results.json"), JSON.stringify({ measures, results }, null, 2)); process.exit(0); }

	// ================= B: import a Zinc library folder, then export
	await phase("B", async (cdp, tab, worker) => {
		await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(WORK, "downloads"), eventsEnabled: true });
		check("fresh profile 2: the welcome screen shows", await tab.evalIn<boolean>("znLibrary.welcomeShown()"), "");
		const n = await stage(tab, "zinc", ZINC);
		const t0 = Date.now();
		const r = await importFrom(tab, "zinc");
		const ms = Date.now() - t0;
		measures.zincImport = { items: zincCounts.items, files: n, ms, wallMsInPage: r.wallMs, phases: await tab.evalIn("znLibrary.importProgress.filter((p, i, a) => a.indexOf(p) === i)") };
		check("Zinc folder import runs", !r.error, r.error ?? `${r.items} items, ${r.collections} collections, ${r.attachments} attachments in ${ms} ms (${n} files sent)`);
		const st = await tab.evalIn<{ items: number; collections: number; leftover: boolean }>(`znLibrary.api("GET", "/browser/state").then((r) => r.json)`);
		check("item and collection counts match the fixture", st.items === zincCounts.items && st.collections === zincCounts.collections && r.topLevelItems === zincCounts.topLevel, `browser ${st.items} items (${r.topLevelItems} top level), ${st.collections} collections; fixture ${zincCounts.items} (${zincCounts.topLevel}), ${zincCounts.collections}`);
		const more = await worker?.evalIn<Record<string, number>>(`(() => { const d = znDb.db; const n = (s) => d.query(s).get().n; return { attachments: n("select count(*) n from attachments"), annotations: n("select count(*) n from annotations"), tags: n("select count(*) n from item_tags"), collectionItems: n("select count(*) n from collection_items"), outbox: n("select count(*) n from sync_outbox"), search: n("select count(*) n from search"), quick: n("select count(*) n from quick_search") }; })()`);
		check("attachments, tags and collection memberships match; no sync change was queued", !!more && more.attachments === zincCounts.attachments && more.tags === zincCounts.tags && more.collectionItems === zincCounts.collectionItems && more.outbox === 0, JSON.stringify(more));
		check("the temporary copy of the folder is deleted", st.leftover === false, `leftover ${st.leftover}`);
		const att = await tab.evalIn<{ status: number; json: { key: string }[] }>(`znLibrary.api("GET", "/items?limit=200&include=creators").then((r) => ({ status: r.status, json: r.json.items }))`);
		const sub = await tab.evalIn<number>(`znLibrary.api("GET", "/items?q=Attention&limit=20").then((r) => r.json.total)`);
		check("search finds an imported item", sub >= 1 && att.status === 200, `"Attention": ${sub} hit(s)`);
		const f = await attHash(tab, zincAttachment);
		check("an attachment's file reads back with the same bytes", f.status === 200 && f.hash === sha(zincPdf) && f.size === zincPdf.length, `status ${f.status}, ${f.size} bytes, sha256 ${f.hash.slice(0, 12)} (fixture ${sha(zincPdf).slice(0, 12)})`);
		check("firstRunDone is set and the welcome screen is gone after the import", (await tab.evalIn<boolean>("znLibrary.readFirstRunDone()")) && !(await tab.evalIn<boolean>("znLibrary.welcomeShown()")), "");
		await sleep(1500);
		await tab.evalIn("znLibrary.setTheme('light')");
		await sleep(1000);
		await tab.shot("5-after-zinc-import-light");

		// export
		const dl = new Promise<{ file: string; ms: number }>((res, rej) => {
			const t1 = Date.now();
			let name = "";
			const to = setTimeout(() => rej(new Error("the download did not finish")), 60_000);
			cdp.listeners.push((m) => {
				if (m.method === "Browser.downloadWillBegin") name = m.params.suggestedFilename;
				if (m.method === "Browser.downloadProgress" && m.params.state === "completed") { clearTimeout(to); res({ file: name, ms: Date.now() - t1 }); }
				if (m.method === "Browser.downloadProgress" && m.params.state === "canceled") { clearTimeout(to); rej(new Error("the download was cancelled")); }
			});
		});
		const tExp = Date.now();
		const exp = await tab.evalIn<{ bytes: number; name: string; summary: Record<string, number> }>("znLibrary.exportLibrary()");
		const requestMs = Date.now() - tExp;
		const got = await dl;
		const zipPath = join(WORK, "downloads", got.file);
		const zipBytes = readFileSync(zipPath);
		measures.export = { zipBytes: zipBytes.length, requestAnswerMs: requestMs, downloadCompletedMs: got.ms, summary: exp.summary, name: got.file };
		check("Export library downloads one zip", existsSync(zipPath) && zipBytes.length === exp.bytes && /^zinc-library-\d{4}-\d\d-\d\d\.zip$/.test(got.file), `${got.file}, ${zipBytes.length} bytes; request answered in ${requestMs} ms, download completed ${got.ms} ms after it started`);
		const files = unzipSync(new Uint8Array(zipBytes));
		const names = Object.keys(files);
		const outDir = join(WORK, "export");
		for (const [p, data] of Object.entries(files)) { const dest = join(outDir, p); mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, data); }
		const { openDb } = await import("../../core/src/db");
		const exported = openDb(join(outDir, "library.sqlite"));
		exported.close();
		const ec = countsOf(join(outDir, "library.sqlite"));
		check("the exported library.sqlite opens with the core and its counts equal the library's", JSON.stringify(ec) === JSON.stringify(zincCounts) || (ec.items === zincCounts.items && ec.collections === zincCounts.collections && ec.attachments === zincCounts.attachments && ec.tags === zincCounts.tags), `export ${JSON.stringify(ec)} vs fixture ${JSON.stringify(zincCounts)}`);
		const stored = `storage/${zincAttachment}/Demo review.pdf`;
		const d2 = new Database(join(outDir, "library.sqlite"), { readonly: true });
		const row = d2.query("SELECT path FROM attachments WHERE item_key = ?").get(zincAttachment) as { path: string };
		d2.close();
		check("the attachment's file is in the zip with the same bytes, and its path points at it", !!files[stored] && sha(files[stored]!) === sha(zincPdf) && row.path === `attachments:${stored}`, `${names.filter((x) => x.startsWith("storage/")).join(", ")}; path ${row.path}`);
	});

	// ================= C: import a Zotero data folder
	await phase("C", async (cdp, tab, worker) => {
		check("fresh profile 3: the welcome screen shows", await tab.evalIn<boolean>("znLibrary.welcomeShown()"), "");
		const n = await stage(tab, "Zotero", ZOTERO);
		const t0 = Date.now();
		const r = await importFrom(tab, "Zotero");
		const ms = Date.now() - t0;
		measures.zoteroImport = { items: zoteroRef.items, files: n, ms, zoteroPdfBytes: 1_300_009 };
		check("Zotero folder import runs (the core's importer, in the browser)", !r.error, r.error ?? `${r.items} items, ${r.collections} collections, ${r.attachments} attachments in ${ms} ms (${n} files sent)`);
		const st = await tab.evalIn<{ items: number; collections: number; leftover: boolean }>(`znLibrary.api("GET", "/browser/state").then((r) => r.json)`);
		check("counts equal the core importer's own result for the same folder", st.items === zoteroRef.items && st.collections === zoteroRef.collections && r.topLevelItems === zoteroRef.topLevel, `browser ${st.items} items (${r.topLevelItems} top level), ${st.collections} collections; core in Bun ${zoteroRef.items} (${zoteroRef.topLevel}), ${zoteroRef.collections}`);
		const more = await worker?.evalIn<Record<string, number>>(`(() => { const d = znDb.db; const n = (s) => d.query(s).get().n; return { attachments: n("select count(*) n from attachments"), annotations: n("select count(*) n from annotations"), fulltext: n("select count(*) n from fulltext"), tags: n("select count(*) n from item_tags"), collectionItems: n("select count(*) n from collection_items"), outbox: n("select count(*) n from sync_outbox"), trashed: n("select count(*) n from items where deleted = 1") }; })()`);
		check("attachments, annotations, full text, tags and memberships equal the core importer's; no sync change was queued", !!more && more.attachments === zoteroRef.attachments && more.annotations === zoteroRef.annotations && more.fulltext === zoteroRef.fulltext && more.tags === zoteroRef.tags && more.collectionItems === zoteroRef.collectionItems && more.outbox === 0, JSON.stringify(more));
		check("the temporary copy of the folder is deleted", st.leftover === false, `leftover ${st.leftover}`);
		// the importer's full-text pass finds the storage folders (upper-case keys) now that the file store keeps their case
		check("full text was imported from the storage folder (.zotero-ft-cache)", !!more && zoteroRef.fulltext >= 1 && more.fulltext >= 1, `browser ${more?.fulltext}, core in Bun ${zoteroRef.fulltext}`);
		const f = await attHash(tab, "ATT00001");
		check("the 1.3 MB attachment (sent as `up` frames) reads back with the same bytes", f.status === 200 && f.hash === fx.zoteroPdf, `status ${f.status}, ${f.size} bytes, sha256 ${f.hash.slice(0, 12)} (fixture ${fx.zoteroPdf.slice(0, 12)})`);
		const gone = await attHash(tab, "ATT00002");
		check("an attachment whose file was not in the folder has no file (404), as in the core", gone.status === 404, `status ${gone.status}`);
		await sleep(1500);
		await tab.shot("6-after-zotero-import-light");

		// export: the zip keeps the case of the folder and file names (ATT00001/Paper One.PDF), not lower-case
		await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(WORK, "downloads"), eventsEnabled: true });
		const dl2 = new Promise<string>((res, rej) => {
			let name = "";
			const to = setTimeout(() => rej(new Error("the second download did not finish")), 60_000);
			cdp.listeners.push((m) => {
				if (m.method === "Browser.downloadWillBegin") name = m.params.suggestedFilename;
				if (m.method === "Browser.downloadProgress" && m.params.state === "completed") { clearTimeout(to); res(name); }
			});
		});
		await tab.evalIn("znLibrary.exportLibrary()");
		const zipName = await dl2;
		const stored = Object.keys(unzipSync(new Uint8Array(readFileSync(join(WORK, "downloads", zipName))))).filter((x) => x.startsWith("storage/"));
		check("an exported zip keeps the original file-name case", stored.includes("storage/ATT00001/Paper One.PDF"), stored.join(", "));

		// not allowed twice: importing into a library that has data is refused
		const again = await importFrom(tab, "Zotero");
		check("importing into a library that already has items is refused", !!again.error && /already has items/i.test(again.error), again.error ?? "it ran");
	});

	const errs = problems.filter((p) => !IGNORED.test(p));
	check("no page, offscreen or worker errors, and no CSP violations", errs.length === 0, errs.slice(0, 8).join(" | ") || "none");
} finally {
	server.stop(true);
	// (assigned inside callbacks, so TypeScript narrows it to null here: read it through its declared type)
	const running = chrome as ChildProcess | null;
	if (running?.pid) spawnSync("taskkill", ["/PID", String(running.pid), "/T", "/F"], { stdio: "ignore" });
	await sleep(1500);
	// the link only: never the build it points to
	spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
}
writeFileSync(join(WORK, "results.json"), JSON.stringify({ measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify(measures, null, 2));
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
