// Shared plumbing of the renderers: the runtime context of one mounted view and what every kind component receives.
import { createContext, useContext, type Accessor } from "solid-js";
import type { Mode, Style } from "../../../contracts";
import type { ViewController } from "../controller";
import type { TextProps } from "../styleMap";
import type { IconRef, NodeProps, UiText, VNode } from "../types";

/** Everything a renderer needs about the view it draws in. */
export interface ViewRuntime {
	ctl: ViewController;
	pluginId: string;
	mode: () => Mode;
	/** Resolve a `ui-text`. */
	txt: (t: UiText | undefined) => string;
	/** The plugin's package folder (bundled icons, images, html pages). */
	dir: () => string | undefined;
	/** Does the plugin hold this permission (`ui.webview`, `library.read`)? */
	has: (permission: string) => boolean;
	/** `net` hosts the plugin may reach (for `web-view`). */
	netHosts: () => string[];
	/** Where the last pointer press was (for `ui.popup-menu` at `pointer`). */
	reducedMotion: () => boolean;
}

export const RuntimeCtx = createContext<ViewRuntime>();
export const useRt = (): ViewRuntime => {
	const r = useContext(RuntimeCtx);
	if (!r) throw new Error("plugin UI: no view runtime (render inside <PluginView>)");
	return r;
};
/** The inherited text properties at this point of the tree. */
export const TextCtx = createContext<Accessor<TextProps>>(() => ({}));
export const useText = (): Accessor<TextProps> => useContext(TextCtx);

/** What NodeView hands to every kind component. */
export interface KindProps {
	node: VNode;
	parentId: string | undefined;
	/** The node's own GPUIX style: layout, size, paint from `style`, `class` and `states`, with `hidden`/`disabled` applied. */
	box: Accessor<Style>;
	/** Inherited text properties including this node's own. */
	text: Accessor<TextProps>;
	/** GPUIX event props for the events every node can fire (press, context menu, hover, key, focus). */
	handlers: Record<string, unknown>;
	/** Register the painted element (popover anchors, focus, scroll-to, `popup-menu` at a node). */
	reg: (el: unknown) => void;
}
export type KindComponent = (p: KindProps) => any;

export type { IconRef, NodeProps };

/** The `form` a control sits in: named controls register their values with it, `submit` collects them. */
export interface FormScope {
	id: string;
	submit: () => void;
	busy: () => boolean;
}
export const FormCtx = createContext<FormScope | undefined>(undefined);
