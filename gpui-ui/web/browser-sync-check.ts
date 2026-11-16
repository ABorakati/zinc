// Headless check of zotero.org sync in the browser library (web/browser-db/CONTRACT.md, "zotero.org sync"):
//   bun web/browser-sync-check.ts [--dist <dir>] [--chrome <exe>] [--work <dir>] [--keep]
// --dist: a build of `bun web/build.ts --target extension` (default gpui-ui/dist-extension).
//
// zotero.org is never contacted. A Bun mock of the Web API (core/test/websync/mock.ts) serves a small library on 127.0.0.1:<port>; the
// extension reaches it through the test-only override (chrome.storage.local "zincTestZoteroApiBase", accepted only as
// http://127.0.0.1:<port>). The PDF's download redirects to a second mock, the "file host", on localhost:<port2>, which records the
// headers it receives. The test extension has the declarativeNetRequest ruleset of web/browser-db/dnr-rules.json (with 127.0.0.1 added
// next to api.zotero.org as "the API host"), host permissions for 127.0.0.1 and localhost, and web/browser-db/test-background.js as
// its service worker. Chrome for Testing, its own profile, CDP port 9354. Nothing of the user's browser is touched.
import { assertSafeToStart, testManifest } from "./check-safety";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { API_KEY, MockZotero } from "../../core/test/websync/mock";

const arg = (n: string) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = resolve(arg("dist") ?? join(ROOT, "gpui-ui", "dist-extension"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-browser-sync-check"));
const KEEP = process.argv.includes("--keep");
const CDP_PORT = Number(arg("port") ?? 9354);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base)
		? readdirSync(base)
				.filter((d) => d.startsWith("win64-"))
				.sort()
				.at(-1)
		: undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}

if (!existsSync(join(DIST, "library.html")) || !existsSync(join(DIST, "db-worker.js")) || !existsSync(join(DIST, "offscreen.html")))
	throw new Error(`build first: bun web/build.ts --target extension (${DIST})`);

// ---- the mock zotero.org and its file host
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const mock = new MockZotero();
mock.put("collection", "COLL0001", { name: "Mock reading list" });
mock.put("item", "ITEM0001", { title: "First mock paper", collections: ["COLL0001"] });
mock.put("item", "ITEM0002", { title: "Second mock paper" });
mock.put("item", "ITEM0003", { title: "Third mock paper" });
mock.put("item", "ATTPDF01", {
	itemType: "attachment",
	parentItem: "ITEM0001",
	linkMode: "imported_file",
	contentType: "application/pdf",
	filename: "paper.pdf",
	title: "paper.pdf",
});
mock.files.set("ATTPDF01", PDF);
const fileHostSeen: { url: string; headers: Record<string, string> }[] = [];
const fileHost = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		fileHostSeen.push({ url: u.pathname, headers: Object.fromEntries(req.headers) });
		const key = u.pathname.replace(/^\/blob\//, "");
		const bytes = mock.files.get(key);
		return bytes
			? new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf" } })
			: new Response("gone", { status: 404 });
	},
});
// the mock's file redirect points at the file host (another origin), as zotero.org's points at its storage host
const origFileRoute = (mock as any).fileRoute.bind(mock);
(mock as any).fileRoute = async (...a: unknown[]) => {
	const r: Response = await origFileRoute(...a);
	return r.status === 302
		? new Response(null, {
				status: 302,
				headers: { Location: r.headers.get("location")!.replace(new URL(mock.url).origin, `http://localhost:${fileHost.port}`) },
			})
		: r;
};
const MOCK_BASE = mock.url;

