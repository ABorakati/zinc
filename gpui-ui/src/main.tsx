// Entry point. Goal: the window is up as early as possible, and never blank.
//
//   1. render() a splash straight away (canvas colour + the layout's skeleton). main.tsx statically imports only the renderer, the
//      theme (colours) and tiny helpers: the heavy modules (the app ~400 ms, the core ~400 ms) are imported afterwards.
//   2. Register the fonts right away, while the tree has no text (cheap then; see below).
//   3. Yield one tick so the splash is presented, then in parallel:
//        - start the in-process core when ZN_DB is set (src/core.ts); api.ts holds requests until it is up,
//        - import the store, which starts the data loading (collections, first page of items, year groups) at once,
//        - import the App and swap it in for the splash.
//
// Set ZN_TRACE=1 to print the milestones (see src/trace.ts; scripts/startup.ts reads them).
import { render } from "@gpuix/solid";
import { createComponent, createEffect, createRoot, createSignal, Show, type Component } from "solid-js";
import type { Mode, Style } from "./contracts";
import { startCore } from "./core";
import { registerFonts } from "./fonts";
import { tw } from "./theme";
import { mark } from "./trace";

mark("main-start");

const MODE: Mode = "dark"; // the store's initial mode
const t = (cls: string): Style => tw(cls, MODE);
const FULL: Style = { width: "100%", height: "100%" };

/** Same frame as App.tsx (top bar, sidebar | list card | item card on the canvas), with grey bars where the content goes. */
function Splash() {
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

render(() => <Root />, { title: "zotero-next", width: 1400, height: 900 });
mark("render-returned");

// Fonts now, while the tree has no text: registering is ~10-30 ms per file then, but ~250 ms per file once a laid-out app is on
// screen (it re-shapes everything). Only Inter + Source Serif 4 (+ italic) are registered; the others when chosen (fonts.ts).
registerFonts();
mark("fonts-registered");

// let the splash be presented before the heavy imports occupy the thread
await new Promise((r) => setTimeout(r, 0));

void startCore().catch((e) => console.error("[core]", e instanceof Error ? e.message : e)); // before the store: it holds requests
const storeP = import("./store"); // creating the store starts the data loading right now
const appP = import("./App");
const { store } = await storeP;
mark("store-ready");
const { App } = await appP;
setApp(() => App);
mark("app-mounted");

createRoot((dispose) => {
	createEffect(() => {
		if (store.pagesLoaded() > 0 || store.error()) {
			mark("first-items"); // the App is mounted and its first page is in: the next frame paints it
			dispose();
		}
	});
});
