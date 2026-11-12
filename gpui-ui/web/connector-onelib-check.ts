// Headless end-to-end check of "one library per computer" in the Zinc Connector (docs/design/browser-edition.md, section 6):
//   bun web/connector-onelib-check.ts [--ext <connector build/manifestv3>] [--chrome <chrome.exe>] [--work <dir>] [--shots <dir>] [--keep]
// --ext: the connector built from its `browser-library` branch with `bun scripts/build-win.ts --library <gpui-ui/dist-extension>`
// (default C:\Users\abora\zotero-next-connector-library\build\manifestv3).
//
// What it walks through, in one Chrome for Testing run (fresh profile, CDP port 9362):
//   1. no native host registered     -> saves go to the browser library; the popup says "Saving to: This browser" and has no Change control
//   2. the test host is registered   -> the next save goes to the app's library (a fixture library in the work folder), the popup says
//                                        "Saving to: Zinc app", and offers "Move your browser library into Zinc" (the library tab does too)
//   3. the move                      -> the browser items are in the fixture library (items, collection, tag, note, annotation, the PDF in
//                                        its storage folder, the sync outbox), an item the app already had is left alone, and the
//                                        browser library is empty
//   4. the host is unregistered      -> back to the browser library
//   5. the host is registered but fails (it exits at once) -> the save fails with the host's message and a Try again button; nothing goes
//                                        to the browser library; Try again works once the host does
//
// Safety: Chrome for Testing reads HKCU\Software\Google\Chrome\NativeMessagingHosts too (the user's real host is registered there), so the
// extension that is loaded is a COPY (<work>/ext) in which only the host name in nativeHost.js is changed, to
// com.zotero_next.connector_host_e2e_one. That name is registered only under HKCU\Software\Chromium\NativeMessagingHosts, only while this
// runs, pointing at a host compiled to <work>/host with a fixture library (ZN_DB) and no app port (ZNH_APP_PORT=0). Nothing leaves this
// machine: no proxy, every name except 127.0.0.1 is unresolvable. Only processes this run started are stopped, by PID.
import { spawn, spawnSync } from "node:child_process";
import { assertSafeToStart, makeConnectorTestCopy } from "./check-safety";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as repo from "../../core/src/db";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const EXT_BUILD = resolve(arg("ext") ?? join(homedir(), "zotero-next-connector-library", "build", "manifestv3"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-onelib", "onelib-check"));
const SHOTS = resolve(arg("shots") ?? join(WORK, "shots"));
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..", "..");
const CDP_PORT = Number(arg("port") ?? 9362);
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const HOST_NAME = "com.zotero_next.connector_host_e2e_one";
const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}
const _log = console.log;
console.log = (...a: unknown[]) => { _log(...a); try { appendFileSync(join(SHOTS, "progress.log"), a.join(" ") + "\n"); } catch { /* shots dir not made yet */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: unknown) => JSON.stringify(s);
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const run = (cmd: string[], cwd: string) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
};

if (!existsSync(join(EXT_BUILD, "popup", "popup.html")) || !existsSync(join(EXT_BUILD, "library", "library.html"))) throw new Error(`${EXT_BUILD} is not a connector build with popup/ and library/ (build with --library)`);
// the machine must have room and not be busy (the checks start a browser)
const load = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"], { encoding: "utf8" });
if (Number(load.stdout.trim()) > 85) throw new Error(`CPU load is ${load.stdout.trim()}%: wait`);
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const EXT = join(WORK, "ext");
// a copy of the build whose real host name is replaced, in every script, by this check's own (web/check-safety.ts)
makeConnectorTestCopy(EXT_BUILD, EXT, HOST_NAME);
for (const d of ["host", "shots", "norepo"]) mkdirSync(join(WORK, d), { recursive: true });

// ---- the app's library (a fixture), the host, and the pages to save
const libDir = join(WORK, "app-library");
mkdirSync(libDir, { recursive: true });
const dbPath = join(libDir, "library.sqlite");
{
	const fx = repo.openDb(dbPath);
	repo.createItem(fx, { itemType: "book", title: "Already in the app (fixture)" } as never);
	fx.close(true);
}
const hostExe = join(WORK, "host", "zinc-e2e-host.exe");
run(["bun", "build", "--compile", join(ROOT, "connector-host", "src", "main.ts"), "--outfile", hostExe], join(ROOT, "connector-host"));
const manifestPath = join(WORK, "host", `${HOST_NAME}.json`);
const writeManifest = (path: string) => writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, description: "Zinc host (one-library check, fixture library)", path, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
const brokenHost = join(WORK, "host", "broken-host.bat");
writeFileSync(brokenHost, "@echo off\r\nexit /b 3\r\n");
const register = (path: string) => { writeManifest(path); run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], WORK); };
const unregister = () => { spawnSync("reg", ["delete", REG_KEY, "/f"], { stdio: "ignore" }); };
const q2 = <T,>(sql: string, ...p: unknown[]): T[] => {
	const db = repo.openDb(dbPath);
	try { return db.query(sql).all(...(p as never[])) as T[]; } finally { db.close(true); }
};

