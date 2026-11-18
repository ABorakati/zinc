// The plugin supervisor. Runs in the Zinc process (the one that owns the UI and the in-process core): it spawns the plugin host
// process, sends it loads and calls, answers `where: "zinc"` imports, watches time budgets, and on a timeout kills the host,
// starts a new one and reloads every plugin except the stuck one, which is disabled.
//
// Time budgets count only time the plugin is RUNNING: while it waits for a host import (net, a dialog) its timers are paused.
//
// ONE CALL AT A TIME PER PLUGIN. Every call into a plugin (`call`, `start`, `stop`, `enable`, `ctx.callExport` of a handler in
// either process) goes through one queue per plugin, and its budget starts when it leaves the queue. Reason: a plugin instance
// that is suspended in an import (JSPI) must not be entered by a call that itself suspends: the two stacks share the guest's memory
// and, for a QuickJS guest, its interpreter, which is not re-entrant (observed: "Out of bounds memory access", and a hang). The one
// exception is a NESTED call: a `where: "zinc"` handler that is still running (its import has not returned) calls an export on its
// own context. The plugin's call is suspended in that very import, so waiting for the queue would never end; this is how the
// events of a dialog reach a plugin while `ui.run-dialog` waits. Nested calls of one plugin run one after the other.
import { statSync } from "node:fs";
import { join } from "node:path";
import { TRANSPILED_ENTRY, declaredGrants, readManifest, type Grants, type PluginManifest } from "./manifest";
import { HandlerTable, WitError, type HandlerContext, type ImportHandler } from "./imports/registry";
import { runHandler } from "./router";
import {
	DEFAULT_TIMEOUTS,
	PluginError,
	type FromHost,
	type LogLevel,
	type PluginSpec,
	type ToHost,
	type WireError,
	type WireResult,
} from "./protocol";

export type PluginStatus = "loading" | "loaded" | "starting" | "running" | "stopping" | "stopped" | "failed" | "disabled";

export interface PluginInfo {
	id: string;
	dir: string;
	manifest: PluginManifest;
	status: PluginStatus;
	/** Why the plugin is `disabled` or `failed`. */
	reason?: string;
	grants: Grants;
}

export interface SupervisorOptions {
	/** `where: "zinc"` handlers (from `discoverHandlers("zinc")`, plus the app's own). */
	importHandlers?: ImportHandler[];
	/** Extra `where: "host"` handler modules (absolute paths) the host process imports besides src/imports/*.host.ts. */
	hostHandlerModules?: string[];
	/** false: the host process does not load `src/imports/*.host.ts`, only `hostHandlerModules` (tests with their own stub handlers). Default true. */
	discoverHostHandlers?: boolean;
	/** Core's HTTP base URL for host handlers (`ctx.coreUrl`). */
	coreUrl?: string;
	/**
	 * Extra budget for plugins with a large transpiled JS file. jco inlines the lifting and lowering of every big type into every
	 * function that uses it (a UI plugin: 199 MB of JS, four exports of 240,000 lines each), and JavaScriptCore compiles a function
	 * the first time it runs: 15 to 22 s for each such export and each such import, once per process (phase2-integrate.md, "Slow first
	 * calls"). A plugin whose `transpiled/plugin.js` is at least `thresholdBytes` gets `msPerMb` x its size in MB (at most `maxMs`)
	 * added to the budget of every call, lifecycle call and `ctx.callExport`. Defaults: 8 MB, 3000 ms, 300 s. Plugins below the
	 * threshold keep the plain budgets. `false` turns it off.
	 */
	coldBudget?: false | { thresholdBytes?: number; msPerMb?: number; maxMs?: number };
	/**
	 * Where a plugin runs. "worker" (default): a Worker in the host process, JIT-compiled on first use. "aot-process": a plugin that has
	 * an AOT executable (`aot/plugin.exe`, package/aot.ts) runs as its own child process of the host; one without it runs in a Worker.
	 * See phase2-aot.md: experimental.
	 */
	runner?: "worker" | "aot-process";
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
	/** Command that runs Bun. Default: this process's executable (a packaged Zinc is a Bun executable: BUN_BE_BUN=1 makes it act as `bun`). */
	runtime?: string[];
	/** Path of host-main.ts. Default: the one next to this file. */
	hostEntry?: string;
	/** What the plugin may do. Default: what its manifest declares. */
	grantsFor?: (manifest: PluginManifest) => Grants;
	/** The host's stderr. Default "ignore". "inherit" shows panics of the host itself. */
	hostStderr?: "ignore" | "inherit";
}

