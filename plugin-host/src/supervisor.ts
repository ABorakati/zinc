// The plugin supervisor. Runs in the Zinc process (the one that owns the UI and the in-process core):
//   wasmtime (default): spawns `zhw` (transport-wasmtime.ts), runs both `*.host.ts` and `*.zinc.ts` handlers in-process, and lets
//                       `zhw` enforce per-plugin CPU epoch timeouts and memory caps without killing other plugins.
//   worker (fallback):  spawns the Bun plugin host process (`host-main.ts`), sends it loads and calls, watches active-time budgets,
//                       and on a timeout kills the host, starts a new one and reloads every plugin except the stuck one.
//
// Time budgets count only time the plugin is RUNNING: while it waits for a host import its timers are paused.
//
// ONE CALL AT A TIME PER PLUGIN. Every call into a plugin (`call`, `start`, `stop`, `enable`, `ctx.callExport` of a handler) goes
// through one queue per plugin, and its budget starts when it leaves the queue.
import { statSync } from "node:fs";
import { join } from "node:path";
import { TRANSPILED_ENTRY, declaredGrants, readManifest, type Grants, type PluginManifest } from "./manifest";
import {
	HandlerTable,
	WitError,
	discoverHandlers,
	loadHandlerModule,
	type HandlerContext,
	type ImportHandler,
} from "./imports/registry";
import { camel, ifaceName, shortIface } from "./names";
import { runHandler } from "./router";
import {
	DEFAULT_TIMEOUTS,
	PluginError,
	type FromHost,
	type LogLevel,
	type PluginL10nState,
	type PluginPrefsState,
	type PluginSpec,
	type ToHost,
	type WireError,
	type WireResult,
} from "./protocol";
import { spawnWasmtimeTransport } from "./transport-wasmtime";

export type PluginStatus = "loading" | "loaded" | "starting" | "running" | "stopping" | "stopped" | "failed" | "disabled";
export type PluginRunner = "wasmtime" | "worker";

export interface PluginInfo {
	id: string;
	dir: string;
	manifest: PluginManifest;
	status: PluginStatus;
	/** Why the plugin is `disabled` or `failed`. */
	reason?: string;
	grants: Grants;
}

export interface LoadInfo {
	compileMs?: number;
	linkMs?: number;
	instantiateMs?: number;
	totalMs?: number;
	fromCwasm?: boolean;
}

export interface SupervisorInitState {
	debugEnabled?: boolean;
	app?: unknown;
	appPrefs?: Record<string, boolean | number | string>;
	locale?: string;
	timeZone?: string;
}

export interface SupervisorLoadState {
	prefs?: PluginPrefsState;
	l10n?: PluginL10nState;
}

export interface SupervisorOptions {
	/** `where: "zinc"` handlers (from `discoverHandlers("zinc")`, plus the app's own). */
	importHandlers?: ImportHandler[];
	/** Extra `where: "host"` handler modules (absolute paths) besides src/imports/*.host.ts. */
	hostHandlerModules?: string[];
	/** false: do not load `src/imports/*.host.ts`, only `hostHandlerModules` (tests with their own stub handlers). Default true. */
	discoverHostHandlers?: boolean;
	/** Core's HTTP base URL for host handlers (`ctx.coreUrl`). */
	coreUrl?: string;
	/**
	 * Extra budget for plugins with a large jco-transpiled JS file (`runner: "worker"` only; always 0 on `wasmtime`).
	 * Defaults: 8 MB, 3000 ms/MB, max 300 s. `false` turns it off.
	 */
	coldBudget?: false | { thresholdBytes?: number; msPerMb?: number; maxMs?: number };
	/**
	 * Where a plugin runs. `"wasmtime"` (default): native Wasmtime host (`zhw`). `"worker"`: a Bun Worker in `host-main.ts`
	 * (also selected when `ZN_PLUGIN_RUNNER=worker` and `opts.runner` is omitted).
	 */
	runner?: PluginRunner;
	/** Explicit path to the `zhw` binary (`wasmtime` runner). */
	zhwPath?: string;
	/** Per-plugin linear memory limit in MiB (`wasmtime` runner). */
	maxMemoryMb?: number;
	/** Per-call import invocation limit (`wasmtime` runner). */
	maxImportCalls?: number;
	/** Interfaces (or `iface.fn` selectors) handled natively by `zhw` in Rust (`wasmtime` runner). */
	nativeImports?: string[];
	/** Look up a precompiled `.cwasm` path for a plugin (`wasmtime` runner). */
	cwasmOf?: (id: string, dir: string, manifest: PluginManifest) => string | undefined | Promise<string | undefined>;
	/** Initial cached `prefs` and `l10n` bundles passed in `load` (`wasmtime` runner). */
	loadStateFor?: (id: string, dir: string, manifest: PluginManifest) => SupervisorLoadState | undefined;
	/** Initial `app`, `debugEnabled`, `appPrefs`, `locale` passed at `zhw` startup (`wasmtime` runner). */
	initState?: () => SupervisorInitState | undefined;
	/** Optional hook run synchronously right before sending a `call` to `zhw` (`wasmtime` runner), to flush pull-provider diffs. */
	beforeCall?: () => void;
	/** Active-time budget of an export call, ms. Default 5000. */
	callTimeoutMs?: number;
	/** Budget of install/startup/shutdown/uninstall, ms. Default 10000, or the manifest's `main.startup_timeout_ms`. */
	lifecycleTimeoutMs?: number;
	/** Budget of loading a component, ms. Default 15000. */
	loadTimeoutMs?: number;
	/** Heartbeat period of the host and the silence that counts as a hung host, ms. Defaults 1000 and 5000. */
	heartbeatMs?: number;
	heartbeatTimeoutMs?: number;
	/** At most this many host restarts in `restartWindowMs` before the supervisor gives up (event "host-failed"). Default 5 in 60 s. */
	maxRestarts?: number;
	restartWindowMs?: number;
	/** Command that runs Bun (`worker` runner). Default: this process's executable (`BUN_BE_BUN=1`). */
	runtime?: string[];
	/** Path of host-main.ts (`worker` runner). Default: the one next to this file. */
	hostEntry?: string;
	/** What the plugin may do. Default: what its manifest declares. */
	grantsFor?: (manifest: PluginManifest) => Grants;
	/** The host's stderr. Default "ignore". "inherit" shows panics of the host itself. */
	hostStderr?: "ignore" | "inherit";
}

