// Headless end-to-end check of the Zinc Connector's save popup (connector: src/browserExt/popup/, savePopup.js):
//   bun web/popup-check.ts --ext <connector build/manifestv3> [--chrome <Chrome for Testing chrome.exe>] [--work <dir>] [--keep]
// Same safety rules as web/extension-check.ts: a fixture library (web/demo-library.ts), the host compiled to <work>/host and
// registered as com.zotero_next.connector_host_e2e under HKCU\Software\Chromium only (where Chrome for Testing looks; the real
// host is not registered there), a fresh profile, and the extension's background pointed at that name before anything is saved
// (Zotero.NativeHost.useHostForTests). It stops before any save unless the host reports the fixture library.
//
// Pages to save come from a local server: two fixture articles with citation_* metadata (Zotero's Embedded Metadata translator)
// and a PDF that is sent slowly, so the popup can be seen during a save. The popup page is opened as a tab with ?tab=<id> (a
// headless browser has no toolbar), 360 px wide. Screenshots: <work>/shots (light and dark, during and after a save).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as repo from "../../core/src/db";

const arg = (n: string) => {
	const i = process.argv.indexOf(`--${n}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const EXT = resolve(arg("ext") ?? join(homedir(), "zotero-next-connector", "build", "manifestv3"));
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-popup-check"));
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(import.meta.dir, "..", "..");
const HOST_NAME = "com.zotero_next.connector_host_e2e";
const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
const CDP_PORT = 9342;
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";

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
const run = (cmd: string[], cwd: string) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
};

if (!existsSync(join(EXT, "popup", "popup.html"))) throw new Error(`${EXT} is not a connector build with popup/popup.html`);
rmSync(WORK, { recursive: true, force: true });
for (const d of ["host", "shots"]) mkdirSync(join(WORK, d), { recursive: true });

// ---- fixture library, host, registration
const libDir = join(WORK, "library");
run(["bun", join(ROOT, "gpui-ui", "web", "demo-library.ts"), libDir], join(ROOT, "gpui-ui"));
const dbPath = join(libDir, "library.sqlite");
const hostExe = join(WORK, "host", "zinc-e2e-host.exe");
run(["bun", "build", "--compile", join(ROOT, "connector-host", "src", "main.ts"), "--outfile", hostExe], join(ROOT, "connector-host"));
const manifestPath = join(WORK, "host", `${HOST_NAME}.json`);
writeFileSync(
	manifestPath,
	JSON.stringify(
		{
			name: HOST_NAME,
			description: "Zinc host (popup check, fixture library)",
			path: hostExe,
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXT_ID}/`],
		},
		null,
		2,
	),
);
run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], WORK);
const fx = repo.openDb(dbPath);
const thesis = (fx.query("SELECT key FROM collections WHERE name = 'Thesis'").get() as { key: string }).key;
fx.close();
const q = <T>(sql: string, ...p: unknown[]): T[] => {
	const db = repo.openDb(dbPath);
	try {
		return db.query(sql).all(...(p as never[])) as T[];
	} finally {
		db.close();
	}
};

// ---- the pages to save
const ARTICLES: Record<string, { title: string; doi: string }> = {
	"1": { title: "Machine perfusion of donor livers: a fixture article", doi: "10.5555/zinc.fixture.1" },
	"2": { title: "Cold ischaemia and graft survival: a second fixture article", doi: "10.5555/zinc.fixture.2" },
};
function pdfBytes(n: string): Uint8Array {
	const text = `Fixture PDF ${n}`;
	const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	objs.forEach((o, i) => {
		offs.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out + `% ${"padding ".repeat(40_000)}\n`); // ~320 KB, sent in slow pieces
}
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const u = new URL(req.url);
		const m = /^\/article(\d)\.html$/.exec(u.pathname);
		if (m && ARTICLES[m[1]!]) {
			const a = ARTICLES[m[1]!]!;
			return new Response(
				`<!doctype html><html><head><meta charset="utf-8"><title>${a.title}</title>
<meta name="citation_title" content="${a.title}"><meta name="citation_author" content="Smith, Jane"><meta name="citation_author" content="Patel, Raj">
<meta name="citation_journal_title" content="Journal of Fixture Studies"><meta name="citation_publication_date" content="2024/03/01">
<meta name="citation_volume" content="12"><meta name="citation_doi" content="${a.doi}">
<meta name="citation_pdf_url" content="${u.origin}/paper${m[1]}.pdf"></head>
<body><h1>${a.title}</h1><p>A page made for the Zinc Connector's headless check. No real article.</p></body></html>`,
				{ headers: { "Content-Type": "text/html" } },
			);
		}
		const p = /^\/paper(\d)\.pdf$/.exec(u.pathname);
		if (p) {
			const bytes = pdfBytes(p[1]!);
			const pieces = 16;
			const size = Math.ceil(bytes.length / pieces);
			let i = 0;
			return new Response(
				new ReadableStream({
					async pull(c) {
						if (i >= pieces) return c.close();
						await sleep(450);
						c.enqueue(bytes.subarray(i * size, (i + 1) * size));
						i++;
					},
				}),
				{ headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length) } },
			);
		}
		return new Response("not found", { status: 404 });
	},
});

