// The import handler contract. See README.md in this folder for how to add a handler.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Grants, PluginManifest } from "../manifest";
import type { LogLevel } from "../protocol";
import { camel, ifaceName, kebab } from "../names";

export type { Grants, PluginManifest, LogLevel };

/** What a handler function is called with first. One per call; cheap to build. */
export interface HandlerContext {
	readonly pluginId: string;
	/** The plugin's folder (the loadable layout: manifest.json, plugin.wasm, transpiled/, locale/, ...). Read only. The `fs` root `bundled` is this folder. */
	readonly pluginDir: string;
	/** The plugin's manifest.json, parsed. */
	readonly manifest: PluginManifest;
	/** What the plugin may do right now. Live: reflects a later grant or revoke. */
	readonly grants: Readonly<Grants>;
	/** Which process the handler runs in. */
	readonly where: "host" | "zinc";
	/** Base URL of core's HTTP API (`http://127.0.0.1:<port>`), when the supervisor was given one. Host handlers use it. */
	readonly coreUrl: string | undefined;
	/** True if the plugin has this permission id (for example "library.read"). */
	has(permission: string): boolean;
	/** Throws `error::permission-denied(permission)` unless `has(permission)`. */
	require(permission: string): void;
	/**
	 * Call one of the plugin's exports (a callback: `events.on-timer`, `extend-handlers.on-menu-command`, ...). Resolves with the
	 * return value, rejects with PluginError.
	 *
	 * ONE CALL AT A TIME PER PLUGIN (phase2-integrate.md). The supervisor queues the call behind the plugin's other calls. The one
	 * exception: a `where: "zinc"` handler that is still running (its import has not returned) calls on the context it was given;
	 * that call is "nested" and enters the plugin at once, because the plugin's own call is suspended in this very import and waiting
	 * for the queue would never end. Use that for dialogs only (the events of a dialog the handler is waiting for). Nested calls of
	 * one plugin are run one after the other. A `where: "host"` handler cannot nest: calling a plugin that waits for you hangs.
	 */
	callExport(iface: string, fn: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<unknown>;
	/** A line for the plugin's log (shown with the plugin id). */
	log(level: LogLevel, message: string): void;
	/**
	 * Make a WIT resource (a handle the plugin keeps, such as `net.body-reader`) from your own state object. Return the result of
	 * this call, anywhere inside a function's return value, where the WIT says `own<resource>`. The plugin gets a JS object whose
	 * methods call the `resources[name].methods` of your handler with `state` as `self`.
	 */
	resource(name: string, state: unknown): ResourceRef;
}

/** What travels over IPC in place of a resource handle. */
export interface ResourceRef {
	"$zinc-resource": string;
	id: number;
}

/** The functions of one WIT resource (see lifecycle.wit `body-reader`, library.wit `file-writer`). */
export interface ResourceHandler {
	/** The WIT `constructor(...)`: build the state. Leave out for resources that only the host creates (`ctx.resource`). The guest does not wait for it: an error shows at its first method call. */
	create?: (ctx: HandlerContext, ...args: any[]) => unknown | Promise<unknown>;
	/** Method name (kebab or camel) -> implementation. `self` is the state object. */
	methods: Record<string, (ctx: HandlerContext, self: any, ...args: any[]) => unknown | Promise<unknown>>;
	/** The plugin dropped the handle, or the plugin was unloaded. */
	drop?: (ctx: HandlerContext, self: any) => unknown | Promise<unknown>;
}

export type HandlerFn = (ctx: HandlerContext, ...args: any[]) => unknown | Promise<unknown>;

export interface ImportHandler {
	/** The WIT interface, "zinc:plugin/<name>" (a bare "<name>" and a "@version" suffix are accepted). */
	interface: string;
	/** "host": runs in the plugin host process (can talk to core over HTTP). "zinc": runs in the Zinc process that owns the supervisor. */
	where: "host" | "zinc";
	/** Function name (kebab or camel) -> implementation. Arguments and result are in jco's JS representation. */
	functions: Record<string, HandlerFn>;
	/** WIT resource name (kebab, for example "body-reader") -> its handler. Only for interfaces that declare resources. */
	resources?: Record<string, ResourceHandler>;
}

export function defineHandler(h: ImportHandler): ImportHandler {
	return h;
}

/**
 * The error a handler throws to return `result::err(error)` to the plugin. `tag` is a case of `types.error`:
 * not-found, invalid-argument, permission-denied, read-only, conflict, limit-exceeded, unavailable, internal (with a string)
 * or timeout, cancelled (without). For a function that does not return a result the plugin traps instead.
 * Any other exception a handler throws becomes `internal(message)`.
 */
export class WitError extends Error {
	readonly payload: { tag: string; val?: unknown };
	constructor(tag: WitErrorTag, val?: string) {
		super(val === undefined ? tag : `${tag}: ${val}`);
		this.payload = val === undefined ? { tag } : { tag, val };
	}
}

export type WitErrorTag =
	| "not-found"
	| "invalid-argument"
	| "permission-denied"
	| "read-only"
	| "conflict"
	| "limit-exceeded"
	| "timeout"
	| "cancelled"
	| "unavailable"
	| "internal";

export function witError(tag: WitErrorTag, val?: string): WitError {
	return new WitError(tag, val);
}

interface LiveResource {
	name: string;
	state: Promise<unknown>;
}

/**
 * All handlers of one process, by interface. Also owns the live resource handles of each plugin (`ctx.resource`, guest
 * constructors), because a handle is only meaningful where its state is.
 */
export class HandlerTable {
	private ifaces = new Map<string, { fns: Map<string, HandlerFn>; resources: Map<string, ResourceHandler> }>();
	private live = new Map<string, Map<number, LiveResource>>();
	private nextRid = -1;

