// Headless end-to-end check of the Zinc Connector saving into the browser library (no native host; CONTRACT.md, work package C):
//   bun web/connector-browser-check.ts [--ext <connector build/manifestv3>] [--chrome <chrome.exe>] [--work <dir>] [--shots <dir>] [--keep]
// --ext: the connector built from its `browser-library` branch with `bun scripts/build-win.ts --library <gpui-ui/dist-extension>`
// (default C:\Users\abora\zotero-next-connector-library\build\manifestv3).
//
// Chrome for Testing, its own fresh profile, CDP port 9353. No native host is registered for the first part. Nothing leaves this
// machine: Chrome runs with --no-proxy-server and host-resolver rules that make every name except 127.0.0.1 unresolvable (so
// repo.zotero.org and api.zotero.org cannot be reached; api.zotero.org is mapped to the local mock, to test the header rule).
// Translators come from a local mock of the Zotero repository serving only "Embedded Metadata" (the connector's REPOSITORY_URL is
// pointed at it through CDP in the background); the pages saved are local fixtures with citation_* metadata and a PDF.
//
// IMPORTANT: Chrome for Testing reads HKCU\Software\Google\Chrome\NativeMessagingHosts too, so on a machine with Zinc installed it
// would start the installed host under the real name. So the check loads a COPY of the build (<work>/ext) in which only the host
// name in nativeHost.js is changed to one that is registered nowhere: "no native host". Nothing in the registry is touched.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendFileSync } from "node:fs";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const EXT_BUILD = resolve(arg("ext") ?? join(homedir(), "zotero-next-connector-library", "build", "manifestv3"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-w2-c"));
const SHOTS = resolve(arg("shots") ?? join(WORK, "shots"));
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..", "..");
const CDP_PORT = Number(arg("port") ?? 9353);
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const LIB_KEY = "zincBrowserLibrary";

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}
// progress is also appended to <shots>/progress.log (a run killed by a timeout loses buffered stdout)
const _log = console.log;
console.log = (...a: unknown[]) => { _log(...a); try { appendFileSync(join(SHOTS, "progress.log"), a.join(" ") + "\n"); } catch { /* shots dir not made yet */ } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: unknown) => JSON.stringify(s);
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

if (!existsSync(join(EXT_BUILD, "popup", "popup.html")) || !existsSync(join(EXT_BUILD, "library", "library.html"))) throw new Error(`${EXT_BUILD} is not a connector build with popup/ and library/ (build with --library)`);
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const EXT = join(WORK, "ext");
cpSync(EXT_BUILD, EXT, { recursive: true });
const nh = readFileSync(join(EXT, "nativeHost.js"), "utf8");
if (!nh.includes("const HOST_NAME = 'com.zotero_next.connector_host';")) throw new Error("nativeHost.js: HOST_NAME line not found");
writeFileSync(join(EXT, "nativeHost.js"), nh.replace("const HOST_NAME = 'com.zotero_next.connector_host';", "const HOST_NAME = 'com.zotero_next.connector_host_unregistered_check';"));
for (const d of ["host", SHOTS]) mkdirSync(d.includes(":") ? d : join(WORK, d), { recursive: true });

