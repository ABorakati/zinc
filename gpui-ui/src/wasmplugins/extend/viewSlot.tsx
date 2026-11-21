// A place where a plugin draws its own view (a section body, a tab, a side panel, a toolbar view). The drawing is the ui agent's
// `PluginView` (gpui-ui/src/wasmplugins/ui/index.ts); it is loaded on first use, so the default app does not load it. Until it is
// there (or when a test binds none) the slot shows a muted note.
import { createSignal, Show, type Component, type JSX } from "solid-js";
import { Txt } from "../../shell/kit";

/** The surface names of ui.wit that extend uses. */
export type ExtendSurface = "item-pane-section" | "tab" | "side-panel" | "toolbar-slot" | "preferences-pane";

/** What this area expects of `PluginView`. */
export interface PluginViewProps {
	plugin: string;
	/** `ui.view-context.view`: the id registered with extend (pane id, tab id, panel id, view id, "<pane>/<row>"). */
	view: string;
	surface: ExtendSurface;
	/** `ui.view-context.params` (an object; the host stringifies it). */
	params?: Record<string, unknown>;
	width?: number;
	height?: number;
	/** The view is on screen (a collapsed section or a hidden tab passes false). */
	visible?: boolean;
	/** Called with the view's `render-result.meta` (title, summary, enabled, badge, buttons). */
	onMeta?: (meta: { enabled?: boolean; summary?: unknown; badge?: number; buttons?: unknown[] } | undefined) => void;
}

const [component, setComponent] = createSignal<Component<PluginViewProps> | undefined>(undefined);
let loading: Promise<void> | undefined;

/** Bind the renderer by hand (tests, or the ui agent at start-up). */
export function setPluginViewComponent(c: Component<PluginViewProps> | undefined): void {
	setComponent(() => c);
}

/** Where the ui agent's module lives, relative to this file. */
const UI_MODULE = "../ui/index";

function load(): void {
	if (component()) return;
	loading ??= (async () => {
		try {
			const spec: string = UI_MODULE;
			const mod = (await import(spec)) as { PluginView?: Component<PluginViewProps> };
			if (!component() && mod.PluginView) setComponent(() => mod.PluginView);
		} catch {
			/* the ui area is not built into this checkout */
		}
	})();
}

/** Press a section header button: forwarded to the ui agent's view runtime (`pressViewButton(plugin, view, buttonId)`) when it has one. */
export async function pressSectionButton(plugin: string, view: string, buttonId: string): Promise<boolean> {
	try {
		const spec: string = UI_MODULE;
		const mod = (await import(spec)) as { pressViewButton?: (plugin: string, view: string, buttonId: string) => Promise<void> | void };
		if (!mod.pressViewButton) return false;
		await mod.pressViewButton(plugin, view, buttonId);
		return true;
	} catch {
		return false;
	}
}

export function PluginViewSlot(p: PluginViewProps & { fallback?: JSX.Element }): JSX.Element {
	load();
	return (
		<Show
			when={component()}
			fallback={p.fallback ?? <Txt cls="text-xs text-muted-foreground">{`${p.view} (the plugin view renderer is not available)`}</Txt>}
		>
			{(C) => {
				const View = C();
				return <View {...p} />;
			}}
		</Show>
	);
}