const profile = join(WORK, "profile");
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
	{ stdio: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0", ZNH_REPO: ROOT } },
);

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
	const listeners: ((m: any) => void)[] = [];
	ws.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)!(m);
			pending.delete(m.id);
		} else for (const l of listeners) l(m);
	};
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
		new Promise((r) => {
			const id = nextId++;
			pending.set(id, r);
			ws.send(JSON.stringify({ id, method, params, sessionId }));
		});
	const problems: string[] = [];
	const attach = async (targetId: string, label: string) => {
		const { result } = await send("Target.attachToTarget", { targetId, flatten: true });
		const sid = result.sessionId as string;
		listeners.push((m) => {
			if (m.sessionId !== sid) return;
			if (m.method === "Runtime.exceptionThrown") {
				const d = m.params.exceptionDetails;
				problems.push(
					`${label} exception: ${(d.exception?.description ?? d.text).slice(0, 400)} at ${d.url ?? ""}:${d.lineNumber ?? ""}`,
				);
			}
			if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
				problems.push(`${label} log: ${m.params.entry.text.slice(0, 300)}`);
		});
		await send("Runtime.enable", {}, sid);
		await send("Log.enable", {}, sid).catch(() => {});
		return sid;
	};
	const evalIn = async <T>(sid: string, expression: string): Promise<T> => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (sid: string, expression: string, ms: number): Promise<boolean> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
			try {
				if (await evalIn<boolean>(sid, expression)) return true;
			} catch {
				/* loading */
			}
		}
		return false;
	};
	const openTab = async (url: string, label: string) => {
		const {
			result: { targetId },
		} = await send("Target.createTarget", { url });
		return { targetId, sid: await attach(targetId, label) };
	};

	// the extension's background: point it at the test host, and confirm which library that host serves
	let swTarget: string | undefined;
	for (let i = 0; i < 100 && !swTarget; i++) {
		const { result } = await send("Target.getTargets");
		swTarget = result.targetInfos.find(
			(t: any) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`),
		)?.targetId;
		if (!swTarget) await sleep(200);
	}
	if (!swTarget) throw new Error("the extension's service worker did not start");
	const sw = await attach(swTarget, "background");
	await waitFor(sw, "typeof Zotero !== 'undefined' && !!Zotero.NativeHost && !!Zotero.SavePopup", 20_000);
	await evalIn(sw, `Zotero.initDeferred.promise.then(() => Zotero.NativeHost.useHostForTests(${JSON.stringify(HOST_NAME)}))`);
	// errors before this point come from the start-up calls to the real host name, which this profile does not have
	const startupProblems = problems.length;
	// the translators came from the real host name at start-up (not registered in this profile): load them from the test host
	await evalIn(sw, "Zotero.Translators.updateFromRemote(true)").catch((e) => console.log(`translator reload: ${e.message}`));
	const hello = await evalIn<{ db?: string }>(sw, "Zotero.NativeHost.hello()").catch((e) => ({ db: `error: ${e.message}` }));
	check(
		"the background reaches the test host, serving the fixture library",
		resolve(hello?.db ?? "") === resolve(dbPath),
		String(hello?.db),
	);
	if (resolve(hello?.db ?? "") !== resolve(dbPath)) throw new Error("not the fixture library: stopping before any save");

	const base = `http://127.0.0.1:${server.port}`;
	const article = async (n: string) => {
		const t = await openTab(`${base}/article${n}.html`, `article${n}`);
		const tabId = await evalIn<number>(
			sw,
			`browser.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith("/article${n}.html"))?.id)`,
		);
		const found = await waitFor(sw, `(Zotero.Connector_Browser.getTabInfo(${tabId})?.translators?.length ?? 0) > 0`, 30_000);
		check(`article ${n}: a translator is found`, found, `tab ${tabId}`);
		return { ...t, tabId };
	};
	const popup = async (tabId: number, scheme: "light" | "dark") => {
		const p = await openTab("about:blank", "popup");
		await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, p.sid);
		await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, p.sid);
		await send("Page.enable", {}, p.sid);
		await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/popup/popup.html?tab=${tabId}` }, p.sid);
		return p;
	};
	const shot = async (sid: string, name: string) => {
		const h = await evalIn<number>(sid, "Math.ceil(document.body.getBoundingClientRect().height)");
		const s = await send(
			"Page.captureScreenshot",
			{ format: "png", clip: { x: 0, y: 0, width: 360, height: h, scale: 1 }, captureBeyondViewport: true },
			sid,
		);
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	};
	const S = "window.znPopup && window.znPopup.state";

	// 1. light: a save from the popup, during and after
	const a1 = await article("1");
	const p1 = await popup(a1.tabId, "light");
	const during = await waitFor(
		p1.sid,
		`${S} && znPopup.state.items.some((r) => r.parentItem && typeof r.progress === "number" && r.progress < 100) && !znPopup.state.done`,
		30_000,
	);
	check(
		"the popup shows the save while it runs",
		during,
		JSON.stringify(await evalIn(p1.sid, `${S} && znPopup.state.items.map((r) => [r.title, r.progress])`)),
	);
	await sleep(300);
	await shot(p1.sid, "1-saving-light");
	const inPage = await evalIn<boolean>(
		a1.sid,
		"!![...document.querySelectorAll('iframe')].find((f) => /progressWindow/.test(f.src) && f.style.display !== 'none')",
	);
	check("the in-page progress window stays hidden", !inPage, inPage ? "visible" : "hidden");
	const saved = await waitFor(
		p1.sid,
		`${S} && znPopup.state.done && znPopup.state.done.ok && znPopup.state.saved.length === 1 && znPopup.state.items.every((r) => r.progress === 100 || r.progress === undefined)`,
		40_000,
	);
	const key = await evalIn<string>(p1.sid, "znPopup.state.saved[0] && znPopup.state.saved[0].key");
	const rows = q<{ title: string; deleted: number }>("SELECT title, deleted FROM items WHERE key = ?", key);
	const pdfs = q<{ n: number }>(
		"SELECT count(*) n FROM items i JOIN attachments a ON a.item_key = i.key WHERE i.parent_key = ? AND a.content_type = 'application/pdf'",
		key,
	);
	check(
		"after the save: item and its PDF are in the library",
		saved && rows[0]?.title === ARTICLES["1"]!.title && pdfs[0]!.n === 1,
		`${key}: ${rows[0]?.title}, PDFs ${pdfs[0]?.n}`,
	);
	await sleep(300);
	await shot(p1.sid, "2-saved-light");

	// 2. the collection picker: search, then move the saved item to "Thesis"
	await evalIn(p1.sid, "document.getElementById('picker').click()");
	await sleep(200);
	await shot(p1.sid, "3-picker-light");
	await evalIn(
		p1.sid,
		"(() => { const s = document.getElementById('search'); s.value = 'thes'; s.dispatchEvent(new Event('input')); })()",
	);
	await sleep(150);
	await shot(p1.sid, "3b-picker-search-light");
	await evalIn(p1.sid, "document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))");
	const moved = await waitFor(
		p1.sid,
		`${S} && znPopup.state.target.id === "C${thesis}" && !znPopup.state.busy && /Moved/.test(znPopup.state.message && znPopup.state.message.text || "")`,
		15_000,
	);
	const inThesis = q<{ n: number }>("SELECT count(*) n FROM collection_items WHERE item_key = ? AND collection_key = ?", key, thesis)[0]!
		.n;
	check("the picker moves the saved item to another collection", moved && inThesis === 1, `in Thesis: ${inThesis}`);
	const recent = await evalIn<string[]>(p1.sid, "chrome.storage.local.get('zincRecentTargets').then((r) => r.zincRecentTargets)");
	check("the chosen collection is remembered as recent", Array.isArray(recent) && recent[0] === `C${thesis}`, JSON.stringify(recent));

	// 3. dark, the same popup
	await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, p1.sid);
	await sleep(300);
	await shot(p1.sid, "4-saved-dark");

	// 4. actions: Open in Zinc (the app lookup is off in this test: the popup reports the host's answer), Open library
	await evalIn(p1.sid, "document.getElementById('open-zinc').click()");
	const zinc = await waitFor(
		p1.sid,
		"/turned off|not running|Zinc/.test(document.getElementById('message').textContent) && !/Asking/.test(document.getElementById('message').textContent)",
		10_000,
	);
	check(
		"Open in Zinc asks the host (revealInApp) and shows its answer",
		zinc,
		await evalIn<string>(p1.sid, "document.getElementById('message').textContent"),
	);
	await evalIn(p1.sid, "document.getElementById('open-library').click()");
	let libTab: string | undefined;
	for (let i = 0; i < 50 && !libTab; i++) {
		const { result } = await send("Target.getTargets");
		libTab = result.targetInfos.find((t: any) =>
			t.url.startsWith(`chrome-extension://${EXT_ID}/library/library.html?select=${key}`),
		)?.targetId;
		if (!libTab) await sleep(200);
	}
	check("Open library opens the library page for the saved item", !!libTab, libTab ? `library.html?select=${key}` : "no tab");
	if (libTab) {
		const lib = await attach(libTab, "library");
		// that page talks to the host by its real name: point it at the test host too (a reload with ?host=)
		await send("Page.enable", {}, lib);
		await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/library/library.html?select=${key}&host=${HOST_NAME}` }, lib);
		const sel = await waitFor(lib, `!!globalThis.znLibrary && znLibrary.store.selectedItem() === ${JSON.stringify(key)}`, 60_000);
		check(
			"the library page selects the saved item",
			sel,
			String(await evalIn(lib, "globalThis.znLibrary?.store.selectedItem()").catch(() => "")),
		);
		await send("Target.closeTarget", { targetId: libTab });
	}

	// 5. Remove: the saved item goes to the Trash (soft delete)
	await evalIn(p1.sid, "document.getElementById('remove').click()");
	const removed = await waitFor(
		p1.sid,
		`${S} && znPopup.state.removed && znPopup.state.removed.length === 1 && !znPopup.state.busy`,
		15_000,
	);
	const del = q<{ deleted: number }>("SELECT deleted FROM items WHERE key = ?", key)[0]?.deleted;
	check("Remove moves the saved item to the Trash", removed && del === 1, `deleted = ${del}`);
	await sleep(300);
	await shot(p1.sid, "5-removed-dark");

	// 6. dark: a second save, cancelled while its PDF is still arriving
	const a2 = await article("2");
	const p2 = await popup(a2.tabId, "dark");
	const during2 = await waitFor(
		p2.sid,
		`${S} && znPopup.state.sessionCreated && znPopup.state.items.some((r) => r.parentItem && typeof r.progress === "number" && r.progress < 100)`,
		30_000,
	);
	check("second save: shown while it runs", during2, "");
	await sleep(300);
	await shot(p2.sid, "6-saving-dark");
	await evalIn(p2.sid, "document.getElementById('cancel').click()");
	const cancelled = await waitFor(p2.sid, `${S} && znPopup.state.cancelled && !znPopup.state.busy`, 15_000);
	await sleep(300);
	await shot(p2.sid, "7-cancelled-dark");
	await sleep(9000); // the PDF finishes arriving; the host refuses it (SESSION_CANCELLED)
	const left = q<{ key: string; deleted: number }>(
		"SELECT key, deleted FROM items WHERE title = ? AND parent_key IS NULL",
		ARTICLES["2"]!.title,
	);
	const pdf2 = q<{ n: number }>(
		"SELECT count(*) n FROM items i JOIN attachments a ON a.item_key = i.key JOIN items p ON p.key = i.parent_key WHERE p.title = ? AND a.content_type = 'application/pdf'",
		ARTICLES["2"]!.title,
	)[0]!.n;
	check(
		"Cancel: the save's item is in the Trash and its PDF was refused",
		cancelled && left.length > 0 && left.every((r) => r.deleted === 1) && pdf2 === 0,
		`items ${JSON.stringify(left)}, PDFs ${pdf2}`,
	);

	// the fixture pages have no favicon (a 404 each)
	// Also expected: Translators.init (translators.js:66) rejects, surfacing late in the worker, because at start-up the profile had no
	// host by the real name and the repository fetch failed as well; the reload from the test host above replaced it.
	const errs = problems
		.slice(startupProblems)
		.filter(
			(p) =>
				!/^article\d log: Failed to load resource/.test(p) &&
				!/^background exception: Error at \S+\/(translators\.js:66|background-worker\.js:0)$/.test(p),
		);
	if (startupProblems)
		console.log(
			`start-up errors (no real host in this profile, expected): ${problems.slice(0, startupProblems).join(" | ").slice(0, 300)}`,
		);
	check(
		"no exceptions in the popup or the background",
		!errs.some((p) => /popup exception|background exception/.test(p)),
		errs.slice(0, 6).join(" | ") || "none",
	);
	if (errs.length) console.log(`page errors (${errs.length}):\n  ${errs.slice(0, 15).join("\n  ")}`);
	ws.close();
} finally {
	spawnSync("reg", ["delete", REG_KEY, "/f"], { stdio: "ignore" });
	if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
	server.stop(true);
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
