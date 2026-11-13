// Headless check of the plain web page (src/platform.web.ts, `bun web/build.ts` with the default --target web):
//   bun web/web-demo-check.ts [--port <CDP port>] [--chrome <exe>] [--work <dir>] [--dist <web build>] [--keep]
// Without --dist it makes the demo library (web/demo-library.ts) and the build in <work>, then serves the build from a loopback server
// of its own (any free port) and opens it in Chrome for Testing (fresh profile, headless, nothing of the user's browser).
//
// Checks: with ?demo the page starts on the in-memory demo library and the app lists its items (store has rows, no error); the demo
// article's PDF opens in the reader; the page logs no error; without ?demo the page asks for its own library (web/browser-db/page-library.ts)
// and, while that file is the "not built yet" stub, says so in the console and lists nothing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const GPUI = resolve(import.meta.dir, "..");
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-web-demo-check"));
const KEEP = process.argv.includes("--keep");
const CDP_PORT = Number(arg("port") ?? 9376);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };

function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}
const run = (cmd: string[]) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: GPUI, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
};

rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(join(WORK, "shots"), { recursive: true });
let dist = arg("dist") ? resolve(arg("dist")!) : "";
if (!dist) {
	dist = join(WORK, "dist");
	run(["bun", "web/demo-library.ts", join(WORK, "demo-library")]);
	const reader = arg("reader");
	run(["bun", "web/build.ts", "--out", dist, "--db", join(WORK, "demo-library", "library.sqlite"), "--styles", join(WORK, "demo-library", "collection-style.json"), ...(reader ? ["--reader", reader] : [])]);
}
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "main.js"))) throw new Error(`no web build in ${dist}`);

