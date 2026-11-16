// Headless end-to-end check of the Zinc Connector's library page (docs/design/web-connector-wasm.md, phase 2):
//   bun web/extension-check.ts --ext <connector build/manifestv3> [--chrome <Chrome for Testing chrome.exe>] [--work <dir>] [--keep]
// 1. Builds a fixture library (web/demo-library.ts: public papers, no personal data) in <work>/library and compiles the native host
//    to <work>/host/zinc-e2e-host.exe.
// 2. Registers that host under a name of its own (com.zotero_next.connector_host_e2e) in HKCU\Software\Chromium. Chrome for Testing
//    also reads HKCU\Software\Google\Chrome, where the installed host is registered, so the extension loaded is a COPY of the
//    build (<work>/ext) whose default host name is registered nowhere, the page is opened with ?host=<that name>, and the check
//    refuses to start Chrome if anything it loads could reach a Google-registered name (web/check-safety.ts). Nothing is written
//    under the Google key.
// 3. Loads the extension in a fresh headless profile (<work>/profile) over CDP, opens library/library.html, and checks: the
//    host answers for the fixture, the list loads the fixture's items, a collection opens, an item's details load, and an item
//    written to the library by this process (another program, as the desktop app would be) shows up. Screenshots: <work>/shots.
// 4. Removes the registration, stops Chrome and (without --keep) deletes the profile and the host exe.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as repo from "../../core/src/db";
import { assertSafeToStart, makeConnectorTestCopy } from "./check-safety";

const arg = (n: string) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const EXT_BUILD = resolve(arg("ext") ?? join(homedir(), "zotero-next-connector", "build", "manifestv3"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-extension-check"));
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..", "..");
const HOST_NAME = "com.zotero_next.connector_host_e2e";
// Chrome for Testing reads hosts under Software\Chromium AND Software\Google\Chrome (where the real host is): only the Chromium key is written.
const REG_KEYS = [`HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`];
const CDP_PORT = Number(arg("port") ?? 9341);

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

if (!existsSync(join(EXT_BUILD, "manifest.json")) || !existsSync(join(EXT_BUILD, "library", "library.html")))
	throw new Error(`${EXT_BUILD} is not a connector build with library/library.html`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, "host"), { recursive: true });
mkdirSync(join(WORK, "shots"), { recursive: true });
const EXT = join(WORK, "ext");
makeConnectorTestCopy(EXT_BUILD, EXT); // no native host by default: the real name is replaced

// 1. fixture library and host
const libDir = join(WORK, "library");
const run = (cmd: string[], cwd: string) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
};
run(["bun", join(ROOT, "gpui-ui", "web", "demo-library.ts"), libDir], join(ROOT, "gpui-ui"));
const dbPath = join(libDir, "library.sqlite");
const hostExe = join(WORK, "host", "zinc-e2e-host.exe");
run(["bun", "build", "--compile", join(ROOT, "connector-host", "src", "main.ts"), "--outfile", hostExe], join(ROOT, "connector-host"));

// what the page should show, from the fixture itself
const fx = repo.openDb(dbPath);
const libTotal = repo.listItems(fx, { limit: 1 }).total;
const thesis = (fx.query("SELECT key FROM collections WHERE name = 'Thesis'").get() as { key: string }).key;
const thesisTotal = repo.listItems(fx, { collection: thesis, limit: 1 }).total;
const attention = (fx.query("SELECT key FROM items WHERE title = 'Attention Is All You Need'").get() as { key: string }).key;
fx.close();

// 2. the test-only registration
const extId = "pakgagonakcalfbmckaolkpidcojacaf"; // pinned by the connector's manifest key (extension-id.txt)
const manifestPath = join(WORK, "host", `${HOST_NAME}.json`);
writeFileSync(
	manifestPath,
	JSON.stringify(
		{
			name: HOST_NAME,
			description: "Zinc host (extension check, fixture library)",
			path: hostExe,
			type: "stdio",
			allowed_origins: [`chrome-extension://${extId}/`],
		},
		null,
		2,
	),
);

