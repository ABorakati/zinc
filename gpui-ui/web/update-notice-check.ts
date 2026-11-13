// Headless check of the update notice of an unpacked Zinc Connector (connector src/browserExt/updateNotice.js, popup/popup.js):
//   ZN_UPDATE_KEY=<test release-key.private.json> \
//   bun web/update-notice-check.ts --ext <connector build/manifestv3 built with the matching public key> [--port 9385] [--work <dir>] [--keep]
//
// 1. Makes a real feed with gpui-ui/scripts/release.ts --extension-zip (a newer version than the build, signed with ZN_UPDATE_KEY), and a
//    second feed with a broken signature.
// 2. Serves them from a local server, and loads a COPY of the build in which the feed URL points at that server (and, as in every
//    check, the native host name is one registered nowhere: web/check-safety.ts).
// 3. A valid feed: the background stores zincUpdateAvailable and the popup shows "Zinc <version> is available", with the link.
//    A tampered feed: nothing is stored. A store install (update_url in the manifest): the feed is never fetched.
// Nothing leaves this machine: --no-proxy-server, and no name but 127.0.0.1 resolves. Never use the real release key.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafeToStart, makeConnectorTestCopy } from "./check-safety";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const EXT_BUILD = resolve(arg("ext") ?? join(homedir(), "zotero-next-connector-library", "build", "manifestv3"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-update-check"));
const PORT = Number(arg("port") ?? 9385);
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..", "..");
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const FEED_CONST = "https://github.com/ABorakati/zinc/releases/latest/download/latest-extension.json";
const NEW_VERSION = "9.9.9";
if (!process.env.ZN_UPDATE_KEY) throw new Error("set ZN_UPDATE_KEY to a TEST release-key.private.json (bun gpui-ui/scripts/release.ts --keygen <scratch>)");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
function findChrome(): string {
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found");
	return exe;
}

rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(join(WORK, "feed"), { recursive: true });
mkdirSync(join(WORK, "shots"), { recursive: true });

// ---- the feeds: made by the real release script
const zip = join(WORK, `Zinc-Connector-${NEW_VERSION}.zip`);
writeFileSync(zip, "not a real zip: only its hash and size go into the feed");
const rel = spawnSync("bun", [join(ROOT, "gpui-ui", "scripts", "release.ts"), "--extension-zip", zip, "--version", NEW_VERSION, "--notes", "Test release",
	"--extension-url", `https://example.invalid/Zinc-Connector-${NEW_VERSION}.zip`, "--out", join(WORK, "feed"), "--force"], { encoding: "utf8", env: process.env });
if (rel.status !== 0) throw new Error(`release.ts failed:\n${rel.stderr || rel.stdout}`);
const good = readFileSync(join(WORK, "feed", "latest-extension.json"), "utf8");
const bad = JSON.stringify({ ...JSON.parse(good), url: "https://example.invalid/evil.zip" });
let serve: "good" | "bad" = "good";
let fetches = 0;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { fetches++; return new Response(serve === "good" ? good : bad, { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); } });
const FEED = `http://127.0.0.1:${server.port}/latest-extension.json`;

/** A copy of the build pointed at the local feed; `store` adds an update_url, as a store install has. */
function makeCopy(dir: string, store: boolean) {
	makeConnectorTestCopy(EXT_BUILD, dir);
	const p = join(dir, "updateNotice.js");
	const src = readFileSync(p, "utf8");
	if (!src.includes(FEED_CONST)) throw new Error("updateNotice.js: the feed URL constant was not found");
	writeFileSync(p, src.replace(FEED_CONST, FEED));
	if (store) {
		const mf = join(dir, "manifest.json");
		writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, "utf8")), update_url: "https://clients2.google.com/service/update2/crx" }, null, 2));
	}
}

