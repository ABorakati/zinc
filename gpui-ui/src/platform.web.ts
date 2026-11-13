// The browser's part of the start-up (src/start.tsx has the rest). web/build.ts uses this file in place of src/platform.ts (the
// `X.web.ts` rule) for both browser targets: the extension's library page and the web page. GPUI is compiled to WebAssembly; the
// page has no disk, no core process and no font files.
//
// The data path is chosen when the page loads:
//   extension page                 the native host: every /api request goes over Chrome native messaging to the connector's host,
//                                  which answers with the core's handleApi against the desktop library (web/native-host.ts)
//   extension page, ?mode=browser  the browser library: the same frames over an extension port named "zinc-db" to an offscreen document
//                                  that owns a SQLite database on OPFS (web/browser-db, CONTRACT.md)
//   web page                       the page's own library: startPageLibrary() (web/browser-db/page-library.ts) runs it in a worker the
//                                  page starts, SQLite on OPFS
//   web page, ?demo                the demo library, in memory: SQLite WebAssembly and the core's handleApi in the tab (the online
//                                  "try it" page; library.sqlite, icons.json and the rest sit next to the bundle)
// Other query parameters: ?theme=light|dark, ?host=<name> (a registration of the native host other than the installed one; tests),
// ?select=<item key> (extension: show that item), ?open=<attachment key|demo> and ?view=reading (demo), ?pdfworkers=N (src/reader/pdf.web.ts).
import { seedFile } from "../web/shims/fs";
import { nativeApiTransport, resolveHostName, type NativePort } from "../web/native-host";
import type { MoveProbe } from "../web/extension-ui";
import { createComponent } from "solid-js";
import { setDirect } from "./api";
import { setThemePrefs } from "./shell/appearance";
import { setBrowserLibrary } from "./shell/libraryMode";
import { fontFamilyNames } from "./theme";
import type { Platform } from "./start";

declare const chrome: {
	runtime: {
		id?: string;
		connectNative(name: string): NativePort;
		connect(info: { name: string }): NativePort;
		getManifest(): { zinc_test?: boolean };
		sendMessage(msg: unknown, cb: (reply: { ok?: boolean; error?: string } | undefined) => void): void;
		lastError?: { message?: string };
		onMessage: { addListener(f: (msg: unknown) => void): void };
	};
} | undefined;

/** Defined by web/build.ts: true in the extension target. A branch on it drops the other target's code from the bundle. */
declare const __ZN_EXTENSION__: boolean;

type Source = "host" | "browser" | "page" | "demo";
const params = new URLSearchParams(location.search);
const inExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
const source: Source = inExtension ? (params.get("mode") === "browser" ? "browser" : "host") : params.has("demo") ? "demo" : "page";
const here = (f: string) => new URL(f, import.meta.url).href;

/** Called for every notice that the browser library changed under this page (set by afterFeatures, once the store exists). */
let onLibraryChanged: (m: { dataVersion?: number }) => void = () => {};
/** The last requests and their status, for automated checks (window.znLibrary.requests). */
const requests: { method: string; path: string; status: number | string }[] = [];
let hostName = "";
/** Demo only: the stored attachments' paths (<key>/<file>), and the core's handler, for the checks' probe. */
let demoStored: string[] = [];
let demoHandle: ((req: Request) => Promise<Response | null>) | undefined;
/** The probe onStore builds (not for the demo): afterFeatures fills in what only exists once the features are in. */
let probeOf: { notices: { at: number; dataVersion?: number }[]; outsideChanges: number; hasExportSetting: boolean; move: MoveProbe } | undefined;

/** Ask the extension's service worker for the database owner (it creates the offscreen document if there is none): {zincEnsureDb: true}. */
const ensureDb = () => new Promise<void>((resolve, reject) => {
	chrome!.runtime.sendMessage({ zincEnsureDb: true }, (r) => {
		if (r?.ok) resolve();
		else reject(new Error(r?.error ?? chrome!.runtime.lastError?.message ?? "the extension did not start the library database"));
	});
});