// ---- the pages to save, the repository mock, the header echo
const TRANSLATOR_DIR = join(ROOT, "core", "vendor", "zotero", "translators");
const EM_FILE = join(TRANSLATOR_DIR, "Embedded Metadata.js");
const EM_CODE = readFileSync(EM_FILE, "utf8");
const EM_META = JSON.parse(/^\s*{[\S\s]*?}\s*?[\r\n]/.exec(EM_CODE)![0]);
const ARTICLES: Record<string, { title: string; doi: string; pieces: number; delay: number }> = {
	"1": { title: "Machine perfusion of donor livers: a fixture article", doi: "10.5555/zinc.fixture.1", pieces: 6, delay: 300 },
	"2": { title: "Cold ischaemia and graft survival: a second fixture article", doi: "10.5555/zinc.fixture.2", pieces: 16, delay: 450 },
	"3": { title: "Normothermic regeneration of kidneys: a third fixture article", doi: "10.5555/zinc.fixture.3", pieces: 4, delay: 150 },
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
	return new TextEncoder().encode(out + `% ${"padding ".repeat(40_000)}\n`); // ~320 KB
}
const PDF_SIZE = pdfBytes("1").length;
const hostsSeen = new Set<string>();
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		hostsSeen.add(req.headers.get("host") ?? "?");
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		if (u.pathname === "/echo") {
			const h: Record<string, string> = {};
			req.headers.forEach((v, k) => (h[k] = v));
			return Response.json({ host: h.host, headers: h }, { headers: cors });
		}
		// the Zotero repository, as far as the connector asks: translator metadata and code
		if (u.pathname === "/repo/metadata") return new Response(JSON.stringify([EM_META]), { headers: { "Content-Type": "application/json", Date: new Date().toUTCString() } });
		if (u.pathname === `/repo/code/${EM_META.translatorID}`) return new Response(EM_CODE, { headers: { "Content-Type": "text/plain" } });
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
		if (p && ARTICLES[p[1]!]) {
			const { pieces, delay } = ARTICLES[p[1]!]!;
			const bytes = pdfBytes(p[1]!);
			const size = Math.ceil(bytes.length / pieces);
			let i = 0;
			return new Response(new ReadableStream({
				async pull(c) {
					if (i >= pieces) return c.close();
					await sleep(delay);
					c.enqueue(bytes.subarray(i * size, (i + 1) * size));
					i++;
				},
			}), { headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length) } });
		}
		return new Response("not found", { status: 404 });
	},
});

