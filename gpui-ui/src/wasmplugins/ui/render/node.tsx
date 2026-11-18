// NodeView: draws one VNode. It resolves `class` + `style` + `states` into a GPUIX style, merges inherited text properties down the
// tree, wires the events every node can fire, and hands the rest to the component of the node's kind.
import { createMemo, For, onCleanup, untrack, type JSX } from "solid-js";
import type { EventPayload, HostElement } from "@gpuix/solid";
import type { Style } from "../../../contracts";
import { openMenu, type MenuItem } from "../../../ui";
import { boundsOf, hideTooltip, showTooltip } from "../../../ui/core";
import { NO_MODS, P } from "../controller";
import { mapBox, mapStates, mergeText } from "../styleMap";
import type { MenuT, Modifiers, NodeProps, StateStyles, Style as PStyle, VNode } from "../types";
import { TextCtx, useRt, useText, type KindComponent, type KindProps } from "./ctx";
import { content } from "./content";
import { collections } from "./collections";
import { inputs } from "./inputs";
import { layout } from "./layout";
import { special } from "./special";

/** GPUIX key names -> DOM key names. */
const DOM_KEY: Record<string, string> = {
	enter: "Enter",
	escape: "Escape",
	esc: "Escape",
	tab: "Tab",
	space: " ",
	backspace: "Backspace",
	delete: "Delete",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
};
export const domKey = (k: string | undefined): string => (k ? (DOM_KEY[k.toLowerCase()] ?? (k.length === 1 ? k : k[0]!.toUpperCase() + k.slice(1))) : "");

export const modsOf = (e: EventPayload | undefined): Modifiers => {
	const m = (e as unknown as { modifiers?: Record<string, boolean> } | undefined)?.modifiers;
	return m ? { shift: !!m.shift, ctrl: !!m.ctrl, alt: !!m.alt, meta: !!(m.meta || m.cmd) } : NO_MODS;
};

/** The pointer last pressed in any plugin view, in window coordinates (`ui.popup-menu` at `pointer`). */
export let lastPointer = { x: 0, y: 0 };
export const setLastPointer = (x: number, y: number) => {
	lastPointer = { x, y };
};

/** Merge `class` named styles (in order) and the node's own style. */
function effective(rt: ReturnType<typeof useRt>, props: NodeProps): { style: PStyle; states: StateStyles | undefined } {
	let style: PStyle = props.style;
	let states: StateStyles | undefined = props.states;
	if (props.class.length) {
		const named = rt.ctl.state.styles;
		let s: PStyle = {};
		let st: StateStyles = {};
		for (const c of props.class) {
			const n = named[c];
			if (!n) continue;
			s = { ...s, ...defined(n.style) };
			if (n.states) st = { ...st, ...n.states };
		}
		style = { ...s, ...defined(props.style) };
		states = { ...st, ...props.states };
	}
	return { style, states };
}
const defined = (o: PStyle): PStyle => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as PStyle;

/** MenuT (flat) -> Zinc menu items. `choose` runs with the item id. */
export function toMenuItems(menu: MenuT, txt: (t: any) => string, choose: (id: string) => void): MenuItem[] {
	const conv = (i: number): MenuItem | undefined => {
		const it = menu.items[i];
		if (!it || it.hidden) return undefined;
		if (it.kind === "separator") return { separator: true };
		if (it.kind === "heading") return { heading: txt(it.label) };
		const icon = it.icon?.tag === "builtin" ? it.icon.val : undefined;
		const out: MenuItem = {
			label: txt(it.label),
			icon,
			shortcut: it.shortcut,
			disabled: it.disabled,
			danger: it.danger,
			checked: it.kind === "check" || it.kind === "radio" ? it.checked : undefined,
		};
		if (it.kind === "submenu") out.submenu = Array.from(it.children).map(conv).filter((x): x is MenuItem => !!x);
		else out.onSelect = () => choose(it.id);
		return out;
	};
	return Array.from(menu.roots).map(conv).filter((x): x is MenuItem => !!x);
}