const profile = join(WORK, "profile");
assertSafeToStart({ extDir: EXT, hostNames: [HOST_NAME] });
for (const k of REG_KEYS) run(["reg", "add", k, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], WORK); // the test host, under the Chromium key only
const chrome = spawn(
	findChrome(),
	[
		"--headless=new",
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${profile}`,
		`--load-extension=${EXT}`,
		`--disable-extensions-except=${EXT}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--enable-unsafe-swiftshader",
		"--window-size=1400,900",
		"about:blank",
	],
	{ stdio: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0" } },
);

try {
	// 3. CDP
	let ver: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 100 && !ver; i++) {
		try {
			ver = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()) as typeof ver;
		} catch {
			await sleep(200);
		}
	}
	if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
	const ws = new WebSocket(ver.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let nextId = 1;
	const pending = new Map<number, (v: any) => void>();
	const events: ((m: any) => void)[] = [];
	ws.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)!(m);
			pending.delete(m.id);
		} else for (const l of events) l(m);
	};
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
		new Promise((r) => {
			const id = nextId++;
			pending.set(id, r);
			ws.send(JSON.stringify({ id, method, params, sessionId }));
		});

	const base = `chrome-extension://${extId}/library/library.html`;
	const {
		result: { targetId },
	} = await send("Target.createTarget", { url: "about:blank" });
	const {
		result: { sessionId },
	} = await send("Target.attachToTarget", { targetId, flatten: true });
	const problems: string[] = [];
	events.push((m) => {
		if (m.sessionId !== sessionId) return;
		if (m.method === "Runtime.exceptionThrown")
			problems.push(
				`exception: ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300)}`,
			);
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`log: ${m.params.entry.text.slice(0, 300)}`);
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
			problems.push(
				`console: ${m.params.args
					.map((a: any) => a.value ?? a.description)
					.join(" ")
					.slice(0, 300)}`,
			);
	});
	for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await send(d, {}, sessionId);
	const evalIn = async <T>(expression: string): Promise<T> => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (expression: string, ms: number): Promise<boolean> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
			try {
				if (await evalIn<boolean>(expression)) return true;
			} catch {
				/* page still loading */
			}
		}
		return false;
	};
	const shot = async (name: string) => {
		const s = await send("Page.captureScreenshot", { format: "png" }, sessionId);
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	};

	await send("Page.navigate", { url: `${base}?host=${HOST_NAME}` }, sessionId);
	// which library the host serves: the fixture, or stop before anything is drawn
	await waitFor("typeof chrome !== 'undefined' && !!chrome.runtime", 15_000);
	const hello = await evalIn<{
		db?: string;
		error?: string;
	}>(`new Promise((r) => { const p = chrome.runtime.connectNative(${JSON.stringify(HOST_NAME)});
		p.onMessage.addListener((m) => { r(m); p.disconnect(); }); p.onDisconnect.addListener(() => r({ error: chrome.runtime.lastError?.message ?? "disconnected" })); p.postMessage({ t: "hello", id: 0 }); })`);
	check("host answers for the fixture library", resolve(hello?.db ?? "") === resolve(dbPath), hello?.db ?? hello?.error ?? "no answer");
	if (resolve(hello?.db ?? "") !== resolve(dbPath))
		throw new Error("the page did not reach the test host: stopping before any screenshot");

	const loaded = await waitFor(
		`!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0 && znLibrary.store.total() === ${libTotal}`,
		60_000,
	);
	check(
		"list loads the fixture's items",
		loaded,
		`total ${await evalIn("globalThis.znLibrary?.store.total()")} (fixture: ${libTotal}), first row "${await evalIn("globalThis.znLibrary?.store.itemAt(0)?.title")}"`,
	);
	await sleep(1500);
	await shot("1-library");

	await evalIn(`znLibrary.store.selectCollection(${JSON.stringify(thesis)})`);
	const coll = await waitFor(
		`znLibrary.store.selectedCollection() === ${JSON.stringify(thesis)} && znLibrary.store.pagesLoaded() > 0 && znLibrary.store.total() === ${thesisTotal}`,
		20_000,
	);
	check("a collection opens", coll, `"Thesis": ${await evalIn("znLibrary.store.total()")} items (fixture: ${thesisTotal})`);
	await sleep(1000);
	await shot("2-collection");

	await evalIn(`znLibrary.store.selectItem(${JSON.stringify(attention)})`);
	const detail = await waitFor(
		`znLibrary.requests.some((r) => r.method === "GET" && r.path.startsWith("/api/items/${attention}") && r.status === 200)`,
		20_000,
	);
	check(
		"an item's details load",
		detail,
		`GET /api/items/${attention}: ${JSON.stringify((await evalIn<any[]>("znLibrary.requests")).filter((r) => r.path.startsWith(`/api/items/${attention}`)).map((r) => r.status))}`,
	);
	await sleep(2000);
	await shot("3-item-details");

	// another program writes to the library while the page is open
	await evalIn("znLibrary.store.selectCollection(null)");
	await waitFor(`znLibrary.store.selectedCollection() === null && znLibrary.store.total() === ${libTotal}`, 20_000);
	const before = await evalIn<number>("znLibrary.outsideChanges");
	const w = repo.openDb(dbPath);
	repo.createItem(w, { itemType: "journalArticle", title: "Added by another program while the page was open", date: "2026" } as never);
	w.close();
	const seen = await waitFor(`znLibrary.outsideChanges > ${before} && znLibrary.store.total() === ${libTotal + 1}`, 20_000);
	check(
		"an outside change shows up",
		seen,
		`outside changes seen: ${await evalIn("znLibrary.outsideChanges")}, total ${await evalIn("znLibrary.store.total()")} (expected ${libTotal + 1})`,
	);
	await evalIn("znLibrary.store.setFilter('Added by another program')");
	await sleep(2500);
	await shot("4-outside-change");

	const failed = (await evalIn<{ method: string; path: string; status: number | string }[]>("znLibrary.requests")).filter(
		(r) => r.status !== 200 && r.status !== "pending",
	);
	check(
		"no request failed except refused ones",
		failed.every((r) => r.status === 403),
		JSON.stringify(failed.slice(0, 10)),
	);
	const csp = problems.filter((p) => /Content Security Policy|wasm-unsafe-eval|eval/i.test(p));
	check("no Content Security Policy violations", csp.length === 0, csp.slice(0, 5).join(" | ") || "none");
	if (problems.length) console.log(`page errors (${problems.length}):\n  ${problems.slice(0, 15).join("\n  ")}`);
	ws.close();
} finally {
	// 4. clean up: the registration always; the profile and host unless --keep
	for (const k of REG_KEYS) spawnSync("reg", ["delete", k, "/f"], { stdio: "ignore" });
	// the whole tree: Chrome's renderer, GPU and native-host children keep the profile and host exe open otherwise
	if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	await sleep(1500);
	if (!KEEP) {
		rmSync(join(WORK, "profile"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		rmSync(join(WORK, "host"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	}
}
writeFileSync(join(WORK, "results.json"), JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
