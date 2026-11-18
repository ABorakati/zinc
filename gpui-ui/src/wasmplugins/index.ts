// WASM plugins in the app process: the plugin runtime (supervisor + package manager + services), start-up behind a switch, the
// `where: "zinc"` handlers and the "clear what a plugin registered" wiring.
//
// OFF BY DEFAULT. Plugins start only when the setting `shell.wasmPlugins` (Settings > Plugins, persisted in ui-state.json) or the
// environment variable ZN_WASM_PLUGINS=1 is on, so the default app does not change. Nothing in this module runs until
// `startWasmPlugins()` is called (src/platform.ts, `afterFeatures`).
//
// What startWasmPlugins() does when plugins are on (phase2-integrate.md):
//   1. createPluginRuntime(): the package area's services and the one supervisor, with every `where: "zinc"` handler
//      (plugin-host/src/imports/*.zinc.ts, found by discoverHandlers) and the run-time permission prompt (ui area).
//   2. wireApp() (wire.ts): file picker, clipboard and shell hooks, plugin prefs for settings panes, drops as grants, reader tab functions.
//   3. binds the extension points to the window (extend/bind.ts) and installs the reader bridge.
//   4. clears every area's registrations when a plugin stops, is disabled or fails, and all of them when the host restarts.
//   5. manager.startAll() (installed and enabled plugins), then main-window-load.
//
// For the other areas (ui, reader, extend):
//   getPluginSupervisor()            the supervisor, or undefined while plugins are off
//   pluginSupervisor()               the same, reactive (inside effects / JSX)
//   useWasmPlugins()                 { enabled, supervisor, status(id) } accessors for components
//   callPlugin(plugin, iface, fn, args)    queued by the supervisor: one call at a time per plugin
//   onPluginRegistrationsReset(fn)   run `fn(pluginId | undefined)` when a plugin's registrations must go (stop, disable, failure,
//                                    host restart = every plugin); the supervisor then replays `startup`, so plugins register again
//   addZincHandlers(list)            more `where: "zinc"` handlers, before startup (used by tests)
//
// Test and dev entry: `startWasmPlugins({ force, dirs, handlers })` loads the given built plugin folders straight into a plain
// supervisor (declared permissions granted, no package manager, no real plugins folder touched). `ZN_WASM_PLUGIN_DIRS` (path
// delimiter separated) does the same for a running app.
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createMemo } from "solid-js";
import { discoverHandlers, type ImportHandler } from "../../../plugin-host/src/imports/registry";
import { configureFs } from "../../../plugin-host/src/imports/data/fs-roots";
import { declaredGrants } from "../../../plugin-host/src/manifest";
import { createLayout, pluginsRoot } from "../../../plugin-host/src/package/layout";
import { createPluginRuntime, type PluginServices } from "../../../plugin-host/src/package/services";
import { createPluginSupervisor, type PluginInfo, type PluginSupervisor, type SupervisorOptions } from "../../../plugin-host/src/supervisor";
import { BASE_URL } from "../api";
import { getPref } from "../shell/prefs";
import { setWasmPluginsEnabled, wasmPluginsEnabled } from "./flag";
export { setWasmPluginsEnabled, wasmPluginsEnabled };
import { extendHandler } from "./extend/handler";
import { clearPluginRegistrations } from "./extend/registry";
import {
	callPlugin,
	getPluginSupervisor,
	onPluginRegistrationsReset,
	pluginList,
	pluginSupervisor,
	setPluginList,
	resetPluginRegistrations,
	setPluginSupervisor,
} from "./host";

export { callPlugin, getPluginSupervisor, onPluginRegistrationsReset, pluginSupervisor, resetPluginRegistrations, setPluginSupervisor };
export type { PluginInfo, PluginSupervisor };

/** Where plugins live (the package area's root: ZN_PLUGINS_DIR, else %APPDATA%\zotero-next-gpui\plugins). */
export function pluginsDir(): string {
	return pluginsRoot();
}