export interface SupervisorEvents {
	/** The host process is up (first start and after each restart). */
	"host-ready": { pid: number; restarts: number };
	/** The host is being killed and replaced. `plugin` is the one that caused it (timeout) and is now disabled. After this event all plugins are reloaded. */
	"host-restart": { reason: "timeout" | "heartbeat" | "crash"; plugin?: string; detail: string };
	/** Restart finished: these plugins were reloaded (and started again if they were running). Anything the UI registered for them before must be re-registered. */
	"host-restarted": { reloaded: string[]; disabled: string[] };
	"host-failed": { detail: string };
	status: { plugin: string; status: PluginStatus; reason?: string };
	log: { plugin?: string; level: LogLevel; message: string };
}

type Handler<K extends keyof SupervisorEvents> = (e: SupervisorEvents[K]) => void;

interface Pending {
	id: number;
	plugin: string;
	phase: string;
	budgetMs: number;
	spentMs: number;
	/** A nested call counts as waiting only for imports that started after it did: the handler that made it is still waiting. */
	baseline: number;
	resolve: (r: WireResult) => void;
}

interface Record_ extends PluginInfo {
	/** Budget added to every call (see SupervisorOptions.coldBudget). */
	coldBonusMs: number;
	wantRunning: boolean;
	/** zinc-side imports in flight + host-side ones reported by the host. */
	zincWaiting: number;
	hostWaiting: number;
}

const POLL_MS = 25;

export interface PluginSupervisor {
	/** Read `<pkgDir>/manifest.json`, create the plugin's Worker in the host and instantiate the component. Does not call `startup`. */
	load(pkgDir: string): Promise<PluginInfo>;
	/** Call `lifecycle.startup`. `why` is a `lifecycle.reason`. Resolves when it returns ok; a WIT error or a trap marks the plugin failed and rejects. */
	start(id: string, opts?: { why?: string; previousVersion?: string }): Promise<void>;
	/** Call `lifecycle.shutdown`, leaving the plugin loaded but stopped. */
	stop(id: string, opts?: { why?: string }): Promise<void>;
	/** Terminate the plugin's Worker and forget the plugin. */
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
	/** Budget added to the plugin's calls because its transpiled JS is large (0 for most plugins). */
	coldBonusMs(id: string): number;
	readonly hostPid: number | undefined;
	readonly restarts: number;
	/** Stop everything and kill the host. */
	shutdown(): Promise<void>;
}

