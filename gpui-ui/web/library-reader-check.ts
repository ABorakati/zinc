// Headless check of EPUBs and web snapshots in the connector's library tab (docs/design/web-connector-wasm.md, section 8): they open in
// Zotero's reader (reader/index.html, built by web/build.ts from reader-host) in a new browser tab, over the native host.
//   bun web/library-reader-check.ts [--chrome <exe>] [--work <dir>] [--host-exe <compiled host>] [--key-file <extension-key.txt>] [--keep]
// Needs `bun web/build.ts --target extension` first (gpui-ui/dist-extension, with library/reader/).
//
// Safety, as in web/library-pdf-check.ts: a fixture library (web/demo-library.ts, plus a generated EPUB and two HTML snapshots), the
// host registered as com.zotero_next.connector_host_e2e_a under HKCU\Software\Chromium only (where Chrome for Testing looks), a fresh
// profile, DevTools port 9351, and the pages opened with ?host=<that name>. The extension loaded is a minimal one made here: the
// connector's manifest key (the same id), the extension-page CSP, and library/ as a link to gpui-ui/dist-extension (nothing copied).
//
// It opens each attachment from the library tab, reads the text the reader drew in its frames, adds a highlight through the reader's own
// annotation manager and finds it in the fixture database, takes screenshots in light and dark, and looks for page errors and CSP
// violations. One snapshot carries scripts: none of them may run (they would run with the extension's privileges).
import { assertSafeToStart, testManifest } from "./check-safety";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { addFile } from "../../core/src/additems/files";
import * as repo from "../../core/src/db";

const arg = (n: string) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = join(ROOT, "gpui-ui", "dist-extension");
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-wp-a", "reader-check"));
const KEEP = process.argv.includes("--keep");
const KEY_FILE = arg("key-file") ?? join(homedir(), "zotero-next-connector", "extension-key.txt");
const HOST_NAME = "com.zotero_next.connector_host_e2e_a";
const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const CDP_PORT = Number(arg("port") ?? 9351);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
	results.push({ check: name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};
const run = (cmd: string[], cwd: string) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
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

// ---- the fixture files
const EPUB_TEXT = [
	"Zinc fixture book, chapter one: a donor liver is kept warm and supplied with oxygen.",
	"Chapter two: machine perfusion lets surgeons assess the graft before it is transplanted.",
];
/** A small valid EPUB 3 with two chapters. */
function makeEpub(): Uint8Array {
	const chapter = (n: number, text: string) =>
		`<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body><h1>Chapter ${n}</h1><p>${text}</p><p>${"Filler sentence to give the page some length. ".repeat(12)}</p></body></html>`;
	return zipSync({
		mimetype: [strToU8("application/epub+zip"), { level: 0 }],
		"META-INF/container.xml": strToU8(
			`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
		),
		"OEBPS/content.opf": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:5a1d9a0e-1111-4222-8333-444455556666</dc:identifier><dc:title>Zinc fixture book</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
		),
		"OEBPS/nav.xhtml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter 1</a></li><li><a href="c2.xhtml">Chapter 2</a></li></ol></nav></body></html>`,
		),
		"OEBPS/c1.xhtml": strToU8(chapter(1, EPUB_TEXT[0]!)),
		"OEBPS/c2.xhtml": strToU8(chapter(2, EPUB_TEXT[1]!)),
	});
}
const SNAP_TEXT = "Snapshot fixture paragraph: tacrolimus levels were checked twice a week after the transplant.";
const snapshot = (title: string, extra = "") =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${SNAP_TEXT}</p><p>${"More snapshot text so that the page scrolls a little. ".repeat(20)}</p>${extra}</body></html>`;
// every way a snapshot can try to run code: inline script, an inline handler, a script file of the extension itself, javascript: in a frame
const SCRIPTED = snapshot(
	"Scripted snapshot",
	`<script>document.documentElement.setAttribute("data-ran", "inline"); try { parent.__znScriptRan = "inline"; } catch (e) {} try { document.body.setAttribute("data-ext", chrome.runtime.id); } catch (e) {}</script>
<img src="data:," onerror="document.documentElement.setAttribute('data-ran-handler', 'yes'); try { parent.__znScriptRan = 'handler'; } catch (e) {}">
<script src="chrome-extension://${EXT_ID}/library/reader/zn-bridge.js"></script>`,
);

if (!existsSync(join(DIST, "library.html")) || !existsSync(join(DIST, "reader", "index.html")))
	throw new Error(`build first: bun web/build.ts --target extension (${DIST}, with reader/)`);
// a link left by an earlier run: remove the link itself first, so the recursive delete below cannot follow it into the build
if (existsSync(join(WORK, "ext", "library"))) spawnSync("cmd", ["/c", "rmdir", join(WORK, "ext", "library")], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true });
for (const d of ["host", "shots", "ext", "files"]) mkdirSync(join(WORK, d), { recursive: true });

// ---- fixture library: the demo library + an EPUB, a snapshot and a snapshot with scripts, each under a paper
const libDir = join(WORK, "library");
run(["bun", join(ROOT, "gpui-ui", "web", "demo-library.ts"), libDir], join(ROOT, "gpui-ui"));
const dbPath = join(libDir, "library.sqlite");
const fx = repo.openDb(dbPath);
const parentOf = (title: string) => (fx.query("SELECT key FROM items WHERE title = ?").get(title) as { key: string }).key;
const add = (file: string, bytes: Uint8Array | string, contentType: string, parentTitle: string) => {
	const p = join(WORK, "files", file);
	writeFileSync(p, bytes);
	const parentKey = parentOf(parentTitle);
	const key = addFile(fx, { mode: "imported_file", path: p, name: file, contentType, parentKey, keepName: true } as never).data.key;
	return { key, parentKey, title: parentTitle };
};
const epub = add("Zinc fixture book.epub", makeEpub(), "application/epub+zip", "Deep learning");
const snap = add("Fixture page.html", snapshot("Snapshot fixture"), "text/html", "Adam: A Method for Stochastic Optimization");
const scripted = add("Scripted page.html", SCRIPTED, "text/html", "Dropout: A Simple Way to Prevent Neural Networks from Overfitting");
fx.close();
rmSync(join(WORK, "files"), { recursive: true, force: true });
function q<T>(sql: string, ...p: unknown[]): T[] {
	const db = repo.openDb(dbPath);
	try {
		return db.query(sql).all(...(p as never[])) as T[];
	} finally {
		db.close();
	}
}
console.log(`fixture: EPUB ${epub.key}, snapshot ${snap.key}, scripted snapshot ${scripted.key}`);

// ---- host, registration, the minimal extension
let hostExe = arg("host-exe");
if (!hostExe) {
	hostExe = join(WORK, "host", "zinc-e2e-host.exe");
	run(["bun", "build", "--compile", join(ROOT, "connector-host", "src", "main.ts"), "--outfile", hostExe], join(ROOT, "connector-host"));
}
const manifestPath = join(WORK, "host", `${HOST_NAME}.json`);
writeFileSync(
	manifestPath,
	JSON.stringify(
		{
			name: HOST_NAME,
			description: "Zinc host (library reader check, fixture library)",
			path: hostExe,
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXT_ID}/`],
		},
		null,
		2,
	),
);
const ext = join(WORK, "ext");
writeFileSync(
	join(ext, "manifest.json"),
	JSON.stringify(
		testManifest({
			name: "Zinc reader check",
			manifest_version: 3,
			version: "1.0",
			key: readFileSync(KEY_FILE, "utf8").trim(),
			permissions: ["nativeMessaging"],
			content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
		}),
		null,
		2,
	),
);
run(["cmd", "/c", "mklink", "/J", join(ext, "library"), DIST], WORK);

