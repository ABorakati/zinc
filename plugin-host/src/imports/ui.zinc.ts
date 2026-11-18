// `ui` (ui.wit): dialogs, prompts, toasts, popup menus, theme and pushed view updates. The implementation draws with Zinc's own
// components and lives in gpui-ui/src/wasmplugins/ui/host.tsx; this file only adapts it to the handler contract. It is loaded by
// `discoverHandlers("zinc")` in the app process, which is the one that has the UI, so the module is imported lazily and by a computed
// path (the host process and the type check of this package never see gpui-ui).
import { defineHandler, witError, type HandlerContext } from "./registry";

type Impl = Record<string, (ctx: any, ...args: any[]) => any> & { UiHostError: new (...a: any[]) => Error & { tag: string } };
let impl: Promise<Impl> | undefined;
const load = (): Promise<Impl> => (impl ??= import(new URL("../../../gpui-ui/src/wasmplugins/ui/host.tsx", import.meta.url).href) as Promise<Impl>);

/** Run an implementation function, turning its UiHostError into `result::err`. */
function fn(name: string) {
	return async (ctx: HandlerContext, ...args: unknown[]) => {
		const m = await load();
		try {
			return await m[name]!({ pluginId: ctx.pluginId, has: (p: string) => ctx.has(p), callExport: (i: string, f: string, a?: unknown[]) => ctx.callExport(i, f, a) }, ...args);
		} catch (e) {
			if (e instanceof m.UiHostError) throw witError(e.tag as never, e.message);
			throw e;
		}
	};
}

export default defineHandler({
	interface: "zinc:plugin/ui",
	where: "zinc",
	functions: {
		push: fn("push"),
		refresh: fn("refresh"),
		focus: fn("focus"),
		"scroll-to": fn("scrollTo"),
		"form-values": fn("formValues"),
		"web-post-message": fn("webPostMessage"),
		"open-dialog": fn("openDialogNow"),
		"update-dialog": fn("updateDialog"),
		"close-dialog": fn("closeDialog"),
		alert: fn("alert"),
		confirm: fn("confirm"),
		prompt: fn("prompt"),
		"open-window": fn("openWindow"),
		"close-window": fn("closeWindow"),
		"popup-menu": fn("popupMenu"),
		"show-toast": fn("showToast"),
		"update-toast": fn("updateToast"),
		"close-toast": fn("closeToast"),
		"get-theme": fn("getTheme"),
		"set-theme-override": fn("setThemeOverride"),
		"clear-theme-override": fn("clearThemeOverride"),
		"measure-text": fn("measure"),
	},
});
