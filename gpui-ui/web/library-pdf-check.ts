// Headless check of PDFs in the connector's library tab (docs/design/web-connector-wasm.md, phase 3):
//   bun web/library-pdf-check.ts [--chrome <exe>] [--work <dir>] [--host-exe <compiled host>] [--key-file <extension-key.txt>] [--modes 0,2] [--keep]
// Needs `bun web/build.ts --target extension` first (gpui-ui/dist-extension).
//
// Safety, as in web/extension-check.ts: a fixture library (web/demo-library.ts, plus a generated ~11 MB multi-page PDF), the host
// registered as com.zotero_next.connector_host_e2e under HKCU\Software\Chromium only (where Chrome for Testing looks), a fresh
// profile, and the page opened with ?host=<that name>. The extension loaded is a minimal one made here: the connector's manifest key
// (the same id), the library page's CSP, and library/ as a link to gpui-ui/dist-extension (nothing copied).
//
// For each --modes value (?pdfworkers=N: 0 = render on the main thread, the old way; 2 = two render workers) it measures opening a
// small and a large PDF (until the first page is drawn) and scrolling the large one (frame gaps, long tasks, render times). In the
// last mode it shows an annotation stored in the library, adds a highlight through the reader's annotation session, checks that it
// reached the fixture database and the sync outbox, and takes screenshots in light and dark.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addFile } from "../../core/src/additems/files";
import * as repo from "../../core/src/db";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = resolve(import.meta.dir, "..", "..");
const DIST = join(ROOT, "gpui-ui", "dist-extension");
const WORK = resolve(arg("work") ?? join(tmpdir(), "zinc-library-pdf-check"));
const KEEP = process.argv.includes("--keep");
const MODES = (arg("modes") ?? "0,2").split(",").map(Number);
const KEY_FILE = arg("key-file") ?? join(homedir(), "zotero-next-connector", "extension-key.txt");
const HOST_NAME = "com.zotero_next.connector_host_e2e";
const REG_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
const EXT_ID = "pakgagonakcalfbmckaolkpidcojacaf";
const CDP_PORT = 9343;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { check: string; ok: boolean; detail: string }[] = [];
const measures: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const run = (cmd: string[], cwd: string) => {
	const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr || r.stdout}`);
};
function findChrome(): string {
	const given = arg("chrome");
	if (given) return given;
	const base = join(homedir(), ".cache", "puppeteer", "chrome");
	const v = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("win64-")).sort().at(-1) : undefined;
	const exe = v && join(base, v, "chrome-win64", "chrome.exe");
	if (!exe || !existsSync(exe)) throw new Error("Chrome for Testing not found: pass --chrome <chrome.exe>");
	return exe;
}

/** A multi-page PDF of about `pages` x 0.9 MB: a heading, a few lines of text and an uncompressed 640x480 picture per page. */
function largePdf(pages: number): Uint8Array {
	const W = 640, H = 480;
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	let size = 0;
	const offs: number[] = [];
	const push = (b: Uint8Array | string) => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); size += u.length; };
	push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
	const n = 3 + pages * 3; // catalog, pages, font, then per page: page, contents, image
	const obj = (i: number, body: () => void) => { offs[i] = size; push(`${i} 0 obj\n`); body(); push("\nendobj\n"); };
	const kids = Array.from({ length: pages }, (_, p) => `${4 + p * 3} 0 R`).join(" ");
	obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
	obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`));
	obj(3, () => push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
	let seed = 7;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
	for (let p = 0; p < pages; p++) {
		const [pg, ct, im] = [4 + p * 3, 5 + p * 3, 6 + p * 3];
		obj(pg, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${ct} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im ${im} 0 R >> >> >>`));
		const lines = [`Large fixture PDF, page ${p + 1} of ${pages}`, "Machine perfusion keeps a donor liver warm and supplied with oxygen", "until it is transplanted, so that its function can be assessed first."];
		const text = lines.map((l, i) => `BT /F1 ${i ? 12 : 18} Tf 72 ${730 - i * 22} Td (${l}) Tj ET`).join("\n");
		const content = `${text}\nq 468 0 0 351 72 300 cm /Im Do Q`;
		obj(ct, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
		const px = new Uint8Array(W * H * 3);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 3;
			px[i] = (x * 255 / W + rnd() / 4) & 255; px[i + 1] = (y * 255 / H + rnd() / 4) & 255; px[i + 2] = ((p * 40 + rnd()) / 2) & 255;
		}
		obj(im, () => { push(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n`); push(px); push("\nendstream"); });
	}
	const xref = size;
	push(`xref\n0 ${n + 1}\n0000000000 65535 f \n${Array.from({ length: n }, (_, i) => `${String(offs[i + 1]).padStart(10, "0")} 00000 n \n`).join("")}`);
	push(`trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
	const out = new Uint8Array(size);
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}

if (!existsSync(join(DIST, "library.html")) || !existsSync(join(DIST, "pdf-worker.js"))) throw new Error(`build first: bun web/build.ts --target extension (${DIST})`);
// a link left by an earlier run: remove the link itself first, so the recursive delete below cannot follow it into the build
if (existsSync(join(WORK, "ext", "library"))) spawnSync("cmd", ["/c", "rmdir", join(WORK, "ext", "library")], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true });
for (const d of ["host", "shots", "ext"]) mkdirSync(join(WORK, d), { recursive: true });

// ---- fixture library: the demo library (its 3-page demo article) + an ~11 MB, 12-page PDF + an annotation already stored
const libDir = join(WORK, "library");
run(["bun", join(ROOT, "gpui-ui", "web", "demo-library.ts"), libDir], join(ROOT, "gpui-ui"));
const dbPath = join(libDir, "library.sqlite");
const bigFile = join(WORK, "Large fixture.pdf");
writeFileSync(bigFile, largePdf(12));
const fx = repo.openDb(dbPath);
const small = fx.query("SELECT i.key, i.parent_key, i.title FROM items i JOIN attachments a ON a.item_key = i.key WHERE a.content_type = 'application/pdf' LIMIT 1").get() as { key: string; parent_key: string; title: string };
const bigParent = (fx.query("SELECT key FROM items WHERE title = 'Deep learning'").get() as { key: string }).key;
const big = addFile(fx, { mode: "imported_file", path: bigFile, name: "Large fixture.pdf", contentType: "application/pdf", parentKey: bigParent, keepName: true } as never).data.key;
repo.upsertAnnotations(fx, small.key, [{ id: "STORED01", type: "highlight", color: "#5fb236", sortIndex: "00000|000200|00100", position: { pageIndex: 0, rects: [[72, 690, 320, 706]] }, text: "stored before the page opened", comment: "", pageLabel: "1", dateModified: new Date().toISOString() } as never]);
fx.close();
rmSync(bigFile);
const bigBytes = q<{ path: string }>("SELECT path FROM attachments WHERE item_key = ?", big)[0]!.path;
const smallBytes = q<{ path: string }>("SELECT path FROM attachments WHERE item_key = ?", small.key)[0]!.path;
function q<T>(sql: string, ...p: unknown[]): T[] {
	const db = repo.openDb(dbPath);
	try { return db.query(sql).all(...(p as never[])) as T[]; } finally { db.close(); }
}
const sizes = { small: Bun.file(smallBytes).size, large: Bun.file(bigBytes).size };
console.log(`fixture: small PDF ${(sizes.small / 1e3).toFixed(0)} kB (3 pages), large PDF ${(sizes.large / 1e6).toFixed(1)} MB (12 pages)`);

// ---- host, registration, the minimal extension
let hostExe = arg("host-exe");
if (!hostExe) {
	hostExe = join(WORK, "host", "zinc-e2e-host.exe");
	run(["bun", "build", "--compile", join(ROOT, "connector-host", "src", "main.ts"), "--outfile", hostExe], join(ROOT, "connector-host"));
}
const manifestPath = join(WORK, "host", `${HOST_NAME}.json`);
writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, description: "Zinc host (library PDF check, fixture library)", path: hostExe, type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], WORK);
const ext = join(WORK, "ext");
writeFileSync(join(ext, "manifest.json"), JSON.stringify({
	name: "Zinc library check", manifest_version: 3, version: "1.0", key: readFileSync(KEY_FILE, "utf8").trim(),
	permissions: ["nativeMessaging"], content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
}, null, 2));
run(["cmd", "/c", "mklink", "/J", join(ext, "library"), DIST], WORK);

const chrome = spawn(findChrome(), [
	"--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, "profile")}`,
	`--load-extension=${ext}`, `--disable-extensions-except=${ext}`, "--disk-cache-size=1048576", "--disable-gpu-shader-disk-cache",
	"--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader", "--window-size=1400,900", "about:blank",
], { stdio: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0" } });

try {
	let ver: { webSocketDebuggerUrl: string } | undefined;
	for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json() as typeof ver; } catch { await sleep(200); } }
	if (!ver) throw new Error("Chrome's DevTools endpoint did not come up");
	const ws = new WebSocket(ver.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let nextId = 1;
	const pending = new Map<number, (v: any) => void>();
	const listeners: ((m: any) => void)[] = [];
	ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else for (const l of listeners) l(m); };
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
	const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
	const { result: { sessionId: sid } } = await send("Target.attachToTarget", { targetId, flatten: true });
	const problems: string[] = [];
	listeners.push((m) => {
		if (m.sessionId !== sid) return;
		if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; problems.push(`exception: ${(d.exception?.description ?? d.text).slice(0, 300)}`); }
		if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`log: ${m.params.entry.text.slice(0, 300)}`);
		if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) problems.push(`console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300)}`);
	});
	for (const d of ["Runtime.enable", "Log.enable", "Page.enable"]) await send(d, {}, sid);
	const evalIn = async <T,>(expression: string): Promise<T> => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value as T;
	};
	const waitFor = async (expression: string, ms: number): Promise<boolean> => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { try { if (await evalIn<boolean>(expression)) return true; } catch { /* loading */ } }
		return false;
	};
	const shot = async (name: string) => {
		const s = await send("Page.captureScreenshot", { format: "png" }, sid);
		writeFileSync(join(WORK, "shots", `${name}.png`), Buffer.from(s.result.data, "base64"));
	};
	/** Open an attachment in the reader; ms until its first page is drawn (page clock). */
	const openTimed = (key: string, title: string, parent: string) => evalIn<number>(`new Promise((done) => {
		const st = znPdfStats, before = st.renders, t0 = performance.now();
		znLibrary.store.openAttachment(${JSON.stringify(key)}, ${JSON.stringify(title)}, ${JSON.stringify(parent)});
		const iv = setInterval(() => { if (st.renders > before) { clearInterval(iv); done(performance.now() - t0); } }, 4);
		setTimeout(() => { clearInterval(iv); done(-1); }, 60000);
	})`);
	const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
	const r1 = (n: number) => Math.round(n * 10) / 10;

	for (const mode of MODES) {
		const tag = `workers=${mode}`;
		await send("Page.navigate", { url: `chrome-extension://${EXT_ID}/library/library.html?host=${HOST_NAME}&pdfworkers=${mode}` }, sid);
		const listed = await waitFor("!!globalThis.znLibrary && znLibrary.store.pagesLoaded() > 0 && znLibrary.store.total() > 0", 60_000);
		check(`${tag}: the library list loads`, listed, "");
		await sleep(800);

		// a small PDF, then a large one
		const smallMs = await openTimed(small.key, small.title ?? "Demo review", small.parent_key);
		await sleep(1500);
		const fetchSmall = await evalIn<{ ms: number; bytes: number }>("znPdfStats.fetches.at(-1)");
		check(`${tag}: the small PDF opens in the tab`, smallMs > 0, `first page after ${Math.round(smallMs)} ms (bytes through the host: ${Math.round(fetchSmall?.ms ?? -1)} ms)`);
		if (mode === MODES.at(-1)) {
			// the annotation stored before the page opened is shown, then a new highlight goes back to the library
			const shown = await waitFor(`znLibrary.annotationIds(${JSON.stringify(small.key)}).then((ids) => ids.includes("STORED01"))`, 10_000);
			check("the document's stored annotations are shown", shown, JSON.stringify(await evalIn(`znLibrary.annotationIds(${JSON.stringify(small.key)})`)));
			const outbox0 = q<{ n: number }>("SELECT count(*) n FROM sync_outbox")[0]!.n;
			const id = await evalIn<string | null>(`znLibrary.highlight(${JSON.stringify(small.key)}, 0, 4)`);
			const saved = await waitFor(`znLibrary.requests.some((r) => r.method === "PUT" && r.path === "/api/attachments/${small.key}/annotations" && r.status === 200)`, 10_000);
			const fxDb = repo.openDb(dbPath);
			const anns = repo.getAnnotations(fxDb, small.key) as { id: string; type: string; text?: string }[];
			fxDb.close();
			const outbox1 = q<{ n: number }>("SELECT count(*) n FROM sync_outbox")[0]!.n;
			const mine = anns.find((a) => a.id === id);
			check("a highlight made in the tab is saved to the library (and the sync outbox)", !!id && saved && !!mine && outbox1 > outbox0, `${id}: "${mine?.text}", annotations now ${anns.map((a) => a.id).join(", ")}, outbox +${outbox1 - outbox0}`);
			await evalIn("znLibrary.setTheme('light')");
			await sleep(1500);
			await shot("1-pdf-highlight-light");
			await evalIn("znLibrary.setTheme('dark')");
			await sleep(1500);
			await shot("2-pdf-highlight-dark");
			await evalIn("znLibrary.setTheme('light')");
		}
		await evalIn(`znLibrary.store.closeTab(${JSON.stringify(small.key)})`);
		await sleep(500);

		const largeMs = await openTimed(big, "Large fixture.pdf", bigParent);
		const fetchLarge = await evalIn<{ ms: number; bytes: number }>("znPdfStats.fetches.at(-1)");
		check(`${tag}: the large PDF opens in the tab`, largeMs > 0, `first page after ${Math.round(largeMs)} ms (${((fetchLarge?.bytes ?? 0) / 1e6).toFixed(1)} MB through the host: ${Math.round(fetchLarge?.ms ?? -1)} ms)`);
		await sleep(2500);

		// scroll the large PDF with the mouse wheel and watch the frames
		await evalIn(`(() => { const m = globalThis.__mon = { frames: [], long: [], r0: znPdfStats.renders, ms0: znPdfStats.renderMs.length, lat0: znPdfStats.latencyMs.length };
			const f = (t) => { m.frames.push(t); if (!m.stop) requestAnimationFrame(f); }; requestAnimationFrame(f);
			try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.long.push(e.duration); }).observe({ type: "longtask" }); } catch {} })()`);
		for (let i = 0; i < 36; i++) {
			await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 700, y: 500, deltaX: 0, deltaY: 420 }, sid);
			await sleep(70);
		}
		await sleep(3000);
		const mon = await evalIn<{ frames: number[]; long: number[]; renders: number; renderMs: number[]; latency: number[] }>(`(() => { const m = __mon; m.stop = true;
			return { frames: m.frames, long: m.long, renders: znPdfStats.renders - m.r0, renderMs: znPdfStats.renderMs.slice(m.ms0), latency: znPdfStats.latencyMs.slice(m.lat0) }; })()`);
		const gaps = mon.frames.slice(1).map((t, i) => t - mon.frames[i]!);
		const m = {
			mode: await evalIn<string>("znPdfStats.mode"),
			smallOpenMs: Math.round(smallMs), largeOpenMs: Math.round(largeMs),
			smallFetchMs: Math.round(fetchSmall?.ms ?? -1), largeFetchMs: Math.round(fetchLarge?.ms ?? -1),
			scrollFrames: gaps.length, maxFrameGapMs: r1(Math.max(0, ...gaps)), framesOver50ms: gaps.filter((g) => g > 50).length,
			longTasks: mon.long.length, longTaskMs: Math.round(mon.long.reduce((a, b) => a + b, 0)),
			pagesRendered: mon.renders, avgRenderMs: r1(avg(mon.renderMs)), avgLatencyMs: r1(avg(mon.latency)), maxLatencyMs: r1(Math.max(0, ...mon.latency)),
		};
		measures[tag] = m;
		check(`${tag}: scrolling the large PDF renders more pages`, mon.renders > 0, JSON.stringify(m));
		if (mode === MODES.at(-1)) await shot("3-large-pdf-scrolled");
		await evalIn(`znLibrary.store.closeTab(${JSON.stringify(big)})`);
		await sleep(500);
	}

	const refused = (await evalIn<{ method: string; path: string; status: number | string }[]>("znLibrary.requests")).filter((r) => r.status !== 200 && r.status !== 206 && r.status !== "pending");
	check("no request failed except refused ones (403)", refused.every((r) => r.status === 403), JSON.stringify(refused.slice(0, 8)));
	const errs = problems.filter((p) => !/sync\/status|structure unavailable|reading view needs layout analysis|403/.test(p));
	check("no exceptions or errors in the page", errs.length === 0, errs.slice(0, 6).join(" | ") || "none");
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
writeFileSync(join(WORK, "results.json"), JSON.stringify({ sizes, measures, results }, null, 2));
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify(measures, null, 2));
console.log(`${results.length - bad}/${results.length} checks passed; screenshots in ${join(WORK, "shots")}`);
process.exit(bad ? 1 : 0);
