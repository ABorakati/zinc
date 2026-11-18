// definePlugin(): fill in the exports a plugin does not write.
//
// The `plugin` world has eight exported interfaces with 48 functions between them. A QuickJS guest that omits one would trap when
// the host calls it, so definePlugin() adds a default for every function: nothing for fire-and-forget callbacks, an empty list for
// list results, "unavailable" for results that cannot be faked. The list of functions is generated from the WIT
// (scripts/gen-types.ts -> src/generated/exports.ts), so it follows the WIT.
import type { Exports } from "../types/exports";
import { fillSpec } from "./defaults";
import { EXPORT_FUNCTIONS } from "./generated/exports";

export type PluginImpl = { [K in keyof Exports]?: Partial<Exports[K]> };
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
		case "mount": case "updateContext": case "onEvent": case "resync":
			return () => ({ content: { tag: "unchanged" } });
		case "renderRange":
			return (_i: unknown, req: any) => ({ start: req?.start ?? 0, rows: [], nodes: [], styles: [], total: 0 });
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
 * export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
 * ```
 */
export function definePlugin(impl: PluginImpl): FullPlugin {
	const out: Record<string, Record<string, unknown>> = {};
	for (const { iface, fn, ret, fill } of EXPORT_FUNCTIONS) {
		out[iface] ??= {};
		const mine = (impl as Record<string, Record<string, unknown> | undefined>)[iface]?.[fn];
		if (typeof mine !== "function") out[iface][fn] = fallback(iface, fn, ret);
		else if (!fill) out[iface][fn] = mine;
		else {
			// complete the records the callback returns (a missing required field would trap the guest)
			out[iface][fn] = function (this: unknown, ...a: unknown[]) {
				const r = (mine as (...x: unknown[]) => unknown).apply(this, a);
				return r && typeof (r as { then?: unknown }).then === "function" ? (r as Promise<unknown>).then((v) => fillSpec(fill, v)) : fillSpec(fill, r);
			};
		}
	}
	for (const iface of Object.keys(impl)) {
		if (!out[iface]) throw new Error(`definePlugin: "${iface}" is not an exported interface of the plugin world`);
		for (const fn of Object.keys((impl as any)[iface])) {
			if (!(fn in out[iface])) throw new Error(`definePlugin: "${iface}.${fn}" does not exist in the plugin world`);
		}
	}
	return out as unknown as FullPlugin;
}