const TRANSLATOR_DIR = join(ROOT, "core", "vendor", "zotero", "translators");
const EM_CODE = readFileSync(join(TRANSLATOR_DIR, "Embedded Metadata.js"), "utf8");
const EM_META = JSON.parse(/^\s*{[\S\s]*?}\s*?[\r\n]/.exec(EM_CODE)![0]);
// Embedded Metadata hands the page's metadata to the RDF import translator: both are served by the local repository mock
const RDF_CODE = readFileSync(join(TRANSLATOR_DIR, "RDF.js"), "utf8");
const RDF_META = JSON.parse(/^\s*{[\S\s]*?}\s*?[\r\n]/.exec(RDF_CODE)![0]);
const REPO_CODE: Record<string, string> = { [EM_META.translatorID]: EM_CODE, [RDF_META.translatorID]: RDF_CODE };
const ARTICLES: Record<string, { title: string; doi: string }> = {
	"1": { title: "Machine perfusion of donor livers: a fixture article", doi: "10.5555/zinc.one.1" },
	"2": { title: "Cold ischaemia and graft survival: a second fixture article", doi: "10.5555/zinc.one.2" },
	"3": { title: "Normothermic regeneration of kidneys: a third fixture article", doi: "10.5555/zinc.one.3" },
	"4": { title: "Ex vivo lung perfusion outcomes: a fourth fixture article", doi: "10.5555/zinc.one.4" },
	"5": { title: "Hypothermic oxygenated perfusion trials: a fifth fixture article", doi: "10.5555/zinc.one.5" },
};
function pdfBytes(n: string): Uint8Array {
	const stream = `BT /F1 18 Tf 72 700 Td (Fixture PDF ${n}) Tj ET`;
	const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out + `% ${"padding ".repeat(20_000)}\n`); // ~160 KB
}
const PDF_SIZE = pdfBytes("3").length;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		if (u.pathname === "/repo/metadata") return new Response(JSON.stringify([EM_META, RDF_META]), { headers: { "Content-Type": "application/json", Date: new Date().toUTCString() } });
		const code = /^\/repo\/code\/([0-9a-f-]+)$/.exec(u.pathname);
		if (code && REPO_CODE[code[1]!]) return new Response(REPO_CODE[code[1]!], { headers: { "Content-Type": "text/plain" } });
		const m = /^\/article(\d)\.html$/.exec(u.pathname);
		if (m && ARTICLES[m[1]!]) {
			const a = ARTICLES[m[1]!]!;
			return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${a.title}</title>
<meta name="citation_title" content="${a.title}"><meta name="citation_author" content="Smith, Jane"><meta name="citation_author" content="Patel, Raj">
<meta name="citation_journal_title" content="Journal of Fixture Studies"><meta name="citation_publication_date" content="2024/03/01">
<meta name="citation_volume" content="12"><meta name="citation_doi" content="${a.doi}">
<meta name="citation_pdf_url" content="${u.origin}/paper${m[1]}.pdf"></head>
<body><h1>${a.title}</h1><p>A page made for the Zinc Connector's headless check. No real article.</p></body></html>`, { headers: { "Content-Type": "text/html" } });
		}
		const p = /^\/paper(\d)\.pdf$/.exec(u.pathname);
		if (p && ARTICLES[p[1]!]) return new Response(pdfBytes(p[1]!) as BlobPart, { headers: { "Content-Type": "application/pdf" } });
		return new Response("not found", { status: 404 });
	},
});

