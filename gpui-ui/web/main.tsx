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
const [lib, styles, icons] = await Promise.all([
	bytes("library.sqlite"),
	fetch(here("collection-style.json")).then((r) => (r.ok ? r.text() : "")),
	fetch(here("icons.json")).then((r) => r.json() as Promise<Record<string, string>>),
]);
for (const [name, svg] of Object.entries(icons)) seedFile(`/icons/${name}.svg`, svg, true);
if (styles) seedFile("/appdata/zotero-next-gpui/collection-style.json", styles, true);
// GPUI's browser build cannot take font files (no registerFont); it has IBM Plex Sans built in, one of the app's own sans choices
fontFamilyNames.sans = fontFamilyNames.title = "IBM Plex Sans";
await initSqlite();
registerDatabase(DB, lib);
process.env.ZN_DB = DB;

const db = new Database(DB);
const { handleApi } = await import("../../core/src/api");
setDirect((req) => handleApi(req, db as never));

// light or dark from the page that embeds the demo (?theme=, then postMessage({ theme }) when the site's theme changes)
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "light" || theme === "dark") setThemePrefs({ mode: theme });
// the interface font through the app's own setting (Settings > Appearance): IBM Plex Sans, the one GPUI's browser build has
setThemePrefs({ font: "plex" });
addEventListener("message", (e) => { const t = (e.data as { theme?: string } | null)?.theme; if (t === "light" || t === "dark") setThemePrefs({ mode: t }); });
const MODE = applyAppearance();
const [app, setApp] = createSignal<Component | null>(null);
function Root() {
	// the outer div sets the family text inherits where the app sets none (GPUI's own default in the browser is a monospace font)
	return (
		<div style={{ width: "100%", height: "100%", fontFamily: "IBM Plex Sans" }}>
			<Show when={app()} fallback={<div style={{ ...tw("bg-canvas", MODE), width: "100%", height: "100%" }} />}>{(C) => createComponent(C(), {})}</Show>
		</div>
	);
}
render(() => <Root />, { title: "Zotero Next demo", onKeyDown: handleWindowKeyDown });

const { store, uiState } = await import("../src/store");
bindUiState(uiState);
startAppearance(store);
const { App } = await import("../src/App");
setApp(() => App);
await import("../src/features").catch((e) => console.warn("[demo] features", e));