/** Plugin folders in `dir` that are loadable (manifest.json and the transpiled entry). Default: the package area's `installed/` folder. */
export function listInstalled(dir: string = createLayout(pluginsRoot()).installedRoot): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name))
			.filter((p) => existsSync(join(p, "manifest.json")) && existsSync(join(p, "transpiled", "plugin.js")))
			.sort();
	} catch {
		return [];
	}
}

// ---- handlers ------------------------------------------------------------------------------------------------------------

const extraHandlers: ImportHandler[] = [];
export function addZincHandlers(list: ImportHandler[]): void {
	extraHandlers.push(...list);
}

/** Every `where: "zinc"` handler: the ones found in plugin-host/src/imports (ui, reader, extend, fs, ... : one file per area), and any added. */
export async function collectZincHandlers(): Promise<ImportHandler[]> {
	const all = [...(await discoverHandlers("zinc")), extendHandler, ...extraHandlers];
	// extend.zinc.ts re-exports `extendHandler`: the same object must not be listed twice
	return [...new Set(all)];
}

// ---- the runtime ---------------------------------------------------------------------------------------------------------

export interface StartOptions {
	/** Built plugin folders to load straight into a plain supervisor (tests, dev). Implies no package manager. */
	dirs?: string[];
	/** Start even when the switch is off (tests). */
	force?: boolean;
	/** false: do not bind the extension points to the app window (unit tests without the store). */
	bindUi?: boolean;
	/** Handlers to use instead of collectZincHandlers() (tests). Implies no package manager. */
	handlers?: ImportHandler[];
	supervisor?: SupervisorOptions;
	/** Use the package runtime (installed plugins, permissions, prefs ...). Default: yes, unless `dirs` or `handlers` is given. */
	runtime?: boolean;
}

let starting: Promise<PluginSupervisor | undefined> | undefined;
let services: PluginServices | undefined;
let stopHooks: Array<() => void> = [];

/** The plugin services (package manager, prefs, logs ...) while the package runtime is up. */
export const pluginServices = (): PluginServices | undefined => services;

/** The plugins the supervisor knows, with their status. Reactive. */
export const installedPlugins = pluginList;

function refreshList(): void {
	setPluginList(getPluginSupervisor()?.list() ?? []);
}

/** What the app tells plugins about itself (`app.get-info`, `prefs.get-app`). */
const appProviders = () => ({
	version: process.env.ZN_VERSION,
	features: () => ["extend.menubar"],
	isUiReady: () => true,
	mainWindows: () => [1],
	activeWindow: () => 1,
	appPrefs: {
		get(key: string) {
			const v = getPref<unknown>(key, undefined);
			return typeof v === "boolean" || typeof v === "number" || typeof v === "string" ? v : undefined;
		},
	},
});

