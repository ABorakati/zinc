// The sign-in helper process (see protocol.ts for why it is a process of its own). It owns WebView2 windows on its own profile,
// watches them through the DevTools protocol, and answers the app over Bun IPC. Started as
//   <...>\zotero-next-signin.exe <this file>          (unpackaged: the hard link is a copy of bun.exe)
//   <...>\zotero-next-signin.exe --signin-helper      (packaged: the hard link is the app's exe, main.tsx -> entry.ts runs this)
//
// Windows: the first one is created at start and never shown (the process is started with its window hidden, and the first
// ShowWindow call of a process obeys that): it keeps the browser, and with it the session cookies, alive when the user closes a sign-in
// window, and serves hidden page loads. Sign-in windows are ordinary framed top-level windows, created when needed and reused.
//
// Trust: navigation URLs and cookies come from the browser through the DevTools protocol, never from the page. The sign-in bar is drawn
// in an isolated world (overlay.ts). Nothing is read from form fields. No URL with a query is logged.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Cdp, type CdpEvent } from "./cdp";
import { OVERLAY_BINDING, OVERLAY_SOURCE, OVERLAY_WORLD } from "./overlay";
import { signinProfileDir } from "./paths";
import type { BannerAction, BannerView, HelperEvent, HelperOp, HelperOps, RawCookie } from "./protocol";
import { hideTopLevel, isWindow, pump, showTopLevel } from "../webview/win32";

type H = number | bigint;
type WebviewLike = { unsafeWindowHandle: H | null; title: string; navigate(url: string): void; destroy(): void };

interface Win {
	wv: WebviewLike;
	hwnd: H;
	kind: "keeper" | "login";
	targetId: string;
	sessionId: string;
	/** the app's id for this window while it is in use, else null (idle) */
	id: string | null;
	topFrame: string;
	ctxs: Set<number>;
	banner: BannerView | null;
	url: string;
	gone: boolean;
}

const wins: Win[] = [];
let cdp: Cdp;
let Webview: new (debug: boolean, size?: { width: number; height: number; hint: number }) => WebviewLike;
let downloadDir: string | null = null;

const send = (m: HelperEvent | { rid: number; ok: boolean; value?: unknown; error?: string }): void => {
	try {
		process.send?.(m);
	} catch {
		/* the app is gone: the disconnect handler ends this process */
	}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- windows

async function waitForDevtools(): Promise<Cdp> {
	const file = join(signinProfileDir(), "DevToolsActivePort");
	for (let i = 0; i < 150; i++) {
		if (existsSync(file)) {
			// the file may be left over from a browser that is gone (then nothing answers on its port until the new one rewrites it),
			// or belong to the browser of another sign-in helper on this profile (then this helper shares that browser)
			try {
				const port = Number(readFileSync(file, "utf8").split("\n")[0]);
				if (port > 0) {
					const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).json()) as { webSocketDebuggerUrl?: string };
					if (v.webSocketDebuggerUrl) return await Cdp.connect(v.webSocketDebuggerUrl);
				}
			} catch {
				/* try again */
			}
		}
		await sleep(100);
	}
	throw new Error("the browser's DevTools endpoint did not appear");
}

async function pageTargets(): Promise<string[]> {
	const r = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
	return r.targetInfos.filter((t) => t.type === "page").map((t) => t.targetId);
}