// ---- the test extension
const ext = join(WORK, "ext");
if (existsSync(join(ext, "library"))) spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
for (const d of ["shots", "ext"]) mkdirSync(join(WORK, d), { recursive: true });
copyFileSync(join(import.meta.dir, "browser-db", "test-background.js"), join(ext, "test-background.js"));
const rules = JSON.parse(readFileSync(join(import.meta.dir, "browser-db", "dnr-rules.json"), "utf8")) as {
	condition: { excludedRequestDomains: string[] };
}[];
rules[0]!.condition.excludedRequestDomains.push("127.0.0.1"); // "the API host" of this check
writeFileSync(join(ext, "dnr-rules.json"), JSON.stringify(rules, null, 2));
writeFileSync(join(ext, "blank.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body>zinc sync check</body></html>\n`);
writeFileSync(
	join(ext, "manifest.json"),
	JSON.stringify(
		testManifest({
			name: "Zinc browser sync check",
			manifest_version: 3,
			version: "1.0",
			permissions: ["offscreen", "unlimitedStorage", "storage", "declarativeNetRequest"],
			host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
			declarative_net_request: { rule_resources: [{ id: "zinc-sync", enabled: true, path: "dnr-rules.json" }] },
			background: { service_worker: "test-background.js" },
			content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
		}),
		null,
		2,
	),
);
spawnSync("cmd", ["/c", "mklink", "/J", join(ext, "library"), DIST], { stdio: "ignore" });
if (!existsSync(join(ext, "library", "library.html"))) throw new Error("could not link library/ to the build");

// ---- Chrome and the DevTools protocol
let chrome: ChildProcess | null = null;
const launch = (): ChildProcess => (
	assertSafeToStart({ extDir: ext }),
	spawn(
		findChrome(),
		[
			"--headless=new",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${join(WORK, "profile")}`,
			`--load-extension=${ext}`,
			`--disable-extensions-except=${ext}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--enable-unsafe-swiftshader",
			"--window-size=1400,900",
			"about:blank",
		],
		{ stdio: "ignore" },
	)
);

class Cdp {
	ws!: WebSocket;
	private nextId = 1;
	private pending = new Map<number, (v: any) => void>();
	listeners: ((m: any) => void)[] = [];
	static async connect(): Promise<Cdp> {
		let ver: { webSocketDebuggerUrl: string } | undefined;
		for (let i = 0; i < 150 && !ver; i++) {
			try {
				ver = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()) as typeof ver;
			} catch {
				await sleep(200);
			}
		}
		if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
		const c = new Cdp();
		c.ws = new WebSocket(ver.webSocketDebuggerUrl);
		await new Promise((r) => (c.ws.onopen = r));
		c.ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data));
			if (m.id && c.pending.has(m.id)) {
				c.pending.get(m.id)!(m);
				c.pending.delete(m.id);
			} else for (const l of c.listeners) l(m);
		};
		return c;
	}
	send(method: string, params: object = {}, sessionId?: string): Promise<any> {
		return new Promise((r) => {
			const id = this.nextId++;
			this.pending.set(id, r);
			this.ws.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}
}

const problems: string[] = [];
const IGNORED =
	/Failed to load resource.*(favicon|403)|sync\/status|structure unavailable|reading view needs layout analysis|Automatic fallback to software WebGL|GPU stall/i;
class Session {
	constructor(
		readonly cdp: Cdp,
		readonly sid: string,
		readonly label: string,
	) {
		cdp.listeners.push((m) => {
			if (m.sessionId !== sid) return;
			const add = (s: string) => {
				if (!IGNORED.test(s)) problems.push(`[${label}] ${s.slice(0, 400)}`);
			};
			if (m.method === "Runtime.exceptionThrown") {
				const d = m.params.exceptionDetails;
				add(`exception: ${d.exception?.description ?? d.text}`);
			}
			if (m.method === "Log.entryAdded" && (m.params.entry.level === "error" || m.params.entry.source === "security"))
				add(`log(${m.params.entry.source}): ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
			if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning"))
				add(`console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
		});
	}
	static async attach(cdp: Cdp, targetId: string, label: string): Promise<Session> {
		const {
			result: { sessionId },
		} = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const s = new Session(cdp, sessionId, label);
		for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await cdp.send(d, {}, sessionId);
		return s;
	}
	send(method: string, params: object = {}) {
		return this.cdp.send(method, params, this.sid);
	}
	async evalIn<T>(expression: string): Promise<T> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	}
	async waitFor(expression: string, ms: number): Promise<boolean> {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
			try {
				if (await this.evalIn<boolean>(expression)) return true;
			} catch {
				/* loading */
			}
		}
		return false;
	}
	async shot(name: string) {
		const s = await this.send("Page.captureScreenshot", { format: "png" });
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	}
}

const q = (s: unknown) => JSON.stringify(s);
/** Every response text and JSON the page's own API calls produced: searched for the API key at the end. */
const seenTexts: string[] = [];

