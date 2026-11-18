// The services behind the `where: "zinc"` handlers of this area (app, plugins, prefs, secrets, l10n, timers, log, permissions), and
// the one call that sets up the whole plugin runtime in the Zinc process.
//
//   const { services, supervisor } = await createPluginRuntime({ app: { version, locale: () => ..., mainWindows: () => ... }, appPrefs, prompt });
//   await services.manager.startAll();            // after the library is open and the UI is ready
//   ...
//   await services.manager.stopAll(); await supervisor.shutdown();
//
// `PluginServices` also pushes live `prefs`, `l10n`, `app`, `log-config` and `timers-clear` state to `zhw`,
// and receives `log-batch` and `timers-count` events back from the supervisor.
import {
	createPluginSupervisor,
	type PluginSupervisor,
	type SupervisorInitState,
	type SupervisorLoadState,
	type SupervisorOptions,
} from "../supervisor";
import type { PluginManifest } from "../manifest";
import { discoverHandlers, type ImportHandler } from "../imports/registry";
import { PermissionService, type PermissionPrompt } from "../permissions/service";
import { APP_PREF_ALLOWLIST, AppService, type AppProviders } from "./app-service";
import type { UpdateOptions } from "./update";
import { PluginManager, type ManagerOptions } from "./installer";
import { L10nService, type LocalizedString } from "./l10n";
import { LogRing } from "./log-ring";
import { PrefStore, toWire, type PrefChange, type PrefValue } from "./prefs-store";
import { SecretStore, type KeyProvider } from "./secrets-store";
import { TimerService } from "./timers";

export interface ServicesOptions {
	manager?: ManagerOptions;
	app?: AppProviders;
	/** The run-time permission prompt (the ui area's dialog). */
	prompt?: PermissionPrompt;
	canPrompt?: (plugin: string) => boolean;
	/** Master-key provider for secrets (tests). */
	secretKeys?: KeyProvider;
	/** `fetch` for update checks (tests). Default: the global fetch. */
	updateFetch?: UpdateOptions["fetch"];
}

interface PrefSub {
	scope: "plugin-own" | "app";
	key: string;
	prefix: boolean;
}

export class PluginServices {
	readonly manager: PluginManager;
	readonly app: AppService;
	readonly prefs: PrefStore;
	readonly secrets: SecretStore;
	readonly l10n: L10nService;
	readonly timers: TimerService;
	readonly logs = new LogRing();
	readonly permissions: PermissionService;
	private sup: PluginSupervisor | undefined;
	private prefSubs = new Map<string, Map<number, PrefSub>>();
	private nextSub = new Map<string, number>();
	private pluginObservers = new Set<string>();
	private offApp: (() => void) | undefined;
	private lastAppJson = "";
	private lastAppPrefsJson = "";
	private lastLocale = "";
	private lastTimeZone: string | undefined;
	updateFetch: UpdateOptions["fetch"];

