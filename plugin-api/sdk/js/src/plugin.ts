// definePlugin(): fill in the exports a plugin does not write.
//
// The `plugin` world has eight exported interfaces with 48 functions between them. A QuickJS guest that omits one would trap when
// the host calls it, so definePlugin() adds a default for every function: nothing for fire-and-forget callbacks, an empty list for
// list results, "unavailable" for results that cannot be faked. The list of functions is generated from the WIT
// (scripts/gen-types.ts -> src/generated/exports.ts), so it follows the WIT.
import type { Exports } from "../types/exports";
import { fillSpec } from "./defaults";
import { EXPORT_FUNCTIONS } from "./generated/exports";
import { callTool, type Tool } from "./mcp";
import { dispatchDialogEvent } from "./ui";

export type PluginImpl = { [K in keyof Exports]?: Partial<Exports[K]> } & {
	/** Tools for AI agents (`defineTool`): implements `mcpHandler.onMcpCall`. See mcp.ts. */
	tools?: Tool[];
};
export type FullPlugin = Exports;

/** Throw this from a callback that returns `result<_, error>`: `fail("not-found", "no such item")`. */
export function fail(tag: "not-found" | "invalid-argument" | "permission-denied" | "read-only" | "conflict" | "limit-exceeded" | "unavailable" | "internal", message: string): never;
export function fail(tag: "timeout" | "cancelled"): never;
export function fail(tag: string, message?: string): never {
	throw message === undefined ? { tag } : { tag, val: message };
}

const unavailable = (what: string) => () => fail("unavailable", `${what} is not implemented`);

function fallback(iface: string, fn: string, ret: string): (...a: unknown[]) => unknown {
	if (ret === "void") return () => undefined;
	if (ret.startsWith("Array<")) return () => [];
	switch (fn) {
		case "mount": case "updateContext": case "resync":
			return () => ({ content: { tag: "unchanged" } });
		case "onEvent":
			return (instance: any, event: any) => {
				dispatchDialogEvent(instance, event);
				return { content: { tag: "unchanged" } };
			};
		case "renderRange":
			return (_i: unknown, req: any) => ({ start: req?.start ?? 0, rows: [], styles: undefined, total: 0 });
		case "onMcpCall": return (tool: unknown) => fail("not-found", `no tool named ${String(tool)}`);
		case "onTabClosing": return () => true;
		case "onTabRestore": return () => false;
		case "onDrop": return () => "ignored";
		case "onVirtualCollectionItems": return () => ({ keys: [], total: 0 });
		default: return unavailable(`${iface}.${fn}`);
	}
}

/**
 * ```js
 * const plugin = definePlugin({ lifecycle: { startup() { ... } }, extendHandlers: { onMenuCommand(menu, entry, checked, ctx) { ... } } });
 * export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents, mcpHandler } = plugin;
 * ```
 */
export function definePlugin(implIn: PluginImpl): FullPlugin {
	const { tools, ...rest } = implIn;
	const impl = rest as { [K in keyof Exports]?: Partial<Exports[K]> };
	if (tools?.length) {
		if (impl.mcpHandler?.onMcpCall) throw new Error("definePlugin: give either `tools` or mcpHandler.onMcpCall, not both");
		const names = new Set<string>();
		for (const t of tools) {
			if (names.has(t.spec.name)) throw new Error(`definePlugin: two tools are called ${t.spec.name}`);
			names.add(t.spec.name);
		}
		impl.mcpHandler = { ...impl.mcpHandler, onMcpCall: (tool: string, args: string) => callTool(tools, tool, args) };
	}
	const out: Record<string, Record<string, unknown>> = {};
	for (const { iface, fn, ret, fill } of EXPORT_FUNCTIONS) {
		out[iface] ??= {};
		const mine = (impl as Record<string, Record<string, unknown> | undefined>)[iface]?.[fn];
		if (typeof mine !== "function") {
			out[iface][fn] = fallback(iface, fn, ret);
			continue;
		}
		const wrapped =
			iface === "uiEvents" && fn === "onEvent"
				? function (this: unknown, instance: any, event: any) {
						if (dispatchDialogEvent(instance, event)) return { content: { tag: "unchanged" } };
						return (mine as (...x: unknown[]) => unknown).call(this, instance, event);
					}
				: (mine as (...x: unknown[]) => unknown);
		if (!fill) {
			out[iface][fn] = function (this: unknown, ...a: unknown[]) {
				const r = wrapped.apply(this, a);
				// In `--sync` QuickJS components, a `void` export that uses `async`/`await` (e.g. `await ui.dialog(...)`)
				// returns a pending Promise; returning `undefined` lets the export finish so the `close` event can re-enter.
				if (ret === "void" && r && typeof (r as { then?: unknown }).then === "function") return undefined;
				return r;
			};
		} else {
			// complete the records the callback returns (a missing required field would trap the guest)
			out[iface][fn] = function (this: unknown, ...a: unknown[]) {
				const r = wrapped.apply(this, a);
				return r && typeof (r as { then?: unknown }).then === "function" ? (r as Promise<unknown>).then((v) => fillSpec(fill, v)) : fillSpec(fill, r);
			};
		}
	}
	// setTimeout/setInterval (prelude.js) fire through events.on-timer: those ids are handled here, the rest go to the plugin's own onTimer.
	const ev = out.events;
	if (ev?.onTimer) {
		const own = ev.onTimer as (id: number, kind: string) => unknown;
		ev.onTimer = (id: number, kind: string) => {
			const fire = (globalThis as { __zincTimerFire?: (id: number, kind: string) => boolean }).__zincTimerFire;
			if (fire?.(id, kind)) return undefined;
			return own(id, kind);
		};
	}
	for (const iface of Object.keys(impl)) {
		if (!out[iface]) throw new Error(`definePlugin: "${iface}" is not an exported interface of the plugin world`);
		for (const fn of Object.keys((impl as any)[iface])) {
			if (!(fn in out[iface])) throw new Error(`definePlugin: "${iface}.${fn}" does not exist in the plugin world`);
		}
	}
	return out as unknown as FullPlugin;
}
