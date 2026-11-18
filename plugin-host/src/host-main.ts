// The plugin host process. Started by the supervisor (`bun src/host-main.ts`) with Bun IPC. Holds one Worker per plugin and
// routes import calls: a `where: "host"` handler runs right here (main thread); anything else is forwarded to the Zinc process.
// When this process is killed by the supervisor, every plugin in it is gone; Zinc starts a new one.
import { discoverHandlers, loadHandlerModule, HandlerTable, WitError, type HandlerContext } from "./imports/registry";
import { runHandler } from "./router";
import type { Grants } from "./manifest";
import { PluginError, type FromHost, type FromWorker, type ToHost, type ToWorker, type WireResult, type PluginSpec } from "./protocol";

const send = (m: FromHost) => process.send!(m);

interface Slot {
	spec: PluginSpec;
	worker: Worker;
	/** Pending `call`s into the worker: id -> resolver. Id 0 is the init reply. */
	calls: Map<number, (r: WireResult) => void>;
	hostImports: number;
	unloading: boolean;
}

const slots = new Map<string, Slot>();
let table = new HandlerTable([]);
let coreUrl: string | undefined;
let nextCallId = 1;
let nextForwardId = 1;
/** Imports forwarded to Zinc: forward id -> where to answer. */
const forwarded = new Map<number, { slot: Slot; workerId: number }>();
/** Export calls a host handler asked Zinc to make: id -> resolver. */
const exportCalls = new Map<number, (r: WireResult) => void>();

function log(level: "error" | "warn" | "info" | "debug", message: string, plugin?: string) {
	send({ t: "log", plugin, level, message });
}

function callWorker(slot: Slot, iface: string, fn: string, args: unknown[]): Promise<WireResult> {
	return new Promise((resolve) => {
		const id = nextCallId++;
		slot.calls.set(id, resolve);
		slot.worker.postMessage({ t: "call", id, iface, fn, args } satisfies ToWorker);
	});
}

function context(slot: Slot): HandlerContext {
	const { spec } = slot;
	const has = (p: string) => spec.grants.capabilities.includes(p);
	return {
		pluginId: spec.id,
		pluginDir: spec.dir,
		manifest: spec.manifest,
		get grants() {
			return spec.grants;
		},
		where: "host",
		coreUrl,
		has,
		require(p) {
			if (!has(p)) throw new WitError("permission-denied", p);
		},
		// Through Zinc, which owns the one per-plugin call queue and the time budgets (calling the Worker from here would skip both).
		async callExport(iface, fn, args = [], o) {
			const id = nextForwardId++;
			const r = await new Promise<WireResult>((resolve) => {
				exportCalls.set(id, resolve);
				send({ t: "call", id, plugin: spec.id, iface, fn, args, timeoutMs: o?.timeoutMs });
			});
			if (!r.ok) throw new PluginError(r.error);
			return r.value;
		},
		log: (level, message) => log(level, message, spec.id),
		resource: (name, state) => table.createResource(spec.id, name, state),
	};
}

function setWaiting(slot: Slot, delta: number) {
	slot.hostImports += delta;
	send({ t: "waiting", plugin: slot.spec.id, n: slot.hostImports });
}

async function onWorkerImport(slot: Slot, m: Extract<FromWorker, { t: "import" }>) {
	const reply = (result: WireResult) => slot.worker.postMessage({ t: "import-reply", id: m.id, result } satisfies ToWorker);
	if (!table.has(m.iface, m.fn)) {
		// Not a host handler: Zinc may have one.
		const id = nextForwardId++;
		forwarded.set(id, { slot, workerId: m.id });
		send({ t: "import", id, plugin: slot.spec.id, iface: m.iface, fn: m.fn, args: m.args });
		return;
	}
	setWaiting(slot, +1);
	try {
		reply(await runHandler(table, context(slot), m.iface, m.fn, m.args, (msg) => log("error", msg, slot.spec.id)));
	} finally {
		setWaiting(slot, -1);
	}
}