async function createWindow(kind: Win["kind"]): Promise<Win> {
	const before = cdp ? new Set(await pageTargets()) : new Set<string>();
	const wv = new Webview(false, { width: 1000, height: 760, hint: 0 });
	const hwnd = wv.unsafeWindowHandle;
	if (hwnd == null) throw new Error("the web view created no window");
	if (!cdp) cdp = await waitForDevtools();
	let targetId = "";
	for (let i = 0; i < 100 && !targetId; i++) {
		targetId = (await pageTargets()).find((t) => !before.has(t)) ?? "";
		if (!targetId) await sleep(50);
	}
	if (!targetId) throw new Error("the new window has no page");
	const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
	const w: Win = { wv, hwnd, kind, targetId, sessionId, id: null, topFrame: "", ctxs: new Set(), banner: null, url: "", gone: false };
	wins.push(w);
	const s = (m: string, p: Record<string, unknown> = {}) => cdp.send(m, p, sessionId);
	await s("Page.enable");
	await s("Runtime.enable");
	await s("Runtime.addBinding", { name: OVERLAY_BINDING, executionContextName: OVERLAY_WORLD });
	await s("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY_SOURCE, worldName: OVERLAY_WORLD, runImmediately: true });
	try {
		const tree = await s("Page.getFrameTree");
		w.topFrame = tree.frameTree?.frame?.id ?? "";
	} catch {
		/* learned from the first navigation */
	}
	return w;
}

function render(w: Win): void {
	const expr = `globalThis.__znRender&&globalThis.__znRender(${JSON.stringify(w.banner)})`;
	for (const contextId of w.ctxs) cdp.send("Runtime.evaluate", { expression: expr, contextId }, w.sessionId).catch(() => {});
}

function byId(id: string): Win {
	const w = wins.find((x) => x.id === id && !x.gone);
	if (!w) throw new Error("no such window");
	return w;
}

async function setDownloads(dir: string | null): Promise<void> {
	downloadDir = dir;
	if (dir) mkdirSync(dir, { recursive: true });
	await cdp.send("Browser.setDownloadBehavior", dir ? { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true } : { behavior: "deny", eventsEnabled: true });
}

const downloads = new Map<string, { url: string; filename?: string }>();

function onEvent(e: CdpEvent): void {
	const w = e.sessionId ? wins.find((x) => x.sessionId === e.sessionId) : undefined;
	const p = e.params ?? {};
	switch (e.method) {
		case "Page.frameNavigated": {
			if (!w || p.frame?.parentId) return;
			w.topFrame = p.frame.id;
			w.url = String(p.frame.url ?? "");
			if (w.id) send({ ev: "nav", id: w.id, url: w.url, ...(p.frame.mimeType ? { mime: String(p.frame.mimeType) } : {}) });
			return;
		}
		case "Page.navigatedWithinDocument":
			if (w?.id && p.frameId === w.topFrame) {
				w.url = String(p.url ?? "");
				send({ ev: "nav", id: w.id, url: w.url });
			}
			return;
		case "Page.loadEventFired":
			if (w?.id) send({ ev: "loaded", id: w.id });
			return;
		case "Runtime.executionContextCreated":
			if (w && p.context?.name === OVERLAY_WORLD) w.ctxs.add(p.context.id);
			return;
		case "Runtime.executionContextDestroyed":
			w?.ctxs.delete(p.executionContextId);
			return;
		case "Runtime.executionContextsCleared":
			w?.ctxs.clear();
			return;
		case "Runtime.bindingCalled": {
			if (!w || p.name !== OVERLAY_BINDING) return;
			let a = "";
			try {
				a = String(JSON.parse(String(p.payload)).a);
			} catch {
				return;
			}
			if (a === "ready") render(w);
			else if (w.id && (a === "skip" || a === "handoff" || a === "keep_waiting")) send({ ev: "action", id: w.id, a: a as BannerAction });
			return;
		}
		case "Browser.downloadWillBegin":
			downloads.set(String(p.guid), { url: String(p.url ?? ""), filename: typeof p.suggestedFilename === "string" ? p.suggestedFilename : undefined });
			send({ ev: "download-begin" });
			return;
		case "Browser.downloadProgress": {
			if (p.state === "canceled") {
				downloads.delete(String(p.guid));
				send({ ev: "download-end" });
				return;
			}
			if (p.state !== "completed" || !downloadDir) return;
			const d = downloads.get(String(p.guid));
			downloads.delete(String(p.guid));
			send({ ev: "download", path: join(downloadDir, String(p.guid)), url: d?.url ?? "", ...(d?.filename ? { filename: d.filename } : {}) });
			return;
		}
		case "Target.targetInfoChanged": {
			// a link that opens a new window: the sign-in goes on in the same window
			const t = p.targetInfo;
			if (!t || t.type !== "page" || wins.some((x) => x.targetId === t.targetId) || !t.openerId || !/^https?:/i.test(String(t.url))) return;
			const opener = wins.find((x) => x.targetId === t.openerId && x.id);
			if (!opener) return;
			cdp.send("Page.navigate", { url: t.url }, opener.sessionId).catch(() => {});
			cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
			return;
		}
	}
}

// ---------------------------------------------------------------- ops

const HTML_JS = (max: number) =>
	"(()=>{try{var c=document.documentElement.cloneNode(true);" +
	"c.querySelectorAll('input,textarea').forEach(function(i){i.removeAttribute('value')});" +
	`return c.outerHTML.slice(0,${Math.max(0, Math.trunc(max))})}catch(e){return ''}})()`;

const ops: { [K in HelperOp]: (a: HelperOps[K]["args"]) => Promise<HelperOps[K]["result"]> } = {
	async open(a) {
		// ZN_SIGNIN_HEADLESS=1 (tests): the sign-in runs in the hidden first window, so no window ever appears
		const want = a.visible && process.env.ZN_SIGNIN_HEADLESS !== "1" ? "login" : "keeper";
		let w = wins.find((x) => !x.gone && !x.id && x.kind === want);
		if (!w) w = await createWindow(want);
		w.id = a.id;
		w.banner = null;
		w.url = "";
		w.wv.title = a.title;
		await cdp.send("Page.navigate", { url: a.url }, w.sessionId);
		if (want === "login") showTopLevel(w.hwnd);
		return null;
	},
	async navigate(a) {
		const w = byId(a.id);
		w.url = "";
		await cdp.send("Page.navigate", { url: a.url }, w.sessionId);
		return null;
	},
	async html(a) {
		const w = byId(a.id);
		const r = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: HTML_JS(a.max), returnByValue: true }, w.sessionId, 4000);
		return typeof r.result?.value === "string" ? r.result.value : "";
	},
	async title(a) {
		byId(a.id).wv.title = a.text;
		return null;
	},
	async banner(a) {
		const w = byId(a.id);
		w.banner = a.state;
		render(w);
		return null;
	},
	async release(a) {
		const w = wins.find((x) => x.id === a.id && !x.gone);
		if (!w) return null;
		w.id = null;
		w.banner = null;
		w.url = "";
		if (w.kind === "login") hideTopLevel(w.hwnd);
		await cdp.send("Page.navigate", { url: "about:blank" }, w.sessionId).catch(() => {});
		return null;
	},
	async cookies() {
		try {
			return (await cdp.send<{ cookies: RawCookie[] }>("Storage.getCookies")).cookies;
		} catch {
			const w = wins.find((x) => !x.gone);
			if (!w) return [];
			return (await cdp.send<{ cookies: RawCookie[] }>("Network.getAllCookies", {}, w.sessionId)).cookies;
		}
	},
	async setCookies(a) {
		const cookies = a.cookies.map((c) => ({
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: c.path,
			secure: c.secure,
			httpOnly: c.httpOnly,
			...(c.expires !== undefined && c.expires > 0 && !c.session ? { expires: c.expires } : {}),
			...(c.sameSite ? { sameSite: c.sameSite } : {}),
		}));
		await cdp.send("Storage.setCookies", { cookies });
		return cookies.length;
	},
	async downloads(a) {
		await setDownloads(a.dir);
		return null;
	},
	async quit() {
		setTimeout(shutdown, 20);
		return null;
	},
};

