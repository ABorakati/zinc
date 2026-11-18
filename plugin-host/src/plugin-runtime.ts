// The plugin runtime: loads a jco-transpiled component (JSPI) and runs its exports. Shared by the two places a plugin can live:
//   worker.ts      a Worker in the plugin host process (default); the glue is imported from disk
//   aot-entry.ts   the entry of a per-plugin AOT executable (src/package/aot.ts); the glue and the core .wasm files are compiled in
//
//   imports  zinc:plugin/*  -> async function that posts an `import` message to the host and awaits the reply
//            wasi:*         -> wasi-stubs.ts (nothing real)
//   exports  `call` messages -> inst[interface][function](...args)
//
// A spinning component cannot be stopped from here (Bun cannot terminate a Worker that runs WebAssembly): the supervisor kills
// the whole host process instead.
import { camel, ifaceName, kebab, shortIface } from "./names";
import type { FromWorker, PluginSpec, ToWorker, WireError, WireResult } from "./protocol";
import { createWasiStubs } from "./wasi-stubs";

/** Make the component instance: `imports` is the jco import object (zinc:plugin/* and the wasi stubs). */
export type LoadComponent = (spec: PluginSpec, imports: unknown) => Promise<Record<string, any>>;

let post: (m: FromWorker) => void = () => {};
let loadComponent: LoadComponent = async () => {
	throw new Error("runtime not started");
};

let instance: Record<string, any> | undefined;
let nextImportId = 1;
const pendingImports = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

/** What jco's glue looks for on a thrown value: an own `payload` property is turned into `result::err(payload)`. */
class PayloadError extends Error {
	payload: unknown;
	constructor(message: string, payload: unknown) {
		super(message);
		this.payload = payload;
	}
}

function callImport(iface: string, fn: string, args: unknown[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const id = nextImportId++;
		pendingImports.set(id, { resolve: (v) => resolve(rehydrate(iface, v)), reject });
		post({ t: "import", id, iface, fn, args });
	});
}

// ---- resources ---------------------------------------------------------------------------------------------------------
// A WIT resource (net.body-reader, attachments.file-writer) is a class in jco's import object. The state lives in the handler's
// process; here an instance only holds a handle number. Methods become `[method]<resource>.<fn>` imports with the handle first.

const RES = "$zinc-resource";
const classes = new Map<string, new (...args: unknown[]) => object>();
let nextRid = 1; // handles made by guest constructors are positive; the host's (ctx.resource) are negative

function resourceClass(iface: string, pascal: string): new (...args: unknown[]) => object {
	const key = `${iface}#${pascal}`;
	let cls = classes.get(key);
	if (cls) return cls;
	const name = kebab(pascal);
	const wrap = (rid: number) => {
		const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		return new Proxy(Object.create(Cls.prototype), {
			get(t, p, recv) {
				if (p === Symbol.dispose) return () => void callImport(iface, `[resource-drop]${name}`, [rid]).catch(() => {});
				if (typeof p !== "string" || p === "then" || p in t) return Reflect.get(t, p, recv);
				let m = methods.get(p);
				if (!m) methods.set(p, (m = (...args) => callImport(iface, `[method]${name}.${kebab(p)}`, [rid, ...args])));
				return m;
			},
		});
	};
	class Cls {
		constructor(...args: unknown[]) {
			const rid = nextRid++;
			// The guest does not wait for a constructor; an error shows at the first method call.
			void callImport(iface, `[constructor]${name}`, [rid, ...args]).catch(() => {});
			return wrap(rid);
		}
		static fromHandle(rid: number) {
			return wrap(rid);
		}
	}
	classes.set(key, Cls);
	return Cls;
}

