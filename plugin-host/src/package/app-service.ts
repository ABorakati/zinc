// What the `app` and `prefs.get-app` imports know about Zinc. Everything the plugin host cannot know itself is a provider the app
// (gpui-ui) passes in; the defaults describe a headless, always-ready Zinc so the package works in tests and in the connector host.
import type { PrefValue } from "./prefs-store";

export interface AppPrefProvider {
	/** The current value of a Zinc setting, by its pref name, or undefined. Only names on APP_PREF_ALLOWLIST are ever asked for. */
	get(key: string): PrefValue | undefined;
	/** Tell `fn` when a setting changes. Returns the unsubscribe function. */
	subscribe?(fn: (key: string, value: PrefValue | undefined) => void): () => void;
}

/**
 * Zinc settings a plugin may read with `prefs.get-app` (and observe, with `prefs.app-read`). Read only. THIS LIST IS OPEN: lifecycle.md
 * (open question 5) leaves the final choice to the settings owner; these are the ones other areas asked for or that are plainly
 * harmless. `shell.*` and `general.*` are the names of gpui-ui's own persisted prefs (src/settings/*.ts); the `extensions.zotero.*`
 * and `export.*` names are Zotero's, which the library area asked for.
 */
export const APP_PREF_ALLOWLIST: readonly string[] = [
	"ui.locale",
	"ui.theme.mode",
	"ui.theme.palette",
	"shell.reader.zoom",
	"shell.reader.sidebar",
	"shell.reader.pages",
	"shell.reader.scrollMode",
	"shell.reader.spreadMode",
	"general.attachPdfs",
	"general.autoTag",
	"extensions.zotero.autoRenameFiles",
	"export.quickCopy.setting",
];

export interface AppProviders {
	/** Zinc's version. Default: ZN_VERSION or "0.1.0". */
	version?: string;
	/** `zinc:plugin` API version. Default "0.1.0". */
	apiVersion?: string;
	/** What `Zotero.version` claims to be, for plugins that branch on it. Default "10.0.0". */
	zoteroVersion?: string;
	/** BCP 47 UI locale. Default: the system's. */
	locale?: () => string;
	timeZone?: () => string;
	devBuild?: () => boolean;
	/** Feature ids (see the doc comment of `app.app-info.features`). */
	features?: () => string[];
	isUiReady?: () => boolean;
	/** Resolves when the UI is ready. Default: at once. */
	waitUiReady?: () => Promise<void>;
	mainWindows?: () => number[];
	activeWindow?: () => number | undefined;
	/** True while every window is hidden or minimised (timers slow down). */
	windowsHidden?: () => boolean;
	appPrefs?: AppPrefProvider;
}

export class AppService {
	locale: () => string;
	locales = new Set<(tag: string) => void>();

	constructor(public providers: AppProviders = {}) {
		this.locale = () => this.providers.locale?.() ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US";
	}

	configure(p: AppProviders) {
		this.providers = { ...this.providers, ...p };
	}

	info() {
		const p = this.providers;
		const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
		return {
			name: "Zinc",
			version: p.version ?? process.env.ZN_VERSION ?? "0.1.0",
			apiVersion: p.apiVersion ?? "0.1.0",
			zoteroVersion: p.zoteroVersion ?? "10.0.0",
			platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
			arch,
			locale: this.locale(),
			timeZone: p.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
			devBuild: p.devBuild?.() ?? false,
			features: p.features?.() ?? [],
		};
	}

	isUiReady(): boolean {
		return this.providers.isUiReady?.() ?? true;
	}

	waitUiReady(): Promise<void> {
		return this.isUiReady() ? Promise.resolve() : (this.providers.waitUiReady?.() ?? Promise.resolve());
	}

	mainWindows(): number[] {
		return this.providers.mainWindows?.() ?? [];
	}

	activeWindow(): number | undefined {
		return this.providers.activeWindow?.();
	}

	appPref(key: string): PrefValue | undefined {
		return this.providers.appPrefs?.get(key);
	}

	/** The UI language changed: tell the services (they call `events.on-locale-changed` on every running plugin). */
	notifyLocaleChanged(tag?: string) {
		const t = tag ?? this.locale();
		for (const fn of this.locales) fn(t);
	}
}