export function NodeView(p: { node: VNode; parentId?: string }): JSX.Element {
	const rt = useRt();
	const inh = useText();
	const eff = createMemo(() => effective(rt, p.node.props));
	const text = createMemo(() => mergeText(inh(), eff().style, rt.mode()));
	const box = createMemo<Style>(() => {
		const m = rt.mode();
		const { style, states } = eff();
		const out = { ...mapBox(style, m), ...mapStates(states, m) } as Style;
		if (p.node.props.disabled && states?.disabled) Object.assign(out, mapBox(states.disabled, m));
		if (p.node.props.hidden) Object.assign(out, { display: "none", visibility: "hidden", width: 0, height: 0, overflow: "hidden" });
		return out;
	});

	const node = () => p.node;
	let el: HostElement | undefined;
	let regId: string | undefined;
	const reg = (x: unknown) => {
		el = x as HostElement;
		regId = untrack(() => node()?.id);
		if (regId !== undefined) rt.ctl.els.set(regId, x);
	};
	onCleanup(() => regId !== undefined && rt.ctl.els.delete(regId));

	// ---- events every node can fire. Bindings are read when the event happens; which handlers are attached is decided once, here.
	const first = untrack(() => node().props);
	const hasInitial = (...kinds: string[]) => first.events.some((b) => kinds.includes(b.event));
	const handlers: Record<string, unknown> = { ref: reg };
	const pointerOf = (e: EventPayload, button = 0) => {
		const b = boundsOf(el);
		return P.pointer((e.x ?? 0) - (b?.x ?? 0), (e.y ?? 0) - (b?.y ?? 0), { button });
	};
	handlers.onClick = (e: EventPayload) => {
		setLastPointer(e.x ?? 0, e.y ?? 0);
		const n = node();
		const m = modsOf(e);
		if ((e.clickCount ?? 1) >= 2 && rt.ctl.has(n, "double-press")) rt.ctl.fire(n, "double-press", pointerOf(e), m);
		const stop = n.props.events.some((b) => b.event === "press" && b.stopPropagation);
		if (rt.ctl.fire(n, "press", pointerOf(e), m) && stop) (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
	};
	handlers.onAuxClick = (e: EventPayload) => {
		setLastPointer(e.x ?? 0, e.y ?? 0);
		const n = node();
		if (!(e.isRightClick || e.button === 2)) return;
		const fired = rt.ctl.fire(n, "context-menu", pointerOf(e, 2), modsOf(e));
		const menu = n.props.contextMenu;
		if (menu) {
			openMenu(
				{ x: e.x ?? 0, y: e.y ?? 0 },
				toMenuItems(menu, rt.txt, (id) => void rt.ctl.fireRaw(id, "press", P.none, n.props.key)),
			);
		}
		if (fired && n.props.events.some((b) => b.event === "context-menu" && b.stopPropagation)) (e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
	};
	if (first.tooltip || hasInitial("hover-enter", "hover-leave")) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			hideTooltip();
		};
		onCleanup(cancel);
		handlers.onMouseEnter = (e: EventPayload) => {
			rt.ctl.fire(node(), "hover-enter", pointerOf(e), modsOf(e));
			cancel();
			const tip = node().props.tooltip;
			if (!tip) return;
			const pointer = { x: e.x ?? 0, y: e.y ?? 0 };
			timer = setTimeout(() => {
				timer = undefined;
				showTooltip({ label: rt.txt(tip), rect: boundsOf(el), pointer });
			}, 500);
		};
		handlers.onMouseLeave = (e: EventPayload) => {
			cancel();
			rt.ctl.fire(node(), "hover-leave", pointerOf(e), modsOf(e));
		};
		handlers.onMouseDown = cancel;
	}
	if (hasInitial("key-down")) {
		handlers.onKeyDown = (e: EventPayload) => {
			const k = domKey(e.key);
			rt.ctl.fire(node(), "key-down", P.key(k, !!e.isHeld), modsOf(e), k);
		};
	}
	if (hasInitial("key-up")) {
		handlers.onKeyUp = (e: EventPayload) => {
			const k = domKey(e.key);
			rt.ctl.fire(node(), "key-up", P.key(k, false), modsOf(e), k);
		};
	}
	if (hasInitial("focus", "blur")) {
		handlers.onFocus = () => rt.ctl.fire(node(), "focus");
		handlers.onBlur = () => rt.ctl.fire(node(), "blur");
		handlers.tabIndex = first.a11y.tabIndex ?? 0;
	}
	if (first.a11y.label) handlers["aria-label"] = rt.txt(first.a11y.label);
	if (first.a11y.role && first.a11y.role !== "none") handlers.role = first.a11y.role;
	if (first.testId) handlers.testId = first.testId;

	// A `visible` binding: the node is shown now (lazy loading); the host has no scroll-visibility tracking yet.
	if (hasInitial("visible")) queueMicrotask(() => rt.ctl.fire(node(), "visible", P.toggled(true)));

	const kp: KindProps = {
		get node() {
			return p.node;
		},
		get parentId() {
			return p.parentId;
		},
		box: box as KindProps["box"],
		text: text as KindProps["text"],
		handlers,
		reg,
	};
	return (
		<TextCtx.Provider value={text}>
			<KindHost kp={kp} />
		</TextCtx.Provider>
	);
}

/** Runs inside the text-context provider so children see this node's inherited text properties. */
function KindHost(p: { kp: KindProps }): JSX.Element {
	const view = createMemo(() => {
		const C: KindComponent = kinds()[p.kp.node.kind.tag] ?? Unknown;
		return untrack(() => C(p.kp));
	});
	return <>{view()}</>;
}

/** Children of a node, each as a NodeView. */
export function Children(p: { node: VNode }): JSX.Element {
	return <For each={p.node.children}>{(c) => <NodeView node={c} parentId={p.node.id} />}</For>;
}

let table: Record<string, KindComponent> | undefined;
const kinds = (): Record<string, KindComponent> => (table ??= { ...layout, ...content, ...inputs, ...collections, ...special });

function Unknown(p: KindProps): JSX.Element {
	const rt = useRt();
	return (
		<div style={{ ...p.box(), padding: 4 }}>
			<text style={{ color: "#c00", fontSize: 12 }}>{`unknown node kind "${p.node.kind.tag}" (${rt.pluginId})`}</text>
		</div>
	);
}
