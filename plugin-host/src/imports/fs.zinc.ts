// `fs` pick dialogs (lifecycle.wit): `pick-open`, `pick-save`, `pick-directory`. They need a window, so they run in the Zinc process.
// The dialog itself is supplied by the app through `setFilePicker` (data/pick-hook.ts); without one every pick is refused.
// A pick becomes a grant in the shared registry (data/fs-roots.ts); `fs.read` and the rest in the plugin host process then use it.
import { defineHandler, witError } from "./registry";
import { addGrant, type GrantMode } from "./data/fs-roots";
import { getFilePicker, type PickKind } from "./data/pick-hook";

async function pick(ctx: { pluginId: string }, kind: PickKind, options: any, mode: GrantMode, suggestedName?: string) {
	const picker = getFilePicker();
	if (!picker) throw witError("unavailable", "no file dialog is available (the app has not set a file picker)");
	const res = await picker({
		pluginId: ctx.pluginId,
		kind,
		options: { title: options?.title ?? undefined, filters: options?.filters ?? [], persistent: !!options?.persistent },
		suggestedName,
	});
	return (res ?? []).map((p) => addGrant(ctx.pluginId, { path: p.path, isDirectory: p.isDirectory, mode, persistent: !!options?.persistent }));
}

export default defineHandler({
	interface: "zinc:plugin/fs",
	where: "zinc",
	functions: {
		"pick-open": (ctx, options: any, multiple: boolean) => pick(ctx, multiple ? "open-multiple" : "open", options, "read"),
		"pick-save": async (ctx, options: any, suggestedName: string | undefined) => (await pick(ctx, "save", options, "write", suggestedName))[0],
		"pick-directory": async (ctx, options: any) => (await pick(ctx, "directory", options, "readwrite"))[0],
	},
});
