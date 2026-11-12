// The user's own library inside the Zinc Connector browser extension (library.html, a full-tab extension page). The same UI as the
// browser demo (web/main.tsx: GPUI compiled to WebAssembly), but no database in the page: every /api request goes over Chrome
// native messaging to the connector's host, which answers it with the core's handleApi against the library file
// (web/native-host.ts, connector-host/src/api.ts). Built by `bun web/build.ts --target extension` (no inline script, no service
// worker: Manifest V3 extension pages allow neither). Changes other programs make to the library show up within ~2 s
// (src/shell/outsideChanges.ts). The host is read-mostly for now: edits answer 403 (see connector-host/src/api.ts).
import "./globals";
import { seedFile } from "./shims/fs";
import { render } from "@gpuix/solid";
import { createComponent, createSignal, Show, type Component } from "solid-js";
import { setDirect } from "../src/api";
import { applyAppearance, setThemePrefs, startAppearance } from "../src/shell/appearance";
import { bindUiState } from "../src/shell/prefs";
import { handleWindowKeyDown } from "../src/shell/shortcuts";
import { fontFamilyNames, tw } from "../src/theme";
import { HOST_NAME, nativeApiTransport, type NativePort } from "./native-host";

declare const chrome: {
	runtime: {
		connectNative(name: string): NativePort;
		lastError?: { message?: string };
		onMessage: { addListener(f: (msg: unknown) => void): void };
	};
};

const here = (f: string) => new URL(f, import.meta.url).href;
// the Lucide icons the app reads from disk on the desktop (src/icons.tsx), before any app module asks for them
const icons = (await fetch(here("icons.json")).then((r) => r.json())) as Record<string, string>;
for (const [name, svg] of Object.entries(icons)) seedFile(`/icons/${name}.svg`, svg, true);
// GPUI's browser build cannot take font files (no registerFont); it has IBM Plex Sans built in, one of the app's own sans choices
fontFamilyNames.sans = fontFamilyNames.title = "IBM Plex Sans";

// the data path: each Request to the host as an `api` frame, the chunked answer back as a Response. ?host=<name> picks another
// registration of the same host (tests register one under their own name, so they never reach the installed host or its library).
const hostParam = new URLSearchParams(location.search).get("host");
const hostName = hostParam && /^com\.zotero_next\.[a-z0-9_.]+$/.test(hostParam) ? hostParam : HOST_NAME;
const transport = nativeApiTransport(() => chrome.runtime.connectNative(hostName), () => chrome.runtime.lastError?.message);
// the last requests and their status, for automated checks (window.znLibrary.requests)
const requests: { method: string; path: string; status: number | string }[] = [];
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
// PDFs: the reader fetches the bytes through the same path (the host sends them in chunks under 1 MB); PDFium and its render workers
// (web/pdf.ts) load on the first one. Each fetch is timed for the headless check (globalThis.znPdfStats.fetches).
const { setFileFetcher } = await import("../src/reader/library");
const { initPdfium, pdfStats } = await import("./pdf");
const { apiFetch } = await import("../src/api");
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

const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") setThemePrefs({ mode: theme });
setThemePrefs({ font: "plex" });
const MODE = applyAppearance();
const [app, setApp] = createSignal<Component | null>(null);
function Root() {
	return (
		<div style={{ width: "100%", height: "100%", fontFamily: "IBM Plex Sans" }}>
			<Show when={app()} fallback={<div style={{ ...tw("bg-canvas", MODE), width: "100%", height: "100%" }} />}>{(C) => createComponent(C(), {})}</Show>
		</div>
	);
}
render(() => <Root />, { title: "Zinc library", onKeyDown: handleWindowKeyDown });

const { store, uiState } = await import("../src/store");
// for automated checks (the connector's headless test): the store, and how many outside changes were seen
const probe = {
	store, outsideChanges: 0, requests, hostName,
	/** ids of the annotations the reader has loaded for an open PDF */
	async annotationIds(attachmentKey: string): Promise<string[]> {
		const { sessionOf } = await import("../src/reader/annotations/session");
		return sessionOf(attachmentKey)?.store.list().map((a) => a.id) ?? [];
	},
	/** light / dark, as Settings > Appearance does */
	setTheme: (mode: "light" | "dark") => setThemePrefs({ mode }),
	/** Highlight the first `n` words of a page of an open PDF through the reader's own annotation session (the same create
	 *  and save path as the toolbar); resolves to the annotation's id, or null when the document is not open. */
	async highlight(attachmentKey: string, page = 0, n = 4): Promise<string | null> {
		const { sessionOf } = await import("../src/reader/annotations/session");
		const { textPosition } = await import("../src/reader/annotations/model");
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
(globalThis as Record<string, unknown>).znLibrary = probe;
bindUiState(uiState);
startAppearance(store);
const { App } = await import("../src/App");
setApp(() => App);
await import("../src/features").catch((e) => console.warn("[library] features", e));
{
	const { FONTS } = await import("../src/reader/reflow/settings");
	for (const f of FONTS as readonly { family: string }[]) (f as { family: string }).family = "IBM Plex Sans";
}
// another program (the desktop app, a connector save) wrote to the library: reload the lists
const { startOutsideChangeWatch } = await import("../src/shell/outsideChanges");
startOutsideChangeWatch(() => {
	probe.outsideChanges++;
	store.refresh();
});

// "Open library" in the connector's popup: show the item just saved. ?select=<key> when the popup opens this page, a
// {zincLibrarySelect: key} message when the page is already open (the save is new, so the lists are reloaded first).
const showItem = (key: unknown) => {
	if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key)) return;
	store.setActiveTab("library");
	store.selectCollection(null);
	store.refresh();
	store.selectItem(key);
};
showItem(new URLSearchParams(location.search).get("select"));
chrome.runtime.onMessage.addListener((m) => showItem((m as { zincLibrarySelect?: unknown } | null)?.zincLibrarySelect));