	constructor(o: ServicesOptions = {}) {
		this.updateFetch = o.updateFetch;
		this.app = new AppService(o.app);
		this.logs.onDebugChange = (debugEnabled) => {
			this.sup?.pushHost?.({ t: "log-config", debugEnabled });
		};
		this.manager = new PluginManager({
			zincVersion: o.app?.version,
			apiVersion: o.app?.apiVersion,
			...o.manager,
			log: (l, m) => this.logs.push(undefined, l, `[plugins] ${m}`),
		});
		this.manager.init();
		const layout = this.manager.layout;
		this.prefs = new PrefStore(
			layout,
			(id) => (this.manager.manifestOf(id) ?? this.sup?.get(id)?.manifest)?.default_prefs as Record<string, PrefValue> | undefined,
		);
		this.secrets = new SecretStore(layout, o.secretKeys);
		this.l10n = new L10nService({
			locale: () => this.app.locale(),
			timeZone: () => this.app.providers.timeZone?.(),
			dirOf: (id) => this.sup?.get(id)?.dir ?? (this.manager.manifestOf(id) ? layout.installed(id) : undefined),
			manifestOf: (id) => this.manager.manifestOf(id) ?? this.sup?.get(id)?.manifest,
			warn: (id, m) => this.logs.push(id, "warn", `[l10n] ${m}`),
		});
		this.timers = new TimerService({
			deliver: (p, i, f, a) => this.deliver(p, i, f, a),
			hidden: () => this.app.providers.windowsHidden?.() ?? false,
			onClear: (plugin) => this.sup?.pushHost?.(plugin ? { t: "timers-clear", plugin } : { t: "timers-clear" }),
		});
		this.permissions = new PermissionService({
			prompt: o.prompt,
			canPrompt: o.canPrompt,
			grant: (id, perm) => this.manager.setPermission(id, perm, true),
			resolveReason: (id, reason) => this.l10n.resolve(id, reason as LocalizedString),
		});

		// uninstall without "keep my data": prefs and secrets go too
		this.manager.onRemoveData((id) => {
			this.prefs.deleteAll(id);
			this.secrets.deleteAll(id);
			this.logs.clearPlugin(id);
		});
		this.manager.on("installed", ({ id }) => {
			this.l10n.invalidate(id);
			this.pushPluginPrefs(id);
			this.pushPluginL10n(id);
		});
		this.manager.on("uninstalled", ({ id }) => {
			this.l10n.invalidate(id);
			this.cleanup(id);
		});
		this.manager.on("window", () => this.pushAppState());
		// synchronous cache pushes to `zhw` BEFORE `prefs.zinc.ts` returns, plus observer fan-out
		this.prefs.onSync((plugin) => this.pushPluginPrefs(plugin));
		this.prefs.onChange((c) => this.fanOutPref(c));
		this.manager.on("hook", (e) => this.fanOutPluginEvent(e));
		this.app.locales.add((tag) => this.fanOutLocale(tag));
		this.offApp = this.app.providers.appPrefs?.subscribe?.((k, v) => this.fanOutAppPref(k, v));
	}

	// ---- `zhw` cache snapshots and pushes ----------------------------------------------------------------------------------

	appPrefsSnapshot(): Record<string, PrefValue> {
		const out: Record<string, PrefValue> = {};
		for (const k of APP_PREF_ALLOWLIST) {
			const v = this.app.appPref(k);
			if (v !== undefined) out[k] = v;
		}
		return out;
	}

	appSnapshot(localeOverride?: string) {
		const info = this.app.info();
		if (localeOverride) info.locale = localeOverride;
		return {
			info,
			isUiReady: this.app.isUiReady(),
			mainWindows: this.app.mainWindows(),
			activeWindow: this.app.activeWindow() ?? null,
			windowsHidden: this.app.providers.windowsHidden?.() ?? false,
		};
	}

	initState(): SupervisorInitState {
		const app = this.appSnapshot();
		const appPrefs = this.appPrefsSnapshot();
		this.lastAppJson = JSON.stringify(app);
		this.lastAppPrefsJson = JSON.stringify(appPrefs);
		this.lastLocale = app.info.locale;
		this.lastTimeZone = app.info.timeZone;
		return {
			debugEnabled: this.logs.debugEnabled,
			app,
			appPrefs,
			locale: app.info.locale,
			timeZone: app.info.timeZone,
		};
	}

	/** Sync any changed pull-provider values (`app.*`, `locale`, `appPrefs.get`) before `zhw` executes a `call`. */
	syncBeforeCall() {
		if (!this.sup) return;
		const app = this.appSnapshot();
		const appJson = JSON.stringify(app);
		if (appJson !== this.lastAppJson) {
			this.lastAppJson = appJson;
			this.sup.pushHost?.({ t: "app", ...app });
		}
		if (app.info.locale !== this.lastLocale || app.info.timeZone !== this.lastTimeZone) {
			this.lastLocale = app.info.locale;
			this.lastTimeZone = app.info.timeZone;
			this.sup.pushHost?.({ t: "l10n", locale: app.info.locale, timeZone: app.info.timeZone });
		}
		const appPrefs = this.appPrefsSnapshot();
		const appPrefsJson = JSON.stringify(appPrefs);
		if (appPrefsJson !== this.lastAppPrefsJson) {
			this.lastAppPrefsJson = appPrefsJson;
			this.sup.pushHost?.({ t: "prefs", appPrefs });
		}
	}