async function session(dir: string, profile: string, body: (h: { sw: string; evalIn: <T>(sid: string, e: string) => Promise<T>; waitFor: (sid: string, e: string, ms: number) => Promise<boolean>; popup: () => Promise<string>; shot: (sid: string, n: string) => Promise<void>; send: (m: string, p?: object, s?: string) => Promise<any>; problems: string[] }) => Promise<void>) {
	assertSafeToStart({ extDir: dir });
	const chrome = spawn(findChrome(), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--load-extension=${dir}`, `--disable-extensions-except=${dir}`,
		"--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=420,640", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
		"--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { stdio: "ignore" });
	try {
		let ver: { webSocketDebuggerUrl: string } | undefined;
		for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json() as typeof ver; } catch { await sleep(200); } }
		if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
		const ws = new WebSocket(ver.webSocketDebuggerUrl);
		await new Promise((r) => (ws.onopen = r));
		let nextId = 1;
		const pending = new Map<number, (v: any) => void>();
		const problems: string[] = [];
		const sids = new Map<string, string>();
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data));
			if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
			const label = sids.get(m.sessionId);
			if (!label) return;
			if (m.method === "Runtime.exceptionThrown") problems.push(`${label}: ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300)}`);
			if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`${label} console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)}`);
		};
		const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
		const attach = async (targetId: string, label: string) => {
			const sid = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId as string;
			sids.set(sid, label);
			await send("Runtime.enable", {}, sid);
			return sid;
		};
		const evalIn = async <T,>(sid: string, expression: string): Promise<T> => {
			const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
			if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
			return r.result?.result?.value as T;
		};
		const waitFor = async (sid: string, expression: string, ms: number) => {
			for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) { try { if (await evalIn<boolean>(sid, expression)) return true; } catch { /* loading */ } }
			return false;
		};
		let swInfo: any;
		for (const end = Date.now() + 30_000; !swInfo && Date.now() < end; await sleep(150)) swInfo = (await send("Target.getTargets")).result.targetInfos.find((t: any) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
		if (!swInfo) throw new Error("the extension's service worker did not start");
		const sw = await attach(swInfo.targetId, "background");
		const popup = async () => {
			const { targetId } = (await send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/popup/popup.html` })).result;
			return attach(targetId, "popup");
		};
		const shot = async (sid: string, name: string) => {
			await send("Page.enable", {}, sid);
			const s = await send("Page.captureScreenshot", { format: "png" }, sid);
			writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
		};
		await body({ sw, evalIn, waitFor, popup, shot, send, problems });
		ws.close();
	} finally {
		if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
		await sleep(1500);
	}
}

try {
	// ---- an unpacked install, a valid feed
	const unpacked = join(WORK, "ext-unpacked");
	makeCopy(unpacked, false);
	await session(unpacked, join(WORK, "profile1"), async ({ sw, evalIn, waitFor, popup, shot, send, problems }) => {
		const stored = await waitFor(sw, "chrome.storage.local.get('zincUpdateAvailable').then((o) => !!o.zincUpdateAvailable)", 30_000);
		const info = await evalIn<any>(sw, "chrome.storage.local.get('zincUpdateAvailable').then((o) => o.zincUpdateAvailable)");
		check("an unpacked install fetches the signed feed and stores the newer version", stored && info?.version === NEW_VERSION, `fetches ${fetches}; stored ${JSON.stringify(info)}`);
		const p = await popup();
		const shown = await waitFor(p, "!document.getElementById('update').hidden", 10_000);
		const text = await evalIn<string>(p, "document.getElementById('update').innerText");
		const href = await evalIn<string>(p, "document.getElementById('update-link').href");
		check("the popup shows \"Zinc <version> is available\" with the download link", shown && text.includes(`Zinc ${NEW_VERSION} is available`) && href.includes(`Zinc-Connector-${NEW_VERSION}.zip`), `${JSON.stringify(text.slice(0, 160))}; link ${href}`);
		for (const mode of ["light", "dark"] as const) {
			await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] }, p);
			await sleep(400);
			await shot(p, `popup-update-${mode}`);
		}
		// a tampered feed (the url changed after signing): cleared state, a fresh check, nothing stored
		serve = "bad";
		await evalIn(sw, "chrome.storage.local.remove('zincUpdateAvailable')");
		const before = fetches;
		const outcome = await evalIn<string>(sw, "self.ZincUpdateNotice.check({ force: true })");
		const after = await evalIn<any>(sw, "chrome.storage.local.get('zincUpdateAvailable').then((o) => o.zincUpdateAvailable ?? null)");
		check("a feed whose signature does not match is ignored", fetches > before && outcome === "invalid" && after === null, `fetched again: ${fetches > before}; outcome ${outcome}; stored ${JSON.stringify(after)}`);
		// expected: the connector cannot reach repo.zotero.org for translators (this check resolves no name but 127.0.0.1)
		const errs = problems.filter((x) => !/update feed|signature|retrieve translators/i.test(x));
		check("no errors in the background or the popup", errs.length === 0, errs.slice(0, 4).join(" | ") || "none");
	});
	// ---- a store install: the browser updates it, so no feed is fetched
	serve = "good";
	const store = join(WORK, "ext-store");
	makeCopy(store, true);
	const before = fetches;
	await session(store, join(WORK, "profile2"), async ({ sw, waitFor, evalIn }) => {
		await waitFor(sw, "typeof self.ZincUpdateNotice !== 'undefined'", 10_000);
		await sleep(5000);
		const info = await evalIn<any>(sw, "chrome.storage.local.get('zincUpdateAvailable').then((o) => o.zincUpdateAvailable ?? null)");
		check("a store install (update_url set) never fetches the feed", fetches === before && info === null, `fetches during the run: ${fetches - before}`);
	});
} finally {
	server.stop(true);
	if (!KEEP) for (const d of ["profile1", "profile2", "ext-unpacked", "ext-store"]) rmSync(join(WORK, d), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(passed === results.length ? 0 : 1);