	constructor(handlers: ImportHandler[]) {
		for (const h of handlers) {
			const key = ifaceName(h.interface);
			const e = this.ifaces.get(key) ?? { fns: new Map(), resources: new Map() };
			for (const [name, fn] of Object.entries(h.functions)) e.fns.set(camel(name), fn);
			for (const [name, r] of Object.entries(h.resources ?? {})) e.resources.set(kebab(name), r);
			this.ifaces.set(key, e);
		}
	}

	interfaces(): string[] {
		return [...this.ifaces.keys()];
	}

	private parse(fn: string): { kind: "fn" | "ctor" | "method" | "drop"; resource?: string; name: string } {
		let m = /^\[constructor\]([a-z0-9-]+)$/.exec(fn);
		if (m) return { kind: "ctor", resource: m[1], name: "" };
		m = /^\[method\]([a-z0-9-]+)\.(.+)$/.exec(fn);
		if (m) return { kind: "method", resource: m[1], name: camel(m[2]) };
		m = /^\[resource-drop\]([a-z0-9-]+)$/.exec(fn);
		if (m) return { kind: "drop", resource: m[1], name: "" };
		return { kind: "fn", name: camel(fn) };
	}

	/** Does this process have an implementation for the call? (The host process uses it to decide whether to forward to Zinc.) */
	has(iface: string, fn: string): boolean {
		const e = this.ifaces.get(ifaceName(iface));
		if (!e) return false;
		const p = this.parse(fn);
		if (p.kind === "fn") return e.fns.has(p.name);
		const r = e.resources.get(p.resource!);
		return !!r && (p.kind === "method" ? camel(p.name) in camelKeys(r.methods) : true);
	}

	/** Make a handle for the plugin. The id is negative; ids the guest makes for its own constructors are positive. */
	createResource(plugin: string, name: string, state: unknown): ResourceRef {
		const id = this.nextRid--;
		this.map(plugin).set(id, { name: kebab(name), state: Promise.resolve(state) });
		return { "$zinc-resource": kebab(name), id };
	}

	private map(plugin: string) {
		let m = this.live.get(plugin);
		if (!m) this.live.set(plugin, (m = new Map()));
		return m;
	}

	/** Run one call. Throws what the handler throws; throws WitError("unavailable") if there is no such handler. */
	async call(ctx: HandlerContext, iface: string, fn: string, args: unknown[]): Promise<unknown> {
		const key = ifaceName(iface);
		const e = this.ifaces.get(key);
		const p = this.parse(fn);
		if (e && p.kind === "fn") {
			const f = e.fns.get(p.name);
			if (f) return f(ctx, ...args);
		} else if (e) {
			const r = e.resources.get(p.resource!);
			const live = this.map(ctx.pluginId);
			const [rid, ...rest] = args as [number, ...unknown[]];
			if (r && p.kind === "ctor" && r.create) {
				const state = Promise.resolve().then(() => r.create!(ctx, ...rest));
				state.catch(() => {}); // surfaces at the first method call
				live.set(rid, { name: p.resource!, state });
				return undefined;
			}
			if (r && p.kind === "method") {
				const entry = live.get(rid);
				if (!entry) throw new WitError("not-found", `resource handle ${rid} of ${p.resource}`);
				const m = camelKeys(r.methods)[p.name];
				if (m) return m(ctx, await entry.state, ...rest);
			}
			if (r && p.kind === "drop") {
				const entry = live.get(rid);
				live.delete(rid);
				if (entry && r.drop) await r.drop(ctx, await entry.state.catch(() => undefined));
				return undefined;
			}
		}
		throw new WitError("unavailable", `unsupported: no handler for ${key}#${fn}`);
	}

	/** The plugin is gone: drop all its handles. */
	async dropPlugin(ctx: HandlerContext): Promise<void> {
		const live = this.live.get(ctx.pluginId);
		this.live.delete(ctx.pluginId);
		for (const entry of live?.values() ?? []) {
			const drop = [...this.ifaces.values()].map((e) => e.resources.get(entry.name)?.drop).find(Boolean);
			if (drop) await Promise.resolve(drop(ctx, await entry.state.catch(() => undefined))).catch(() => {});
		}
	}
}

function camelKeys<T>(o: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
}

function asHandlers(mod: any, file: string): ImportHandler[] {
	const raw = mod.default ?? mod.handlers ?? mod.handler;
	const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
	for (const h of list) {
		if (typeof h?.interface !== "string" || (h.where !== "host" && h.where !== "zinc") || typeof h.functions !== "object") {
			throw new Error(`${file}: export default must be an ImportHandler or an array of them ({ interface, where, functions })`);
		}
	}
	return list;
}

/** Import one handler module by path and return its handlers. Used for `hostModules` and by tests. */
export async function loadHandlerModule(file: string): Promise<ImportHandler[]> {
	return asHandlers(await import(pathToFileURL(file).href), file);
}

/**
 * Find the handler modules that live in this folder: `*.host.ts` for the plugin host process, `*.zinc.ts` for the Zinc process.
 * The host process calls `discoverHandlers("host")` itself. The app calls `discoverHandlers("zinc")` and passes the result to
 * `createPluginSupervisor({ importHandlers })`, together with handlers of its own.
 */
export async function discoverHandlers(where: "host" | "zinc", dir: string = import.meta.dir): Promise<ImportHandler[]> {
	const suffix = `.${where}.ts`;
	const files = (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
	const out: ImportHandler[] = [];
	for (const f of files) {
		for (const h of await loadHandlerModule(join(dir, f))) {
			if (h.where !== where) throw new Error(`${f}: handler for ${h.interface} says where "${h.where}" but the file is *.${where}.ts`);
			out.push(h);
		}
	}
	return out;
}
