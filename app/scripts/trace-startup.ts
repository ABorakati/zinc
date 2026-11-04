// Start-up trace for the installed desktop app: `bun app/scripts/trace-startup.ts [options]`
//
// Launches the installed zotero-next (newest folder under %USERPROFILE%\ZoteroNext\versions, or --app <launcher.exe>)
// on a snapshot copy of the library, attaches to its WebView2 through the DevTools protocol, and records a timeline:
// main-process log lines, every page navigation / load (so repeated reloads show up), every HTTP request with its
// timing, console messages, and repeated requests. Writes trace.json + timeline.txt to --out and prints a summary.
//
//   --runs N          start the app N times (default 1); a summary line per run, timelines in out/run-<n>/
//   --seconds S       how long to watch each run after launch (default 20)
//   --db PATH         library to copy (default: data/library.sqlite). The original is only read (VACUUM INTO).
//   --profile fresh|copy   WebView2 profile: an empty one (default), or a copy of the app's real profile
//                     (open tabs, view settings) so start-up matches what you see
//   --sync            keep Zotero sync on (off by default so runs are comparable)
//   --scroll          also wheel-scroll the item list (slow, fast) and report frame pacing (fps, frame-gap percentiles)
//   --frames          filmstrip: a JPEG in run-<n>/frames/ each time the window's picture changes (first 8 s)
//   --out DIR         output folder (default: %TEMP%/zn-trace/<timestamp>)
//
// The app is single-instance: close zotero-next first. Nothing of the real library or the app's real profile is
// written; the Zotero connector port is disabled (ZN_ZPORT=0) and the core listens on a separate port.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const arg = (name: string, def?: string) => {
	const i = process.argv.indexOf("--" + name);
	return i > 0 ? process.argv[i + 1] : def;
};
const flag = (name: string) => process.argv.includes("--" + name);

const REPO = join(import.meta.dir, "..", "..");
const runs = Number(arg("runs", "1"));
const seconds = Number(arg("seconds", "20"));
const profileMode = arg("profile", "fresh");
const out = arg("out", join(tmpdir(), "zn-trace", new Date().toISOString().replace(/[:.]/g, "-")))!;
const frames = flag("frames"); // save a screenshot on every visible change during the first 8 s (frames/ in the run folder)
const framesUntil = 8000;
const PORT = 23150, DEVTOOLS = 9350;

function launcherPath(): string {
	const given = arg("app");
	if (given) return given;
	const root = join(process.env.USERPROFILE ?? "", "ZoteroNext", "versions");
	const vs = readdirSync(root).filter((d) => existsSync(join(root, d, "zotero-next", "bin", "launcher.exe"))).sort();
	if (!vs.length) throw new Error("no installed zotero-next under " + root);
	return join(root, vs.at(-1)!, "zotero-next", "bin", "launcher.exe");
}