try {
	chrome = launch();
	const cdp = await Cdp.connect();

	// the extension's id (no manifest key: it comes from the folder), from its service worker
	let extId = "";
	for (let i = 0; i < 100 && !extId; i++) {
		const {
			result: { targetInfos },
		} = await cdp.send("Target.getTargets");
		const sw = targetInfos.find(
			(t: any) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/test-background\.js$/.test(t.url),
		);
		if (sw) extId = sw.url.split("/")[2];
		else await sleep(200);
	}
	if (!extId) throw new Error("the test extension did not load");

	// the test-only override, set from an extension page before anything starts the database worker
	{
		const {
			result: { targetId },
		} = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/blank.html` });
		const page = await Session.attach(cdp, targetId, "setup");
		await page.waitFor("document.readyState === 'complete'", 10_000);
		// a value that does NOT match the pattern is ignored (checked below through the worker); the real one is set after the worker has proven it
		await page.evalIn(`chrome.storage.local.set({ zincTestZoteroApiBase: ${q(MOCK_BASE)} })`);
		const back = await page.evalIn<string>(`chrome.storage.local.get("zincTestZoteroApiBase").then((o) => o.zincTestZoteroApiBase)`);
		check("the test API base override is stored (an extension page sets it)", back === MOCK_BASE, back);
		await cdp.send("Target.closeTarget", { targetId });
	}

	// ---- 1. open the library tab in browser mode
	const {
		result: { targetId: tabId },
	} = await cdp.send("Target.createTarget", { url: "about:blank" });
	const tab = await Session.attach(cdp, tabId, "tab");
	const t0 = performance.now();
	await tab.send("Page.navigate", { url: `chrome-extension://${extId}/library/library.html?mode=browser` });
	const loaded = await tab.waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0", 90_000);
	check("the library tab opens in browser mode", loaded, `${Math.round(performance.now() - t0)} ms`);
	if (!loaded) throw new Error("the library tab did not load");

	// the offscreen document and the worker: errors are collected from now on; what chrome.* they have
	const {
		result: { targetInfos },
	} = await cdp.send("Target.getTargets");
	const offT = targetInfos.find((t: any) => t.url.endsWith("/library/offscreen.html") && t.type !== "iframe");
	const off = offT ? await Session.attach(cdp, offT.targetId, "offscreen") : undefined;
	let worker: Session | undefined;
	if (off) {
		const got = new Promise<string | null>((res) => {
			const t = setTimeout(() => res(null), 4000);
			cdp.listeners.push((m) => {
				if (m.method === "Target.attachedToTarget" && m.sessionId === off.sid && m.params.targetInfo.type === "worker") {
					clearTimeout(t);
					res(m.params.sessionId);
				}
			});
		});
		await off.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
		const sid = await got;
		if (sid) {
			worker = new Session(cdp, sid, "db-worker");
			await cdp.send("Runtime.enable", {}, sid);
		}
	}
	const offHas = off
		? await off.evalIn<string>("JSON.stringify({ storage: typeof chrome.storage, runtime: typeof chrome.runtime })")
		: "no offscreen";
	const wInfo = worker ? await worker.evalIn<string>("JSON.stringify({ hasChrome: znDb.hasChrome, sync: znDb.sync })") : "no worker";
	console.log(`offscreen chrome.*: ${offHas}; worker: ${wInfo}`);
	measures.offscreenChrome = offHas;
	measures.worker = wInfo;
	const sync = worker
		? (JSON.parse(wInfo) as { hasChrome: boolean; sync: { storage: string; apiBase: string; mode: string; started: boolean } | null })
		: null;
	check(
		"sync is set up in the worker (key store through the offscreen document, test API base read)",
		!!sync?.sync && sync.sync.apiBase === MOCK_BASE && !sync.sync.started,
		wInfo,
	);

	const api = async (method: string, path: string, body?: unknown) => {
		const r = await tab.evalIn<{ status: number; json: any; text: string }>(
			`znLibrary.api(${q(method)}, ${q(path)}, ${body === undefined ? "undefined" : q(body)})`,
		);
		seenTexts.push(r.text);
		return r;
	};
	const status = async () =>
		(await api("GET", "/websync/status")).json as {
			mode: string;
			account: { keySet: boolean; userId?: number; username?: string };
			push: boolean;
			files: string;
			pending: number;
			lastPullAt?: string;
			lastPushAt?: string;
			lastError?: string;
			busy: boolean;
			fileJob?: { done: number; total: number; failed: number; running: boolean };
		};
	const until = async (what: string, f: () => Promise<boolean>, ms = 30_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await f()) return true;
		console.log(`timeout: ${what}`);
		return false;
	};

	// ---- 2. the key, through the route Settings > Sync uses
	const s0 = await status();
	check(
		"Settings > Sync can read the status in browser mode (no key yet)",
		s0.mode === "zotero-local" && !s0.account.keySet,
		JSON.stringify(s0).slice(0, 200),
	);
	const bad = await api("POST", "/websync/key", { apiKey: "wrong-key" });
	check("a wrong key is refused", bad.status === 400 && !(await status()).account.keySet, `${bad.status} ${bad.text.slice(0, 100)}`);
	const good = await api("POST", "/websync/key", { apiKey: API_KEY });
	check(
		"the key is accepted by the mock zotero.org and kept",
		good.status === 200 && good.json.account.keySet && good.json.account.userId === 42,
		`${good.status} user ${good.json?.account?.userId} ${good.json?.account?.username}`,
	);
	const stored = await (async () => {
		const {
			result: { targetId },
		} = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/blank.html` });
		const p = await Session.attach(cdp, targetId, "peek");
		await p.waitFor("document.readyState === 'complete'", 10_000);
		const v = await p.evalIn<string | null>(`chrome.storage.local.get("zincZoteroApiKey").then((o) => o.zincZoteroApiKey ?? null)`);
		await cdp.send("Target.closeTarget", { targetId });
		return v;
	})();
	check("the key is in chrome.storage.local (zincZoteroApiKey)", stored === API_KEY, stored ? "present" : "missing");

	// ---- 3. start sync: push on, files download, source = zotero.org
	await api("POST", "/websync/options", { push: true, files: "download" });
	const startAt = performance.now();
	const m = await api("POST", "/websync/mode", { mode: "zotero-org" });
	check(
		"the sync source is switched to zotero.org (starts the service in the worker)",
		m.status === 200 && m.json.mode === "zotero-org",
		`${m.status} mode ${m.json?.mode}`,
	);
	const pulled = await until("pull", async () => {
		const s = await status();
		return !!s.lastPullAt && !s.busy;
	});
	const s1 = await status();
	check(
		"the first pull finished without an error",
		pulled && !s1.lastError,
		`lastError ${s1.lastError ?? "none"}, library version ${(s1 as any).libraryVersion}, ${Math.round(performance.now() - startAt)} ms`,
	);
	const shown = await tab.waitFor("znLibrary.store.total() === 3", 15_000);
	const list = await api("GET", "/items?limit=200&sort=title&dir=asc");
	const colls = await api("GET", "/collections");
	check(
		"the items and the collection appear in the tab",
		shown &&
			list.json.items.map((i: any) => i.title).join("|") === "First mock paper|Second mock paper|Third mock paper" &&
			colls.json.some((c: any) => c.name === "Mock reading list"),
		`list total ${await tab.evalIn("znLibrary.store.total()")}; items ${list.json.items.map((i: any) => i.title).join(" | ")}; collections ${colls.json.map((c: any) => c.name).join(" | ")}`,
	);

	// ---- 4. the PDF
	await until("file job", async () => {
		const s = await status();
		return !!s.fileJob && !s.fileJob.running;
	});
	const fj = (await status()).fileJob;
	const file = await api("GET", "/attachments/ATTPDF01/file");
	check(
		"the PDF downloaded into the browser library and opens (GET /api/attachments/<key>/file)",
		file.status === 200 && file.text.startsWith("%PDF"),
		`status ${file.status}, ${file.text.length} bytes, starts ${q(file.text.slice(0, 8))}; file job ${JSON.stringify(fj)}`,
	);

	// ---- 5. the file host did not get the key
	const blobReqs = fileHostSeen.filter((r) => r.url.startsWith("/blob/"));
	const leaked = blobReqs.filter((r) => Object.keys(r.headers).some((h) => h.toLowerCase() === "zotero-api-key"));
	check(
		"the file host never received a Zotero-API-Key header (the DNR rule works)",
		blobReqs.length >= 1 && leaked.length === 0,
		`${blobReqs.length} request(s) to the file host, ${leaked.length} with the key; headers seen: ${Object.keys(blobReqs[0]?.headers ?? {}).join(",")}`,
	);
	check(
		"the mock API did get the key (its own requests are not stripped)",
		mock.log.length > 3 && mock.log.filter((l) => l.status === 403).length === 1,
		`${mock.log.length} API requests, ${mock.log.filter((l) => l.status === 403).length} refused (the wrong key of step 2)`,
	);

	// ---- 6. an edit in the tab is uploaded
	const postsBefore = mock.posts().length;
	const edit = await api("PATCH", "/items/ITEM0002", { data: { title: "Second mock paper, edited in the browser" } });
	await api("POST", "/websync/now");
	await until("push", async () => mock.item("ITEM0002")?.data.title === "Second mock paper, edited in the browser", 20_000);
	const posts = mock.posts();
	check(
		"an item edited in the tab is uploaded (the mock recorded the write)",
		edit.status === 200 &&
			posts.length > postsBefore &&
			mock.item("ITEM0002")?.data.title === "Second mock paper, edited in the browser",
		`edit ${edit.status}; ${posts.length - postsBefore} write request(s); mock title ${q(mock.item("ITEM0002")?.data.title)}; pending ${(await status()).pending}`,
	);

	// ---- 7. a change on the server shows in the tab after the next sync
	mock.put("item", "ITEM0004", { title: "Added on the server" });
	mock.put("item", "ITEM0001", { title: "First mock paper (renamed on the server)", collections: ["COLL0001"] });
	await api("POST", "/websync/now");
	const seen4 = await tab.waitFor("znLibrary.store.total() === 4", 15_000);
	const list2 = await api("GET", "/items?limit=200&sort=title&dir=asc");
	check(
		"a change made on the mock server shows in the tab after the next sync",
		seen4 &&
			list2.json.items.some((i: any) => i.title === "Added on the server") &&
			list2.json.items.some((i: any) => i.title === "First mock paper (renamed on the server)"),
		`list total ${await tab.evalIn("znLibrary.store.total()")}: ${list2.json.items.map((i: any) => i.title).join(" | ")}`,
	);

	// ---- 8. the key is never visible to the page
	const reqs = await tab.evalIn<string>("JSON.stringify(znLibrary.requests)");
	const pageText = await tab.evalIn<string>(
		"document.documentElement.outerHTML + JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage))",
	);
	const sts = JSON.stringify(await status());
	const hay = [reqs, pageText, sts, ...seenTexts];
	const hits = hay.filter((t) => t.includes(API_KEY)).length;
	check(
		"the API key is never visible to the page (znLibrary.requests, every response, the page, its storage)",
		hits === 0,
		`searched ${reqs.length + pageText.length + seenTexts.reduce((n, t) => n + t.length, 0)} characters in ${hay.length} texts, ${(JSON.parse(reqs) as unknown[]).length} requests; ${hits} hit(s)`,
	);

	// ---- 9. screenshots of Settings > Sync
	const click = async (x: number, y: number) => {
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
			await tab.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
		await sleep(700);
	};
	await tab.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
	await click(1374, 19); // the gear: Settings
	await click(55, 194); // Sync
	await sleep(1500);
	for (const theme of ["light", "dark"] as const) {
		await tab.evalIn(`znLibrary.setTheme(${q(theme)})`);
		await sleep(800);
		await tab.shot(`settings-sync-${theme}`);
	}
	await tab.evalIn("znLibrary.setTheme('light')");

	const errs = problems.filter((p) => !IGNORED.test(p));
	check("no page, offscreen or worker errors", errs.length === 0, errs.slice(0, 6).join(" | ") || "none");
	await cdp.send("Browser.close").catch(() => {});
} finally {
	await sleep(1500);
	if (chrome?.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	await sleep(1500);
	mock.stop();
	fileHost.stop(true);
	// the junction only: never the build it points to
	spawnSync("cmd", ["/c", "rmdir", join(ext, "library")], { stdio: "ignore" });
	await sleep(1500);
	if (!KEEP)
		try {
			rmSync(join(WORK, "profile"), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
		} catch (e) {
			console.log(`could not delete the profile yet: ${(e as Error).message}`);
		}
}
writeFileSync(join(WORK, "results.json"), JSON.stringify({ measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
