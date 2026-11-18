// `zinc:plugin/reader`, `zinc:plugin/annotations` and `zinc:plugin/note-editor` in the Zinc process (reader.wit).
// The implementation lives with the UI it drives: gpui-ui/src/wasmplugins/reader/ (service.ts). These handlers only forward each call to
// that service, which the app installs with `installReaderBridge()` (gpui-ui/src/wasmplugins/reader/index.ts). Called before the app
// installed it (a test that loads only this file), the first call installs it. The service is found through a global slot, not an import,
// so this file stays free of the UI's JSX in plugin-host's own type check.
import { defineHandler, witError, type HandlerContext, type ImportHandler, type WitErrorTag } from "./registry";

const SLOT = Symbol.for("zinc.wasmplugins.reader-service");
type Service = { call(iface: string, fn: string, ctx: HandlerContext, args: unknown[]): Promise<unknown> };

const here = import.meta.dir;
async function service(): Promise<Service> {
	const g = globalThis as Record<symbol, unknown>;
	if (!g[SLOT]) {
		const spec: string = `${here.replace(/\\/g, "/")}/../../../gpui-ui/src/wasmplugins/reader/index.ts`;
		const m = (await import(spec)) as { installReaderBridge(): () => void };
		m.installReaderBridge();
	}
	const s = g[SLOT] as Service | undefined;
	if (!s) throw witError("unavailable", "the reader is not running");
	return s;
}

const TAGS = new Set(["not-found", "invalid-argument", "permission-denied", "read-only", "conflict", "limit-exceeded", "unavailable", "internal"]);

function forward(iface: "annotations" | "reader" | "note-editor", names: string[]): ImportHandler {
	const functions: ImportHandler["functions"] = {};
	for (const name of names) {
		functions[name] = async (ctx: HandlerContext, ...args: unknown[]) => {
			try {
				return await (await service()).call(iface, name, ctx, args);
			} catch (e) {
				const f = e as { name?: string; tag?: string; text?: string; payload?: unknown };
				if (f?.name === "WitFailure" && f.tag && TAGS.has(f.tag)) throw witError(f.tag as WitErrorTag, f.text);
				throw e; // a WitError from ctx.require, or a bug: the router turns it into err(internal)
			}
		};
	}
	return defineHandler({ interface: `zinc:plugin/${iface}`, where: "zinc", functions });
}

export default [
	forward("annotations", [
		"list-annotations",
		"get-annotations",
		"create-annotations",
		"update-annotations",
		"remove-annotations",
		"get-annotation-image",
		"set-annotation-image",
		"annotation-colors",
		"import-embedded-annotations",
	]),
	forward("reader", [
		"list-readers",
		"get-reader",
		"get-reader-by-tab",
		"selected-reader",
		"open",
		"close",
		"focus",
		"get-state",
		"get-selection",
		"get-outline",
		"get-page-labels",
		"get-page-text",
		"render-page",
		"navigate",
		"navigate-step",
		"run-command",
		"set-layout",
		"set-tool",
		"set-filter",
		"show-annotations",
		"select-annotations",
		"clear-selection",
		"set-sidebar",
		"set-split",
		"find",
		"rotate-pages",
		"delete-pages",
		"list-themes",
		"get-theme-choice",
		"set-theme-choice",
		"save-theme",
		"delete-theme",
		"register-listener",
		"register-panel",
		"register-overlay",
		"register-link-interceptor",
		"unregister",
		"invalidate",
		"subscribe",
	]),
	forward("note-editor", [
		"list-editors",
		"active-editor",
		"open-note",
		"focus",
		"get-content",
		"get-selection",
		"insert-html",
		"insert-annotations",
		"apply-update",
		"save-now",
		"serialize-annotations",
		"create-note-from-annotations",
		"exportable-html",
		"add-embedded-image",
		"copy-embedded-images",
		"embedded-images-available",
		"delete-unused-embedded-images",
		"register-head",
		"unregister-head",
		"invalidate-head",
		"subscribe-note-events",
	]),
];
