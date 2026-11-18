// <PluginView>: mounts a plugin's view (`ui-events.mount`), draws what it returns and keeps it alive: events go back through
// `ui-events.on-event`, `ui.push` and patches are applied, a changed context goes through `update-context`, hiding calls
// `visibility`, and removal calls `unmount`. If the plugin host restarts, the view is mounted again with the same instance id.
import { createEffect, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import type { Style } from "../../contracts";
import { mode } from "../../ui/core";
import { getPluginSupervisor } from "../host";
import { ControllerView } from "./ControllerView";
import { ViewController } from "./controller";
import type { Surface, UiSupervisor, ViewMeta } from "./types";

let defaultSupervisor: UiSupervisor | undefined;
/** The app sets the supervisor once (`gpui-ui/src/wasmplugins`); views that get no `supervisor` prop use it. */
export function setUiSupervisor(sup: UiSupervisor | undefined): void {
	defaultSupervisor = sup;
}
export const uiSupervisor = (): UiSupervisor | undefined => defaultSupervisor;

export interface PluginViewProps {
	pluginId: string;
	surface: Surface;
	/** The id the plugin used when it registered the surface (`view-context.view`). */
	view: string;
	/** Surface-specific data (`view-context.params`): an object (sent as JSON) or a JSON string. Changing it calls `update-context`. */
	params?: unknown;
	/** The plugin supervisor. Default: the one given to `setUiSupervisor`. */
	supervisor?: UiSupervisor;
	/** false while the view is hidden (a collapsed section, a background tab): the plugin gets `visibility(false)`. Default true. */
	visible?: boolean;
	/** Available size in logical pixels, when known (`view-context.width/height`). */
	width?: number;
	height?: number;
	locale?: string;
	/** Style of the view's frame (size, scrolling). */
	style?: Style;
	/** The controller, once created: `fireRaw(buttonId, "press")` delivers a section header button press, `state.meta` has the frame data. */
	onController?: (c: ViewController) => void;
	/** `render-result.meta` (title, summary, enabled, badge, button states) every time the plugin sends it. */
	onMeta?: (m: ViewMeta) => void;
	reducedMotion?: boolean;
}

export function PluginView(p: PluginViewProps): JSX.Element {
	const sup = untrack(() => p.supervisor ?? defaultSupervisor ?? (getPluginSupervisor() as unknown as UiSupervisor | undefined));
	if (!sup) throw new Error("PluginView: no plugin supervisor (pass `supervisor` or call setUiSupervisor)");
	const ctl = new ViewController(p.pluginId, sup, {
		view: p.view,
		surface: p.surface,
		params: p.params,
		theme: untrack(mode),
		width: p.width,
		height: p.height,
		locale: p.locale ?? "en-US",
	});
	ctl.onMeta = (m) => p.onMeta?.(m);
	p.onController?.(ctl);
	onMount(() => void ctl.mount());
	onCleanup(() => void ctl.unmount());
	// context changes
	createEffect(on(() => (typeof p.params === "string" ? p.params : JSON.stringify(p.params ?? {})), (params) => void ctl.updateContext({ params }), { defer: true }));
	createEffect(on(mode, (theme) => void ctl.updateContext({ theme }), { defer: true }));
	createEffect(on(() => [p.width, p.height] as const, ([width, height]) => void ctl.updateContext({ width, height }), { defer: true }));
	createEffect(on(() => p.locale, (locale) => locale && void ctl.updateContext({ locale }), { defer: true }));
	createEffect(on(() => p.visible !== false, (v) => ctl.setVisible(v), { defer: true }));
	// plugin host restart: the plugin lost its state, so mount again
	const off = sup.on?.("host-restarted", (e: { reloaded: string[] }) => {
		if (e.reloaded.includes(p.pluginId)) void ctl.remount();
	});
	onCleanup(() => off?.());
	return <ControllerView controller={ctl} style={p.style} reducedMotion={p.reducedMotion} />;
}