// a static server for the build (WebAssembly and workers need http://)
const types: Record<string, string> = { html: "text/html", js: "text/javascript", wasm: "application/wasm", json: "application/json", pdf: "application/pdf", png: "image/png", webmanifest: "application/manifest+json" };
const server = Bun.serve({
	port: 0, hostname: "127.0.0.1",
	async fetch(req) {
		const p = decodeURIComponent(new URL(req.url).pathname);
		const f = Bun.file(join(dist, p === "/" ? "index.html" : p.slice(1)));
		if (!(await f.exists())) return new Response("not found", { status: 404 });
		return new Response(f, { headers: { "Content-Type": types[p.split(".").pop()!] ?? "application/octet-stream" } });
	},
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

const chrome: ChildProcess = spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, "profile")}`,
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

/** Open a page; collect what it logs as errors (and every console line, for the "not built yet" message). */
async function open(cdp: Cdp, url: string) {
	const { result: { targetId } } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const { result: { sessionId } } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	const errors: string[] = [];
	const lines: string[] = [];
	const IGNORED = /favicon|Automatic fallback to software WebGL|GPU stall|reading view needs layout analysis|structure unavailable/i;
	cdp.listeners.push((m) => {
		if (m.sessionId !== sessionId) return;
		if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; errors.push(`exception: ${d.exception?.description ?? d.text}`); }
		if (m.method === "Runtime.consoleAPICalled") {
			const text = m.params.args.map((a: any) => a.value ?? a.description).join(" ");
			lines.push(text);
			if ((m.params.type === "error" || m.params.type === "warning") && !IGNORED.test(text)) errors.push(`console.${m.params.type}: ${text.slice(0, 300)}`);
		}
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !IGNORED.test(m.params.entry.text + (m.params.entry.url ?? ""))) errors.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
	});
	for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await cdp.send(d, {}, sessionId);
	await cdp.send("Page.navigate", { url }, sessionId);
	const evalIn = async <T>(expression: string): Promise<T> => {
		const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (expression: string, ms: number) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { try { if (await evalIn<boolean>(expression)) return true; } catch { /* loading */ } }
		return false;
	};
	const shot = async (name: string) => writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId)).result.data, "base64"));
	return { targetId, errors, lines, evalIn, waitFor, shot };
}

let failed = true;
try {
	const cdp = await Cdp.connect();

	// ---- ?demo: the in-memory demo library
	const demo = await open(cdp, `${ORIGIN}/index.html?demo`);
	const listed = await demo.waitFor("!!globalThis.znDemo?.store && globalThis.znDemo.store.pagesLoaded() > 0 && !!globalThis.znDemo.store.peek(0)", 60_000);
	const first = listed ? await demo.evalIn<{ title: string; groups: number; error: string | null }>(`({ title: String(znDemo.store.peek(0)?.title ?? ""), groups: znDemo.store.groups().length, error: znDemo.store.error() })`) : null;
	check("demo library lists items", listed && !!first?.title && !first.error, listed ? `first row "${first!.title.slice(0, 60)}", error ${first!.error}` : "the store never loaded a page");
	const rows = listed ? await demo.evalIn<number>(`(async () => { const r = await fetch(location.origin + "/library.sqlite"); return (await r.arrayBuffer()).byteLength; })()`) : 0;
	check("demo library file served next to the bundle", rows > 10_000, `${rows} bytes`);
	await sleep(1500);
	await demo.shot("demo");
	const stored = await demo.evalIn<string[]>(`fetch(location.origin + "/storage.json").then((r) => r.json())`);
	if (stored.length) {
		const key = stored[0]!.split("/")[0]!;
		await demo.evalIn(`znDemo.store.openAttachment(${JSON.stringify(key)}, "Demo review", "")`);
		const opened = await demo.waitFor(`globalThis.znPdfStats?.opens?.length > 0 && globalThis.znPdfStats.fetches?.length > 0`, 60_000);
		check("the demo article's PDF opens in the reader", opened, opened ? `${await demo.evalIn<number>("znPdfStats.fetches[0].bytes")} bytes fetched` : "no PDF fetch or open recorded");
		await sleep(1500);
		await demo.shot("demo-reader");
	} else check("the demo article's PDF opens in the reader", false, "the demo library has no stored attachment");
	check("no page errors with ?demo", demo.errors.length === 0, demo.errors.length ? demo.errors.slice(0, 3).join(" | ") : "none");

	// ---- no ?demo: the page's own library (a stub until web/browser-db/page-library.ts is built)
	const ready = "!!globalThis.znLibrary?.store && globalThis.znLibrary.store.pagesLoaded() > 0";
	const own = await open(cdp, `${ORIGIN}/index.html`);
	const loaded = await own.waitFor(ready, 60_000);
	const isDemo = loaded ? await own.evalIn<boolean>(`!!globalThis.znDemo`) : false;
	const total0 = loaded ? await own.evalIn<number>(`znLibrary.store.groups().length + (znLibrary.store.peek(0) ? 1 : 0)`) : -1;
	check("without ?demo the page's own library loads, empty", loaded && !isDemo && total0 === 0, loaded ? `rows: ${total0}` : `never loaded: ${own.errors.slice(0, 2).join(" | ")}`);
	const made = loaded ? await own.evalIn<{ status: number }>(`znLibrary.api("POST", "/items", { data: { itemType: "book", title: "Made on the plain page" } })`) : { status: 0 };
	check("an item is created", made.status >= 200 && made.status < 300, `status ${made.status}`);
	await own.evalIn(`location.reload()`).catch(() => {});
	await sleep(1500);
	const again = await own.waitFor(ready, 60_000);
	const title = again ? await own.waitFor(`znLibrary.store.peek(0)?.title === "Made on the plain page"`, 15_000) : false;
	check("the item survives a reload", title, title ? "listed after the reload" : again ? "not listed" : `the page did not come back: ${own.errors.slice(0, 2).join(" | ")}`);
	await own.shot("page-library");
	check("no page errors on the plain page", own.errors.length === 0, own.errors.length ? own.errors.slice(0, 3).join(" | ") : "none");
	// a second tab: the library is owned by the first (one page per library), so it says so instead of showing the app
	const second = await open(cdp, `${ORIGIN}/index.html`);
	await sleep(6000);
	const busy = second.errors.some((e) => /open in another tab/.test(e)) || second.lines.some((l) => /open in another tab/.test(l));
	check("a second tab says the library is open elsewhere", busy, busy ? "PageLibraryBusyError reached the console" : "no busy message seen");
	await second.shot("page-library-busy");
	failed = results.some((r) => !r.ok);
} finally {
	chrome.kill();
	server.stop(true);
	await sleep(500);
	if (!KEEP) rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