export interface SupervisorEvents {
	/** The host process is up (first start and after each restart). */
	"host-ready": { pid: number; restarts: number };
	/** The host is being killed and replaced. After this event all plugins are reloaded. */
	"host-restart": { reason: "timeout" | "heartbeat" | "crash"; plugin?: string; detail: string };
	/** Restart finished: these plugins were reloaded (and started again if they were running). */
	"host-restarted": { reloaded: string[]; disabled: string[] };
	"host-failed": { detail: string };
	status: { plugin: string; status: PluginStatus; reason?: string };
	log: { plugin?: string; level: LogLevel; message: string; rawMessage?: string; stack?: string; isError?: boolean; dropped?: number };
	"timers-count": { plugin: string; count: number };
}

type Handler<K extends keyof SupervisorEvents> = (e: SupervisorEvents[K]) => void;

interface Pending {
	id: number;
	plugin: string;
	phase: string;
	budgetMs: number;
	spentMs: number;
	resolve: (r: WireResult) => void;
}

interface Record_ extends PluginInfo {
	/** Budget added to every call (`worker` runner only; see SupervisorOptions.coldBudget). */
	coldBonusMs: number;
	wantRunning: boolean;
	/** zinc-side imports in flight + host-side ones reported by the host. */
	zincWaiting: number;
	hostWaiting: number;
}

interface HostProcess {
	readonly pid: number | undefined;
	readonly exited: Promise<unknown>;
	send(msg: ToHost): void;
	kill(): void;
}

const POLL_MS = 25;
const DEFAULT_CHATTY_NATIVE = ["log", "prefs", "timers", "l10n", "app", "util"] as const;