/** Turn `{ "$zinc-resource": "body-reader", id }` markers anywhere in a result into resource objects. */
function rehydrate(iface: string, v: unknown): unknown {
	if (Array.isArray(v)) return v.map((x) => rehydrate(iface, x));
	if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
		const o = v as Record<string, unknown>;
		if (typeof o[RES] === "string") {
			const pascal = (o[RES] as string).replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
			return (resourceClass(iface, pascal) as unknown as { fromHandle(id: number): object }).fromHandle(o.id as number);
		}
		return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, rehydrate(iface, x)]));
	}
	return v;
}

function importObject(iface: string) {
	const fns = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	return new Proxy(Object.create(null), {
		get(_t, prop) {
			if (typeof prop !== "string" || prop === "then") return undefined;
			if (/^[A-Z]/.test(prop)) return resourceClass(iface, prop);
			let f = fns.get(prop);
			if (!f) {
				f = (...args) => callImport(iface, prop, args);
				fns.set(prop, f);
			}
			return f;
		},
		has: () => true,
	});
}

function makeImports(wasi: (name: string) => unknown) {
	const zinc = new Map<string, unknown>();
	return new Proxy(Object.create(null), {
		get(_t, key) {
			if (typeof key !== "string") return undefined;
			const name = ifaceName(key);
			if (name.startsWith("zinc:plugin/")) {
				let o = zinc.get(name);
				if (!o) zinc.set(name, (o = importObject(name)));
				return o;
			}
			// wasi:* and anything else: stubs that deny.
			return wasi(name);
		},
		has: () => true,
	});
}

async function init(spec: PluginSpec) {
	const wasi = createWasiStubs((stream, text) => post({ t: "log", level: stream === "stderr" ? "warn" : "info", message: `[${stream}] ${text}` }));
	instance = await loadComponent(spec, makeImports(wasi));
}

function toWireError(e: unknown): WireError {
	if (e && typeof e === "object" && Object.prototype.hasOwnProperty.call(e, "payload")) {
		return { kind: "wit", payload: (e as { payload: unknown }).payload };
	}
	const err = e as Error | undefined;
	return { kind: "trap", message: String(err?.message ?? e), stack: err?.stack };
}

async function call(iface: string, fn: string, args: unknown[]): Promise<WireResult> {
	if (!instance) return { ok: false, error: { kind: "not-loaded", plugin: "" } };
	const ns = instance[camel(shortIface(iface))];
	const f = ns?.[camel(fn)];
	if (typeof f !== "function") return { ok: false, error: { kind: "no-such-export", iface: shortIface(iface), fn: camel(fn) } };
	try {
		return { ok: true, value: await f.apply(ns, args) };
	} catch (e) {
		return { ok: false, error: toWireError(e) };
	}
}

/** Start the runtime: `send` goes to the host, the returned function takes the host's messages. */
export function startRuntime(send: (m: FromWorker) => void, load: LoadComponent): (m: ToWorker) => void {
	post = send;
	loadComponent = load;
	return onMessage;
}

function onMessage(m: ToWorker) {
	switch (m.t) {
		case "init":
			init(m.spec).then(
				() => post({ t: "reply", id: 0, result: { ok: true, value: undefined } }),
				(e) => post({ t: "reply", id: 0, result: { ok: false, error: { kind: "internal", message: `load failed: ${(e as Error)?.stack ?? e}` } } }),
			);
			break;
		case "call":
			call(m.iface, m.fn, m.args).then((result) => post({ t: "reply", id: m.id, result }));
			break;
		case "import-reply": {
			const p = pendingImports.get(m.id);
			if (!p) break;
			pendingImports.delete(m.id);
			if (m.result.ok) p.resolve(m.result.value);
			else if (m.result.error.kind === "wit") {
				const payload = m.result.error.payload as { tag?: string; val?: unknown };
				p.reject(new PayloadError(`${payload?.tag}${payload?.val !== undefined ? `: ${String(payload.val)}` : ""}`, payload));
			} else p.reject(new Error(`host import failed: ${JSON.stringify(m.result.error)}`));
			break;
		}
	}
}