/** Create the runtime and load + start the installed plugins. Resolves with the supervisor, or undefined when plugins are off. Idempotent. */
export function startWasmPlugins(opts: StartOptions = {}): Promise<PluginSupervisor | undefined> {
	if (!opts.force && !wasmPluginsEnabled()) return Promise.resolve(undefined);
	starting ??= (async () => {
		const useRuntime = opts.runtime ?? (!opts.dirs && !opts.handlers);
		let sup: PluginSupervisor;
		if (useRuntime) {
			// The host process (a separate process) finds the plugins' data and temp folders through the environment it inherits.
			const layout = createLayout(pluginsRoot());
			process.env.ZN_PLUGIN_DATA_DIR ??= layout.dataRoot;
			process.env.ZN_PLUGIN_TEMP_DIR ??= layout.tempRoot;
			configureFs({ dataRoot: process.env.ZN_PLUGIN_DATA_DIR, tempRoot: process.env.ZN_PLUGIN_TEMP_DIR });
			const { promptPermission } = await import("./ui");
			const rt = await createPluginRuntime({
				coreUrl: BASE_URL,
				handlers: opts.handlers ?? (await collectZincHandlers()),
				app: appProviders(),
				prompt: (req) => promptPermission(req as unknown as Parameters<typeof promptPermission>[0]),
				manager: { root: layout.root },
				supervisor: opts.supervisor,
			});
			services = rt.services;
			sup = rt.supervisor;
			services.manager.on("changed", refreshList);
		} else {
			sup = createPluginSupervisor({
				importHandlers: opts.handlers ?? (await collectZincHandlers()),
				coreUrl: BASE_URL,
				...opts.supervisor,
			});
		}
		setPluginSupervisor(sup);
		if (useRuntime) (await import("./wire")).wireApp();
		if (opts.bindUi !== false) {
			await import("./extend/bind").then((m) => m.bindExtendUi()); // the main window side of the extension points
			const { installReaderBridge } = await import("./reader");
			stopHooks.push(installReaderBridge());
			const { clearUiOf } = await import("./ui");
			stopHooks.push(onPluginRegistrationsReset((plugin) => clearUiOf(plugin)));
		}
		// what a plugin registered goes when it stops, is disabled or fails, and everything goes when the host restarts
		sup.on("host-restart", () => {
			clearPluginRegistrations();
			resetPluginRegistrations(undefined);
			refreshList();
		});
		sup.on("host-restarted", refreshList);
		sup.on("status", (e) => {
			if (e.status === "stopped" || e.status === "disabled" || e.status === "failed" || e.status === "stopping") {
				clearPluginRegistrations(e.plugin);
				resetPluginRegistrations(e.plugin);
			}
			refreshList();
		});
		sup.on("log", (e) => {
			if (e.level === "error") console.error(`[plugin${e.plugin ? ` ${e.plugin}` : ""}]`, e.message);
		});
		await sup.ready();
		if (services) {
			await services.manager.startAll().catch((e) => console.error("[wasmplugins] startAll:", e instanceof Error ? e.message : e));
			await services.manager.windowLoaded(1).catch(() => {});
		}
		// built folders given directly (tests, dev): loaded as they are, with the permissions their manifests declare
		const dirs = opts.dirs ?? (process.env.ZN_WASM_PLUGIN_DIRS ?? "").split(delimiter).filter(Boolean);
		for (const dir of dirs) {
			try {
				const info = await sup.load(dir);
				sup.setGrants(info.id, declaredGrants(info.manifest));
				await sup.start(info.id, { why: "app-startup" });
				await sup
					.call(info.id, "lifecycle", "main-window-load", [{ id: info.id, version: info.manifest.version, previousVersion: undefined }, 1])
					.catch(() => {}); // a plugin without the hook
			} catch (e) {
				console.error(`[wasmplugins] ${dir}:`, e instanceof Error ? e.message : e);
			}
		}
		refreshList();
		return sup;
	})();
	return starting;
}

/** Stop every plugin and the plugin host; the default app is back as before. */
export async function stopWasmPlugins(): Promise<void> {
	const sup = getPluginSupervisor();
	starting = undefined;
	if (!sup) return;
	await services?.manager.stopAll().catch(() => {});
	await sup.shutdown().catch(() => {});
	services?.dispose();
	services = undefined;
	setPluginSupervisor(undefined);
	await import("./extend/bind").then((m) => m.unbindExtendUi()).catch(() => {});
	for (const h of stopHooks.splice(0)) h();
	await import("./wire").then((m) => m.unwireApp()).catch(() => {});
	clearPluginRegistrations();
	resetPluginRegistrations(undefined);
	setPluginList([]);
}

/** Accessors for components. */
export function useWasmPlugins() {
	const running = createMemo(() => pluginSupervisor() !== undefined);
	return {
		enabled: wasmPluginsEnabled,
		running,
		supervisor: pluginSupervisor,
		plugins: installedPlugins,
		status: (id: string) => installedPlugins().find((p) => p.id === id)?.status,
	};
}
