// Bridge process for the Wasmtime host. The Rust host forwards each import call (iface, function, args as JSON) here over
// stdin/stdout (NDJSON); this process runs the EXISTING handlers of plugin-host/src/imports (where: "host" ones, like the Bun host
// process does) and answers with a WireResult. Calls with no host-side handler get {kind:"no-handler"}: the Rust side then forwards
// them to Zinc as an `import` message, exactly as plugin-host/src/host-main.ts does.
//
//   Rust -> bridge   {t:"init", hostModules, discover}   {t:"plugin", spec}   {t:"unplug", plugin}   {t:"call", id, plugin, iface, fn, args}
//   bridge -> Rust   {t:"ready", interfaces}             {t:"reply", id, result}                      {t:"log", plugin, level, message}
//
// JSON escapes: {"$big":"123"} <-> bigint, {"$bytes":"<base64>"} <-> Uint8Array, null -> undefined.
import { discoverHandlers, loadHandlerModule, HandlerTable, WitError, type HandlerContext } from "../../plugin-host/src/imports/registry";
import { runHandler } from "../../plugin-host/src/router";
import type { PluginSpec, WireResult } from "../../plugin-host/src/protocol";

let table = new HandlerTable([]);
const specs = new Map<string, PluginSpec>();

const out = (m: unknown) => process.stdout.write(JSON.stringify(m, replacer) + "\n");

function replacer(_k: string, v: unknown) {
	if (typeof v === "bigint") return { $big: v.toString() };
	if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
	return v;
}

function reviver(_k: string, v: unknown) {
	if (v === null) return undefined;
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (typeof o.$big === "string") return BigInt(o.$big);
		if (typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
	}
	return v;
}

const send = (m: unknown) => out(m);

function context(spec: PluginSpec): HandlerContext {
	const has = (p: string) => spec.grants.capabilities.includes(p);
	return {
		pluginId: spec.id,
		pluginDir: spec.dir,
		manifest: spec.manifest,
		get grants() {
			return spec.grants;
		},
		where: "host",
		coreUrl: process.env.ZN_CORE_URL,
		has,
		require(p) {
			if (!has(p)) throw new WitError("permission-denied", p);
		},
		async callExport() {
			throw new Error("ctx.callExport is not supported by the Wasmtime spike bridge (a host handler would need the per-plugin call queue)");
		},
		log: (level, message) => send({ t: "log", plugin: spec.id, level, message }),
		resource: (name, state) => table.createResource(spec.id, name, state),
	};
}

async function onCall(m: { id: number; plugin: string; iface: string; fn: string; args: unknown[] }) {
	const reply = (result: WireResult) => m.id && send({ t: "reply", id: m.id, result });
	if (!table.has(m.iface, m.fn)) return reply({ ok: false, error: { kind: "no-handler" } as never });
	const spec = specs.get(m.plugin);
	if (!spec) return reply({ ok: false, error: { kind: "not-loaded", plugin: m.plugin } });
	reply(await runHandler(table, context(spec), m.iface, m.fn, m.args, (msg) => send({ t: "log", plugin: m.plugin, level: "error", message: msg })));
}

async function onMessage(line: string) {
	const m = JSON.parse(line, reviver);
	switch (m.t) {
		case "init": {
			const handlers = [...(m.discover === false ? [] : await discoverHandlers("host")), ...(await Promise.all((m.hostModules ?? []).map(loadHandlerModule))).flat()];
			table = new HandlerTable(handlers);
			send({ t: "ready", pid: process.pid, interfaces: table.interfaces() });
			break;
		}
		case "plugin":
			specs.set(m.spec.id, m.spec);
			break;
		case "unplug": {
			const spec = specs.get(m.plugin);
			specs.delete(m.plugin);
			if (spec) void table.dropPlugin(context(spec));
			break;
		}
		case "call":
			await onCall(m);
			break;
	}
}

// Line reader on stdin. Messages are handled concurrently (an import that awaits does not block the next one).
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let i: number;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim()) onMessage(line).catch((e) => send({ t: "log", level: "error", message: `bridge: ${(e as Error)?.stack ?? e}` }));
	}
}
process.exit(0);
