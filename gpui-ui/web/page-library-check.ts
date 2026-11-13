// Headless check of the browser library on a plain web page (web/browser-db/CONTRACT.md, "Plain web page"):
//   bun web/page-library-check.ts [--dist <dir>] [--chrome <exe>] [--work <dir>] [--keep]
// --dist: a build of `bun web/build.ts --target extension` (default gpui-ui/dist-extension); only its db-worker.js and sqlite3.wasm are
// used (the plain web target builds the same worker).
//
// No extension and no app: a minimal harness page (an HTML file and web/page-library-harness.ts bundled by Bun.build, which calls
// startPageLibrary()) is served from a local Bun server on 127.0.0.1:<port>, next to the built db-worker.js and sqlite3.wasm. A real
// origin, not an extension. Chrome for Testing, its own profile, CDP port 9376, --disable-extensions.
//
// zotero.org is never contacted. The mock Web API (core/test/websync/mock.ts) runs on another 127.0.0.1 port with CORS for the page's
// origin; the page reaches it through the test-only override (IndexedDB "zinc-page-keys", name zincTestZoteroApiBase, accepted only as
// http://127.0.0.1:<port>). The PDF's download redirects to a second mock, the "file host", on localhost:<port2>, which records every
// header and URL it receives.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { API_KEY, MockZotero } from "../../core/test/websync/mock";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = resolve(arg("dist") ?? join(ROOT, "gpui-ui", "dist-extension"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-page-library-check"));
const KEEP = process.argv.includes("--keep");
const CDP_PORT = Number(arg("port") ?? 9376);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}

if (!existsSync(join(DIST, "db-worker.js")) || !existsSync(join(DIST, "sqlite3.wasm"))) throw new Error(`build first: bun web/build.ts --target extension (${DIST})`);