function startWorker(spec: PluginSpec): Promise<WireResult> {
	const worker = new Worker(new URL("./worker.ts", import.meta.url).href, { name: `plugin:${spec.id}` });
	const slot: Slot = { spec, worker, calls: new Map(), hostImports: 0, unloading: false };
	slots.set(spec.id, slot);
	worker.onmessage = (ev: MessageEvent<FromWorker>) => {
		const m = ev.data;
		if (m.t === "reply") {
			const r = slot.calls.get(m.id);
			slot.calls.delete(m.id);
			r?.(m.result);
		} else if (m.t === "import") void onWorkerImport(slot, m);
		else if (m.t === "log") log(m.level, m.message, spec.id);
	};
	const died = (message: string) => {
		if (slot.unloading) return;
		slots.delete(spec.id);
		void table.dropPlugin(context(slot));
		for (const r of slot.calls.values()) r({ ok: false, error: { kind: "trap", message } });
		slot.calls.clear();
		send({ t: "plugin-exit", plugin: spec.id, message });
	};
	worker.onerror = (ev) => died(`worker error: ${ev.message}`);
	worker.addEventListener("close", () => died("worker closed"));
	return new Promise((resolve) => {
		slot.calls.set(0, resolve);
		worker.postMessage({ t: "init", spec } satisfies ToWorker);
	});
}

async function onMessage(m: ToHost) {
	switch (m.t) {
		case "init": {
			coreUrl = m.coreUrl;
			const handlers = [...(m.discover === false ? [] : await discoverHandlers("host")), ...(await Promise.all((m.hostModules ?? []).map(loadHandlerModule))).flat()];
			table = new HandlerTable(handlers);
			send({ t: "ready", pid: process.pid, interfaces: table.interfaces() });
			setInterval(() => send({ t: "heartbeat", ts: Date.now() }), m.heartbeatMs);
			break;
		}
		case "load": {
			const old = slots.get(m.plugin.id);
			if (old) {
				old.unloading = true;
				old.worker.terminate();
			}
			const result = await startWorker(m.plugin);
			if (!result.ok) slots.get(m.plugin.id)?.worker.terminate(), slots.delete(m.plugin.id);
			send({ t: "reply", id: m.id, result });
			break;
		}
		case "unload": {
			const slot = slots.get(m.plugin);
			if (slot) {
				slot.unloading = true;
				slots.delete(m.plugin);
				slot.worker.terminate();
				void table.dropPlugin(context(slot));
			}
			send({ t: "reply", id: m.id, result: { ok: true, value: undefined } });
			break;
		}
		case "call": {
			const slot = slots.get(m.plugin);
			const result: WireResult = slot
				? await callWorker(slot, m.iface, m.fn, m.args)
				: { ok: false, error: { kind: "not-loaded", plugin: m.plugin } };
			send({ t: "reply", id: m.id, result });
			break;
		}
		case "import-reply": {
			const f = forwarded.get(m.id);
			forwarded.delete(m.id);
			f?.slot.worker.postMessage({ t: "import-reply", id: f.workerId, result: m.result } satisfies ToWorker);
			break;
		}
		case "call-reply": {
			const r = exportCalls.get(m.id);
			exportCalls.delete(m.id);
			r?.(m.result);
			break;
		}
		case "grants": {
			const slot = slots.get(m.plugin);
			if (slot) slot.spec.grants = m.grants satisfies Grants;
			break;
		}
		case "exit":
			process.exit(0);
	}
}

process.on("message", (m: ToHost) => {
	onMessage(m).catch((e) => log("error", `host: ${(e as Error)?.stack ?? e}`));
});
// If Zinc goes away, do not leave a process (and a spinning plugin) behind. A Worker stuck in WebAssembly can stall a normal exit.
process.on("disconnect", () => {
	setTimeout(() => process.kill(process.pid, "SIGKILL"), 500).unref?.();
	process.exit(0);
});