	loadStateFor(id: string, dir: string, manifest: PluginManifest): SupervisorLoadState {
		const prefs = this.prefs.snapshot(id, manifest.default_prefs as Record<string, PrefValue> | undefined);
		const l10n = this.l10n.rawBundles(id, dir, manifest);
		return { prefs, l10n };
	}

	private pushAppState(localeOverride?: string) {
		const snap = this.appSnapshot(localeOverride);
		this.lastAppJson = JSON.stringify(snap);
		this.sup?.pushHost?.({ t: "app", ...snap });
	}

	private pushPluginPrefs(plugin: string) {
		const snap = this.prefs.snapshot(plugin);
		this.sup?.pushHost?.({ t: "prefs", plugin, ...snap });
	}

	private pushPluginL10n(plugin: string) {
		const raw = this.l10n.rawBundles(plugin);
		if (raw) {
			this.sup?.pushHost?.({ t: "l10n", plugin, defaultLocale: raw.defaultLocale, bundles: raw.bundles });
		}
	}

	/** Call a plugin export; rejects if the plugin is not there. */
	deliver(plugin: string, iface: string, fn: string, args: unknown[]): Promise<unknown> {
		if (!this.sup) return Promise.reject(new Error("no supervisor attached"));
		return this.manager.callPlugin(plugin, iface, fn, args); // the supervisor runs one call into a plugin at a time
	}

	/** Wire the supervisor's events in: stopped or failed plugins lose their timers and observers; log lines go to the ring. */
	attach(sup: PluginSupervisor) {
		this.sup = sup;
		this.manager.attach(sup);
		sup.on("status", (e) => {
			if (e.status === "stopped" || e.status === "failed" || e.status === "disabled" || e.status === "loading") this.cleanup(e.plugin);
		});
		sup.on("host-restart", () => {
			for (const id of [...this.prefSubs.keys(), ...this.pluginObservers]) this.cleanup(id);
			this.timers.clearEverything();
		});
		sup.on("log", (e) => {
			this.logs.push(e.plugin, e.level, e.message);
			if (e.isError && e.plugin) this.logs.recordError(e.plugin, e.rawMessage ?? e.message, e.stack);
			if (e.dropped && e.plugin) this.logs.addDropped(e.plugin, e.dropped);
		});
		sup.on("timers-count", (e) => this.timers.setRemoteCount(e.plugin, e.count));
	}

	/** Everything a plugin registered through this area: timers, pref observers, plugin-event observer. Run at shutdown and on failure. */
	cleanup(plugin: string) {
		this.timers.clearAll(plugin);
		this.prefSubs.delete(plugin);
		this.nextSub.delete(plugin);
		this.pluginObservers.delete(plugin);
	}

	// ---- pref observers -----------------------------------------------------------------------------------------------------

	observePref(plugin: string, scope: "plugin-own" | "app", key: string, prefix: boolean): number {
		let m = this.prefSubs.get(plugin);
		if (!m) this.prefSubs.set(plugin, (m = new Map()));
		const id = (this.nextSub.get(plugin) ?? 0) + 1;
		this.nextSub.set(plugin, id);
		m.set(id, { scope, key, prefix });
		return id;
	}

	unobservePref(plugin: string, id: number) {
		this.prefSubs.get(plugin)?.delete(id);
	}

	private fanOut(plugin: string, scope: "plugin-own" | "app", key: string, value: PrefValue | undefined) {
		for (const [id, s] of this.prefSubs.get(plugin) ?? []) {
			if (s.scope !== scope) continue;
			if (s.prefix ? key.startsWith(s.key) : key === s.key) {
				// after the handler that caused the change has answered
				setTimeout(() => void this.deliver(plugin, "events", "on-pref-changed", [id, scope, key, value === undefined ? undefined : toWire(value)]).catch(() => {}), 0);
			}
		}
	}

	private fanOutPref(c: PrefChange) {
		this.fanOut(c.plugin, "plugin-own", c.key, c.value);
	}

