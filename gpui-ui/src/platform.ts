// The desktop's part of the start-up (src/start.tsx has the rest): the in-process core, the fonts, the prefetch worker, the window
// (title bar theme, icon), the services that need an OS (reveal requests, updates, crash toast). The browser builds use
// src/platform.web.ts instead (web/build.ts picks it).
//
// The four side-effect imports come first and in this order: main.tsx imports this module before anything else, so they still run before
// any other module of the app loads.
import "./shell/linuxDisplay"; // Linux: X11 for GPUI and GTK (the web view needs it), before either loads (shell/linuxDisplay.ts)
import "./uvpool"; // before anything can start libuv's thread pool: 2 workers, not 4 (src/uvpool.ts)
import "./signin/entry"; // the packaged exe started as the sign-in browser helper (--signin-helper) runs that and never gets past here
import { startup } from "./packaged"; // sets the packaged app's defaults before other modules read the environment
import { initErrorLog } from "./shell/errorlog"; // local error log + crash marker (shell/errorlog.ts)
import { createEffect, createRoot } from "solid-js";
import { startCore } from "./core";
import { registerFonts } from "./fonts";
import { themePrefs } from "./shell/appearance";
import { tokens } from "./theme";
import { startCoreOnDemand } from "./api";
import { saveHint, startPrefetch } from "./prefetch";
import { mark } from "./trace";
import type { Platform } from "./start";

/** Measurement aid: ZN_OPEN_TABS=attKey1,attKey2 opens those PDFs as reader tabs 2 s apart once the list is in (last one active). */
async function openTabsFromEnv(open: (key: string, title: string, itemKey: string) => void) {
	const keys = (process.env.ZN_OPEN_TABS ?? "").split(",").filter(Boolean);
	for (const k of keys) {
		await new Promise((r) => setTimeout(r, 2000));
		open(k, k, k);
		mark("tab-opened");
	}
}

// The core: at once, unless the prefetch worker is answering the first screen's requests (src/prefetch.ts); then it starts when the
// first page is in (settled below) or when a request needs it (api.ts calls this on the first request the worker did not answer).
const bootCore = () => void startCore().catch((e) => console.error("[core]", e instanceof Error ? e.message : e));

export const platform: Platform = {
	title: "Zinc",
	window: { width: 1400, height: 900 },
	init: initErrorLog,
	prepare() {},
	prefetch: startPrefetch,
	registerFonts,

	// No library chosen yet (packaged.ts found none): the first-run screen runs first (src/firstrun/); it saves the choice and sets ZN_DB, and the start-up goes on.
	async firstRun(ctx) {
		if (startup.firstRun) await import("./firstrun/run").then((m) => m.runFirstRun(ctx.setApp, ctx.mode));
	},

	async connect(_ctx, earlyData) {
		if (earlyData) startCoreOnDemand(bootCore); else bootCore();
	},

	// the Windows title bar follows the theme too (after startAppearance's effect, so the scheme's tokens are already rewritten)
	onAppearance(store) {
		void import("./shell/windowFrame").then(({ applyFrameTheme }) => createRoot(() => createEffect(() => {
			const m = store.mode();
			themePrefs(); // re-run on a scheme change: applyColours rewrites tokens in place
			const t = tokens[m];
			applyFrameTheme(m === "dark", { caption: t.canvas, text: t.foreground, border: t.border });
		})));
	},

	settled() {
		bootCore(); // (a no-op when it already started)
		saveHint();
		void import("./shell/windowIcon").then((m) => m.applyWindowIcon()); // the app icon in the title bar / taskbar (GPUI sets none)
	},

	afterFeatures(store) {
		void openTabsFromEnv(store.openAttachment);
		// "Open in Zinc" from the Word sidebar or the browser connector: POST /api/ui/reveal, acted on here (src/shell/revealRequests.ts)
		void import("./shell/revealRequests").then((m) => m.startRevealPolling((key, open) => {
			store.setActiveTab("library");
			store.selectItem(key);
			if (open) store.openAttachment(open.key, open.title, key); // "Open item" from the connector popup
		}));
		void import("./features/report/crashToast").then((m) => m.showCrashToast()); // "closed unexpectedly last time", if the crash marker found one
		void import("./update/service").then((m) => m.startUpdates()); // auto-update: timer + install-on-exit hooks; no network unless a feed is configured (src/update/)
	},
};
