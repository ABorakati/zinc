// The Zinc-process side of the `reader`, `annotations` and `note-editor` imports. The `where: "zinc"` handler files
// (plugin-host/src/imports/{reader,annotations,note-editor}.zinc.ts) are thin: they find this service through a global slot and call
// `service.call(interface, function, ctx, args)`. Keeping the logic here lets it import the reader and the UI.
import { createAnnotationsApi } from "./annotations";
import { createNoteApi } from "./notes";
import { createReaderApi } from "./reader";
import { fail, type PluginCtx } from "./types";

export type ReaderInterface = "annotations" | "reader" | "note-editor";

/** The slot the handler files read. */
export const SERVICE_SLOT = Symbol.for("zinc.wasmplugins.reader-service");

export interface ReaderService {
	/** `fn` in camelCase (the router normalises names). Throws WitFailure for a WIT error. */
	call(iface: ReaderInterface, fn: string, ctx: PluginCtx, args: unknown[]): Promise<unknown>;
}

export function createReaderService(): ReaderService {
	const apis = { annotations: createAnnotationsApi(), reader: createReaderApi(), "note-editor": createNoteApi() } as unknown as Record<
		ReaderInterface,
		Record<string, (ctx: PluginCtx, ...a: unknown[]) => unknown>
	>;
	return {
		async call(iface, fn, ctx, args) {
			const f = apis[iface]?.[fn.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())];
			if (typeof f !== "function") return fail("unavailable", `unsupported: no handler for zinc:plugin/${iface}#${fn}`);
			return await f.call(apis[iface], ctx, ...args);
		},
	};
}

export const installedService = (): ReaderService | undefined => (globalThis as Record<symbol, unknown>)[SERVICE_SLOT] as ReaderService | undefined;
export const setInstalledService = (s: ReaderService | undefined): void => {
	(globalThis as Record<symbol, unknown>)[SERVICE_SLOT] = s;
};