// ---- Chrome
const profile = join(WORK, "profile");
const chrome = spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
	`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
	"--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=1400,900",
	// nothing leaves this machine: no proxy, and no name but 127.0.0.1 resolves (api.zotero.org is the local mock)
	"--no-proxy-server", "--host-resolver-rules=MAP api.zotero.org 127.0.0.1, MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
	"--disable-background-networking", "--disable-component-update", "--disable-sync",
	"about:blank",
], { stdio: "ignore" });

try {
	let ver: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json() as typeof ver; } catch { await sleep(200); } }
	if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
	console.log("stage: devtools endpoint is up");
	const ws = new WebSocket(ver.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let nextId = 1;
	const pending = new Map<number, (v: any) => void>();
	const listeners: ((m: any) => void)[] = [];
	ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else for (const l of listeners) l(m); };
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });

	const problems: string[] = [];
	const watch = (sid: string, label: string) => listeners.push((m) => {
		if (m.sessionId !== sid) return;
		if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; problems.push(`${label} exception: ${(d.exception?.description ?? d.text).slice(0, 400)} at ${d.url ?? ""}:${d.lineNumber ?? ""}`); }
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`${label} log: ${m.params.entry.text.slice(0, 300)} ${m.params.entry.url ?? ""}`);
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`${label} console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)}`);
	});
	const attach = async (targetId: string, label: string) => {
		const { result } = await send("Target.attachToTarget", { targetId, flatten: true });
		const sid = result.sessionId as string;
		watch(sid, label);
		await send("Runtime.enable", {}, sid);
		await send("Log.enable", {}, sid).catch(() => {});
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
	const targets = async (): Promise<any[]> => (await send("Target.getTargets")).result.targetInfos;
	const findTarget = async (pred: (t: any) => boolean, ms = 10_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { const t = (await targets()).find(pred); if (t) return t; }
		return undefined;
	};

	// ---- the background
	const swInfo = await findTarget((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`), 30_000);
	if (!swInfo) throw new Error("the extension's service worker did not start");
	console.log("stage: service worker found");
	const sw = await attach(swInfo.targetId, "background");
	console.log("stage: attached to the service worker");
	if (process.argv.includes("--debug")) listeners.push((m) => { if (m.sessionId === sw && m.method === "Runtime.consoleAPICalled") console.log("bg:", m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 260)); });
	await waitFor(sw, "typeof Zotero !== 'undefined' && !!Zotero.NativeHost && !!Zotero.SavePopup", 20_000);
	const base = `http://127.0.0.1:${server.port}`;

	// a connector-style call over a "zinc-db" port, made from the background (the way nativeHost.js talks to the database)
	const HELPERS = `globalThis.znCall ||= (method, http, path, body) => new Promise((resolve, reject) => {
		const port = chrome.runtime.connect({ name: 'zinc-db' });
		let head = null, got = 0; const parts = [];
		const timer = setTimeout(() => { port.disconnect(); reject(new Error('no answer from the library')); }, 30000);
		const fin = () => { clearTimeout(timer); port.disconnect(); const bin = parts.map((p) => atob(p)).join(''); const ct = String((head.headers || {})['content-type'] || (head.headers || {})['Content-Type'] || '');
			resolve({ status: head.status, size: bin.length, magic: bin.slice(0, 5), type: ct, text: /json|text/.test(ct) ? decodeURIComponent(escape(bin)) : '' }); };
		port.onMessage.addListener((m) => { if (m.t === 'res') { head = m; if (!m.n) fin(); } else if (m.t === 'rc') { parts[m.seq] = m.data; if (++got === head.n) fin(); } });
		port.postMessage({ t: 'req', id: 1, method, http, path, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : { kind: 'text', text: JSON.stringify(body) } });
	})`;
	const api = async (http: string, path: string, body?: unknown): Promise<{ status: number; size: number; magic: string; type: string; json: any }> => {
		const r = await evalIn<any>(sw, `(async () => { ${HELPERS}; return await znCall("api", ${q(http)}, ${q(path)}, ${body === undefined ? "undefined" : q(body)}); })()`);
		let json: any = null;
		try { json = r.text ? JSON.parse(r.text) : null; } catch { /* binary or empty */ }
		return { ...r, json };
	};
	const itemsOf = async (query = ""): Promise<any[]> => (await api("GET", `/api/items?limit=200${query}`)).json?.items ?? [];

	// ---- 1. first run, no host: the setting
	let stored: any = null;
	for (const end = Date.now() + 30_000; Date.now() < end && !stored?.saveTarget; await sleep(250)) stored = await evalIn(sw, `chrome.storage.local.get(${q(LIB_KEY)}).then((r) => r[${q(LIB_KEY)}])`);
	check("first run with no host: zincBrowserLibrary = {saveTarget: browser, firstRunDone: true}", stored?.saveTarget === "browser" && stored?.firstRunDone === true && Object.keys(stored).length === 2, JSON.stringify(stored));

	// translators: the profile has none, and repo.zotero.org cannot be reached from here. Point the repository at the local mock.
	await evalIn(sw, `ZOTERO_CONFIG.REPOSITORY_URL = ${q(`${base}/repo/`)}`);
	await evalIn(sw, "Zotero.Translators.updateFromRemote(true)").catch((e) => console.log(`translator reload: ${e.message}`));

	// ---- 2. {zincEnsureDb: true} from an extension page
	const extPage = await openTab(`chrome-extension://${EXT_ID}/preferences/preferences.html`, "extension page (preferences)");
	const t0 = performance.now();
	const ensured = await evalIn<any>(extPage.sid, "Promise.race([chrome.runtime.sendMessage({ zincEnsureDb: true }), new Promise((r) => setTimeout(() => r({ ok: false, error: 'no answer in 60 s' }), 60000))])");
	measures.ensureDbMs = Math.round(performance.now() - t0);
	check("{zincEnsureDb: true} answers {ok: true}", ensured?.ok === true, `${JSON.stringify(ensured)} after ${measures.ensureDbMs} ms`);
	const again = await evalIn<any>(extPage.sid, "chrome.runtime.sendMessage({ zincEnsureDb: true })");
	// (getContexts also lists the library iframe: an offscreen-document context of its own; Chrome allows one document, with frames)
	const contexts = await evalIn<any[]>(sw, "chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.filter((x) => !x.documentUrl.includes('library/offscreen')).map((x) => x.documentUrl + '#' + x.frameId))");
	const offInfo = await findTarget((t) => t.url.endsWith("/offscreen/offscreen.html") && t.type !== "iframe");
	const off = offInfo ? await attach(offInfo.targetId, "offscreen") : undefined;
	const frame = off ? await evalIn<string>(off, "document.getElementById('zinc-db-frame')?.src ?? ''") : "";
	check("exactly one offscreen document, with the library iframe", again?.ok === true && contexts.length === 1 && frame === `chrome-extension://${EXT_ID}/library/offscreen.html`, `contexts ${JSON.stringify(contexts)}; iframe ${frame || "none"}`);
	// the database worker (a child target of the offscreen document's frame): watch it for errors too
	if (off) {
		const got = new Promise<string | null>((res) => {
			const t = setTimeout(() => res(null), 4000);
			listeners.push((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") { clearTimeout(t); res(m.params.sessionId); } });
		});
		await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, off);
		const wsid = await got;
		if (wsid) { watch(wsid, "db-worker"); await send("Runtime.enable", {}, wsid); }
		console.log(wsid ? "watching the database worker" : "(the database worker is not an attachable target here)");
	}
	const hello = await api("GET", "/api/collections");
	check("the library answers on a zinc-db port (empty)", hello.status === 200 && Array.isArray(hello.json) && hello.json.length === 0, `${hello.status} ${JSON.stringify(hello.json)}`);
	const thesis = (await api("POST", "/api/collections", { name: "Thesis" })).json?.key as string;

	// ---- helpers for the pages and the popup
	const article = async (n: string) => {
		const t = await openTab(`${base}/article${n}.html`, `article${n}`);
		const tabId = await evalIn<number>(sw, `browser.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith("/article${n}.html"))?.id)`);
		const found = await waitFor(sw, `(Zotero.Connector_Browser.getTabInfo(${tabId})?.translators?.length ?? 0) > 0`, 60_000);
		check(`article ${n}: a translator is found (Embedded Metadata from the local mock)`, found, `tab ${tabId}`);
		return { ...t, tabId };
	};
	const popup = async (tabId: number, scheme: "light" | "dark", query = "") => {
		const p = await openTab("about:blank", "popup");
		await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, p.sid);
		await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, p.sid);
		await send("Page.enable", {}, p.sid);
		await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}${query}` }, p.sid);
		return p;
	};
	const shot = async (sid: string, name: string) => {
		const h = await evalIn<number>(sid, "Math.ceil(document.body.getBoundingClientRect().height)");
		const s = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 360, height: h, scale: 1 }, captureBeyondViewport: true }, sid);
		writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(s.result.data, "base64"));
	};
	const S = "window.znPopup && window.znPopup.state";
	const text = (sid: string, id: string) => evalIn<string>(sid, `document.getElementById(${q(id)}).textContent`);

	// ---- 3. a save through the popup, into the browser library
	const a1 = await article("1");
	const tSave = performance.now();
	const p1 = await popup(a1.tabId, "light");
	const during = await waitFor(p1.sid, `${S} && znPopup.state.items.some((r) => r.parentItem && typeof r.progress === "number" && r.progress < 100) && !znPopup.state.done`, 30_000);
	check("the popup shows the save while it runs", during, JSON.stringify(await evalIn(p1.sid, `${S} && znPopup.state.items.map((r) => [r.title, r.progress])`)));
	await sleep(300);
	const savingTo = await text(p1.sid, "target-name");
	check('the popup says where it saves: "This browser"', savingTo === "This browser", `target line: "${savingTo}"; headline: "${await text(p1.sid, "headline")}"`);
	await shot(p1.sid, "1-saving-light");
	const saved = await waitFor(p1.sid, `${S} && znPopup.state.done && znPopup.state.done.ok && znPopup.state.saved.length === 1 && znPopup.state.items.every((r) => r.progress === 100 || r.progress === undefined)`, 40_000);
	measures.saveMs = Math.round(performance.now() - tSave);
	const key = await evalIn<string>(p1.sid, "znPopup.state.saved[0] && znPopup.state.saved[0].key");
	const listed = (await itemsOf()).find((i) => i.key === key);
	const detail = await api("GET", `/api/items/${key}`);
	if (process.argv.includes("--debug")) console.log(`item detail: ${JSON.stringify(detail.json).slice(0, 900)}; popup rows: ${JSON.stringify(await evalIn(p1.sid, "znPopup.state.items"))}`);
	const att = listed?.primaryAttachment;
	const file = att ? await api("GET", `/api/attachments/${att.key}/file`) : null;
	measures.pdfBytesExpected = PDF_SIZE;
	measures.pdfBytesRead = file?.size;
	check("after the save: the item is in the browser library, with its PDF read back through GET /api/attachments/<key>/file",
		saved && listed?.title === ARTICLES["1"]!.title && file?.status === 200 && file.magic === "%PDF-" && file.size === PDF_SIZE,
		`${key}: "${listed?.title}", attachment ${att?.key} ${att?.contentType}, file ${file?.status} ${file?.size} bytes (served ${PDF_SIZE}), ${measures.saveMs} ms from opening the popup to "Saved"`);
	check("the save shows 'Saved to My Library' with the target still the browser", /^Saved to/.test(await text(p1.sid, "headline")) && (await text(p1.sid, "target-name")) === "This browser", await text(p1.sid, "headline"));
	await sleep(300);
	await shot(p1.sid, "2-saved-light");

	// the collection picker
	await evalIn(p1.sid, "document.getElementById('picker').click()");
	await sleep(200);
	await shot(p1.sid, "3-picker-light");
	await evalIn(p1.sid, "(() => { const s = document.getElementById('search'); s.value = 'thes'; s.dispatchEvent(new Event('input')); })()");
	await sleep(150);
	await evalIn(p1.sid, "document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))");
	const moved = await waitFor(p1.sid, `${S} && znPopup.state.target.id === "C${thesis}" && !znPopup.state.busy && /Moved/.test(znPopup.state.message && znPopup.state.message.text || "")`, 15_000);
	const inThesis = (await itemsOf(`&collection=${thesis}`)).some((i) => i.key === key);
	check("the picker moves the saved item to the Thesis collection", moved && inThesis, `GET /api/items?collection=${thesis} lists it: ${inThesis}`);

	await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, p1.sid);
	await sleep(300);
	await shot(p1.sid, "4-saved-dark");

	// ---- 4. Open library
	await evalIn(p1.sid, "document.getElementById('open-library').click()");
	const libInfo = await findTarget((t) => t.url === `chrome-extension://${EXT_ID}/library/library.html?mode=browser&select=${key}`, 10_000);
	check("Open library opens library.html?mode=browser&select=<key>", !!libInfo, libInfo?.url ?? "no tab");
	if (libInfo) {
		const lib = await attach(libInfo.targetId, "library");
		const sel = await waitFor(lib, `!!globalThis.znLibrary && znLibrary.browser === true && znLibrary.store.selectedItem() === ${q(key)}`, 90_000);
		const shown = await waitFor(lib, "znLibrary.store.total() >= 1", 15_000);
		check("the library tab shows the saved item (browser mode, item selected)", sel && shown, `selected: ${await evalIn(lib, "globalThis.znLibrary?.store.selectedItem()").catch(() => "?")}; items in the list: ${await evalIn(lib, 'znLibrary.store.total()').catch(() => '?')}`);
		await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, lib);
		await sleep(800);
		const s = await send("Page.captureScreenshot", { format: "png" }, lib);
		writeFileSync(join(SHOTS, "5-library-tab.png"), Buffer.from(s.result.data, "base64"));
	}

	// ---- 5. Remove: the item goes to the Trash
	await evalIn(p1.sid, "document.getElementById('remove').click()");
	const removed = await waitFor(p1.sid, `${S} && znPopup.state.removed && znPopup.state.removed.length === 1 && !znPopup.state.busy`, 15_000);
	const inTrash = (await itemsOf("&trash=1")).some((i) => i.key === key);
	const inList = (await itemsOf()).some((i) => i.key === key);
	check("Remove trashes the item", removed && inTrash && !inList, `in the Trash: ${inTrash}; still in the library list: ${inList}`);
	await sleep(300);
	await shot(p1.sid, "6-removed-dark");

	// ---- 6. Cancel during a slow PDF: no file is kept
	const a2 = await article("2");
	const p2 = await popup(a2.tabId, "dark");
	const during2 = await waitFor(p2.sid, `${S} && znPopup.state.sessionCreated && znPopup.state.items.some((r) => r.parentItem && typeof r.progress === "number" && r.progress < 100)`, 30_000);
	check("second save: shown while its PDF is still arriving", during2, "");
	await sleep(300);
	await shot(p2.sid, "7-saving-dark");
	await evalIn(p2.sid, "document.getElementById('cancel').click()");
	const cancelled = await waitFor(p2.sid, `${S} && znPopup.state.cancelled && !znPopup.state.busy`, 15_000);
	await sleep(300);
	await shot(p2.sid, "8-cancelled-dark");
	await sleep(9000); // the PDF finishes arriving; the library refuses it (SESSION_CANCELLED)
	const live = await itemsOf();
	const trash = await itemsOf("&trash=1");
	const mine = [...live, ...trash].filter((i) => i.title === ARTICLES["2"]!.title);
	const strayFiles = [...live, ...trash].filter((i) => i.itemType === "attachment");
	check("Cancel during the slow PDF: the item is in the Trash and no PDF was kept", cancelled && mine.length > 0 && mine.every((i) => trash.some((t) => t.key === i.key) && i.attachmentCount === 0 && !i.primaryAttachment) && strayFiles.length === 0,
		`items ${JSON.stringify(mine.map((i) => [i.key, i.attachmentCount, trash.some((t) => t.key === i.key) ? "trash" : "live"]))}; stray top-level attachments ${strayFiles.length}`);
	const ctxAfter = await evalIn<number>(sw, "chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.filter((x) => !x.documentUrl.includes('library/offscreen')).length)");
	check("still exactly one offscreen document after the saves", ctxAfter === 1, String(ctxAfter));

	// ---- 7. the header rule (declarative_net_request: Zotero-API-Key is removed except for api.zotero.org)
	const rules = await evalIn<string[]>(sw, "chrome.declarativeNetRequest.getEnabledRulesets()");
	const echo = (url: string) => evalIn<any>(extPage.sid, `fetch(${q(url)}, { headers: { "Zotero-API-Key": "test-key-not-real", "X-Check": "kept" } }).then((r) => r.json())`);
	const toLocal = await echo(`${base}/echo`);
	check("header rule: a fetch from an extension page to another host arrives without Zotero-API-Key", !("zotero-api-key" in toLocal.headers) && toLocal.headers["x-check"] === "kept", `rulesets ${JSON.stringify(rules)}; arrived with: ${Object.keys(toLocal.headers).filter((k) => /zotero|x-check/.test(k)).join(", ")}`);
	const toApi = await echo(`http://api.zotero.org:${server.port}/echo`).catch((e) => ({ error: String(e) }));
	check("header rule: to api.zotero.org (mapped to the local mock; the rule's exclusion) the header survives", toApi.headers?.["zotero-api-key"] === "test-key-not-real", toApi.error ?? `host ${toApi.host}; header ${toApi.headers?.["zotero-api-key"]}`);

	// ---- 9. errors
	// the fixture pages have no favicon (404). The start-up translator update (repo.zotero.org: unreachable here) rejects once in the
	// background before the mock repository is set (translators.js:66).
	const errs = problems.filter((p) => !/^article\d log: Failed to load resource/.test(p) && !/repo\.zotero\.org\/repo\/metadata/.test(p) && !/^background exception: Error at \S+\/(translators\.js:66|background-worker\.js:0)$/.test(p));
	const watched = ["background", "popup", "offscreen", "library", "db-worker"].map((l) => `${l}: ${problems.filter((p) => p.startsWith(l)).length}`).join(", ");
	check("no errors in the popup, background, offscreen document, database worker and library tab", !errs.some((p) => /^(background|popup|offscreen|library|db-worker)/.test(p)), errs.slice(0, 8).join(" | ") || `none (${watched})`);
	const extErrs = errs.filter((p) => p.startsWith("extension page"));
	if (extErrs.length) console.log(`(the preferences page used as the extension page logged: ${extErrs.slice(0, 3).join(" | ")})`);
	if (errs.length) console.log(`page errors (${errs.length}):\n  ${errs.slice(0, 15).join("\n  ")}`);
	console.log(`hosts the mock saw: ${[...hostsSeen].join(", ")}`);
	ws.close();
} finally {
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