/** The data path of the chosen source: each Request to its answer. */
async function openTransport(): Promise<(req: Request) => Promise<Response>> {
	if (source === "host") return nativeApiTransport(() => chrome!.runtime.connectNative(hostName), () => chrome!.runtime.lastError?.message);
	if (source === "browser") {
		await ensureDb();
		const port = nativeApiTransport(() => chrome!.runtime.connect({ name: "zinc-db" }), () => chrome!.runtime.lastError?.message, { onNotice: (m) => onLibraryChanged(m), peer: "The browser library" });
		// the offscreen document can be closed by the browser: ask for it again (the service worker recreates it) and retry once
		return async (req) => {
			const again = req.clone();
			try { return await port(req); } catch { await ensureDb(); return port(again); }
		};
	}
	// the web page's own library, or the demo (web/page-source.ts: not in the extension build, which has no such page)
	if (!__ZN_EXTENSION__) {
		const s = await import("../web/page-source").then((m) => m.openPageSource(source === "demo" ? "demo" : "page"));
		if (s.onChanged) s.onChanged(() => onLibraryChanged({}));
		if (s.demo) { demoStored = s.demo.stored; demoHandle = s.demo.handle; }
		return s.transport;
	}
	throw new Error("the extension's library page has no data path without the extension");
}