export interface PluginSupervisor {
	/** Read `<pkgDir>/manifest.json`, load and instantiate the component in the host. Does not call `startup`. */
	load(pkgDir: string): Promise<PluginInfo>;
	/** Call `lifecycle.startup`. `why` is a `lifecycle.reason`. Resolves when it returns ok; a WIT error or a trap marks the plugin failed and rejects. */
	start(id: string, opts?: { why?: string; previousVersion?: string }): Promise<void>;
	/** Call `lifecycle.shutdown`, leaving the plugin loaded but stopped. */
	stop(id: string, opts?: { why?: string }): Promise<void>;
	/** Unload the plugin from the host and forget it. */
	unload(id: string): Promise<void>;
	/** Call an export. `args` in jco's representation. Resolves with the value; rejects with PluginError. */
	call(id: string, iface: string, fn: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<unknown>;
	/** Clear `disabled`/`failed`, load again and start. */
	enable(id: string): Promise<void>;
	/** Replace a plugin's grants (and tell the host). Does not call `events.on-permission-changed`. */
	setGrants(id: string, grants: Grants): void;
	get(id: string): PluginInfo | undefined;
	list(): PluginInfo[];
	on<K extends keyof SupervisorEvents>(event: K, handler: Handler<K>): () => void;
	/** Wait for the host process to be up. */
	ready(): Promise<void>;
	/** Budget added to the plugin's calls because its transpiled JS is large (0 on `wasmtime` and for small plugins). */
	coldBonusMs(id: string): number;
	/** Active runner (`"wasmtime"` or `"worker"`). */
	readonly runner?: PluginRunner;
	/** Push a fire-and-forget state update (`prefs`, `l10n`, `app`, `log-config`, `timers-clear`) to `zhw` (`wasmtime` runner). */
	pushHost?(msg: Record<string, unknown>): void;
	/** Query `zhw` host RSS and per-plugin telemetry (`wasmtime` runner). */
	stats?(): Promise<unknown>;
	/** Load telemetry (`fromCwasm`, `compileMs`, ...) from the most recent `load` of `id`. */
	lastLoadInfo?(id: string): LoadInfo | undefined;
	readonly hostPid: number | undefined;
	readonly restarts: number;
	/** Stop everything and kill the host. */
	shutdown(): Promise<void>;
}

export function createPluginSupervisor(opts: SupervisorOptions = {}): PluginSupervisor {
	const envRunner = process.env.ZN_PLUGIN_RUNNER ?? process.env.ZN_TEST_RUNNER;
	const runner: PluginRunner = opts.runner ?? (envRunner === "worker" ? "worker" : "wasmtime");
	const callMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUTS.call;
	const lifecycleMs = opts.lifecycleTimeoutMs ?? DEFAULT_TIMEOUTS.lifecycle;
	const loadMs = opts.loadTimeoutMs ?? DEFAULT_TIMEOUTS.load;
	const heartbeatMs = opts.heartbeatMs ?? 1000;
	const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 5000;
	const maxRestarts = opts.maxRestarts ?? 5;
	const restartWindowMs = opts.restartWindowMs ?? 60_000;
	const runtime = opts.runtime ?? [process.execPath];
	const hostEntry = opts.hostEntry ?? join(import.meta.dir, "host-main.ts");

	let table = new HandlerTable(opts.importHandlers ?? []);
	let hostTablePromise: Promise<{ table: HandlerTable; hostModIfaces: Set<string> }> | undefined;
	function ensureCombinedTable(): Promise<{ table: HandlerTable; hostModIfaces: Set<string> }> {
		if (runner === "worker") return Promise.resolve({ table, hostModIfaces: new Set() });
		hostTablePromise ??= (async () => {
			const discovered = opts.discoverHostHandlers === false ? [] : await discoverHandlers("host");
			const extraMods = (await Promise.all((opts.hostHandlerModules ?? []).map(loadHandlerModule))).flat();
			const hostModIfaces = new Set(extraMods.map((h) => shortIface(h.interface)));
			// Order: discovered *.host.ts -> importHandlers (*.zinc.ts + app) -> explicit hostHandlerModules overrides
			const merged = new HandlerTable([...discovered, ...(opts.importHandlers ?? []), ...extraMods]);
			table = merged;
			return { table: merged, hostModIfaces };
		})();
		return hostTablePromise;
	}

	function resolveNativeImports(hostModIfaces: Set<string>): string[] {
		if (opts.nativeImports !== undefined) return opts.nativeImports;
		if (opts.discoverHostHandlers === false) return [];
		if (opts.initState) {
			return DEFAULT_CHATTY_NATIVE.filter((n) => !hostModIfaces.has(n));
		}
		const overridden = new Set([
			...(opts.importHandlers ?? []).map((h) => shortIface(h.interface)),
			...hostModIfaces,
		]);
		return ["util"].filter((n) => !overridden.has(n));
	}

	const cold =
		runner !== "worker" || opts.coldBudget === false
			? undefined
			: { thresholdBytes: 8_000_000, msPerMb: 3000, maxMs: 300_000, ...opts.coldBudget };
	const coldBonusOf = (dir: string): number => {
		if (!cold) return 0;
		try {
			const size = statSync(join(dir, TRANSPILED_ENTRY)).size;
			return size < cold.thresholdBytes ? 0 : Math.min(cold.maxMs, Math.round((size / 1e6) * cold.msPerMb));
		} catch {
			return 0;
		}
	};

	// One chain per plugin. `chain` never rejects the tail, so one failed call does not stop the next.
	const gates = new Map<string, Promise<void>>();
	function chain<T>(map: Map<string, Promise<void>>, id: string, job: () => Promise<T>): Promise<T> {
		const prev = map.get(id) ?? Promise.resolve();
		const run = prev.then(job);
		const tail = run.then(
			() => {},
			() => {},
		);
		map.set(id, tail);
		void tail.then(() => {
			if (map.get(id) === tail) map.delete(id);
		});
		return run;
	}

	const plugins = new Map<string, Record_>();
	const loadInfos = new Map<string, LoadInfo>();
	const listeners = new Map<string, Set<(e: any) => void>>();
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let proc: HostProcess | undefined;
	let spawning: Promise<void> | undefined;
	let hostReady: Promise<void> = Promise.resolve();
	let resolveReady: (() => void) | undefined;
	let lastBeat = 0;
	let restarts = 0;
	const restartTimes: number[] = [];
	let restarting: Promise<void> | undefined;
	let shuttingDown = false;
	let failed = false;
	let lastTick = Date.now();

	const emit = <K extends keyof SupervisorEvents>(event: K, e: SupervisorEvents[K]) => {
		for (const h of listeners.get(event) ?? []) {
			try {
				h(e);
			} catch (err) {
				console.error(`[plugin-host] listener for ${event} threw`, err);
			}
		}
	};

	const setStatus = (r: Record_, status: PluginStatus, reason?: string) => {
		r.status = status;
		r.reason = reason;
		emit("status", { plugin: r.id, status, reason });
	};

	const info = (r: Record_): PluginInfo => ({ id: r.id, dir: r.dir, manifest: r.manifest, status: r.status, reason: r.reason, grants: r.grants });

	// ---- sending ----------------------------------------------------------------------------------------------------

	const sendRaw = (m: ToHost) => {
		try {
			proc?.send(m);
		} catch {
			/* the host is gone; the exit handler restarts it */
		}
	};

	/** Send a request and wait for its reply under an active-time budget. `plugin` ties the budget to that plugin's waiting state. */
	function request(
		m: Extract<ToHost, { t: "load" | "unload" | "call" | "stats" }>,
		plugin: string,
		phase: string,
		budgetMs: number,
	): Promise<WireResult> {
		return new Promise((resolve) => {
			pending.set(m.id, { id: m.id, plugin, phase, budgetMs, spentMs: 0, resolve });
			sendRaw(m);
		});
	}

	function callRequest(plugin: string, iface: string, fn: string, args: unknown[], budgetMs: number): Promise<WireResult> {
		if (runner === "wasmtime" && proc) opts.beforeCall?.();
		return request(
			{
				t: "call",
				id: nextId++,
				plugin,
				iface,
				fn,
				args,
				timeoutMs: budgetMs,
				...(opts.maxImportCalls !== undefined ? { maxImportCalls: opts.maxImportCalls } : {}),
			},
			plugin,
			`${iface}#${fn}`,
			budgetMs,
		);
	}

	function settle(id: number, result: WireResult) {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		p.resolve(result);
	}

	function failAll(error: (p: Pending) => WireError) {
		for (const p of [...pending.values()]) settle(p.id, { ok: false, error: error(p) });
	}

	// ---- time budgets and heartbeat -------------------------------------------------------------------------------------

	const ticker = setInterval(() => {
		const now = Date.now();
		const dt = now - lastTick;
		lastTick = now;
		if (shuttingDown || !proc) return;
		if (!restarting && lastBeat && now - lastBeat > heartbeatTimeoutMs) {
			void restart("heartbeat", undefined, `no heartbeat for ${now - lastBeat} ms`);
			return;
		}
		if (runner !== "worker") return; // `zhw` owns per-call CPU timeouts via Wasmtime epochs
		for (const p of pending.values()) {
			const r = plugins.get(p.plugin);
			if (r && r.zincWaiting + r.hostWaiting > 0) continue; // waiting for a host import: not the plugin's time
			p.spentMs += dt;
			if (p.spentMs > p.budgetMs) {
				void restart("timeout", p.plugin, `${p.phase} exceeded ${p.budgetMs} ms`, p);
				return;
			}
		}
	}, POLL_MS);
	ticker.unref?.();

	// ---- the host process -----------------------------------------------------------------------------------------------

	async function spawnHost(): Promise<void> {
		const { hostModIfaces } = await ensureCombinedTable();
		let readyTimer: ReturnType<typeof setTimeout> | undefined;
		hostReady = new Promise<void>((resolve, reject) => {
			resolveReady = () => {
				if (readyTimer) clearTimeout(readyTimer);
				resolve();
			};
			readyTimer = setTimeout(() => reject(new Error("the plugin host did not start in 20 s")), 20_000);
			readyTimer.unref?.();
		});
		hostReady.catch(() => {});

		if (runner === "wasmtime") {
			const handle: HostProcess = spawnWasmtimeTransport({
				zhwPath: opts.zhwPath,
				maxMemoryMb: opts.maxMemoryMb,
				hostStderr: opts.hostStderr,
				onMessage: (m) => onHostMessage(m),
				onExit: () => {
					if (proc === handle) {
						proc = undefined;
						if (!shuttingDown) void restart("crash", undefined, "the zhw plugin host process exited");
					}
				},
			});
			proc = handle;
			lastBeat = Date.now();
			const initExtra = opts.initState?.();
			sendRaw({
				t: "init",
				heartbeatMs,
				...(opts.maxMemoryMb !== undefined ? { maxMemoryMb: opts.maxMemoryMb } : {}),
				...(opts.maxImportCalls !== undefined ? { maxImportCalls: opts.maxImportCalls } : {}),
				native: resolveNativeImports(hostModIfaces),
				...(initExtra?.debugEnabled !== undefined ? { debugEnabled: initExtra.debugEnabled } : {}),
				...(initExtra?.app !== undefined ? { app: initExtra.app } : {}),
			});
			if (initExtra?.appPrefs && Object.keys(initExtra.appPrefs).length > 0) {
				sendRaw({ t: "prefs", appPrefs: initExtra.appPrefs });
			}
			if (initExtra?.locale !== undefined || initExtra?.timeZone !== undefined) {
				sendRaw({ t: "l10n", locale: initExtra.locale, timeZone: initExtra.timeZone });
			}
			return hostReady;
		}

		const child = Bun.spawn([...runtime, hostEntry], {
			ipc: (m: FromHost) => onHostMessage(m),
			serialization: "advanced",
			stdin: "ignore",
			stdout: "ignore",
			stderr: opts.hostStderr ?? "ignore",
			env: { ...process.env, BUN_BE_BUN: "1" },
			onExit: () => {
				if (proc === handle) {
					proc = undefined;
					if (!shuttingDown) void restart("crash", undefined, "the plugin host process exited");
				}
			},
		});
		const handle: HostProcess = {
			get pid() {
				return child.pid;
			},
			get exited() {
				return child.exited;
			},
			send(msg) {
				(child as any).send(msg);
			},
			kill() {
				child.kill();
			},
		};
		proc = handle;
		lastBeat = Date.now();
		sendRaw({ t: "init", coreUrl: opts.coreUrl, hostModules: opts.hostHandlerModules ?? [], heartbeatMs, discover: opts.discoverHostHandlers });
		return hostReady;
	}

	function ensureHost(): Promise<void> {
		if (failed) return Promise.reject(new PluginError({ kind: "internal", message: "plugin host failed to stay up" }));
		if (restarting) return restarting;
		if (proc) return hostReady;
		if (spawning) return spawning;
		spawning = spawnHost().finally(() => {
			spawning = undefined;
		});
		return spawning;
	}

	function emitLogEntry(e: { plugin?: string; level: LogLevel; message: string; stack?: string; isError?: boolean; dropped?: number }) {
		const rawMsg = e.stack && e.message.endsWith("\n" + e.stack) ? e.message.slice(0, -(e.stack.length + 1)) : e.message;
		const formatted = e.stack && !e.message.includes(e.stack) ? `${e.message}\n${e.stack}` : e.message;
		emit("log", {
			plugin: e.plugin,
			level: e.level,
			message: formatted,
			rawMessage: rawMsg,
			stack: e.stack,
			isError: e.isError,
			dropped: e.dropped,
		});
	}

	function onHostMessage(m: FromHost) {
		switch (m.t) {
			case "ready":
				lastBeat = Date.now();
				resolveReady?.();
				emit("host-ready", { pid: m.pid, restarts });
				break;
			case "heartbeat":
				lastBeat = Date.now();
				break;
			case "reply":
				settle(m.id, m.result);
				break;
			case "waiting": {
				const r = plugins.get(m.plugin);
				if (r) r.hostWaiting = m.n;
				break;
			}
			case "import":
				void onZincImport(m);
				break;
			case "call":
				// a host-side handler's ctx.callExport: queued like any other call
				queuedCall(m.plugin, m.iface, m.fn, m.args, { timeoutMs: m.timeoutMs }).then(
					(value) => sendRaw({ t: "call-reply", id: m.id, result: { ok: true, value } }),
					(e) =>
						sendRaw({
							t: "call-reply",
							id: m.id,
							result: { ok: false, error: e instanceof PluginError ? e.error : { kind: "internal", message: String(e?.message ?? e) } },
						}),
				);
				break;
			case "plugin-exit": {
				const r = plugins.get(m.plugin);
				if (r) {
					r.wantRunning = false;
					if (m.kind === "timeout") {
						if (r.status !== "disabled") setStatus(r, "disabled", m.message);
						void table.dropPlugin(zincContext(r));
					} else if (r.status !== "disabled") {
						setStatus(r, "failed", m.message);
						void table.dropPlugin(zincContext(r));
						if (runner === "wasmtime") sendRaw({ t: "unload", id: nextId++, plugin: m.plugin });
					}
				}
				break;
			}
			case "log":
				emitLogEntry(m);
				break;
			case "log-batch":
				for (const e of m.entries) emitLogEntry(e);
				break;
			case "timers-count":
				emit("timers-count", { plugin: m.plugin, count: m.count });
				break;
		}
	}

	async function onZincImport(m: Extract<FromHost, { t: "import" }>) {
		const r = plugins.get(m.plugin);
		const reply = (result: WireResult) => sendRaw({ t: "import-reply", id: m.id, result });
		if (!r || !table.has(m.iface, m.fn)) {
			reply({
				ok: false,
				error: { kind: "wit", payload: { tag: "unavailable", val: `unsupported: no handler for ${ifaceName(m.iface)}#${camel(m.fn)}` } },
			});
			return;
		}
		r.zincWaiting++;
		const live = { done: false }; // while false, calling back into the same plugin is refused (no re-entrant exports)
		try {
			reply(await runHandler(table, zincContext(r, live), m.iface, m.fn, m.args, (message) => emit("log", { plugin: r.id, level: "error", message })));
		} finally {
			live.done = true;
			r.zincWaiting--;
		}
	}

	function zincContext(r: Record_, live?: { done: boolean }): HandlerContext {
		const has = (p: string) => r.grants.capabilities.includes(p);
		return {
			pluginId: r.id,
			pluginDir: r.dir,
			manifest: r.manifest,
			get grants() {
				return r.grants;
			},
			where: "zinc",
			coreUrl: opts.coreUrl,
			has,
			require(p) {
				if (!has(p)) throw new WitError("permission-denied", p);
			},
			callExport: (iface, fn, args = [], o) =>
				live && !live.done
					? Promise.reject(new PluginError({ kind: "reentrant", plugin: r.id, message: "cannot call into plugin while it is waiting on a host import" }))
					: queuedCall(r.id, iface, fn, args, o),
			log: (level, message) => emit("log", { plugin: r.id, level, message }),
			resource: (name, state) => table.createResource(r.id, name, state),
		};
	}

	// ---- restart --------------------------------------------------------------------------------------------------------
	//
	// A restart is a job: disable the culprit (Worker timeout), fail what is in flight, kill the host, then start a new host
	// and reload the plugins. On `wasmtime`, per-plugin timeouts/traps do NOT restart `zhw`; `restart` only runs if `zhw`
	// itself crashes or misses heartbeats.

	interface RestartJob {
		reason: "timeout" | "heartbeat" | "crash";
		culprit?: string;
		detail: string;
	}
	const jobs: RestartJob[] = [];
	let dying: Promise<unknown>[] = [];

	function restart(reason: RestartJob["reason"], culprit: string | undefined, detail: string, timedOut?: Pending): Promise<void> {
		const now = Date.now();
		restartTimes.push(now);
		while (restartTimes.length && now - restartTimes[0] > restartWindowMs) restartTimes.shift();
		emit("host-restart", { reason, plugin: culprit, detail });
		const culpritRec = culprit ? plugins.get(culprit) : undefined;
		if (culpritRec) {
			culpritRec.wantRunning = false;
			setStatus(culpritRec, "disabled", `${detail} (the plugin host was restarted)`);
		}
		// Fail what is in flight: the call that timed out says "timeout", the culprit's others "disabled", everything else "host restarting".
		failAll((p) =>
			timedOut && p.id === timedOut.id
				? { kind: "timeout", ms: p.budgetMs, phase: p.phase }
				: p.plugin === culprit
					? { kind: "disabled", plugin: p.plugin, reason: detail }
					: { kind: "host-restarting" },
		);
		const old = proc;
		proc = undefined;
		if (old) {
			old.kill();
			dying.push(old.exited.catch(() => {}));
		}
		for (const r of plugins.values()) {
			r.zincWaiting = 0;
			r.hostWaiting = 0;
			void table.dropPlugin(zincContext(r)); // their handles died with the host process
		}
		jobs.push({ reason, culprit, detail });
		restarting ??= runRestarts()
			.catch((e) => {
				failed = true;
				emit("host-failed", { detail: String((e as Error)?.message ?? e) });
			})
			.finally(() => {
				restarting = undefined;
			});
		return restarting;
	}

	async function runRestarts() {
		while (jobs.length) {
			const job = jobs.shift()!;
			await Promise.all(dying);
			dying = [];
			if (jobs.length) continue; // a newer job supersedes this one: one spawn is enough
			if (restartTimes.length > maxRestarts) {
				failed = true;
				emit("host-failed", { detail: `${restartTimes.length} restarts in ${restartWindowMs} ms; last: ${job.detail}` });
				for (const r of plugins.values()) if (r.status !== "disabled") setStatus(r, "failed", "the plugin host keeps failing");
				return;
			}
			restarts++;
			await spawnHost();
			const todo = [...plugins.values()].filter((r) => r.status !== "disabled" && r.status !== "failed");
			const wasRunning = new Map(todo.map((r) => [r.id, r.wantRunning]));
			const reloaded: string[] = [];
			for (const r of todo) {
				if (jobs.length) break; // the host was killed again meanwhile
				try {
					setStatus(r, "loading");
					await loadRecord(r, true);
					if (wasRunning.get(r.id)) await startRecord(r, "app-startup");
					reloaded.push(r.id);
				} catch (e) {
					if (r.status !== "disabled" && !jobs.length) setStatus(r, "failed", `reload after host restart failed: ${(e as Error).message}`);
				}
			}
			if (!jobs.length) {
				emit("host-restarted", { reloaded, disabled: [...plugins.values()].filter((r) => r.status === "disabled").map((r) => r.id) });
			} else {
				// Plugins this pass did not get to are reloaded by the next one; they must be loadable again.
				for (const r of todo) if (r.status === "loading" || r.status === "starting") setStatus(r, "loaded");
			}
		}
	}

	// ---- the API ----------------------------------------------------------------------------------------------------------

	function toError(r: WireResult): never {
		throw new PluginError((r as { ok: false; error: WireError }).error);
	}

	async function loadRecord(r: Record_, fromRestart = false) {
		if (!fromRestart) await ensureHost();
		const cwasm = runner === "wasmtime" ? await opts.cwasmOf?.(r.id, r.dir, r.manifest) : undefined;
		const extra = runner === "wasmtime" ? opts.loadStateFor?.(r.id, r.dir, r.manifest) : undefined;
		const spec: PluginSpec = {
			id: r.id,
			dir: r.dir,
			...(cwasm ? { cwasm } : {}),
			manifest: r.manifest,
			grants: r.grants,
			...(extra?.prefs ? { prefs: extra.prefs } : {}),
			...(extra?.l10n ? { l10n: extra.l10n } : {}),
		};
		const res = await request({ t: "load", id: nextId++, plugin: spec }, r.id, "load", loadMs);
		if (!res.ok) {
			if (r.status !== "disabled") setStatus(r, "failed", `load failed: ${describe(res.error)}`);
			toError(res);
		}
		if (res.value && typeof res.value === "object") {
			loadInfos.set(r.id, res.value as LoadInfo);
		} else {
			loadInfos.delete(r.id);
		}
		setStatus(r, "loaded");
	}

	const describe = (e: WireError) => new PluginError(e).message;

	function lifecycleBudget(r: Record_) {
		return (r.manifest.main.startup_timeout_ms ?? lifecycleMs) + r.coldBonusMs;
	}

	function pluginData(r: Record_, previousVersion?: string) {
		return { id: r.id, version: r.manifest.version, previousVersion };
	}

	function handleCallFailure(r: Record_, res: { ok: false; error: WireError }, fallbackPhase: string, prefix?: string) {
		if (res.error.kind === "timeout") {
			r.wantRunning = false;
			setStatus(r, "disabled", `${res.error.phase || fallbackPhase} exceeded ${res.error.ms} ms`);
			void table.dropPlugin(zincContext(r));
			return;
		}
		if (res.error.kind === "trap" && r.status !== "disabled") {
			r.wantRunning = false;
			const msg = describe(res.error);
			setStatus(r, "failed", prefix ? `${prefix}: ${msg}` : msg);
			void table.dropPlugin(zincContext(r));
			sendRaw({ t: "unload", id: nextId++, plugin: r.id });
			return;
		}
		if (prefix && r.status !== "disabled") {
			setStatus(r, "failed", `${prefix}: ${describe(res.error)}`);
		}
	}

	async function startRecord(r: Record_, why: string, previousVersion?: string) {
		r.wantRunning = true;
		setStatus(r, "starting");
		const res = await callRequest(r.id, "lifecycle", "startup", [pluginData(r, previousVersion), why], lifecycleBudget(r));
		if (!res.ok) {
			r.wantRunning = false;
			handleCallFailure(r, res, "lifecycle#startup", "startup failed");
			toError(res);
		}
		setStatus(r, "running");
	}

	function must(id: string): Record_ {
		const r = plugins.get(id);
		if (!r) throw new PluginError({ kind: "not-loaded", plugin: id });
		return r;
	}

	function usable(r: Record_) {
		if (r.status === "disabled") throw new PluginError({ kind: "disabled", plugin: r.id, reason: r.reason ?? "" });
		if (r.status === "failed" || r.status === "loading") throw new PluginError({ kind: "not-loaded", plugin: r.id });
	}

	/** An ordinary call: waits for the plugin's other calls (and for a host restart in progress), then runs. */
	function queuedCall(id: string, iface: string, fn: string, args: unknown[], o: { timeoutMs?: number } = {}): Promise<unknown> {
		return chain(gates, id, async () => {
			await restarting;
			return callImpl(id, iface, fn, args, o);
		});
	}

	async function callImpl(id: string, iface: string, fn: string, args: unknown[], o: { timeoutMs?: number } = {}): Promise<unknown> {
		const r = must(id);
		usable(r);
		const budget = (o.timeoutMs ?? callMs) + r.coldBonusMs;
		const res = await callRequest(id, iface, fn, args, budget);
		if (res.ok) return res.value;
		handleCallFailure(r, res, `${iface}#${fn}`);
		return toError(res);
	}

	const api: PluginSupervisor = {
		runner,

		async load(pkgDir) {
			const manifest = await readManifest(pkgDir);
			const existing = plugins.get(manifest.id);
			if (existing && existing.status !== "failed" && existing.status !== "disabled") throw new Error(`plugin ${manifest.id} is already loaded`);
			const r: Record_ = {
				id: manifest.id,
				dir: pkgDir,
				manifest,
				status: "loading",
				grants: (opts.grantsFor ?? declaredGrants)(manifest),
				wantRunning: false,
				zincWaiting: 0,
				hostWaiting: 0,
				coldBonusMs: coldBonusOf(pkgDir),
			};
			plugins.set(r.id, r);
			setStatus(r, "loading");
			await loadRecord(r);
			return info(r);
		},

		start: (id, o = {}) =>
			chain(gates, id, async () => {
				await restarting;
				const r = must(id);
				usable(r);
				await startRecord(r, o.why ?? "app-startup", o.previousVersion);
			}),

		stop: (id, o = {}) =>
			chain(gates, id, async () => {
				await restarting;
				const r = must(id);
				usable(r);
				r.wantRunning = false;
				setStatus(r, "stopping");
				const budget = Math.min(lifecycleBudget(r), 5000 + r.coldBonusMs);
				const res = await callRequest(id, "lifecycle", "shutdown", [pluginData(r), o.why ?? "app-shutdown"], budget);
				if (!res.ok) {
					handleCallFailure(r, res, "lifecycle#shutdown", "shutdown failed");
					toError(res);
				}
				if (r.status === "disabled") return;
				setStatus(r, "stopped");
			}),

		async unload(id) {
			await restarting;
			const r = plugins.get(id);
			if (!r) return;
			plugins.delete(id);
			loadInfos.delete(id);
			await table.dropPlugin(zincContext(r)).catch(() => {});
			if (proc) await request({ t: "unload", id: nextId++, plugin: id }, id, "unload", callMs);
		},

		call: (id, iface, fn, args = [], o = {}) => queuedCall(id, iface, fn, args, o),

		enable: (id) =>
			chain(gates, id, async () => {
				await restarting;
				const r = must(id);
				if (r.status !== "disabled" && r.status !== "failed" && r.status !== "stopped") return;
				r.coldBonusMs = coldBonusOf(r.dir);
				setStatus(r, "loading");
				await loadRecord(r);
				await startRecord(r, "addon-enable");
			}),

		setGrants(id, grants) {
			const r = must(id);
			r.grants = grants;
			sendRaw({ t: "grants", plugin: id, grants });
		},

		pushHost(msg) {
			if (runner !== "wasmtime" || !proc) return;
			sendRaw(msg as unknown as ToHost);
		},

		async stats() {
			if (runner !== "wasmtime") return undefined;
			await ensureHost();
			const res = await request({ t: "stats", id: nextId++ }, "", "stats", callMs);
			if (!res.ok) toError(res);
			return res.value;
		},

		lastLoadInfo: (id) => loadInfos.get(id),

		get: (id) => (plugins.has(id) ? info(plugins.get(id)!) : undefined),
		list: () => [...plugins.values()].map(info),

		on(event, handler) {
			let set = listeners.get(event);
			if (!set) listeners.set(event, (set = new Set()));
			set.add(handler as (e: any) => void);
			return () => void set!.delete(handler as (e: any) => void);
		},

		async ready() {
			await ensureHost();
		},
		coldBonusMs: (id) => plugins.get(id)?.coldBonusMs ?? 0,
		get hostPid() {
			return proc?.pid;
		},
		get restarts() {
			return restarts;
		},

		async shutdown() {
			shuttingDown = true;
			clearInterval(ticker);
			await restarting?.catch(() => {});
			await spawning?.catch(() => {});
			for (const r of plugins.values()) {
				if (r.status === "running" && proc) {
					await callRequest(r.id, "lifecycle", "shutdown", [pluginData(r), "app-shutdown"], 2000).catch(() => {});
				}
			}
			for (const r of plugins.values()) {
				await table.dropPlugin(zincContext(r)).catch(() => {});
			}
			failAll(() => ({ kind: "host-restarting" }));
			sendRaw({ t: "exit" });
			const p = proc;
			proc = undefined;
			if (p) {
				const killer = setTimeout(() => p.kill(), 300);
				await p.exited.catch(() => {});
				clearTimeout(killer);
			}
			plugins.clear();
			loadInfos.clear();
		},
	};
	return api;
}
