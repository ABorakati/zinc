// Task-pane entry for the Office.js Word add-in: waits for Office.onReady, builds the Host from src/host and
// src/services, sets globalThis.__znHost, and loads the shared sidebar (as word/sidebar/src/demo.ts does).
import { createDocMethods } from "../host";
import { createServiceMethods } from "../services";
import { applyOfficeTheme, createOfficeHost, startTaskPane } from "./router";

export { applyOfficeTheme, createOfficeHost, startTaskPane };

if (typeof Office !== "undefined" && typeof Office?.onReady === "function") {
	void startTaskPane({
		office: Office,
		createDocMethods,
		createServiceMethods,
		loadSidebar: () => import("../../../sidebar/src/main"),
	});
}