export const platform: Platform = {
	title: source === "demo" ? "Zinc demo" : source === "page" ? "Zinc" : "Zinc library",
	// the outer div sets the family text inherits where the app sets none (GPUI's own default in the browser is a monospace font)
	frame: { width: "100%", height: "100%", fontFamily: "IBM Plex Sans" },
	init() {},

	prepare() {
		setBrowserLibrary(source === "browser" || source === "page"); // settings read it (src/shell/libraryMode.ts): this library has no desktop Zotero folder
		// GPUI's browser build cannot take font files (no registerFont); it has IBM Plex Sans built in, one of the app's own sans choices
		fontFamilyNames.sans = fontFamilyNames.title = "IBM Plex Sans";
		// light or dark from the page that embeds this one (?theme=, then postMessage({ theme }) when the site's theme changes)
		const theme = params.get("theme");
		if (theme === "light" || theme === "dark") setThemePrefs({ mode: theme });
		// the interface font through the app's own setting (Settings > Appearance): IBM Plex Sans, the one GPUI's browser build has
		setThemePrefs({ font: "plex" });
		if (!inExtension) addEventListener("message", (e) => { const t = (e.data as { theme?: string } | null)?.theme; if (t === "light" || t === "dark") setThemePrefs({ mode: t }); });
	},
	prefetch: () => false,
	registerFonts() {},

	async connect(ctx) {
		// the Lucide icons the app reads from disk on the desktop (src/icons.tsx), before any app module asks for them
		const icons = (await fetch(here("icons.json")).then((r) => r.json())) as Record<string, string>;
		for (const [name, svg] of Object.entries(icons)) seedFile(`/icons/${name}.svg`, svg, true);
		// the data path: each Request as an `api` frame to the host, or to the library in this browser. ?host=<name> picks another
		// registration of the same host (tests register one under their own name, so they never reach the installed host or its library).
		if (inExtension) hostName = resolveHostName(location.search, chrome!.runtime.getManifest().zinc_test === true);
		let transport: (req: Request) => Promise<Response>;
		try {
			transport = await openTransport();
		} catch (e) {
			// the page's own library could not start (another tab has it, no OPFS): its message in the app's look, in place of the app
			if (!__ZN_EXTENSION__ && source === "page") {
				const message = e instanceof Error ? e.message : String(e);
				const { PageError } = await import("../web/page-error");
				ctx.setOverlay(() => createComponent(PageError, { message, mode: ctx.mode }));
			}
			throw e;
		}
		setDirect(async (req) => {
			const entry: (typeof requests)[number] = { method: req.method, path: new URL(req.url).pathname + new URL(req.url).search, status: "pending" };
			requests.push(entry);
			if (requests.length > 200) requests.shift();
			try {
				const res = await transport(req);
				entry.status = res.status;
				return res;
			} catch (e) {
				entry.status = String(e instanceof Error ? e.message : e);
				throw e;
			}
		});
		// EPUBs and web snapshots: Zotero's reader (reader/index.html, copied by web/build.ts) in a new browser tab of this extension. It
		// reaches the same host by name (reader/zn-bridge.js); PDFs keep opening in the GPUI reader below.
		if (inExtension) {
			const { setWebTabOpener } = await import("./webview/config");
			setWebTabOpener((key) => {
				const url = new URL("reader/index.html", location.href);
				url.searchParams.set("attachment", key);
				url.searchParams.set("host", hostName);
				const tabs = (globalThis as { chrome?: { tabs?: { create(o: { url: string }): unknown } } }).chrome?.tabs;
				if (tabs?.create) tabs.create({ url: url.href });
				else window.open(url.href, "_blank");
			});
		}
		// PDFs: the reader fetches the bytes through the same path (the host sends them in chunks under 1 MB); PDFium and its render workers
		// (src/reader/pdf.web.ts) load on the first one. Each fetch is timed for the headless check (globalThis.znPdfStats.fetches).
		const { setFileFetcher } = await import("./reader/library");
		const { initPdfium, pdfStats } = await import("./reader/pdf.web");
		const { apiFetch } = await import("./api");
		const fetches: { key: string; bytes: number; ms: number }[] = [];
		Object.assign(pdfStats, { fetches });
		setFileFetcher(async (key, signal) => {
			const t0 = performance.now();
			const [, res] = await Promise.all([initPdfium(), apiFetch(`/attachments/${encodeURIComponent(key)}/file`, { signal })]);
			if (!res.ok) return res;
			const bytes = await res.arrayBuffer();
			fetches.push({ key, bytes: bytes.byteLength, ms: performance.now() - t0 });
			return new Response(bytes, { status: res.status, headers: res.headers });
		});
	},

	// for automated checks: the store and what the page saw
	async onStore(store, ctx) {
		if (source === "demo") {
			// the store, and the layout analysis of the demo article (counts of what it found)
			(globalThis as Record<string, unknown>).znDemo = {
				store,
				async analyse() {
					const key = demoStored[0]?.split("/")[0];
					if (!key || !demoHandle) return null;
					const { loadStructure } = await import("./reader/structure/load");
					const bytes = new Uint8Array(await (await demoHandle(new Request(`http://127.0.0.1/api/attachments/${key}/file`)))!.arrayBuffer());
					const s = await loadStructure(key, bytes) as unknown as Record<string, unknown>;
					return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]));
				},
			};
			return;
		}
		const probe = {
			store, outsideChanges: 0, requests, hostName, browser: source === "browser",
			/** browser mode: when each `changed` notice arrived (performance.now()) and its dataVersion */
			notices: [] as { at: number; dataVersion?: number }[],
			/** one /api call as the page makes it (for the headless check); resolves to {status, json} */
			async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
				const { apiFetch } = await import("./api");
				const res = await apiFetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
				const text = await res.text();
				let json: unknown = null;
				try { json = JSON.parse(text); } catch { /* a file, not JSON */ }
				return { status: res.status, json, text };
			},
			/** ids of the annotations the reader has loaded for an open PDF */
			async annotationIds(attachmentKey: string): Promise<string[]> {
				const { sessionOf } = await import("./reader/annotations/session");
				return sessionOf(attachmentKey)?.store.list().map((a) => a.id) ?? [];
			},
			/** light / dark, as Settings > Appearance does */
			setTheme: (mode: "light" | "dark") => setThemePrefs({ mode }),
			/** browser mode, for the headless check (web/browser-welcome-check.ts): is the welcome screen up */
			welcomeShown: () => ctx.overlayShown(),
			/** the app's library tab: the "Move your browser library into Zinc" offer (web/extension-ui.tsx offerMove), for the headless check */
			move: { phase: "idle" } as MoveProbe,
			/** browser mode: has Settings the Export library row */
			hasExportSetting: false,
			importProgress: [] as string[],
			/** Highlight the first `n` words of a page of an open PDF through the reader's own annotation session (the same create
			 *  and save path as the toolbar); resolves to the annotation's id, or null when the document is not open. */
			async highlight(attachmentKey: string, page = 0, n = 4): Promise<string | null> {
				const { sessionOf } = await import("./reader/annotations/session");
				const { textPosition } = await import("./reader/annotations/model");
				const s = sessionOf(attachmentKey);
				if (!s) return null;
				const size = s.ctx.pageSize(page);
				const words = (await s.ctx.textLayer(page)).words.filter((w) => w.l === 0).slice(0, n);
				if (!words.length) return null;
				const rects = words.map((w) => [w.x * size.w, (1 - w.y - w.h) * size.h, (w.x + w.w) * size.w, (1 - w.y) * size.h] as [number, number, number, number]);
				const a = await s.act.create("highlight", "#ffd400", textPosition(page, rects), { text: words.map((w) => w.t).join(" ") });
				return a.id;
			},
		};
		// the entries only the extension's page has: importFolder, exportLibrary, readFirstRunDone (web/extension-ui.tsx)
		if (__ZN_EXTENSION__) await import("../web/extension-ui").then((m) => m.addExtensionProbe(probe, ctx, store));
		(globalThis as Record<string, unknown>).znLibrary = probe;
		probeOf = probe;
	},

	// a new browser library asks how to start before the app is shown (no flash of an empty library)
	async beforeApp(store, ctx) {
		if (__ZN_EXTENSION__ && source === "browser") await import("../web/extension-ui").then((m) => m.welcomeScreenHook(ctx, store)).catch((e) => console.warn("[library] welcome screen", e));
	},

	async afterFeatures(store) {
		// The reading view's fonts (Source Serif 4, Georgia, ...) are not in GPUI's browser build: draw them all in IBM Plex Sans, which is
		// (a monospace fallback would make the reflowed text hard to read).
		const { FONTS } = await import("./reader/reflow/settings");
		for (const f of FONTS as readonly { family: string }[]) (f as { family: string }).family = "IBM Plex Sans";
		const probe = probeOf;
		if (source === "demo") {
			// ?view=reading opens PDFs straight in the reading view; ?open=<attachment key>, or ?open=demo for the demo article: open that
			// PDF in the reader once the list is in (a direct link)
			if (params.get("view") === "reading") (await import("./reader/reflow/state")).setReflowSettings({ openByDefault: true });
			const openParam = params.get("open");
			const open = openParam === "demo" ? demoStored[0]?.split("/")[0] : openParam;
			if (open && /^[A-Z0-9]{8}$/.test(open)) setTimeout(() => store.openAttachment(open, "Demo review", ""), 400);
			return;
		}
		if (source === "browser" || source === "page") {
			// the browser library tells every connected page when a write committed (a save from the connector, an edit in another tab): reload
			// the lists then, in place of polling. A burst of writes (an import) costs one reload.
			let timer: ReturnType<typeof setTimeout> | undefined;
			onLibraryChanged = (m) => {
				probe?.notices.push({ at: performance.now(), dataVersion: m.dataVersion });
				clearTimeout(timer);
				timer = setTimeout(() => { if (probe) probe.outsideChanges++; store.refresh(); }, 60);
			};
		}
		if (__ZN_EXTENSION__ && source === "browser" && probe) {
			await import("../web/extension-ui").then((m) => m.registerExportSetting());
			probe.hasExportSetting = true;
		}
		if (__ZN_EXTENSION__ && source === "host" && probe) {
			// another program (the desktop app, a connector save) wrote to the library: reload the lists
			const { startOutsideChangeWatch } = await import("./shell/outsideChanges");
			startOutsideChangeWatch(() => {
				probe.outsideChanges++;
				store.refresh();
			});
			// One library per computer (docs/design/browser-edition.md, section 6): this tab is the app's library. When the browser still holds a
			// library of its own, offer to move it into the app. no background to ask (an extension without the connector's service worker,
			// e.g. a test one): nothing to offer, quietly
			void import("../web/extension-ui").then((m) => m.offerMove(probe, store)).catch((e) => { if (!/Receiving end does not exist/i.test(String(e?.message ?? e))) console.warn("[library] move offer", e); });
		}
		if (inExtension) {
			// "Open library" in the connector's popup: show the item just saved. ?select=<key> when the popup opens this page, a
			// {zincLibrarySelect: key} message when the page is already open (the save is new, so the lists are reloaded first).
			const showItem = (key: unknown) => {
				if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key)) return;
				store.setActiveTab("library");
				store.selectCollection(null);
				store.refresh();
				store.selectItem(key);
			};
			showItem(params.get("select"));
			chrome!.runtime.onMessage.addListener((m) => showItem((m as { zincLibrarySelect?: unknown } | null)?.zincLibrarySelect));
		}
	},
};