async function ps(cmd: string): Promise<string> {
	const p = Bun.spawn(["pwsh", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
	return (await new Response(p.stdout).text()).trim();
}

// ---------------------------------------------------------------- setup

const launcher = launcherPath();
const running = await ps(`Get-Process launcher,zotero-next -ErrorAction SilentlyContinue | ? { $_.Path -like '*ZoteroNext*' } | % Id`);
if (running) {
	console.error(`zotero-next is running (pid ${running.split(/\s+/).join(", ")}). Close it first: the app allows one instance.`);
	process.exit(2);
}
mkdirSync(out, { recursive: true });
const work = join(out, "work");
mkdirSync(work, { recursive: true });
const dbCopy = join(work, "library.sqlite");
{
	const src = arg("db", join(REPO, "data", "library.sqlite"))!;
	const t = performance.now();
	const db = new Database(src, { readonly: true });
	db.run("VACUUM INTO ?", [dbCopy]);
	db.close();
	console.log(`library copy: ${(statSync(dbCopy).size / 1e6).toFixed(0)} MB in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
// zotero-next.config.json next to the library holds file/storage settings: copy it so attachments resolve the same way
const cfg = join(REPO, "data", "zotero-next.config.json");
if (existsSync(cfg)) cpSync(cfg, join(work, "zotero-next.config.json"));

function makeProfile(dir: string) {
	rmSync(dir, { recursive: true, force: true });
	if (profileMode === "copy") {
		// Electrobun keeps the main window's WebView2 profile in the app's user-data folder (partition "default",
		// which is what WEBVIEW2_USER_DATA_FOLDER replaces); copy it without the caches
		const real = join(process.env.LOCALAPPDATA ?? "", "dev.zotero-next.app", "stable", "WebView2", "Partitions", "default");
		if (existsSync(real))
			cpSync(real, dir, { recursive: true, filter: (p) => !/\\(Cache|Code Cache|GPUCache|DawnCache|GrShaderCache|ShaderCache|Crashpad)(\\|$)/i.test(p) });
		else console.warn("no real WebView2 profile at " + real + "; using a fresh one");
	}
	mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------- one run

interface Ev { t: number; kind: string; text: string; data?: unknown }

async function traceRun(n: number) {
	const dir = join(out, `run-${n}`);
	mkdirSync(dir, { recursive: true });
	const profile = join(work, `webview2-${n}`);
	makeProfile(profile);
	const events: Ev[] = [];
	const t0 = performance.now();
	const at = () => Math.round(performance.now() - t0);
	const ev = (kind: string, text: string, data?: unknown) => events.push({ t: at(), kind, text, data });

	const env = {
		...process.env,
		ZN_DB: dbCopy, ZN_PORT: String(PORT), ZN_ZPORT: "0",
		...(flag("sync") ? {} : { ZN_SYNC: "0" }),
		WEBVIEW2_USER_DATA_FOLDER: profile,
		WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS}`,
	};
	const app = Bun.spawn([launcher], { env, cwd: join(launcher, ".."), stdout: "pipe", stderr: "pipe" });
	ev("main", "launcher started");
	const pump = async (s: ReadableStream<Uint8Array>, kind: string) => {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of s) {
			buf += dec.decode(chunk);
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (line && !line.startsWith("[electrobun:process]")) ev(kind, line);
			}
		}
	};
	void pump(app.stdout, "main");
	void pump(app.stderr, "main-err");

	// core up?
	const coreUp = (async () => {
		for (;;) {
			try {
				const r = await fetch(`http://127.0.0.1:${PORT}/api/collections`, { signal: AbortSignal.timeout(500) });
				if (r.ok) return ev("core", "core answers HTTP");
			} catch {}
			if (at() > seconds * 1000) return;
			await Bun.sleep(50);
		}
	})();

	// attach to the page as soon as the DevTools endpoint exists
	let ws: WebSocket | undefined;
	let msgId = 0;
	const send = (method: string, params: object = {}) => ws?.send(JSON.stringify({ id: ++msgId, method, params }));
	const reqs = new Map<string, { url: string; start: number; method: string; type?: string }>();
	const done: { url: string; method: string; start: number; end: number; status?: number; bytes?: number; type?: string; fromCache?: boolean }[] = [];
	const status = new Map<string, number>();
	for (;;) {
		try {
			const list = (await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json`, { signal: AbortSignal.timeout(300) })).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
			const page = list.find((x) => x.type === "page");
			if (page) {
				ev("devtools", "page target " + page.url);
				ws = new WebSocket(page.webSocketDebuggerUrl);
				await new Promise((r, j) => { ws!.onopen = r; ws!.onerror = j; });
				break;
			}
		} catch {}
		if (at() > seconds * 1000) break;
		await Bun.sleep(30);
	}
	if (ws) {
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data));
			const p = m.params;
			switch (m.method) {
				case "Page.frameNavigated":
					if (!p.frame.parentId) ev("page", "navigated " + p.frame.url);
					else ev("frame", "iframe " + p.frame.url);
					break;
				case "Page.screencastFrame": {
					// one frame per visible change: a filmstrip of what the window showed
					send("Page.screencastFrameAck", { sessionId: p.sessionId });
					if (at() > framesUntil) break;
					const name = `${String(at()).padStart(6, "0")}.jpg`;
					writeFileSync(join(dir, "frames", name), Buffer.from(p.data, "base64"));
					ev("frame", "screen changed -> frames/" + name);
					break;
				}
				case "Page.domContentEventFired": ev("page", "DOMContentLoaded"); break;
				case "Page.loadEventFired": ev("page", "load"); break;
				case "Runtime.consoleAPICalled":
					ev("console", `${p.type}: ` + p.args.map((a: any) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300));
					break;
				case "Runtime.exceptionThrown": ev("error", p.exceptionDetails.exception?.description?.slice(0, 300) ?? p.exceptionDetails.text); break;
				case "Network.requestWillBeSent":
					reqs.set(p.requestId, { url: p.request.url, start: at(), method: p.request.method, type: p.type });
					break;
				case "Network.responseReceived": status.set(p.requestId, p.response.status); break;
				case "Network.loadingFinished":
				case "Network.loadingFailed": {
					const r = reqs.get(p.requestId);
					if (!r) break;
					reqs.delete(p.requestId);
					done.push({ ...r, end: at(), status: m.method === "Network.loadingFailed" ? -1 : status.get(p.requestId), bytes: p.encodedDataLength });
					break;
				}
			}
		};
		send("Page.enable");
		send("Network.enable");
		send("Runtime.enable");
		if (frames) {
			mkdirSync(join(dir, "frames"), { recursive: true });
			send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 900, everyNthFrame: 1 });
		}
	}
	await Bun.sleep(Math.max(0, seconds * 1000 - at()));
	await coreUp;

	// the app's processes: the WebView2 processes carry this run's profile folder on their command line, plus the installed bun
	const procs = `(Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -or ($_.Name -eq 'bun.exe' -and $_.ExecutablePath -like '*ZoteroNext*') })`;
	// memory at <seconds> s, library window only (same moment as the GPUI app's aot-bench sample)
	{
		const m = JSON.parse(await ps(`$r = ${procs} | % { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | ? { $_ }; @{ n = @($r).Count; priv = [math]::Round((($r | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB); ws = [math]::Round((($r | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } | ConvertTo-Json -Compress`) || "{}");
		ev("memory", `memory: ${m.priv} MB private, ${m.ws} MB working set (${m.n} processes)`, m);
	}
	// --scroll: wheel-scroll the item list through the DevTools input API (no OS mouse) at the GPUI scroll-bench's paces
	// (one wheel step every 16 ms for 3 s: slow 24 px, fast 100 px per step) and time the page's frames with requestAnimationFrame
	const eval_ = (expression: string) => new Promise<any>((r) => {
		const id = ++msgId;
		const prev = ws!.onmessage!;
		ws!.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === id) { ws!.onmessage = prev; r(m.result?.result?.value); } else (prev as any)(e); };
		ws!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
		setTimeout(() => r(undefined), 8000);
	});
	if (ws && flag("scroll")) {
		const box = await eval_(`(() => { let best = null; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (!/(auto|scroll)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 50) continue; if (!best || el.scrollHeight > best.scrollHeight) best = el; } if (!best) return null; window.__znScroller = best; const r = best.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: best.scrollHeight }; })()`);
		if (box) for (const [name, dy] of [["slow", 24], ["fast", 100]] as const) {
			await eval_(`(() => { window.__znScroller.scrollTop = 0; window.__znGaps = []; let last = performance.now(); const tick = (t) => { window.__znGaps.push(t - last); last = t; if (!window.__znStop) requestAnimationFrame(tick); }; window.__znStop = false; requestAnimationFrame(tick); return 1; })()`);
			const t = performance.now();
			let steps = 0;
			while (performance.now() - t < 3000) {
				ws.send(JSON.stringify({ id: ++msgId, method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: dy } }));
				steps++;
				await Bun.sleep(16);
			}
			const r = await eval_(`(() => { window.__znStop = true; const g = window.__znGaps.slice(2); const s = [...g].sort((a, b) => a - b); const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; return { frames: g.length, fps: Math.round(g.length / (g.reduce((a, b) => a + b, 0) / 1000)), gapP50: q(0.5), gapP95: q(0.95), gapP99: q(0.99), slow25: g.filter((x) => x > 25).length, slow40: g.filter((x) => x > 40).length, scrolledPx: Math.round(window.__znScroller.scrollTop) }; })()`);
			ev("scroll", `scroll ${name}: ${JSON.stringify(r)} (${steps} wheel steps)`, { name, ...r });
		}
		else ev("scroll", "scroll: no scrollable list found");
	}

	// idle cost: CPU seconds used by the app's processes (bun + its web views) over 3 s with nothing happening
	{
		const cpu = `(Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -or ($_.Name -eq 'bun.exe' -and $_.ExecutablePath -like '*ZoteroNext*') } | % { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum`;
		const a = Number(await ps(cpu));
		await Bun.sleep(3000);
		const b = Number(await ps(cpu));
		ev("idle", `CPU while idle: ${(((b - a) / 3) * 100).toFixed(1)}% of one core over 3 s`, { cpuSeconds: b - a });
	}
	// navigation timing of the page as it is now (covers the first load, which can start before we attach)
	if (ws) {
		send("Runtime.evaluate", {
			returnByValue: true,
			expression: `JSON.stringify({ nav: performance.getEntriesByType("navigation").map(e => ({ type: e.type, dcl: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd) })), fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1), items: document.querySelectorAll("[data-item],[role=row]").length, animations: document.getAnimations().filter(a => a.playState === "running").map(a => (a.animationName || a.transitionProperty || a.constructor.name) + " on " + ((t => t ? t.tagName.toLowerCase() + (t.getAttribute("class") ? "." + String(t.getAttribute("class")).trim().split(/\\s+/).slice(0, 4).join(".") : "") + (t.closest("[aria-label],[title]") ? " in [" + (t.closest("[aria-label],[title]").getAttribute("aria-label") || t.closest("[aria-label],[title]").getAttribute("title")) + "]" : "") : "?")(a.effect && a.effect.target))).slice(0, 15) })`,
		});
		const val = await new Promise<string>((r) => {
			const prev = ws!.onmessage!;
			ws!.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === msgId) r(m.result?.result?.value ?? "{}"); else (prev as any)(e); };
			setTimeout(() => r("{}"), 3000);
		});
		ev("page", "page timing " + val, JSON.parse(val));
		ws.close();
	}
	app.kill();
	// the launcher's bun child and the web views outlive it: stop what this run started (its own profile folder / port)
	await ps(`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -or ($_.Name -eq 'bun.exe' -and $_.ExecutablePath -like '*ZoteroNext*') } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);

	// ---------------------------------------------------------------- report
	const api = done.filter((r) => r.url.includes("/api/"));
	for (const r of done) {
		const what = `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")} ${r.status}`;
		events.push({ t: r.start, kind: "net", text: `${what} ${r.end - r.start} ms${r.bytes ? " " + (r.bytes / 1024).toFixed(0) + " KB" : ""}`, data: r });
		if (r.end - r.start >= 100) events.push({ t: r.end, kind: "net-end", text: what });
	}
	events.sort((a, b) => a.t - b.t);
	const counts = new Map<string, number>();
	for (const r of api) {
		const k = r.method + " " + r.url.replace(/^https?:\/\/[^/]+/, "");
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const repeated = [...counts].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
	const first = (pred: (e: Ev) => boolean) => events.find(pred)?.t ?? -1;
	const navs = events.filter((e) => e.kind === "page" && e.text.startsWith("navigated"));
	const summary = {
		run: n,
		coreUpMs: first((e) => e.kind === "core"),
		pageTargetMs: first((e) => e.kind === "devtools"),
		navigationsSeen: navs.length,
		reloads: Math.max(0, navs.length - 1),
		firstItemsResponseMs: (() => { const r = api.filter((x) => /\/api\/items\b/.test(x.url)).sort((a, b) => a.end - b.end)[0]; return r ? r.end : -1; })(),
		apiRequests: api.length,
		memory: events.find((e) => e.kind === "memory")?.data,
		scroll: events.filter((e) => e.kind === "scroll").map((e) => e.data),
		idleCpu: events.find((e) => e.kind === "idle")?.text,
		repeated: repeated.slice(0, 12).map(([k, c]) => `${c}x ${k}`),
		slowest: [...api].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 8).map((r) => `${r.end - r.start} ms ${r.url.replace(/^https?:\/\/[^/]+/, "")}`),
		errors: events.filter((e) => e.kind === "error" || e.kind === "main-err").map((e) => e.text).slice(0, 10),
	};
	writeFileSync(join(dir, "trace.json"), JSON.stringify({ summary, events }, null, 1));
	writeFileSync(join(dir, "timeline.txt"), events.map((e) => `${String(e.t).padStart(6)} ms  ${e.kind.padEnd(8)} ${e.text}`).join("\n") + "\n");
	return summary;
}

const all = [];
for (let n = 1; n <= runs; n++) {
	const s = await traceRun(n);
	all.push(s);
	console.log(JSON.stringify(s, null, 2));
}
writeFileSync(join(out, "summary.json"), JSON.stringify(all, null, 2));
rmSync(work, { recursive: true, force: true });
console.log("trace written to " + out);