	private fanOutAppPref(key: string, value: PrefValue | undefined) {
		if (!APP_PREF_ALLOWLIST.includes(key)) return; // plugins only ever hear about allowlisted settings
		const appPrefs = this.appPrefsSnapshot();
		this.lastAppPrefsJson = JSON.stringify(appPrefs);
		this.sup?.pushHost?.({ t: "prefs", appPrefs });
		for (const plugin of this.prefSubs.keys()) this.fanOut(plugin, "app", key, value);
	}

	subscriptionCount(plugin: string): number {
		return this.prefSubs.get(plugin)?.size ?? 0;
	}

	// ---- plugin events, locale ----------------------------------------------------------------------------------------------

	observePlugins(plugin: string) {
		this.pluginObservers.add(plugin);
	}

	stopObservingPlugins(plugin: string) {
		this.pluginObservers.delete(plugin);
	}

	private fanOutPluginEvent(e: { plugin: string; hook: string; why: string }) {
		for (const observer of this.pluginObservers) void this.deliver(observer, "events", "on-plugin-event", [e.plugin, e.hook, e.why]).catch(() => {});
	}

	private fanOutLocale(tag: string) {
		this.pushAppState(tag);
		const info = this.app.info();
		this.lastLocale = tag;
		this.lastTimeZone = info.timeZone;
		this.sup?.pushHost?.({ t: "l10n", locale: tag, timeZone: info.timeZone });
		for (const p of this.sup?.list() ?? []) {
			this.l10n.invalidate(p.id);
			if (p.status === "running") void this.deliver(p.id, "events", "on-locale-changed", [tag]).catch(() => {});
		}
	}

	dispose() {
		this.offApp?.();
		this.timers.clearEverything();
		if (current === this) current = undefined;
	}
}

// ---- the module-level slot -------------------------------------------------------------------------------------------------------

let current: PluginServices | undefined;

export function setServices(s: PluginServices | undefined) {
	current = s;
}

/**
 * The services of this process: the ones `createPluginRuntime` (or `setServices`) registered. There is ONE per process, because the
 * handlers of the supervisor's `importHandlers` find them here; a second runtime in the same process replaces the first.
 */
export function getServices(): PluginServices {
	if (!current) throw new Error("plugin services are not set up: call createPluginRuntime() first");
	return current;
}

export interface RuntimeOptions extends ServicesOptions {
	/** Replaces `discoverHandlers("zinc")` (tests that load only some areas' handlers). */
	handlers?: ImportHandler[];
	/** Extra `where: "zinc"` handlers (the app's own), besides the discovered ones. */
	extraHandlers?: ImportHandler[];
	supervisor?: SupervisorOptions;
	/** Core's HTTP base URL for host handlers. */
	coreUrl?: string;
}

/** The one-liner for the app: services + supervisor, wired together and registered as the process's services. */
export async function createPluginRuntime(o: RuntimeOptions = {}): Promise<{ services: PluginServices; supervisor: PluginSupervisor }> {
	const zhwPath = o.supervisor?.zhwPath ?? o.manager?.zhwPath;
	const services = new PluginServices({
		...o,
		manager: {
			...(zhwPath ? { zhwPath } : {}),
			...o.manager,
		},
	});
	setServices(services);
	const importHandlers = [...(o.handlers ?? (await discoverHandlers("zinc"))), ...(o.extraHandlers ?? [])];
	const supervisor = createPluginSupervisor({
		coreUrl: o.coreUrl,
		...(zhwPath ? { zhwPath } : {}),
		cwasmOf: (id, _dir, manifest) => services.manager.cwasmFor(id, manifest),
		loadStateFor: (id, dir, manifest) => services.loadStateFor(id, dir, manifest),
		initState: () => services.initState(),
		beforeCall: () => services.syncBeforeCall(),
		...o.supervisor,
		importHandlers: [...importHandlers, ...(o.supervisor?.importHandlers ?? [])],
		grantsFor: (m) => services.manager.grants.grantsFor(m),
	});
	services.attach(supervisor);
	return { services, supervisor };
}