// ---- the harness page, bundled
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const site = join(WORK, "site");
mkdirSync(site, { recursive: true });
mkdirSync(join(WORK, "shots"), { recursive: true });
{
	const r = await Bun.build({ entrypoints: [join(import.meta.dir, "page-library-harness.ts")], outdir: site, target: "browser", format: "esm", naming: { entry: "harness.js" }, throw: false, define: { "process.env.NODE_ENV": '"production"' } });
	if (!r.success) { for (const l of r.logs) console.error(String(l).slice(0, 400)); throw new Error("harness build failed"); }
}
writeFileSync(join(site, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Zinc page library check</title></head><body>page library harness<script type="module" src="harness.js"></script></body></html>\n`);
copyFileSync(join(DIST, "db-worker.js"), join(site, "db-worker.js"));
copyFileSync(join(DIST, "sqlite3.wasm"), join(site, "sqlite3.wasm"));
const siteServer = Bun.serve({
	port: 0, hostname: "127.0.0.1",
	fetch(req) {
		const name = new URL(req.url).pathname.replace(/^\/+/, "") || "index.html";
		const f = Bun.file(join(site, name));
		// (no COOP/COEP headers: a plain page; the pool VFS needs neither)
		return /^[\w.-]+$/.test(name) && existsSync(join(site, name)) ? new Response(f) : new Response("not found", { status: 404 });
	},
});
const PAGE = `http://127.0.0.1:${siteServer.port}`;

// ---- the mock zotero.org (CORS for the page) and its file host
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const mock = new MockZotero();
mock.corsOrigin = PAGE;
mock.put("collection", "COLL0001", { name: "Mock reading list" });
mock.put("item", "ITEM0001", { title: "First mock paper", collections: ["COLL0001"] });
mock.put("item", "ITEM0002", { title: "Second mock paper" });
mock.put("item", "ITEM0003", { title: "Third mock paper" });
mock.put("item", "ATTPDF01", { itemType: "attachment", parentItem: "ITEM0001", linkMode: "imported_file", contentType: "application/pdf", filename: "paper.pdf", title: "paper.pdf" });
mock.files.set("ATTPDF01", PDF);
const fileHostSeen: { method: string; url: string; headers: Record<string, string> }[] = [];
const fileHost = Bun.serve({
	port: 0, hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		fileHostSeen.push({ method: req.method, url: u.pathname + u.search, headers: Object.fromEntries(req.headers) });
		// (a file host a page can read: any origin; the redirected request's origin is opaque, so "*")
		const cors = { "Access-Control-Allow-Origin": "*" };
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Headers": "*" } });
		const bytes = mock.files.get(u.pathname.replace(/^\/blob\//, ""));
		return bytes ? new Response(Buffer.from(bytes), { headers: { ...cors, "Content-Type": "application/pdf" } }) : new Response("gone", { status: 404, headers: cors });
	},
});
// the mock's file redirect points at the file host (another origin), as zotero.org's points at its storage host
const origFileRoute = (mock as any).fileRoute.bind(mock);
(mock as any).fileRoute = async (...a: unknown[]) => {
	const r: Response = await origFileRoute(...a);
	return r.status === 302 ? new Response(null, { status: 302, headers: { Location: r.headers.get("location")!.replace(new URL(mock.url).origin, `http://localhost:${fileHost.port}`) } }) : r;
};

// ---- Chrome and the DevTools protocol
let chrome: ChildProcess | null = null;
const launch = (): ChildProcess => spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, "profile")}`,
	"--disable-extensions", "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=1400,900", "about:blank",
], { stdio: "ignore" });
const killChrome = async () => {
	if (chrome?.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	chrome = null;
	await sleep(2500);
};

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
const IGNORED = /Failed to load resource.*(favicon|403)|GPU stall|Automatic fallback to software WebGL/i;
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
	static async attach(cdp: Cdp, targetId: string, label: string, watchWorkers = false): Promise<Session> {
		const { result: { sessionId } } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const s = new Session(cdp, sessionId, label);
		for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await cdp.send(d, {}, sessionId);
		if (watchWorkers) {
			// a dedicated worker the page starts: collect its errors from its first line (it waits for us), and keep a session for it
			cdp.listeners.push((m) => {
				if (m.method !== "Target.attachedToTarget" || m.sessionId !== sessionId || m.params.targetInfo.type !== "worker") return;
				const wsid = m.params.sessionId as string;
				const w = new Session(cdp, wsid, `${label}/worker`);
				s.workers.push(w);
				void (async () => {
					await cdp.send("Runtime.enable", {}, wsid);
					await cdp.send("Log.enable", {}, wsid).catch(() => {});
					await cdp.send("Runtime.runIfWaitingForDebugger", {}, wsid);
				})();
			});
			await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
		}
		return s;
	}
	workers: Session[] = [];
	send(method: string, params: object = {}) { return this.cdp.send(method, params, this.sid); }
	async evalIn<T>(expression: string): Promise<T> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	}
	async waitFor(expression: string, ms: number): Promise<boolean> {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { try { if (await this.evalIn<boolean>(expression)) return true; } catch { /* loading */ } }
		return false;
	}
}

const q = (s: unknown) => JSON.stringify(s);
type Api = { status: number; json: any; text: string };
const seenTexts: string[] = [];
const MOCK_BASE = mock.url;

/** A new tab on the harness page, with its worker watched; the page's library started (returns the start result). */
async function openTab(cdp: Cdp, label: string): Promise<{ tab: Session; started: { ok: boolean; name?: string; message?: string }; targetId: string }> {
	const { result: { targetId } } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const tab = await Session.attach(cdp, targetId, label, true);
	await tab.send("Page.navigate", { url: `${PAGE}/index.html` });
	if (!(await tab.waitFor("!!globalThis.znH", 20_000))) throw new Error("the harness page did not load");
	const started = await tab.evalIn<{ ok: boolean; name?: string; message?: string }>("znH.start()");
	return { tab, started, targetId };
}
const api = async (tab: Session, method: string, path: string, body?: unknown): Promise<Api> => {
	const r = await tab.evalIn<Api>(`znH.api(${q(method)}, ${q(path)}, ${body === undefined ? "undefined" : q(body)})`);
	seenTexts.push(r.text);
	return r;
};
const titles = async (tab: Session) => ((await api(tab, "GET", "/items?limit=200&sort=title&dir=asc")).json?.items ?? []).map((i: any) => i.title as string);
const collNames = async (tab: Session) => ((await api(tab, "GET", "/collections")).json ?? []).map((c: any) => c.name as string);
const until = async (what: string, f: () => Promise<boolean>, ms = 30_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await f()) return true; console.log(`timeout: ${what}`); return false; };

try {
	chrome = launch();
	let cdp = await Cdp.connect();

	// the override and nothing else is stored before the library opens (IndexedDB of the page's origin)
	{
		const { result: { targetId } } = await cdp.send("Target.createTarget", { url: `${PAGE}/index.html` });
		const s = await Session.attach(cdp, targetId, "setup");
		await s.waitFor("!!globalThis.znH", 20_000);
		await s.evalIn(`znH.setApiBase(${q(MOCK_BASE)})`);
		await cdp.send("Target.closeTarget", { targetId });
	}

	// ---- 1. the library opens empty
	const t0 = performance.now();
	let { tab, started } = await openTab(cdp, "tab1");
	check("the page starts its library (worker, SQLite on OPFS, no extension)", started.ok, `${Math.round(performance.now() - t0)} ms${started.ok ? "" : `: ${started.message}`}`);
	if (!started.ok) throw new Error("the library did not start");
	const info = await tab.workers[0]?.evalIn<string>("JSON.stringify({ hasChrome: znDb.hasChrome, pageMode: znDb.pageMode, sync: znDb.sync })") ?? "no worker session";
	measures.worker = info;
	const wi = (() => { try { return JSON.parse(info) as { hasChrome: boolean; pageMode: boolean; sync: { storage: string; apiBase: string; mode: string; started: boolean } | null }; } catch { return null; } })();
	check("the worker runs in page mode: no chrome.*, its key area is the page's IndexedDB, the test API base is read", !!wi && !wi.hasChrome && wi.pageMode && wi.sync?.storage === "page" && wi.sync.apiBase === MOCK_BASE, info);
	const ctx = await tab.evalIn<string>("JSON.stringify({ chrome: typeof chrome === 'undefined' ? 'none' : typeof chrome.runtime, locks: typeof navigator.locks, isolated: crossOriginIsolated, origin: location.origin })");
	measures.pageContext = ctx;
	const items0 = await api(tab, "GET", "/items?limit=200");
	check("the library opens empty", items0.status === 200 && (items0.json?.items?.length ?? -1) === 0 && (await collNames(tab)).length === 0, `status ${items0.status}, ${items0.json?.items?.length} items; page: ${ctx}`);

	// ---- 2. a collection and an item through the transport
	const changes0 = await tab.evalIn<number>("znH.changes");
	const coll = await api(tab, "POST", "/collections", { name: "Page collection" });
	const item = await api(tab, "POST", "/items", { data: { itemType: "book", title: "Written in the page" } });
	check("a collection and an item are created through the transport", coll.status < 300 && item.status < 300, `collection ${coll.status}, item ${item.status}`);
	const noticed = await tab.waitFor(`znH.changes > ${changes0}`, 5000);
	check("onChanged fires when the library changes", noticed, `${await tab.evalIn("znH.changes")} notice(s)`);
	check("they are listed", (await titles(tab)).join("|") === "Written in the page" && (await collNames(tab)).join("|") === "Page collection", `${(await titles(tab)).join("|")} / ${(await collNames(tab)).join("|")}`);

	// ---- 3. reload
	await tab.send("Page.reload");
	await sleep(500);
	await tab.waitFor("!!globalThis.znH", 20_000);
	const again = await tab.evalIn<{ ok: boolean; message?: string }>("znH.start()");
	const afterReload = again.ok ? { items: (await titles(tab)).join("|"), colls: (await collNames(tab)).join("|") } : { items: "", colls: "" };
	check("after a reload the item and the collection are still there (and the lock was handed over)", again.ok && afterReload.items === "Written in the page" && afterReload.colls === "Page collection", again.ok ? `${afterReload.items} / ${afterReload.colls}` : `start failed: ${again.message}`);

	// ---- 4. restart Chrome on the same profile
	await cdp.send("Browser.close").catch(() => {});
	await sleep(2000);
	await killChrome();
	chrome = launch();
	cdp = await Cdp.connect();
	({ tab, started } = await openTab(cdp, "tab1-restarted"));
	const afterRestart = started.ok ? { items: (await titles(tab)).join("|"), colls: (await collNames(tab)).join("|") } : { items: "", colls: "" };
	check("after restarting Chrome on the same profile they are still there", started.ok && afterRestart.items === "Written in the page" && afterRestart.colls === "Page collection", started.ok ? `${afterRestart.items} / ${afterRestart.colls}` : `start failed: ${started.message}`);

	// ---- 5. a second tab
	const second = await openTab(cdp, "tab2");
	check("a second tab gets the 'open in another tab' error", !second.started.ok && second.started.name === "PageLibraryBusyError" && /open in another tab/i.test(second.started.message ?? ""), `${second.started.name}: ${second.started.message}`);
	const hadWorker = second.tab.workers.length;
	check("the second tab never started a database worker", hadWorker === 0, `${hadWorker} worker(s)`);
	const wrote = await api(tab, "POST", "/items", { data: { itemType: "book", title: "Written while tab 2 was refused" } });
	check("the first tab keeps working (a write succeeds, both items are listed)", wrote.status < 300 && (await titles(tab)).join("|") === "Written in the page|Written while tab 2 was refused", `write ${wrote.status}; ${(await titles(tab)).join("|")}`);
	await cdp.send("Target.closeTarget", { targetId: second.targetId });
	// the refused tab is closed; the first tab still holds the lock, so a later tab is refused too
	const stillBusy = await openTab(cdp, "tab3");
	check("while the first tab is open a later tab is refused again", !stillBusy.started.ok && stillBusy.started.name === "PageLibraryBusyError", `${stillBusy.started.name}`);
	await cdp.send("Target.closeTarget", { targetId: stillBusy.targetId });

	// ---- 6. sync against the mock zotero.org
	const status = async () => (await api(tab, "GET", "/websync/status")).json as { mode: string; account: { keySet: boolean; userId?: number }; files: string; pending: number; lastPullAt?: string; lastPushAt?: string; lastError?: string; busy: boolean; fileJob?: { done: number; total: number; failed: number; running: boolean } };
	const s0 = await status();
	check("Settings > Sync can read the status (no key yet)", s0.mode === "zotero-local" && !s0.account.keySet, JSON.stringify(s0).slice(0, 160));
	const bad = await api(tab, "POST", "/websync/key", { apiKey: "wrong-key" });
	check("a wrong key is refused by the mock", bad.status === 400 && !(await status()).account.keySet, `${bad.status} ${bad.text.slice(0, 80)}`);
	const good = await api(tab, "POST", "/websync/key", { apiKey: API_KEY });
	check("the fake key is accepted by the mock zotero.org (over CORS) and kept", good.status === 200 && good.json?.account?.keySet === true && good.json.account.userId === 42, `${good.status} user ${good.json?.account?.userId}`);
	const stored = await tab.evalIn<string | null>("znH.peekKey()");
	check("the key is in the page's IndexedDB key area (zinc-page-keys), not in localStorage", stored === API_KEY && !(await tab.evalIn<boolean>(`JSON.stringify(Object.entries(localStorage)).includes(${q(API_KEY)})`)), stored ? "present" : "missing");
	await api(tab, "POST", "/websync/options", { push: true, files: "download" });
	const m = await api(tab, "POST", "/websync/mode", { mode: "zotero-org" });
	check("the sync source is switched to zotero.org (starts the service in the worker)", m.status === 200 && m.json?.mode === "zotero-org", `${m.status} mode ${m.json?.mode}`);
	const pulled = await until("pull", async () => { const s = await status(); return !!s.lastPullAt && !s.busy; });
	const s1 = await status();
	check("the first pull finished without an error", pulled && !s1.lastError, `lastError ${s1.lastError ?? "none"}`);
	const want = ["First mock paper", "Second mock paper", "Third mock paper"];
	const got = await titles(tab);
	check("the mock library's items and collection arrived (with the local ones kept)", want.every((t) => got.includes(t)) && got.includes("Written in the page") && (await collNames(tab)).includes("Mock reading list"), `${got.join(" | ")}; ${(await collNames(tab)).join(" | ")}`);

	await until("file job", async () => { const s = await status(); return !!s.fileJob && !s.fileJob.running; });
	const fj = (await status()).fileJob;
	const file = await api(tab, "GET", "/attachments/ATTPDF01/file");
	check("the PDF downloaded into the page library and opens (GET /api/attachments/<key>/file)", file.status === 200 && file.text.startsWith("%PDF"), `status ${file.status}, ${file.text.length} bytes; file job ${JSON.stringify(fj)}`);

	const blobReqs = fileHostSeen.filter((r) => r.url.startsWith("/blob/"));
	const leakIn = (r: { url: string; headers: Record<string, string> }) => JSON.stringify(r).includes(API_KEY) || Object.keys(r.headers).some((h) => /zotero|api-key/i.test(h)) || /[?&]key=/.test(r.url);
	const leaked = fileHostSeen.filter(leakIn);
	check("the mock file host got the file request and no key: not in a header, not in the URL", blobReqs.length >= 1 && leaked.length === 0, `${fileHostSeen.length} request(s) to the file host (${fileHostSeen.map((r) => r.method).join(",")}), ${leaked.length} with the key; headers seen: ${Object.keys(blobReqs[0]?.headers ?? {}).join(",")}; url ${blobReqs[0]?.url}`);
	const apiLog = mock.log.filter((l) => !l.path.startsWith("/blob/") && !l.path.startsWith("/upload/"));
	check("the mock API got the key as the `key` query parameter on every request (a refused wrong key aside)", apiLog.length > 3 && apiLog.every((l) => l.query.key === API_KEY || l.query.key === "wrong-key"), `${apiLog.length} API requests, ${apiLog.filter((l) => l.status === 403).length} refused`);

	// ---- 7. an edit is uploaded
	const postsBefore = mock.posts().length;
	const edit = await api(tab, "PATCH", "/items/ITEM0002", { data: { title: "Second mock paper, edited in the page" } });
	await api(tab, "POST", "/websync/now");
	await until("push", async () => mock.item("ITEM0002")?.data.title === "Second mock paper, edited in the page", 20_000);
	check("an item edited in the page is uploaded (the mock recorded the write)", edit.status === 200 && mock.posts().length > postsBefore && mock.item("ITEM0002")?.data.title === "Second mock paper, edited in the page", `edit ${edit.status}; ${mock.posts().length - postsBefore} write request(s); mock title ${q(mock.item("ITEM0002")?.data.title)}; pending ${(await status()).pending}`);
	check("the local items were uploaded too", [...mock.objects.values()].some((o) => o.data.title === "Written in the page"), `${[...mock.objects.values()].filter((o) => /^Written/.test(o.data.title ?? "")).length} of 2 on the mock`);

	// ---- 8. the key stays out of every response; errors
	const hits = seenTexts.filter((t) => t.includes(API_KEY)).length;
	check("the API key is in no response the page got", hits === 0, `searched ${seenTexts.reduce((n, t) => n + t.length, 0)} characters in ${seenTexts.length} responses; ${hits} hit(s)`);
	const errs = problems.filter((p) => !IGNORED.test(p));
	check("no page or worker errors", errs.length === 0, errs.slice(0, 6).join(" | ") || "none");
	await cdp.send("Browser.close").catch(() => {});
} finally {
	await sleep(1500);
	await killChrome();
	mock.stop();
	fileHost.stop(true);
	siteServer.stop(true);
	await sleep(1500);
	if (!KEEP) try { rmSync(join(WORK, "profile"), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch (e) { console.log(`could not delete the profile yet: ${(e as Error).message}`); }
}
writeFileSync(join(WORK, "results.json"), JSON.stringify({ measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