assertSafeToStart({ extDir: ext, hostNames: [HOST_NAME] });
run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], WORK); // the test host, under the Chromium key only
const chrome = spawn(
	findChrome(),
	[
		"--headless=new",
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${join(WORK, "profile")}`,
		`--load-extension=${ext}`,
		`--disable-extensions-except=${ext}`,
		"--disk-cache-size=1048576",
		"--disable-gpu-shader-disk-cache",
		"--no-first-run",
		"--no-default-browser-check",
		"--enable-unsafe-swiftshader",
		"--window-size=1400,900",
		"about:blank",
	],
	{ stdio: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0" } },
);

interface Tab {
	sid: string;
	targetId: string;
	url: string;
	type: string;
	problems: string[];
	csp: string[];
	label: string;
}
try {
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
	const tabs = new Map<string, Tab>();
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
		new Promise((r) => {
			const id = nextId++;
			pending.set(id, r);
			ws.send(JSON.stringify({ id, method, params, sessionId }));
		});
	ws.onmessage = async (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)!(m);
			pending.delete(m.id);
			return;
		}
		if (m.method === "Target.attachedToTarget") {
			// every new target starts paused: the page's console and errors are listened to from its first script on
			const { sessionId, targetInfo } = m.params;
			const t: Tab = {
				sid: sessionId,
				targetId: targetInfo.targetId,
				url: targetInfo.url,
				type: targetInfo.type,
				problems: [],
				csp: [],
				label: "",
			};
			tabs.set(sessionId, t);
			if (targetInfo.type === "page") for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await send(d, {}, sessionId);
			await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
			return;
		}
		const t = tabs.get(m.sessionId);
		if (!t) return;
		const text = (s: string) => s.slice(0, 300);
		if (m.method === "Target.targetInfoChanged") return;
		if (m.method === "Runtime.exceptionThrown") {
			const d = m.params.exceptionDetails;
			t.problems.push(`exception: ${text(d.exception?.description ?? d.text)}`);
		}
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
			const s = text(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
			(/Content Security Policy|violates the following/i.test(s) ? t.csp : t.problems).push(`log: ${s}`);
		}
		if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
			const s = text(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
			(/Content Security Policy|violates the following/i.test(s) ? t.csp : t.problems).push(`console.${m.params.type}: ${s}`);
		}
	};
	// the browser target: attach to every new page (the reader tabs that chrome.tabs.create opens) before it runs anything
	await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	const evalIn = async <T>(t: Tab, expression: string): Promise<T> => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, t.sid);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (t: Tab, expression: string, ms: number): Promise<boolean> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
			try {
				if (await evalIn<boolean>(t, expression)) return true;
			} catch {
				/* loading */
			}
		}
		return false;
	};
	const waitTab = async (pred: (t: Tab) => boolean, ms: number): Promise<Tab | undefined> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
			const t = [...tabs.values()].find((x) => x.type === "page" && pred(x));
			if (t) return t;
		}
	};
	const shot = async (t: Tab, name: string) => {
		await send("Target.activateTarget", { targetId: t.targetId });
		await sleep(400);
		const s = await send("Page.captureScreenshot", { format: "png" }, t.sid);
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	};
	const infos = async () => (await send("Target.getTargets")).result.targetInfos as { targetId: string; url: string; type: string }[];

	// the library tab
	const created = await send("Target.createTarget", { url: "about:blank" });
	const lib = await waitTab((t) => t.targetId === created.result.targetId, 10_000);
	if (!lib) throw new Error("the library tab did not attach");
	lib.label = "library";
	await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/library/library.html?host=${HOST_NAME}` }, lib.sid);
	check(
		"the library list loads",
		await waitFor(lib, "!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0 && znLibrary.store.total() > 0", 60_000),
		"",
	);
	await sleep(800);

	/** Open an attachment from the library tab; the reader tab it opens (chrome.tabs.create) once its first page is drawn. */
	const openReader = async (a: { key: string; title: string; parentKey: string }, label: string) => {
		const before = new Set(tabs.keys());
		const tabsBefore = (await infos()).length;
		await evalIn(
			lib,
			`znLibrary.store.openAttachment(${JSON.stringify(a.key)}, ${JSON.stringify(a.title)}, ${JSON.stringify(a.parentKey)})`,
		);
		const t = await waitTab((x) => !before.has(x.sid) && true, 15_000);
		if (!t) return { t: undefined, ready: false, tabsBefore };
		t.label = label;
		const ready = await waitFor(t, "window.__readerReady === true", 60_000);
		return { t, ready, tabsBefore };
	};
	const frameText = (t: Tab) =>
		evalIn<string>(
			t,
			`[...document.querySelectorAll("iframe")].map((f) => { try { return f.contentDocument.body.innerText; } catch (e) { return ""; } }).join("\\n---\\n")`,
		);
	const highlight = (t: Tab) =>
		evalIn<string | null>(
			t,
			`(() => {
		const v = _reader._primaryView, doc = v._iframeDocument;
		const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n;
		while ((n = w.nextNode())) if (n.textContent.trim().length > 30) break;
		if (!n) return null;
		const r = doc.createRange(); r.setStart(n, 0); r.setEnd(n, 24);
		const a = v.getAnnotationFromRange(r, "highlight", "#ffd400");
		return a ? _reader._annotationManager.addAnnotation({ color: "#ffd400", ...a }).id : null;
	})()`,
		);
	const annsOf = (key: string) => {
		const d = repo.openDb(dbPath);
		try {
			return repo.getAnnotations(d, key) as { id: string; type: string; text?: string }[];
		} finally {
			d.close();
		}
	};

	const sessions: Tab[] = [];
	for (const [kind, item, expect] of [
		["EPUB", epub, EPUB_TEXT[0]!],
		["snapshot", snap, SNAP_TEXT],
	] as const) {
		const outbox0 = q<{ n: number }>("SELECT count(*) n FROM sync_outbox")[0]!.n;
		const { t, ready } = await openReader(item, kind);
		check(
			`${kind}: opens in a new tab of the extension`,
			!!t && ready,
			t ? `${(await infos()).find((i) => i.targetId === t.targetId)?.url}` : "no new tab",
		);
		if (!t) continue;
		sessions.push(t);
		const text0 = await waitFor(
			t,
			`[...document.querySelectorAll("iframe")].some((f) => { try { return f.contentDocument.body.innerText.includes(${JSON.stringify(expect.slice(0, 40))}); } catch (e) { return false; } })`,
			15_000,
		);
		const text = await frameText(t);
		check(`${kind}: its text renders in the reader frame`, text0, JSON.stringify(text.slice(0, 90)));
		const title = await evalIn<string>(t, "document.title");
		check(`${kind}: the tab is titled with the item`, title === item.title, title);
		const id = await highlight(t);
		let saved = false;
		for (const end = Date.now() + 10_000; Date.now() < end && !saved; await sleep(200))
			saved = !!id && annsOf(item.key).some((a) => a.id === id);
		const mine = annsOf(item.key).find((a) => a.id === id);
		const outbox1 = q<{ n: number }>("SELECT count(*) n FROM sync_outbox")[0]!.n;
		check(
			`${kind}: a highlight made in the reader is saved to the library (and the sync outbox)`,
			saved && outbox1 > outbox0,
			`${id}: "${mine?.text}", outbox +${outbox1 - outbox0}`,
		);
		await evalIn(t, "_reader.setColorScheme('light')");
		await sleep(900);
		await shot(t, `${kind.toLowerCase()}-light`);
		const darkErr = await evalIn<string>(
			t,
			"(() => { try { _reader.setColorScheme('dark'); return ''; } catch (e) { return String(e); } })()",
		);
		check(`${kind}: dark mode switches without an error`, !darkErr, darkErr || "static or dynamic theme applied");
		await sleep(1500);
		await shot(t, `${kind.toLowerCase()}-dark`);
		const darkText = await frameText(t);
		check(`${kind}: still readable in dark mode`, darkText.includes(expect.slice(0, 40)), "");
	}

	// the snapshot with scripts: none may run
	{
		const { t, ready } = await openReader(scripted, "scripted snapshot");
		check("scripted snapshot: opens", !!t && ready, "");
		if (t) {
			sessions.push(t);
			await waitFor(
				t,
				`[...document.querySelectorAll("iframe")].some((f) => { try { return f.contentDocument.body.innerText.includes("Snapshot fixture paragraph"); } catch (e) { return false; } })`,
				15_000,
			);
			await sleep(1500);
			const st = await evalIn<{
				inline: string | null;
				handler: string | null;
				ext: string | null;
				parent: unknown;
				bridge: boolean;
				text: boolean;
				sandbox: string;
			}>(
				t,
				`(() => {
				const f = document.querySelector("#primary-view iframe"), d = f.contentDocument, w = f.contentWindow;
				return { inline: d.documentElement.getAttribute("data-ran"), handler: d.documentElement.getAttribute("data-ran-handler"), ext: d.body.getAttribute("data-ext"),
					parent: window.__znScriptRan ?? null, bridge: typeof w.znApiFetch === "function", text: d.body.innerText.includes("Snapshot fixture paragraph"), sandbox: f.getAttribute("sandbox") };
			})()`,
			);
			check("scripted snapshot: its text still shows", st.text, "");
			check(
				"scripted snapshot: no inline script, inline handler or extension script ran",
				!st.inline && !st.handler && !st.ext && !st.parent && !st.bridge,
				JSON.stringify(st),
			);
			check(
				"scripted snapshot: the browser reported the blocked scripts (CSP)",
				t.csp.length > 0,
				`${t.csp.length} violation(s), e.g. ${t.csp[0] ?? "none"}`,
			);
			await shot(t, "scripted-light");
		}
	}

	// the library tab can still be used, and nothing failed in any tab
	const refused = (await evalIn<{ method: string; path: string; status: number | string }[]>(lib, "znLibrary.requests")).filter(
		(r) => r.status !== 200 && r.status !== 206 && r.status !== "pending",
	);
	check(
		"library tab: no request failed except refused ones (403)",
		refused.every((r) => r.status === 403),
		JSON.stringify(refused.slice(0, 6)),
	);
	// reading mode (the structured text pack) needs Zotero's document worker, which this build leaves out: the reader says so and goes on
	const ignored = /sync\/status|SDT pack unavailable|structure unavailable|reading view needs layout analysis|403|favicon/i;
	for (const t of [lib, ...sessions]) {
		const errs = t.problems.filter((p) => !ignored.test(p));
		check(`${t.label}: no exceptions or console errors`, errs.length === 0, errs.slice(0, 5).join(" | ") || "none");
		if (t.label !== "scripted snapshot")
			check(`${t.label}: no CSP violations`, t.csp.length === 0, t.csp.slice(0, 3).join(" | ") || "none");
	}
	ws.close();
} finally {
	spawnSync("reg", ["delete", REG_KEY, "/f"], { stdio: "ignore" });
	if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	await sleep(1500);
	if (!KEEP) {
		rmSync(join(WORK, "profile"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		rmSync(join(WORK, "host"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
		// the junction only: never the build it points to
		spawnSync("cmd", ["/c", "rmdir", join(WORK, "ext", "library")], { stdio: "ignore" });
		rmSync(join(WORK, "library"), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	}
}
writeFileSync(join(WORK, "results.json"), JSON.stringify({ results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
