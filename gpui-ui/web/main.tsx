// Browser demo of the app: the real UI (src/App.tsx, drawn by GPUI compiled to WebAssembly through GPUIX's browser build) on the
// real core (core/src/api.ts handleApi), reading a demo library through SQLite compiled to WebAssembly (web/sqlite.ts). Nothing
// leaves the tab: the library is an in-memory copy, settings go to an in-memory file system (web/shims/fs.ts).
// Built by web/build.ts; the files it fetches (library.sqlite, icons.json, collection-style.json) sit next to the bundle.
// A trimmed copy of src/main.tsx: no sign-in helper, packaged-app start-up, error log, prefetch worker, services or updates.
import "./globals";
import { seedFile } from "./shims/fs";
import { initSqlite, registerDatabase, Database } from "./sqlite";
import { render } from "@gpuix/solid";
import { createComponent, createSignal, Show, type Component } from "solid-js";
import { setDirect } from "../src/api";
import { applyAppearance, setThemePrefs, startAppearance } from "../src/shell/appearance";
import { bindUiState } from "../src/shell/prefs";
import { handleWindowKeyDown } from "../src/shell/shortcuts";
import { fontFamilyNames, tw } from "../src/theme";

const DB = "/demo/library.sqlite";
const here = (f: string) => new URL(f, import.meta.url).href;
const bytes = async (f: string) => new Uint8Array(await (await fetch(here(f))).arrayBuffer());

// the demo library and the files the app reads from disk (Lucide icons, the collections' colours and icons), fetched before any
// app module asks for them
const [lib, styles, icons, stored] = await Promise.all([
	bytes("library.sqlite"),
	fetch(here("collection-style.json")).then((r) => (r.ok ? r.text() : "")),
	fetch(here("icons.json")).then((r) => r.json() as Promise<Record<string, string>>),
	fetch(here("storage.json")).then((r) => (r.ok ? (r.json() as Promise<string[]>) : [])),
]);
for (const [name, svg] of Object.entries(icons)) seedFile(`/icons/${name}.svg`, svg, true);
// the library's stored attachments (the demo article's PDF), where the core looks for them: <library folder>/storage/<key>/<file>
await Promise.all(
	stored.map(async (rel) => seedFile(`/demo/storage/${rel}`, await bytes(`storage/${rel.split("/").map(encodeURIComponent).join("/")}`))),
);
if (styles) seedFile("/appdata/zotero-next-gpui/collection-style.json", styles, true);
// GPUI's browser build cannot take font files (no registerFont); it has IBM Plex Sans built in, one of the app's own sans choices
fontFamilyNames.sans = fontFamilyNames.title = "IBM Plex Sans";
await initSqlite();
registerDatabase(DB, lib);
// (ZN_DB stays unset: on the desktop it makes src/core.ts start a loopback server; here the core is plugged in with setDirect)

const db = new Database(DB);
const { handleApi } = await import("../../core/src/api");
setDirect((req) => handleApi(req, db as never));
// the reader fetches a PDF's bytes through the core, like src/core.ts wires it; PDFium (web/pdf.ts) loads on the first one
const { setFileFetcher } = await import("../src/reader/library");
const { initPdfium } = await import("./pdf");
setFileFetcher(async (key, signal) => {
	await initPdfium();
	return (
		(await handleApi(new Request(`http://127.0.0.1/api/attachments/${encodeURIComponent(key)}/file`, { signal }), db as never)) ??
		new Response("not found", { status: 404 })
	);
});

// light or dark from the page that embeds the demo (?theme=, then postMessage({ theme }) when the site's theme changes)
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") setThemePrefs({ mode: theme });
// the interface font through the app's own setting (Settings > Appearance): IBM Plex Sans, the one GPUI's browser build has
setThemePrefs({ font: "plex" });
addEventListener("message", (e) => {
	const t = (e.data as { theme?: string } | null)?.theme;
	if (t === "light" || t === "dark") setThemePrefs({ mode: t });
});
const MODE = applyAppearance();
const [app, setApp] = createSignal<Component | null>(null);
function Root() {
	// the outer div sets the family text inherits where the app sets none (GPUI's own default in the browser is a monospace font)
	return (
		<div style={{ width: "100%", height: "100%", fontFamily: "IBM Plex Sans" }}>
			<Show when={app()} fallback={<div style={{ ...tw("bg-canvas", MODE), width: "100%", height: "100%" }} />}>
				{(C) => createComponent(C(), {})}
			</Show>
		</div>
	);
}
render(() => <Root />, { title: "Zinc demo", onKeyDown: handleWindowKeyDown });

const { store, uiState } = await import("../src/store");
// for automated checks of the demo: store.openAttachment, and the layout analysis of the demo article (counts of what it found)
(globalThis as Record<string, unknown>).znDemo = {
	store,
	async analyse() {
		const key = stored[0]?.split("/")[0];
		if (!key) return null;
		const { loadStructure } = await import("../src/reader/structure/load");
		const bytes = new Uint8Array(
			await (await handleApi(new Request(`http://127.0.0.1/api/attachments/${key}/file`), db as never))!.arrayBuffer(),
		);
		const s = (await loadStructure(key, bytes)) as unknown as Record<string, unknown>;
		return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]));
	},
};
bindUiState(uiState);
startAppearance(store);
const { App } = await import("../src/App");
setApp(() => App);
await import("../src/features").catch((e) => console.warn("[demo] features", e));
// The reading view's fonts (Source Serif 4, Georgia, ...) are not in GPUI's browser build: draw them all in IBM Plex Sans, which is
// (a monospace fallback would make the reflowed text hard to read). ?view=reading opens PDFs straight in the reading view.
{
	const { FONTS } = await import("../src/reader/reflow/settings");
	for (const f of FONTS as readonly { family: string }[]) (f as { family: string }).family = "IBM Plex Sans";
	if (new URLSearchParams(location.search).get("view") === "reading")
		(await import("../src/reader/reflow/state")).setReflowSettings({ openByDefault: true });
}
// ?open=<attachment key>, or ?open=demo for the demo article: open that PDF in the reader once the list is in (a direct link)
const openParam = new URLSearchParams(location.search).get("open");
const open = openParam === "demo" ? stored[0]?.split("/")[0] : openParam;
if (open && /^[A-Z0-9]{8}$/.test(open)) setTimeout(() => store.openAttachment(open, "Demo review", ""), 400);