// ---- Chrome: only if nothing it loads can reach a host registered for the user's browser (web/check-safety.ts)
assertSafeToStart({ extDir: EXT, hostNames: [HOST_NAME] });
const profile = join(WORK, "profile");
const chrome = spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
	`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
	"--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=1400,900",
	"--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
	"--disable-background-networking", "--disable-component-update", "--disable-sync",
	"about:blank",
], { stdio: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0", ZNH_REPO: join(WORK, "norepo") } });

try {
	let ver: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json() as typeof ver; } catch { await sleep(200); } }
	if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
	const ws = new WebSocket(ver.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let nextId = 1;
	const pending = new Map<number, (v: any) => void>();
	const listeners: ((m: any) => void)[] = [];
	ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else for (const l of listeners) l(m); };
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
	const problems: string[] = [];
	const attach = async (targetId: string, label: string) => {
		const { result } = await send("Target.attachToTarget", { targetId, flatten: true });
		const sid = result.sessionId as string;
		listeners.push((m) => {
			if (m.sessionId !== sid) return;
			if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "warning" || m.params.type === "error") && label.startsWith("library")) problems.push(`${label} console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 400)}`);
			if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; problems.push(`${label} exception: ${(d.exception?.description ?? d.text).slice(0, 400)} at ${d.url ?? ""}:${d.lineNumber ?? ""}`); }
		});
		await send("Runtime.enable", {}, sid);
		return sid;
	};
	const evalIn = async <T,>(sid: string, expression: string): Promise<T> => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (sid: string, expression: string, ms: number): Promise<boolean> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { try { if (await evalIn<boolean>(sid, expression)) return true; } catch { /* loading */ } }
		return false;
	};
	const openTab = async (url: string, label: string) => {
		const { result: { targetId } } = await send("Target.createTarget", { url });
		return { targetId, sid: await attach(targetId, label) };
	};
	const closeTab = (t: { targetId: string }) => send("Target.closeTarget", { targetId: t.targetId });
	const findTarget = async (pred: (t: any) => boolean, ms = 10_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { const t = ((await send("Target.getTargets")).result.targetInfos as any[]).find(pred); if (t) return t; }
		return undefined;
	};

	// ---- the background
	const swInfo = await findTarget((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`), 30_000);
	if (!swInfo) throw new Error("the extension's service worker did not start");
	const sw = await attach(swInfo.targetId, "background");
	if (process.argv.includes("--debug")) listeners.push((m) => { if (m.sessionId === sw && m.method === "Runtime.consoleAPICalled") console.log("bg:", m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)); });
	await waitFor(sw, "typeof Zotero !== 'undefined' && !!Zotero.NativeHost && !!Zotero.SavePopup", 20_000);
	const base = `http://127.0.0.1:${server.port}`;
	await evalIn(sw, `ZOTERO_CONFIG.REPOSITORY_URL = ${q(`${base}/repo/`)}`);
	await evalIn(sw, "Zotero.Translators.updateFromRemote(true)").catch((e) => console.log(`translator reload: ${e.message}`));

	// a call to the browser library over a zinc-db port, from the background (the way nativeHost.js talks to it)
	const HELPERS = `globalThis.znCall ||= (method, http, path, body) => new Promise((resolve, reject) => {
		const port = chrome.runtime.connect({ name: 'zinc-db' });
		let head = null, got = 0; const parts = [];
		const timer = setTimeout(() => { port.disconnect(); reject(new Error('no answer from the library')); }, 30000);
		const fin = () => { clearTimeout(timer); port.disconnect(); const bin = parts.map((p) => atob(p)).join(''); resolve({ status: head.status, size: bin.length, text: decodeURIComponent(escape(bin.slice(0, 200000))) }); };
		port.onMessage.addListener((m) => { if (m.t === 'res') { head = m; if (!m.n) fin(); } else if (m.t === 'rc') { parts[m.seq] = m.data; if (++got === head.n) fin(); } });
		port.postMessage({ t: 'req', id: 1, method, http, path, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : { kind: 'text', text: JSON.stringify(body) } });
	})`;
	const browserApi = async (http: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
		const r = await evalIn<any>(sw, `(async () => { ${HELPERS}; return await znCall("api", ${q(http)}, ${q(path)}, ${body === undefined ? "undefined" : q(body)}); })()`);
		let json: any = null;
		try { json = r.text ? JSON.parse(r.text) : null; } catch { /* not JSON */ }
		return { status: r.status, json };
	};
	/** how many items the browser library holds (it may not exist yet: that is 0). Does not start it when it is not running. */
	const browserCount = async (): Promise<number> => {
		const exists = await evalIn<boolean>(sw, "chrome.storage.local.get('zincBrowserLibraryCreated').then((r) => !!r.zincBrowserLibraryCreated)");
		if (!exists) return 0;
		return Number((await browserApi("GET", "/api/browser/state")).json?.topLevelItems ?? 0);
	};
	const stored = (key: string) => evalIn<any>(sw, `chrome.storage.local.get(${q(key)}).then((r) => r[${q(key)}])`);

	// the offscreen document (translators run in it) exists, and the translator is loaded, before the first page is detected; detection
	// otherwise races both, and a page then saves as a plain web page
	await evalIn(sw, "Zotero.NativeHost.ensureOffscreen()");
	const haveTranslator = await waitFor(sw, `Zotero.Translators.get(${q(EM_META.translatorID)}).then((t) => !!t)`, 30_000);
	if (!haveTranslator) throw new Error("the Embedded Metadata translator did not load from the local repository mock");
	await sleep(1500);

	// ---- helpers for the pages and the popup
	const article = async (n: string) => {
		const t = await openTab(`${base}/article${n}.html`, `article${n}`);
		await send("Target.activateTarget", { targetId: t.targetId });
		const tabId = await evalIn<number>(sw, `browser.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith("/article${n}.html"))?.id)`);
		const has = `(Zotero.Connector_Browser.getTabInfo(${tabId})?.translators?.length ?? 0) > 0`;
		let found = await waitFor(sw, has, 25_000);
		for (let retry = 0; !found && retry < 2; retry++) {
			// the translator list was not loaded when the page did: load it again and reload the page
			await evalIn(sw, "Zotero.Translators.updateFromRemote(true)").catch(() => {});
			await send("Page.reload", {}, t.sid).catch(() => {});
			found = await waitFor(sw, has, 25_000);
		}
		if (!found) throw new Error(`no translator for article ${n}`);
		return { ...t, tabId };
	};
	const popup = async (tabId: number, save = true) => {
		const p = await openTab("about:blank", "popup");
		await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, p.sid);
		await send("Page.enable", {}, p.sid);
		await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}${save ? "" : "&save=0"}` }, p.sid);
		return p;
	};
	const shot = async (sid: string, name: string) => {
		const h = await evalIn<number>(sid, "Math.ceil(document.body.getBoundingClientRect().height)");
		const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 360, height: h, scale: 1 }, captureBeyondViewport: true }, sid);
		writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(s.result.data, "base64"));
	};
	const S = "window.znPopup && window.znPopup.state";
	const text = (sid: string, id: string) => evalIn<string>(sid, `document.getElementById(${q(id)}).textContent`);
	const visible = (sid: string, id: string) => evalIn<boolean>(sid, `!document.getElementById(${q(id)}).hidden`);
	/** save an article through the popup and wait for "Saved" (or the failure) */
	const saveArticle = async (n: string, shotName?: string) => {
		const a = await article(n);
		const p = await popup(a.tabId);
		// a save that cannot happen (the app's host fails) never finishes: the popup then shows the host's message (hostDown)
		const done = await waitFor(p.sid, `${S} && (znPopup.state.done || znPopup.state.hostDown)`, 60_000);
		await sleep(500);
		const st = await evalIn<any>(p.sid, `({ library: znPopup.state.library, done: znPopup.state.done, hostError: znPopup.state.hostError, key: znPopup.state.saved[0] && znPopup.state.saved[0].key, label: document.getElementById('target-name').textContent })`);
		if (process.argv.includes("--debug")) console.log(`save of article ${n}: ${await evalIn<string>(p.sid, "JSON.stringify({ errors: znPopup.state.errors, items: znPopup.state.items, saved: znPopup.state.saved.map((s) => [s.itemType, s.title]) })")}`);
		if (shotName) await shot(p.sid, shotName);
		return { ...a, popup: p, done, ...st };
	};
	const itemByTitle = (title: string) => q2<{ key: string; title: string }>("SELECT key, title FROM items WHERE title = ? AND parent_key IS NULL", title)[0];

	// ================================================================ 1. no host: the browser library
	const t1 = await evalIn<{ target: string; hostError: string | null }>(sw, "Zotero.NativeHost.refreshTarget()");
	check("no host registered: the target is the browser library, with no host error", t1.target === "browser" && t1.hostError === null, JSON.stringify(t1));
	const s1 = await saveArticle("1", "1-no-app-saved");
	check("a save with no host goes to the browser library", s1.done && s1.library === "browser" && s1.done.ok === true, `library ${s1.library}, done ${JSON.stringify(s1.done)}`);
	check('the popup says "Saving to: This browser", as a read-only label (no Change control, no "save to this browser instead")',
		s1.label === "This browser" && await evalIn<boolean>(s1.popup.sid, "!document.getElementById('target-change') && !document.getElementById('save-in-browser') && !document.querySelector('.target-opt') && document.querySelector('#target button') === null"), `label "${s1.label}"`);
	const lib1 = await stored("zincBrowserLibrary");
	check("no save target is stored", !JSON.stringify(lib1 ?? {}).includes("saveTarget"), JSON.stringify(lib1));
	check("the browser library holds the saved item, the app's library does not", (await browserCount()) === 1 && !itemByTitle(ARTICLES["1"]!.title), `browser items ${await browserCount()}; app has it: ${!!itemByTitle(ARTICLES["1"]!.title)}`);
	check("without an app there is no move offer", (await evalIn<boolean>(s1.popup.sid, `${S} && znPopup.state.move.offer === false`)) && !(await visible(s1.popup.sid, "move")), "popup: move section hidden");
	await closeTab(s1.popup);

	// a second article, with a collection, a tag, a note and an annotation on it (these must arrive in the app)
	const s3 = await saveArticle("3");
	const key3 = s3.key as string;
	// the item has a PDF and a web snapshot: the annotation goes on the PDF (the list's primary attachment)
	const detail3 = (await browserApi("GET", `/api/items/${key3}`)).json;
	const pdf3 = (detail3?.attachments ?? detail3?.children ?? []).find((a: any) => /pdf/i.test(a.contentType ?? a.data?.contentType ?? ""));
	const att3 = (pdf3?.key ?? pdf3?.data?.key) as string;
	if (!att3) throw new Error(`no PDF attachment on the saved item: ${JSON.stringify(detail3).slice(0, 600)}`);
	const coll = (await browserApi("POST", "/api/collections", { name: "Browser thesis" })).json?.key as string;
	await browserApi("POST", `/api/collections/${coll}/items`, { keys: [key3] });
	await browserApi("POST", `/api/items/${key3}/tags`, { tags: ["from-the-browser"] });
	const note = (await browserApi("POST", "/api/items", { data: { itemType: "note", note: "<p>A note written in the browser.</p>", parentItem: key3 } })).json?.data?.key as string;
	const ann = await browserApi("PUT", `/api/attachments/${att3}/annotations`, [{ id: "ANNOT003", type: "highlight", color: "#ffd400", sortIndex: "00000|000000|00000", position: { pageIndex: 0, rects: [[72, 700, 160, 718]] }, text: "Fixture PDF 3", comment: "", tags: [], pageLabel: "1", dateModified: new Date().toISOString(), authorName: "check" }]);
	check("the browser library has two saved items, a collection, a tag, a note and an annotation", (await browserCount()) === 2 && !!coll && !!note && ann.status === 200 && !!att3, `items ${await browserCount()}, collection ${coll}, note ${note}, attachment ${att3}, annotation PUT ${ann.status}`);
	await closeTab(s3.popup);
	const key1 = (await browserApi("GET", "/api/items?limit=50")).json?.items?.find((i: any) => i.title === ARTICLES["1"]!.title)?.key as string;

	// the app already has item 1 (same key, its own title): it must be skipped, not duplicated or overwritten
	const browserItem1 = (await browserApi("GET", `/api/items/${key1}`)).json?.data;
	{
		const d = repo.openDb(dbPath);
		d.query("INSERT INTO items(key, item_type, title, data, date_added, date_modified) VALUES (?, 'journalArticle', ?, ?, ?, ?)")
			.run(key1, "Same key, the app's own copy", JSON.stringify({ key: key1, itemType: "journalArticle", title: "Same key, the app's own copy", tags: [], collections: [], relations: {} }), browserItem1?.dateAdded ?? new Date().toISOString(), new Date().toISOString());
		d.close(true);
	}

	// ================================================================ 2. the host is registered: the app's library
	register(hostExe);
	await sleep(300);
	const t2 = await evalIn<{ target: string; hostError: string | null }>(sw, "Zotero.NativeHost.refreshTarget()");
	check("the test host is registered: the target is the app (looked up again, not remembered)", t2.target === "app" && t2.hostError === null, JSON.stringify(t2));
	const s2 = await saveArticle("2", "2-app-saved");
	const app2 = itemByTitle(ARTICLES["2"]!.title);
	const browserAfter = await browserCount();
	check("the next save goes to the app's library (the fixture), not the browser library", s2.done?.ok === true && s2.library === "app" && !!app2 && browserAfter === 2, `library ${s2.library}; in the fixture: ${app2?.key}; browser items ${browserAfter}`);
	check('the popup says "Saving to: Zinc app"', s2.label === "Zinc app", `label "${s2.label}"`);
	const offer = await waitFor(s2.popup.sid, `${S} && znPopup.state.move.offer === true && !document.getElementById('move').hidden`, 30_000);
	const offerText = offer ? await text(s2.popup.sid, "move-head") : "";
	check("the popup offers Move your browser library into Zinc, with the number of items", offer && /^Move your browser library into Zinc/.test(offerText) && /2 items/.test(await text(s2.popup.sid, "move-sub")), `"${offerText}" / "${offer ? await text(s2.popup.sid, "move-sub") : ""}"`);
	await shot(s2.popup.sid, "3-offer");

	// the library tab (the app's library) offers it too
	const libTab = await openTab(`chrome-extension://${EXT_ID}/library/library.html?host=${HOST_NAME}`, "library (app)");
	const libOffered = await waitFor(libTab.sid, "!!globalThis.znLibrary && znLibrary.move.offered === true", 90_000);
	check("the library tab on the app's library offers the move, with the number of items", libOffered && (await evalIn<number>(libTab.sid, "znLibrary.move.items")) === 2, `offered ${libOffered}, items ${await evalIn<number>(libTab.sid, "znLibrary.move && znLibrary.move.items").catch(() => "?")}`);
	if (!libOffered) console.log(`library tab problems so far: ${problems.filter((p) => p.startsWith("library")).join(" | ") || "none"}; move: ${JSON.stringify(await evalIn(libTab.sid, "globalThis.znLibrary && JSON.stringify(znLibrary.move)").catch((e) => String(e)))}`);
	await sleep(1200);
	{
		const s = await send("Page.captureScreenshot", { format: "png" }, libTab.sid);
		writeFileSync(join(SHOTS, "4-library-offer.png"), Buffer.from(s.result.data, "base64"));
	}

	// ================================================================ 3. the move (from the popup)
	const tMove = performance.now();
	await evalIn(s2.popup.sid, "document.getElementById('move-library').click()");
	const sawProgress = await waitFor(s2.popup.sid, `${S} && znPopup.state.move.busy === true`, 5000).catch(() => false);
	await shot(s2.popup.sid, "5-moving").catch(() => {});
	const moved = await waitFor(s2.popup.sid, `${S} && znPopup.state.move.result && !znPopup.state.move.busy`, 120_000);
	measures.moveMs = Math.round(performance.now() - tMove);
	const result = await evalIn<any>(s2.popup.sid, `${S} && znPopup.state.move.result`);
	const headText = await text(s2.popup.sid, "move-head");
	check('the popup shows progress, then "Moved 1 item into Zinc"', moved && headText === "Moved 1 item into Zinc" && result?.topLevelItems === 1 && result?.skippedItems === 1, `progress seen: ${sawProgress}; head "${headText}"; result ${JSON.stringify(result)}; ${measures.moveMs} ms`);
	await sleep(300);
	await shot(s2.popup.sid, "6-moved");
	const moved3 = itemByTitle(ARTICLES["3"]!.title);
	check("the browser's new item is in the app's library under its own key", moved3?.key === key3, `fixture has ${moved3?.key} (browser key ${key3})`);
	const dup = q2<{ title: string }>("SELECT title FROM items WHERE key = ?", key1);
	check("the item whose key the app already had is skipped: not duplicated, not overwritten", dup.length === 1 && dup[0]!.title === "Same key, the app's own copy" && !itemByTitle(ARTICLES["1"]!.title), JSON.stringify(dup));
	check("the collection, the tag, the note and the annotation arrived",
		q2("SELECT 1 FROM collections c JOIN collection_items ci ON ci.collection_key = c.key WHERE c.name = 'Browser thesis' AND ci.item_key = ?", key3).length === 1
		&& q2("SELECT 1 FROM item_tags WHERE item_key = ? AND tag = 'from-the-browser'", key3).length === 1
		&& q2("SELECT 1 FROM items WHERE key = ? AND parent_key = ?", note, key3).length === 1
		&& q2("SELECT 1 FROM annotations WHERE key = 'ANNOT003' AND attachment_key = ?", att3).length === 1,
		"collection membership, tag, child note, annotation");
	const attRow = q2<{ path: string; link_mode: string }>("SELECT path, link_mode FROM attachments WHERE item_key = ?", att3)[0];
	const fileOk = !!attRow?.path && existsSync(attRow.path) && statSync(attRow.path).size === PDF_SIZE && attRow.path.replaceAll("\\", "/").startsWith(`${libDir.replaceAll("\\", "/")}/storage/${att3}/`);
	check("the PDF is in the app library's storage folder, with its size", fileOk, `${attRow?.path}: ${attRow?.path && existsSync(attRow.path) ? statSync(attRow.path).size : "missing"} bytes (served ${PDF_SIZE})`);
	const outbox = q2<{ type: string; key: string }>("SELECT type, key FROM sync_outbox WHERE op = 'upsert'");
	check("the sync outbox records the new items, collection and annotation (and not the skipped item)", outbox.some((o) => o.type === "item" && o.key === key3) && outbox.some((o) => o.type === "item" && o.key === note) && outbox.some((o) => o.type === "collection" && o.key === coll) && outbox.some((o) => o.type === "annotation" && o.key === "ANNOT003"), `${outbox.length} outbox rows`);
	const left = await browserCount();
	const leftColl = Number((await browserApi("GET", "/api/browser/state")).json?.collections ?? -1);
	check("the browser library is empty afterwards", left === 0 && leftColl === 0, `items ${left}, collections ${leftColl}`);
	check("no move offer is left", !(await stored("zincBrowserLibraryCreated")) && (await evalIn<any>(sw, "Zotero.NativeHost.browserLibraryState()")).offer === false, "browserLibraryState().offer is false");
	// the library tab shows what was moved (the host's rev counter moved: the tab reloads its lists)
	const shown = await waitFor(libTab.sid, "znLibrary.store.total() >= 3", 20_000);
	check("the library tab on the app's library shows the moved item", shown, `items listed: ${await evalIn<number>(libTab.sid, "znLibrary.store.total()")}`);
	await closeTab(s2.popup);
	await closeTab(libTab);

	// ================================================================ 4. the host is unregistered: back to the browser library
	unregister();
	// the app is gone: its running host process goes with it (only the host this run started, by its path)
	const hostPids = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${hostExe.replaceAll("'", "''")}' }).ProcessId`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean);
	for (const pid of hostPids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
	await sleep(800);
	const t4 = await evalIn<{ target: string; hostError: string | null }>(sw, "Zotero.NativeHost.refreshTarget()");
	check("the host is unregistered (and its process gone): the target is the browser library again", t4.target === "browser" && t4.hostError === null, `${JSON.stringify(t4)}; stopped host pids ${hostPids.join(",") || "none"}`);
	const s4 = await saveArticle("4");
	check("a save after uninstalling goes to the browser library again; the app's library is unchanged", s4.done?.ok === true && s4.library === "browser" && s4.label === "This browser" && (await browserCount()) === 1 && !itemByTitle(ARTICLES["4"]!.title), `library ${s4.library}, label "${s4.label}", browser items ${await browserCount()}`);
	await closeTab(s4.popup);

	// ================================================================ 5. the host is registered but fails
	register(brokenHost);
	await sleep(300);
	const t5 = await evalIn<{ target: string; hostError: string | null }>(sw, "Zotero.NativeHost.refreshTarget()");
	check("a registered host that exits at once: the target is the app, with the host's message", t5.target === "app" && /exited|not available/i.test(t5.hostError ?? ""), JSON.stringify(t5));
	const before5 = await browserCount();
	const s5 = await saveArticle("5", "7-host-fails");
	const down = await visible(s5.popup.sid, "host-down");
	const msg5 = await text(s5.popup.sid, "host-down-message");
	const head5 = await text(s5.popup.sid, "headline");
	check("the save fails with the host's message and a Try again button; nothing is saved", s5.done?.ok !== true && down && head5 === "Could not save" && /not available|exited|communicating/i.test(msg5) && (await visible(s5.popup.sid, "try-again")), `headline "${head5}"; message "${msg5}"`);
	check("nothing went to the browser library (no second library)", (await browserCount()) === before5 && !itemByTitle(ARTICLES["5"]!.title) && s5.library === "app", `browser items ${await browserCount()} (before ${before5})`);
	// the host works again (a fixed install): Try again saves into the app
	register(hostExe);
	await sleep(300);
	await evalIn(s5.popup.sid, "document.getElementById('try-again').click()");
	const retried = await waitFor(s5.popup.sid, `${S} && znPopup.state.done && znPopup.state.done.ok === true && znPopup.state.library === 'app'`, 60_000);
	await sleep(500);
	await shot(s5.popup.sid, "8-try-again-saved");
	check("Try again saves into the app's library once the host works", retried && !!itemByTitle(ARTICLES["5"]!.title) && (await browserCount()) === before5, `in the fixture: ${itemByTitle(ARTICLES["5"]!.title)?.key}; browser items ${await browserCount()}`);
	await closeTab(s5.popup);

	// ================================================================ errors
	const errs = problems.filter((p) => !/repo\.zotero\.org\/repo\/metadata/.test(p) && !/^background exception: Error at \S+\/(translators\.js:66|background-worker\.js:0)$/.test(p));
	check("no exceptions in the popup, background, offscreen document or library tab", !errs.some((p) => /^(background|popup|offscreen|library)/.test(p)), errs.slice(0, 6).join(" | ") || "none");
	ws.close();
} finally {
	unregister();
	if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	server.stop(true);
	await sleep(1500);
	if (!KEEP) try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`profile not deleted yet: ${(e as Error).message}`); }
}
writeFileSync(join(SHOTS, "results.json"), JSON.stringify({ measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify(measures));
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(bad ? 1 : 0);
