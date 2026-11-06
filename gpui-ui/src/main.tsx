// Entry point. Goal: the window is up as early as possible, and never blank.
//
//   1. render() a splash straight away (canvas colour + the layout's skeleton). main.tsx statically imports only the renderer, the
//      theme (colours) and tiny helpers: the heavy modules (the app ~400 ms, the core ~400 ms) are imported afterwards.
//   2. Register the fonts right away, while the tree has no text (cheap then; see below).
//   3. Yield one tick so the splash is presented, then:
//        - import the store, which starts the data loading (collections, first page of items, year groups) at once,
//        - import the App and swap it in for the splash,
//        - the in-process core (ZN_DB; src/core.ts, api.ts holds requests until it is up) starts at once, or, when the prefetch worker
//          (src/prefetch.ts) is answering the first screen's requests, right after the first page is in.
//   Before render(): startPrefetch() launches that worker, so the first screen's data is read while render() blocks this thread.
//   After the first page of items: the core and its services, the feature modules, the prefetch hint.
//
// Set ZN_TRACE=1 to print the milestones (see src/trace.ts; scripts/startup.ts reads them).
import "./signin/entry"; // the packaged exe started as the sign-in browser helper (--signin-helper) runs that and never gets past here
import { startup } from "./packaged"; // first: sets the packaged app's defaults before other modules read the environment
import { initErrorLog } from "./shell/errorlog"; // local error log + crash marker (shell/errorlog.ts)
import { render } from "@gpuix/solid";
import { createComponent, createEffect, createRoot, createSignal, Show, type Component } from "solid-js";
import type { Mode, Style } from "./contracts";
import { startCore } from "./core";
import { registerFonts } from "./fonts";
import { applyAppearance, startAppearance, themePrefs } from "./shell/appearance";
import { bindUiState } from "./shell/prefs";
import { handleWindowKeyDown } from "./shell/shortcuts";
import { tokens, tw } from "./theme";
import { startCoreOnDemand } from "./api";
import { saveHint, startPrefetch } from "./prefetch";
import { mark } from "./trace";

initErrorLog();
mark("main-start");

// Stored appearance (colour scheme, text size, UI font, light/dark/system) before the first frame, so the splash and the first
// App render already have the user's look; startAppearance() below keeps it live once the store exists.
const MODE: Mode = applyAppearance();
const t = (cls: string): Style => tw(cls, MODE);
const FULL: Style = { width: "100%", height: "100%" };