export function createPluginSupervisor(opts: SupervisorOptions = {}): PluginSupervisor {
	const callMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUTS.call;
	const lifecycleMs = opts.lifecycleTimeoutMs ?? DEFAULT_TIMEOUTS.lifecycle;
	const loadMs = opts.loadTimeoutMs ?? DEFAULT_TIMEOUTS.load;
	const heartbeatMs = opts.heartbeatMs ?? 1000;
	const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 5000;
	const maxRestarts = opts.maxRestarts ?? 5;
	const restartWindowMs = opts.restartWindowMs ?? 60_000;
	const runtime = opts.runtime ?? [process.execPath];
	const hostEntry = opts.hostEntry ?? join(import.meta.dir, "host-main.ts");
	const zincTable = new HandlerTable(opts.importHandlers ?? []);
	const cold = opts.coldBudget === false ? undefined : { thresholdBytes: 8_000_000, msPerMb: 3000, maxMs: 300_000, ...opts.coldBudget };
	const coldBonusOf = (dir: string): number => {
		if (!cold) return 0;
		try {
			const size = statSync(join(dir, TRANSPILED_ENTRY)).size;
			return size < cold.thresholdBytes ? 0 : Math.min(cold.maxMs, Math.round((size / 1e6) * cold.msPerMb));
		} catch {
			return 0;
		}
	};

	// One chain per plugin for ordinary calls, one for nested calls. `chain` never rejects the tail, so one failed call does not
	// stop the next.
	const gates = new Map<string, Promise<void>>();
	const nestedGates = new Map<string, Promise<void>>();
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
	const listeners = new Map<string, Set<(e: any) => void>>();
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let proc: ReturnType<typeof Bun.spawn> | undefined;
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
			(proc as any)?.send(m);
		} catch {
			/* the host is gone; the exit handler restarts it */
		}
	};

	/** Send a request and wait for its reply under an active-time budget. `plugin` ties the budget to that plugin's waiting state. */
	function request(m: Extract<ToHost, { t: "load" | "unload" | "call" }>, plugin: string, phase: string, budgetMs: number, nested = false): Promise<WireResult> {
		return new Promise((resolve) => {
			const r = plugins.get(plugin);
			const baseline = nested && r ? r.zincWaiting + r.hostWaiting : 0;
			pending.set(m.id, { id: m.id, plugin, phase, budgetMs, spentMs: 0, baseline, resolve });
			sendRaw(m);
		});
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
		for (const p of pending.values()) {
			const r = plugins.get(p.plugin);
			if (r && r.zincWaiting + r.hostWaiting > p.baseline) continue; // waiting for a host import: not the plugin's time
			p.spentMs += dt;
			if (p.spentMs > p.budgetMs) {
				void restart("timeout", p.plugin, `${p.phase} exceeded ${p.budgetMs} ms`, p);
				return;
			}
		}
	}, POLL_MS);
	ticker.unref?.();

	// ---- the host process -----------------------------------------------------------------------------------------------

	function spawnHost(): Promise<void> {
		hostReady = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			setTimeout(() => reject(new Error("the plugin host did not start in 20 s")), 20_000).unref?.();
		});
		hostReady.catch(() => {});
		const p = Bun.spawn([...runtime, hostEntry], {
			ipc: (m: FromHost) => onHostMessage(m),
			serialization: "advanced",
			stdin: "ignore",
			stdout: "ignore",
			stderr: opts.hostStderr ?? "ignore",
			env: { ...process.env, BUN_BE_BUN: "1", ...(opts.runner === "aot-process" ? { ZN_PLUGIN_RUNNER: "aot-process" } : {}) },
			onExit: () => {
				if (proc === p) {
					proc = undefined;
					if (!shuttingDown) void restart("crash", undefined, "the plugin host process exited");
				}
			},
		});
		proc = p;
		lastBeat = Date.now();
		sendRaw({ t: "init", coreUrl: opts.coreUrl, hostModules: opts.hostHandlerModules ?? [], heartbeatMs, discover: opts.discoverHostHandlers });
		return hostReady;
	}

	function ensureHost(): Promise<void> {
		if (failed) return Promise.reject(new PluginError({ kind: "internal", message: "plugin host failed to stay up" }));
		if (restarting) return restarting;
		return proc ? hostReady : spawnHost();
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
					(e) => sendRaw({ t: "call-reply", id: m.id, result: { ok: false, error: e instanceof PluginError ? e.error : { kind: "internal", message: String(e?.message ?? e) } } }),
				);
				break;
			case "plugin-exit": {
				const r = plugins.get(m.plugin);
				if (r && r.status !== "disabled") {
					r.wantRunning = false;
					setStatus(r, "failed", m.message);
				}
				break;
			}
			case "log":
				emit("log", { plugin: m.plugin, level: m.level, message: m.message });
				break;
		}
	}

	async function onZincImport(m: Extract<FromHost, { t: "import" }>) {
		const r = plugins.get(m.plugin);
		const reply = (result: WireResult) => sendRaw({ t: "import-reply", id: m.id, result });
		if (!r || !zincTable.has(m.iface, m.fn)) {
			reply({ ok: false, error: { kind: "wit", payload: { tag: "unavailable", val: `unsupported: no handler for ${m.iface}#${m.fn}` } } });
			return;
		}
		r.zincWaiting++;
		const live = { done: false }; // while false, calls made on this context are nested (see the top of this file)
		try {
			reply(await runHandler(zincTable, zincContext(r, live), m.iface, m.fn, m.args, (message) => emit("log", { plugin: r.id, level: "error", message })));
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
				live && !live.done ? chain(nestedGates, r.id, () => callImpl(r.id, iface, fn, args, o, true)) : queuedCall(r.id, iface, fn, args, o),
			log: (level, message) => emit("log", { plugin: r.id, level, message }),
			resource: (name, state) => zincTable.createResource(r.id, name, state),
		};
	}

	// ---- restart --------------------------------------------------------------------------------------------------------
	//
	// A restart is a job: disable the culprit, fail what is in flight, kill the host (all synchronous, so a call that times out
	// during a reload takes effect at once), then a loop starts a new host and reloads the plugins. A job that arrives while the
	// loop runs cuts the current reload short; the loop then handles it.

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
			void zincTable.dropPlugin(zincContext(r)); // their handles died with the host process
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
		const spec: PluginSpec = { id: r.id, dir: r.dir, manifest: r.manifest, grants: r.grants };
		const res = await request({ t: "load", id: nextId++, plugin: spec }, r.id, "load", loadMs);
		if (!res.ok) {
			if (r.status !== "disabled") setStatus(r, "failed", `load failed: ${describe(res.error)}`);
			toError(res);
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

	async function startRecord(r: Record_, why: string, previousVersion?: string) {
		r.wantRunning = true;
		setStatus(r, "starting");
		const res = await request(
			{ t: "call", id: nextId++, plugin: r.id, iface: "lifecycle", fn: "startup", args: [pluginData(r, previousVersion), why] },
			r.id,
			"lifecycle#startup",
			lifecycleBudget(r),
		);
		if (!res.ok) {
			r.wantRunning = false;
			if (r.status !== "disabled") setStatus(r, "failed", `startup failed: ${describe(res.error)}`);
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

	async function callImpl(id: string, iface: string, fn: string, args: unknown[], o: { timeoutMs?: number } = {}, nested = false): Promise<unknown> {
		const r = must(id);
		usable(r);
		const res = await request({ t: "call", id: nextId++, plugin: id, iface, fn, args }, id, `${iface}#${fn}`, (o.timeoutMs ?? callMs) + r.coldBonusMs, nested);
		if (res.ok) return res.value;
		if (res.error.kind === "trap" && r.status !== "disabled") {
			// The instance is poisoned after a trap: drop it, mark the plugin failed, keep the host.
			r.wantRunning = false;
			setStatus(r, "failed", describe(res.error));
			sendRaw({ t: "unload", id: nextId++, plugin: id });
		}
		return toError(res);
	}

	const api: PluginSupervisor = {
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
				const res = await request(
					{ t: "call", id: nextId++, plugin: id, iface: "lifecycle", fn: "shutdown", args: [pluginData(r), o.why ?? "app-shutdown"] },
					id,
					"lifecycle#shutdown",
					Math.min(lifecycleBudget(r), 5000 + r.coldBonusMs),
				);
				if (r.status === "disabled") toError(res);
				setStatus(r, res.ok ? "stopped" : "failed", res.ok ? undefined : `shutdown failed: ${describe(res.error)}`);
				if (!res.ok) toError(res);
			}),

		async unload(id) {
			await restarting;
			const r = plugins.get(id);
			if (!r) return;
			plugins.delete(id);
			void zincTable.dropPlugin(zincContext(r));
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
			for (const r of plugins.values()) {
				if (r.status === "running" && proc) {
					await request({ t: "call", id: nextId++, plugin: r.id, iface: "lifecycle", fn: "shutdown", args: [pluginData(r), "app-shutdown"] }, r.id, "lifecycle#shutdown", 2000).catch(() => {});
				}
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
		},
	};
	return api;
}