// ---------------------------------------------------------------- loop

function tick(): void {
	pump();
	for (const w of [...wins]) {
		if (w.gone || isWindow(w.hwnd)) continue;
		w.gone = true;
		wins.splice(wins.indexOf(w), 1);
		cdp?.send("Target.detachFromTarget", { sessionId: w.sessionId }).catch(() => {});
		if (w.id) send({ ev: "closed", id: w.id });
	}
}

let ending = false;
function shutdown(): void {
	if (ending) return;
	ending = true;
	for (const w of wins.splice(0)) {
		try {
			w.wv.destroy();
		} catch {
			/* already gone */
		}
	}
	for (let i = 0; i < 5; i++) pump();
	// let the browser flush its cookie store before this process ends
	setTimeout(() => process.exit(0), 700);
}

/** Old files in the downloads folder (a previous run was killed mid-capture). */
function sweepDownloads(dir: string): void {
	try {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (Date.now() - statSync(p).mtimeMs > 3600_000) rmSync(p, { force: true, recursive: true });
		}
	} catch {
		/* none */
	}
}

export async function main(): Promise<void> {
	// the browser's DevTools endpoint (loopback, a port the browser chooses, announced in the profile's DevToolsActivePort file)
	// (--remote-allow-origins is left unset: the browser then refuses DevTools WebSocket connections that carry a web page's Origin.
	// Other local accounts can still reach the port; the browser therefore runs only for IDLE_MS after its last use, see bridge.ts.)
	process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=0";
	({ Webview } = (await import("webview-bun" as string)) as unknown as { Webview: typeof Webview });
	process.on("disconnect", shutdown);
	process.on("message", (m: { rid: number; op: HelperOp; args?: unknown }) => {
		const fn = ops[m?.op] as ((a: unknown) => Promise<unknown>) | undefined;
		if (typeof m?.rid !== "number" || !fn) return;
		fn(m.args ?? {}).then(
			(value) => send({ rid: m.rid, ok: true, value }),
			(e) => send({ rid: m.rid, ok: false, error: e instanceof Error ? e.message : String(e) }),
		);
	});
	setInterval(tick, 10);
	await createWindow("keeper");
	cdp.onEvent(onEvent);
	cdp.onClose(shutdown);
	await cdp.send("Target.setDiscoverTargets", { discover: true });
	if (process.env.ZN_SIGNIN_DOWNLOADS) sweepDownloads(process.env.ZN_SIGNIN_DOWNLOADS);
	await setDownloads(null);
	send({ ev: "ready" });
}

// run when started as the helper script (unpackaged); the packaged exe calls main() from entry.ts
if (import.meta.main) void main();