/** Same frame as App.tsx (top bar, sidebar | list card | item card on the canvas), with grey bars where the content goes. */
function Splash() {
	mark("splash-start");
	const bar = (w: number | string, h = 10): Style => ({ ...t("rounded-md bg-border"), width: w, height: h, opacity: 0.5 });
	return (
		<div style={{ ...t("flex flex-col bg-canvas"), ...FULL }}>
			<div style={{ ...t("flex h-10 flex-none items-center gap-1 border-b bg-topbar px-3"), width: "100%" }} />
			<div style={{ ...t("flex flex-1 min-h-0 pt-3 pr-3 pb-3 pl-3"), width: "100%" }}>
				<div style={{ ...t("flex flex-col gap-3 p-3"), width: "18%", flexShrink: 0, minWidth: 0, height: "100%" }}>
					{[70, 55, 80, 60, 65].map((w) => <div style={bar(`${w}%`)} />)}
				</div>
				<div style={{ ...t("min-w-0 rounded-[14px] bg-background shadow-raised flex flex-col gap-4 p-4 overflow-hidden"), flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%" }}>
					{[90, 70, 85, 60, 80, 75, 65, 88, 72].map((w) => <div style={bar(`${w}%`, 12)} />)}
				</div>
				<div style={{ width: 12, flexShrink: 0 }} />
				<div style={{ ...t("min-w-0 rounded-[14px] bg-background shadow-raised"), width: "28%", flexShrink: 0, height: "100%" }} />
			</div>
		</div>
	);
}

const [app, setApp] = createSignal<Component | null>(null);

function Root() {
	return <Show when={app()} fallback={<Splash />}>{(C) => createComponent(C(), {})}</Show>;
}

const earlyData = startPrefetch(); // a worker answers the first screen's requests while render() below blocks this thread (src/prefetch.ts)
mark("pre-render");
// onKeyDown is the window-level key handler: global shortcuts of the registry's appActions (shell/shortcuts.ts).
render(() => <Root />, { title: "zotero-next", width: 1400, height: 900, onKeyDown: handleWindowKeyDown });
mark("render-returned");

// Fonts now, while the tree has no text: registering is ~10-30 ms per file then, but ~250 ms per file once a laid-out app is on
// screen (it re-shapes everything). Only Inter + Source Serif 4 (+ italic) are registered; the others when chosen (fonts.ts).
registerFonts();
mark("fonts-registered");

/** Measurement aid: ZN_OPEN_TABS=attKey1,attKey2 opens those PDFs as reader tabs 2 s apart once the list is in (last one active). */
async function openTabsFromEnv(open: (key: string, title: string, itemKey: string) => void) {
	const keys = (process.env.ZN_OPEN_TABS ?? "").split(",").filter(Boolean);
	for (const k of keys) {
		await new Promise((r) => setTimeout(r, 2000));
		open(k, k, k);
		mark("tab-opened");
	}
}

// let the splash be presented before the heavy imports occupy the thread
await new Promise((r) => setTimeout(r, 0));

// No library chosen yet (packaged.ts found none): the first-run screen runs first (src/firstrun/); it saves the choice and sets ZN_DB, and the start-up goes on.
if (startup.firstRun) await import("./firstrun/run").then((m) => m.runFirstRun((c) => setApp(() => c), MODE));

// The core: at once, unless the prefetch worker is answering the first screen's requests (src/prefetch.ts); then it starts when the
// first page is in (below) or when a request needs it (api.ts calls this on the first request the worker did not answer).
const bootCore = () => void startCore().catch((e) => console.error("[core]", e instanceof Error ? e.message : e));
if (earlyData) startCoreOnDemand(bootCore); else bootCore(); // before the store: it holds requests
const storeP = import("./store"); // creating the store starts the data loading right now
const appP = import("./App");
const { store, uiState } = await storeP;
bindUiState(uiState); // shell preferences are written by store.ts's ui-state.json writer
mark("store-ready");
startAppearance(store); // store.mode follows the stored mode / the OS; colours, font and size follow the preferences
// the Windows title bar follows the theme too (after startAppearance's effect, so the scheme's tokens are already rewritten)
void import("./shell/windowFrame").then(({ applyFrameTheme }) => createRoot(() => createEffect(() => {
	const m = store.mode();
	themePrefs(); // re-run on a scheme change: applyColours rewrites tokens in place
	const t = tokens[m];
	applyFrameTheme(m === "dark", { caption: t.canvas, text: t.foreground, border: t.border });
})));
const { App } = await appP;
setApp(() => App);
mark("app-mounted");

// The App is mounted; this resolves when its first page of items is in (or the load failed): the next frame paints it.
await new Promise<void>((resolve) => createRoot((dispose) => {
	createEffect(() => {
		if (store.pagesLoaded() > 0 || store.error()) {
			mark("first-items");
			dispose();
			resolve();
		}
	});
}));

// Everything below is off the path to the first items. Let the frame go out first.
await new Promise((r) => setTimeout(r, 16));
bootCore(); // (a no-op when it already started)
saveHint();
void import("./shell/windowIcon").then((m) => m.applyWindowIcon()); // the app icon in the title bar / taskbar (GPUI sets none)

// ---- FEATURES: each feature's register() puts its menu entries, dialogs, sidebar/settings sections and reader plugins in the registry
// (registered after the first page: the registry is reactive, the menus and sections fill in a few ms later)
await import("./features").then(
	() => mark("features-registered"),
	(e) => console.error("[features]", e),
);
void openTabsFromEnv(store.openAttachment);
void import("./features/report/crashToast").then((m) => m.showCrashToast()); // "closed unexpectedly last time", if the crash marker found one
void import("./update/service").then((m) => m.startUpdates()); // auto-update: timer + install-on-exit hooks; no network unless a feed is configured (src/update/)
