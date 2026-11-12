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
	runtime: { connectNative(name: string): NativePort; lastError?: { message?: string } };
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
// PDFs (phase 3, not tested yet): the reader fetches the bytes through the same path; PDFium loads on the first one
const { setFileFetcher } = await import("../src/reader/library");
const { initPdfium } = await import("./pdf");
const { apiFetch } = await import("../src/api");
setFileFetcher(async (key, signal) => {
	await initPdfium();
	return apiFetch(`/attachments/${encodeURIComponent(key)}/file`, { signal });
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
const probe = { store, outsideChanges: 0, requests, hostName };
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
