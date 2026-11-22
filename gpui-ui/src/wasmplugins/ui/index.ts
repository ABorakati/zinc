// The plugin UI: what the extend and reader areas (and the app) import.
//
//   <PluginView pluginId surface view params />   mounts a plugin view and draws it with Zinc's components (PluginView.tsx)
//   setUiSupervisor(sup)                          optional: the supervisor views use when they get no `supervisor` prop. Without it
//                                                 PluginView falls back to getPluginSupervisor() of ../host
//   ControllerView / ViewController               the pieces under PluginView (dialogs use them; tests too)
//   promptPermission(req)                         the run-time permission dialog: pass it as `prompt` to createPluginRuntime
//   clearUiOf(pluginId?)                          close the plugin's dialogs and toasts and drop its theme override when its registrations are reset
//   setLocalizer / setPrefsBackend                where texts and `pref` bindings come from (defaults: the package area's services)
// The `ui` import itself (dialogs, toasts, theme, ...) is plugin-host/src/imports/ui.zinc.ts, which calls ./host.
import * as uiHost from "./host";

export { PluginView, setUiSupervisor, uiSupervisor } from "./PluginView";
export type { PluginViewProps } from "./PluginView";
export { ControllerView } from "./ControllerView";
export { ViewController, allocInstance, lookupInstance, allControllers, P } from "./controller";
export type { ViewState, ViewStatus } from "./controller";
export { promptPermission } from "./permission";
export type { PermissionPromptRequest } from "./permission";
export { clearUiOf, onThemeOverrideChange, themeOverrideList } from "./host";
export { setLocalizer } from "./l10n";
export { setPrefsBackend } from "./prefs";
export { jsonToTree, jsonToPatch, buildNested, applyPatch, getValidationMode, setValidationMode, TreeError } from "./convert";
export type { ValidationMode } from "./convert";
export type * from "./types";

const UI_HOST_SLOT = Symbol.for("zinc.wasmplugins.ui-host");

/** Register the UI host implementation for `plugin-host/src/imports/ui.zinc.ts` so packaged builds never need a runtime `import(new URL(...))`. */
export function installUiHost(): () => void {
	const g = globalThis as Record<symbol, unknown>;
	g[UI_HOST_SLOT] = uiHost;
	return () => {
		if (g[UI_HOST_SLOT] === uiHost) delete g[UI_HOST_SLOT];
	};
}
