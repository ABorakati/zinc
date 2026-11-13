// The start-up, shared by every build of the app: the desktop app (src/platform.ts), the browser extension's library page and the web
// page (src/platform.web.ts, picked by web/build.ts: it uses `X.web.ts` where one sits next to `X.ts`). src/main.tsx calls start().
// Goal: the window is up as early as possible, and never blank.
//
//   1. render() a splash straight away (canvas colour + the layout's skeleton). This file statically imports only the renderer, the
//      theme (colours) and tiny helpers: the heavy modules (the app ~400 ms, the core ~400 ms) are imported afterwards.
//   2. Register the fonts right away, while the tree has no text (cheap then; see below).
//   3. Yield one tick so the splash is presented, then:
//        - connect the data: the platform starts the core (desktop: in-process, api.ts holds requests until it is up; when the prefetch
//          worker (src/prefetch.ts) is answering the first screen's requests, right after the first page is in) or opens the transport
//          (browser),
//        - import the store, which starts the data loading (collections, first page of items, year groups) at once,
//        - import the App and swap it in for the splash.
//   Before render(): the platform's prefetch() launches the desktop's worker, so the first screen's data is read while render() blocks
//   this thread. After the first page of items: the platform's settled() work, the feature modules, then its services.
//
// What differs between builds is only in the Platform each one supplies; the order of the steps, and their trace marks (src/trace.ts;
// scripts/startup.ts reads them), are the same everywhere. Set ZN_TRACE=1 to print the milestones.
import { render } from "@gpuix/solid";
import { createComponent, createEffect, createRoot, createSignal, Show, type Component } from "solid-js";
import type { Mode, Style } from "./contracts";
import { applyAppearance, startAppearance } from "./shell/appearance";
import { bindUiState } from "./shell/prefs";
import { handleWindowKeyDown } from "./shell/shortcuts";
import { tw } from "./theme";
import { mark } from "./trace";

/** The store, as src/store.ts exports it (a type only: the module itself is imported after the splash is up). */
export type Store = typeof import("./store")["store"];

/** What start() hands to a platform's hooks. */
export interface StartContext {
	/** Light or dark, as applyAppearance() resolved it before the first frame. */
	mode: Mode;
	/** Put a component where the app goes (the desktop's first-run screen does this before the app exists). */
	setApp(c: Component | null): void;
	/** A screen over the app (the browser library's welcome screen); null takes it away. */
	setOverlay(c: Component | null): void;
	/** Is an overlay up? */
	overlayShown(): boolean;
}

/** The parts of start-up that differ between the desktop app and the browser. Every hook runs at the same step in both. */
export interface Platform {
	/** The window title. */
	title: string;
	/** Initial window size (the desktop; the browser fills its page). */
	window?: { width: number; height: number };
	/** Style of a div around everything, for what text inherits where the app sets nothing (the browser: GPUI's default there is monospace). */
	frame?: Style;
	/** First thing, before the first trace mark: the error log. */
	init(): void;
	/** Before applyAppearance(): fonts the page has, the colour mode and font the page asks for. */
	prepare(): void;
	/** Before render(): start whatever answers the first screen's requests while render() blocks. True when something is. */
	prefetch(): boolean;
	/** After render(), while the tree has no text (cheap then). */
	registerFonts(): void;
	/** No library chosen yet: the first-run screen (desktop). It sets up the choice and the start-up goes on. */
	firstRun?(ctx: StartContext): Promise<void>;
	/** Make the data reachable: start the core or open the transport. Runs before the store is imported (it holds requests until then). */
	connect(ctx: StartContext, earlyData: boolean): Promise<void>;
	/** The store exists (its first requests are out). */
	onStore?(store: Store, ctx: StartContext): void | Promise<void>;
	/** startAppearance() has run: the colours, font and size follow the store. */
	onAppearance?(store: Store, ctx: StartContext): void;
	/** The App module is in, not yet shown: a screen to show first (the browser library's welcome screen). */
	beforeApp?(store: Store, ctx: StartContext): Promise<void>;
	/** The first page of items is in and a frame went out: everything that is off the path to the first items. */
	settled?(store: Store, ctx: StartContext): void;
	/** The feature modules are registered: the services and the page's own wiring. */
	afterFeatures?(store: Store, ctx: StartContext): void | Promise<void>;
}

/** Same frame as App.tsx (top bar, sidebar | list card | item card on the canvas), with grey bars where the content goes. */
function Splash(props: { t: (cls: string) => Style }) {
	const t = props.t;
	mark("splash-start");
	const FULL: Style = { width: "100%", height: "100%" };
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

export async function start(platform: Platform): Promise<void> {
	platform.init();
	mark("main-start");

	// Stored appearance (colour scheme, text size, UI font, light/dark/system) before the first frame, so the splash and the first
	// App render already have the user's look; startAppearance() below keeps it live once the store exists.
	platform.prepare();
	const MODE: Mode = applyAppearance();
	const t = (cls: string): Style => tw(cls, MODE);

	const [app, setApp] = createSignal<Component | null>(null);
	const [overlay, setOverlay] = createSignal<Component | null>(null);
	function Root() {
		const screen = () => (
			<Show when={overlay()} fallback={<Show when={app()} fallback={<Splash t={t} />}>{(C) => createComponent(C(), {})}</Show>}>
				{(W) => createComponent(W(), {})}
			</Show>
		);
		return platform.frame ? <div style={platform.frame}>{screen()}</div> : screen();
	}
	const ctx: StartContext = {
		mode: MODE,
		setApp: (c) => setApp(() => c),
		setOverlay: (c) => setOverlay(() => c),
		overlayShown: () => overlay() !== null,
	};

	const earlyData = platform.prefetch(); // a worker answers the first screen's requests while render() below blocks this thread (src/prefetch.ts)
	mark("pre-render");
	// onKeyDown is the window-level key handler: global shortcuts of the registry's appActions (shell/shortcuts.ts).
	render(() => <Root />, { title: platform.title, ...platform.window, onKeyDown: handleWindowKeyDown });
	mark("render-returned");

	// Fonts now, while the tree has no text: registering is ~10-30 ms per file then, but ~250 ms per file once a laid-out app is on
	// screen (it re-shapes everything). Only Inter + Source Serif 4 (+ italic) are registered; the others when chosen (fonts.ts).
	platform.registerFonts();
	mark("fonts-registered");

	// let the splash be presented before the heavy imports occupy the thread
	await new Promise((r) => setTimeout(r, 0));

	await platform.firstRun?.(ctx);
	// the core or the transport: at once, unless the prefetch worker is answering the first screen's requests; before the store: it holds requests
	await platform.connect(ctx, earlyData);
	const storeP = import("./store"); // creating the store starts the data loading right now
	const appP = import("./App");
	const { store, uiState } = await storeP;
	await platform.onStore?.(store, ctx);
	bindUiState(uiState); // shell preferences are written by store.ts's ui-state.json writer
	mark("store-ready");
	startAppearance(store); // store.mode follows the stored mode / the OS; colours, font and size follow the preferences
	platform.onAppearance?.(store, ctx);
	const { App } = await appP;
	await platform.beforeApp?.(store, ctx);
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
	platform.settled?.(store, ctx);

	// ---- FEATURES: each feature's register() puts its menu entries, dialogs, sidebar/settings sections and reader plugins in the registry
	// (registered after the first page: the registry is reactive, the menus and sections fill in a few ms later)
	await import("./features").then(
		() => mark("features-registered"),
		(e) => console.error("[features]", e),
	);
	await platform.afterFeatures?.(store, ctx);
}
