// `app` (lifecycle.wit): Zinc's version, platform, locale and features, and the library windows. The facts come from the providers the
// app passed to createPluginRuntime (package/app-service.ts). No permission.
import { defineHandler } from "./registry";
import { getServices } from "../package/services";

export default defineHandler({
	interface: "zinc:plugin/app",
	where: "zinc",
	functions: {
		"get-info"() {
			return getServices().app.info();
		},
		"is-ui-ready"() {
			return getServices().app.isUiReady();
		},
		async "wait-ui-ready"() {
			await getServices().app.waitUiReady();
		},
		"main-windows"() {
			return getServices().app.mainWindows();
		},
		"active-window"() {
			return getServices().app.activeWindow();
		},
	},
});
