// Headless check of the browser library (docs/design/browser-edition.md, step B1; web/browser-db/CONTRACT.md):
//   bun web/browser-library-check.ts [--dist <dir>] [--chrome <exe>] [--work <dir>] [--key-file <extension-key.txt>] [--keep]
// --dist: a build of `bun web/build.ts --target extension` (default gpui-ui/dist-extension).
//
// The extension loaded is a minimal one made here: the connector's manifest key (the same id), permissions offscreen and
// unlimitedStorage, the library page's CSP, web/browser-db/test-background.js as its service worker (it creates the offscreen
// document on {zincEnsureDb: true}, as the connector's background does), and library/ as a link to the build (nothing copied).
// No native host is registered. Chrome for Testing, its own fresh profile and CDP port 9352; nothing of the user's browser is touched.
//
// Checks: the empty library loads; a collection and an item made through the page's API are there after a reload and after Chrome
// is quit and started again on the same profile (and after it is killed); an item made in one tab shows in a second tab within
// 1 s; a connector save (saveItems over a "zinc-db" port) lands in the library; the policy (/api/sync, /api/integrations: 403);
// journal mode and migrations on the sahpool VFS; screenshots in light and dark; no page errors and no CSP violations.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = resolve(arg("dist") ?? join(ROOT, "gpui-ui", "dist-extension"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-browser-library-check"));
const KEEP = process.argv.includes("--keep");
const KEY_FILE = arg("key-file") ?? join(homedir(), "zotero-next-connector", "extension-key.txt");
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const CDP_PORT = 9352;
const PAGE = `chrome-extension://${EXT_ID}/library/library.html?mode=browser`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const r1 = (n: number) => Math.round(n * 10) / 10;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

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
// a link left by an earlier run: remove the link itself first, so the recursive delete below cannot follow it into the build
if (existsSync(join(ext, "library"))) spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
for (const d of ["shots", "ext"]) mkdirSync(join(WORK, d), { recursive: true });
// --iframe: library/offscreen.html is a hidden iframe inside the extension's one offscreen document, as in the real connector
const IFRAME = process.argv.includes("--iframe");
const background = readFileSync(join(import.meta.dir, "browser-db", "test-background.js"), "utf8");
writeFileSync(join(ext, "test-background.js"), IFRAME ? `self.ZINC_TEST_OFFSCREEN = "test-offscreen.html";\n${background}` : background);
if (IFRAME) writeFileSync(join(ext, "test-offscreen.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe src="library/offscreen.html" style="display:none"></iframe></body></html>\n`);
writeFileSync(join(ext, "manifest.json"), JSON.stringify({
	name: "Zinc browser library check", manifest_version: 3, version: "1.0", key: readFileSync(KEY_FILE, "utf8").trim(),
	permissions: ["offscreen", "unlimitedStorage", "storage"], background: { service_worker: "test-background.js" },
	content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
}, null, 2));
spawnSync("cmd", ["/c", "mklink", "/J", join(ext, "library"), DIST], { stdio: "ignore" });
if (!existsSync(join(ext, "library", "library.html"))) throw new Error("could not link library/ to the build");

// ---- Chrome and the DevTools protocol
let chrome: ChildProcess | null = null;
const launch = (): ChildProcess => spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, "profile")}`,
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
}

/** Open the library tab on the browser library; resolves when its first list is in. Returns the session and the ms it took. */
async function openLibrary(cdp: Cdp, label: string): Promise<{ tab: Session; ms: number; targetId: string }> {
	const { result: { targetId } } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const tab = await Session.attach(cdp, targetId, label);
	const t0 = performance.now();
	await tab.send("Page.navigate", { url: PAGE });
	const ok = await tab.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0", 90_000);
	if (!ok) {
		const here = await tab.evalIn<string>("location.href + ' | ' + document.readyState + ' | ' + (document.body?.innerText ?? '').slice(0, 200)").catch((e) => `eval failed: ${e}`);
		const ds = await dbSessions(cdp).catch(() => ({}) as { off?: Session });
		const state = ds.off ? await ds.off.evalIn<string>("JSON.stringify(znOffscreen.state)").catch((e) => String(e)) : "no offscreen document";
		throw new Error(`${label}: the library tab did not load. Page: ${here}. Offscreen: ${state}. Problems: ${problems.slice(-4).join(" | ")}`);
	}
	return { tab, ms: performance.now() - t0, targetId };
}

/** Attach to the offscreen document and the database worker (if they exist) and read what they report. */
async function dbSessions(cdp: Cdp): Promise<{ off?: Session; worker?: Session }> {
	const { result: { targetInfos } } = await cdp.send("Target.getTargets");
	// (an iframe of an extension page is not a target of its own)
	const off = targetInfos.find((t: any) => t.url.endsWith("/library/offscreen.html") && t.type !== "iframe");
	const offSession = off ? await Session.attach(cdp, off.targetId, "offscreen") : undefined;
	// the worker is a child target of the offscreen document: auto-attach reports the running one
	let worker: Session | undefined;
	if (offSession) {
		const got = new Promise<string | null>((res) => {
			const t = setTimeout(() => res(null), 4000);
			cdp.listeners.push((m) => { if (m.method === "Target.attachedToTarget" && m.sessionId === offSession.sid && m.params.targetInfo.type === "worker") { clearTimeout(t); res(m.params.sessionId); } });
		});
		await offSession.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
		const sid = await got;
		if (sid) { worker = new Session(cdp, sid, "db-worker"); await cdp.send("Runtime.enable", {}, sid); }
	}
	return { off: offSession, worker };
}

const q = (s: unknown) => JSON.stringify(s);
const ATT_TEXT = "hello from the browser library, stored in OPFS";
/** The text of an attachment's file as the library serves it ("" when it is not there). */
const readAtt = (t: Session, key: string) => t.evalIn<string>(`znLibrary.api("GET", "/attachments/${key}/file").then((r) => r.text)`);
const ITEMS = (tab: Session) => tab.evalIn<{ total: number; items: { key: string; title: string }[] }>(`znLibrary.api("GET", "/items?limit=200&sort=title&dir=asc").then((r) => r.json)`);
const COLLS = (tab: Session) => tab.evalIn<{ key: string; name: string }[]>(`znLibrary.api("GET", "/collections").then((r) => r.json)`);

async function quit(cdp: Cdp, how: "graceful" | "kill"): Promise<void> {
	const proc = chrome!;
	const exited = new Promise<void>((r) => proc.once("exit", () => r()));
	if (how === "graceful") { await cdp.send("Browser.close").catch(() => {}); } else if (proc.pid) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
	await Promise.race([exited, sleep(15_000)]);
	if (proc.pid && proc.exitCode === null) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
	try { cdp.ws.close(); } catch { /* gone */ }
	await sleep(1500);
}

const fixtureItem = {
	id: "fx1", itemType: "journalArticle", title: "Connector fixture: perfusion in the browser library",
	creators: [{ firstName: "Ana", lastName: "Lopez", creatorType: "author" }], date: "2025", publicationTitle: "Journal of Fixtures",
	url: "https://example.org/fixture", tags: [{ tag: "fixture" }],
};
/** One raw connector call over a "zinc-db" port from inside an extension page: the frames the connector sends (CONTRACT.md "Transport"). */
const connectorCall = (method: string, json: unknown) => `new Promise((resolve, reject) => {
	const port = chrome.runtime.connect({ name: "zinc-db" });
	const t0 = performance.now(); let head = null; const parts = [];
	port.onMessage.addListener((m) => {
		if (m.t === "res") { head = m; if (!m.n) fin(); }
		else if (m.t === "rc") { parts[m.seq] = atob(m.data); if (parts.filter(Boolean).length === head.n) fin(); }
	});
	const fin = () => { port.disconnect(); resolve({ status: head.status, text: parts.join(""), ms: performance.now() - t0 }); };
	setTimeout(() => reject(new Error("no answer")), 20000);
	port.postMessage({ t: "req", id: 1, method: ${q(method)}, http: "POST", headers: { "content-type": "application/json" }, body: { kind: "text", text: ${q(JSON.stringify(json))} } });
})`;

try {
	chrome = launch();
	let cdp = await Cdp.connect();

	// ---- 1. the empty library
	const first = await openLibrary(cdp, "tab1");
	let tab1 = first.tab;
	const empty = await tab1.evalIn<{ total: number; browser: boolean }>("({ total: znLibrary.store.total(), browser: znLibrary.browser })");
	check("the empty browser library loads (cold: offscreen document, SQLite on OPFS, migrations)", empty.total === 0 && empty.browser, `list in after ${Math.round(first.ms)} ms, ${empty.total} items`);
	measures.emptyLibraryColdLoadMs = Math.round(first.ms);
	const { off, worker } = await dbSessions(cdp);
	check(`the offscreen document${IFRAME ? " (as an iframe in the connector's own)" : ""} and its database worker are running`, IFRAME || (!!off && !!worker), `${IFRAME ? "an iframe is not a DevTools target of its own: shown to work by the checks below; " : ""}${off ? "offscreen" : "no offscreen"}, ${worker ? "worker" : "no worker"}; state ${off ? q(await off.evalIn("znOffscreen.state")) : "?"}`);
	if (worker) {
		const j = await worker.evalIn<{ mode: string; version: string; file: string }>(`(() => { const d = znDb.db; return { mode: d.query("PRAGMA journal_mode").get().journal_mode, version: d.query("SELECT value FROM meta WHERE name = 'schema_version'").get().value, file: d.filename }; })()`);
		check("migrations ran on the sahpool VFS (journal mode and file name)", j.file === "/opfs/zinc/library.sqlite" && /^\d+$/.test(j.version), `schema_version ${j.version}, journal_mode ${j.mode}, filename ${j.file}`);
		measures.journalMode = j.mode;
	}

	// the request round trip: a small GET, 60 times
	const rtts = await tab1.evalIn<number[]>(`(async () => { const a = []; for (let i = 0; i < 60; i++) { const t = performance.now(); await znLibrary.api("GET", "/ui/selection"); a.push(performance.now() - t); } return a; })()`);
	measures.requestRoundTripMs = { median: r1(median(rtts)), max: r1(Math.max(...rtts)) };
	check("request round trip over the port (GET /api/ui/selection)", median(rtts) < 50, `median ${r1(median(rtts))} ms, max ${r1(Math.max(...rtts))} ms`);
	const idleNotices = await tab1.evalIn<number>("znLibrary.notices.length");
	await sleep(2500);
	const idleAfter = await tab1.evalIn<number>("znLibrary.notices.length");
	check("no change notices while nothing is written", idleAfter === idleNotices, `${idleNotices} -> ${idleAfter}`);

	// the policy
	const pol = await tab1.evalIn<number[]>(`Promise.all([ "/sync/status", "/integrations/tokens" ].map((p) => znLibrary.api("GET", p).then((r) => r.status))).then(async (a) => [...a, (await znLibrary.api("GET", "/websync/status")).status])`);
	check("policy: /api/sync and /api/integrations answer 403, /api/websync is served", pol[0] === 403 && pol[1] === 403 && pol[2] !== 403, `sync ${pol[0]}, integrations ${pol[1]}, websync ${pol[2]}`);

	// ---- 2. write through the page's API
	const coll = await tab1.evalIn<{ status: number; json: { key: string } }>(`znLibrary.api("POST", "/collections", { name: "Browser collection" })`);
	const item = await tab1.evalIn<{ status: number; json: { key?: string; data?: { key: string } } }>(`znLibrary.api("POST", "/items", { data: { itemType: "book", title: "Written in the browser" } })`);
	const itemKey = item.json.key ?? item.json.data?.key ?? "";
	check("a collection and an item are created through the page's API", coll.status < 300 && !!coll.json.key && item.status < 300 && !!itemKey, `collection ${coll.json.key} (${coll.status}), item ${itemKey} (${item.status})`);
	// a file: an attachment uploaded through the API goes to the durable file store (files.sqlite in the same pool)
	const att = await tab1.evalIn<{ status: number; json: { key?: string; data?: { key?: string } } }>(`znLibrary.api("POST", "/add/file", { name: "note.txt", contentType: "text/plain", dataBase64: btoa(${q(ATT_TEXT)}), mode: "imported_file", parentKey: ${q(itemKey)} })`);
	check("an attachment uploaded through the API is stored", att.status === 201 && !!(att.json.key ?? att.json.data?.key), `status ${att.status}, key ${att.json.key ?? att.json.data?.key}`);
	const attKey = att.json.key ?? att.json.data?.key ?? "";
	check("the file reads back", (await readAtt(tab1, attKey)) === ATT_TEXT, "");
	const noticed = await tab1.waitFor("znLibrary.notices.length > 0 && znLibrary.store.total() === 1", 5000);
	check("the page refreshes its list on the change notice (no polling)", noticed, `notices ${await tab1.evalIn("znLibrary.notices.length")}, list total ${await tab1.evalIn("znLibrary.store.total()")}`);
	await tab1.shot("1-first-items-light");

	// ---- 3. reload the tab
	await tab1.send("Page.reload");
	await sleep(300);
	const reloaded = await tab1.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0 && znLibrary.store.total() > 0", 60_000);
	const afterReload = reloaded ? { items: await ITEMS(tab1), colls: await COLLS(tab1) } : null;
	check("after reloading the tab: the collection and the item are still there", !!afterReload && afterReload.items.items.some((i) => i.key === itemKey) && afterReload.colls.some((c) => c.key === coll.json.key), JSON.stringify(afterReload && { items: afterReload.items.items.map((i) => i.title), colls: afterReload.colls.map((c) => c.name) }));

	check("after reloading the tab: the attachment's file is still there", (await readAtt(tab1, attKey)) === ATT_TEXT, "");

	// ---- 4. a second tab: a change in tab 1 shows in tab 2 within 1 s
	const second = await openLibrary(cdp, "tab2");
	const tab2 = second.tab;
	measures.emptyLibraryWarmLoadMs = Math.round(second.ms);
	const base = await tab2.evalIn<number>("znLibrary.store.total()");
	await tab2.evalIn(`(() => { globalThis.__seenAt = null; const iv = setInterval(() => { if (znLibrary.store.total() > ${base}) { globalThis.__seenAt = Date.now(); clearInterval(iv); } }, 10); })()`);
	await sleep(300);
	const madeAt = await tab1.evalIn<number>(`znLibrary.api("POST", "/items", { data: { itemType: "book", title: "Made in tab 1" } }).then(() => Date.now())`);
	const seen = await tab2.waitFor("globalThis.__seenAt !== null", 5000);
	const lag = seen ? (await tab2.evalIn<number>("globalThis.__seenAt")) - madeAt : -1;
	measures.changeToOtherTabMs = lag;
	check("an item made in tab 1 shows in tab 2 within 1 s", seen && lag <= 1000, `${lag} ms (from the answer to tab 1's request to tab 2's list showing it); second tab loaded in ${Math.round(second.ms)} ms`);

	// ---- 5. a connector save over a zinc-db port
	const saved = await tab2.evalIn<{ status: number; text: string; ms: number }>(connectorCall("saveItems", { sessionID: "S1", uri: "https://example.org/fixture", items: [fixtureItem] }));
	const sess = await tab2.evalIn<{ status: number; text: string }>(connectorCall("sessionItems", { sessionID: "S1" }));
	const sessJson = (() => { try { return JSON.parse(sess.text); } catch { return null; } })();
	check("a connector save (saveItems over a zinc-db port) is accepted", saved.status === 201, `status ${saved.status}, ${r1(saved.ms)} ms`);
	const landed = (await ITEMS(tab2)).items.find((i) => i.title.startsWith("Connector fixture"));
	check("the saved item is in the library, and sessionItems lists it", !!landed && sessJson?.items?.length === 1, `${landed?.key}; sessionItems: ${sess.status} ${sess.text.slice(0, 120)}`);
	const t1Sees = await tab1.waitFor(`znLibrary.store.total() >= 3`, 3000);
	check("the save shows in the other tab by itself", t1Sees, `tab 1 list total ${await tab1.evalIn("znLibrary.store.total()")}`);
	const n404 = await tab2.evalIn<number[]>(`Promise.all([${q("getTranslators")}, ${q("revealInApp")}].map((m) => ${connectorCall("X", {}).replace('method: "X"', "method: m")}.then((r) => r.status)))`);
	check("getTranslators and revealInApp answer 404", n404[0] === 404 && n404[1] === 404, JSON.stringify(n404));

	// ---- 6. screenshots
	const tabCount = await tab1.evalIn<number>("znLibrary.store.total()");
	await tab1.evalIn("znLibrary.setTheme('light')");
	await sleep(1200);
	await tab1.shot("2-library-light");
	await tab1.evalIn("znLibrary.setTheme('dark')");
	await sleep(1200);
	await tab1.shot("3-library-dark");
	await tab1.evalIn("znLibrary.setTheme('light')");

	// ---- 7. quit Chrome, start it again on the same profile
	const expectTotal = tabCount;
	await quit(cdp, "graceful");
	chrome = launch();
	cdp = await Cdp.connect();
	const again = await openLibrary(cdp, "tab-restart");
	tab1 = again.tab;
	const afterQuit = { items: await ITEMS(tab1), colls: await COLLS(tab1) };
	check("after quitting Chrome and starting it again on the same profile: the collection and the items are still there",
		afterQuit.items.total === expectTotal && afterQuit.colls.some((c) => c.key === coll.json.key) && afterQuit.items.items.some((i) => i.key === itemKey),
		`${afterQuit.items.items.map((i) => i.title).join(" | ")}; ${afterQuit.colls.length} collection(s); library loaded in ${Math.round(again.ms)} ms`);
	check("after the restart: the attachment's file is still there", (await readAtt(tab1, attKey)) === ATT_TEXT, "");
	measures.coldStartAfterRestartMs = Math.round(again.ms);
	await tab1.shot("4-after-restart-light");

	// a write, then kill the browser process (no clean shutdown)
	const k = await tab1.evalIn<number>(`znLibrary.api("POST", "/items", { data: { itemType: "book", title: "Written just before the kill" } }).then((r) => r.status)`);
	await sleep(300);
	await quit(cdp, "kill");
	chrome = launch();
	cdp = await Cdp.connect();
	const crash = await openLibrary(cdp, "tab-after-kill");
	const afterKill = await ITEMS(crash.tab);
	check("after killing Chrome (no clean shutdown): a committed item is still there and the library opens", k < 300 && afterKill.items.some((i) => i.title === "Written just before the kill") && afterKill.total === expectTotal + 1, `${afterKill.total} items, library loaded in ${Math.round(crash.ms)} ms`);
	if (!afterKill.items.length) await crash.tab.shot("5-after-kill");
	check("after the kill: the attachment's file is still there", (await readAtt(crash.tab, attKey)) === ATT_TEXT, "");
	const bg = await crash.tab.evalIn<unknown[]>("znLibrary.requests.filter((r) => r.status !== 200 && r.status !== 403 && r.status !== 201)");
	check("no request failed in the last page", bg.length === 0, JSON.stringify(bg));

	const errs = problems.filter((p) => !IGNORED.test(p));
	check("no page, offscreen or worker errors, and no CSP violations", errs.length === 0, errs.slice(0, 6).join(" | ") || "none");
	await quit(cdp, "graceful");
	chrome = null;
} finally {
	if (chrome?.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	await sleep(1500);
	// the junction only: never the build it points to
	spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
	await sleep(2000);
	if (!KEEP) try { rmSync(join(WORK, "profile"), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch (e) { console.log(`could not delete the profile yet: ${(e as Error).message}`); }
}
writeFileSync(join(WORK, "results.json"), JSON.stringify({ measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify(measures, null, 2));
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
