// Menus: openMenu(), DropdownMenu, ContextMenu and the MenuLayerView that OverlayHost draws.
// Look: ui/src/components/ui/dropdown-menu.tsx ("min-w-32 rounded-md border bg-popover p-1 shadow-md", items
// "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm focus:bg-accent"). Positioning is computed here (window
// coordinates + `anchored position`), not by GPUIX trigger-relative anchoring.
import { createSignal, For, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import type { Style } from "../contracts";
import { Icon } from "../icons";
import { withAlpha } from "../theme";
import {
	boundsOf,
	closeMenus,
	focusClaimCount,
	focusedId,
	newId,
	placeAt,
	pushLayer,
	removeLayer,
	restoreFocus,
	t,
	tok,
	tx,
	windowSize,
	type Anchor,
	type MenuItem,
	type MenuLayer,
	type Pos,
} from "./core";

/** Optional third argument of openMenu (addition): minWidth is the least panel width in px (Select uses the trigger width). */
export interface OpenMenuOptions {
	minWidth?: number;
}

/** Open a menu at a point or under a rect; closes on select, Escape or outside click. */
export function openMenu(at: Anchor, items: MenuItem[] | (() => MenuItem[]), opts?: OpenMenuOptions): void {
	closeMenus();
	pushLayer({
		kind: "menu",
		id: newId(),
		at,
		items: typeof items === "function" ? items : () => items,
		minWidth: opts?.minWidth,
		prevFocus: focusedId(),
	});
}

/** A button that opens a dropdown menu under itself (trigger is any element). */
export function DropdownMenu(p: {
	trigger: JSX.Element;
	items: MenuItem[] | (() => MenuItem[]);
	align?: "start" | "end";
	width?: number;
	style?: Style;
}): JSX.Element {
	let el: HostElement | undefined;
	const open = (e: EventPayload) => {
		const b = boundsOf(el);
		openMenu(b ? { rect: b, align: p.align } : { x: e.x ?? 0, y: e.y ?? 0 }, p.items, { minWidth: p.width });
	};
	// The click is taken by a transparent layer OVER the trigger, not by this wrapper: GPUIX lets a filled box block the hit test for
	// the boxes around it (should_occlude), so a wrapper around a filled trigger (a white button) never got the click. The layer has
	// pointerEvents "none", which in GPUIX only means "does not block": it still gets the click, and the trigger under it keeps its
	// hover and its own handlers (e.g. swallow() in a card).
	return (
		<div
			ref={(x: HostElement) => {
				el = x;
			}}
			style={{ display: "flex", flexDirection: "row", ...p.style }}
		>
			{p.trigger}
			<div onClick={open} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none" }} />
		</div>
	);
}

/**
 * Attach a right-click menu to its children. The wrapper is a column that fills its parent's width (what a list row
 * needs); pass `style` (addition) to change that, e.g. { width: "auto" } around an inline element.
 */
export function ContextMenu(p: { items: () => MenuItem[]; children: JSX.Element; style?: Style }): JSX.Element {
	const open = (e: EventPayload) => {
		if (!(e.isRightClick || e.button === 2)) return;
		openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, p.items);
	};
	return (
		<div onAuxClick={open} style={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0, ...p.style }}>
			{p.children}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- layer view

interface Level {
	items: MenuItem[];
	pos: Pos;
	minWidth?: number;
}

const isSelectable = (it: MenuItem | undefined): boolean =>
	!!it && !it.separator && it.heading === undefined && !it.disabled && (it.label !== undefined || !!it.submenu);
/** A list longer than this gets compact rows (long pickers such as Add to collection). */
const COMPACT_AFTER = 12;
const isCompact = (items: MenuItem[]) => items.length > COMPACT_AFTER;
/** Panel height caps: a submenu, and a long list at the top level; shorter menus keep their natural height (up to the window). */
const SUB_MAX_H = 420;
const LONG_MAX_H = 520;
/** Labels longer than this are cut with an ellipsis, so one long collection name does not widen the whole panel. */
const LABEL_MAX_W = 320;
const rowH = (items: MenuItem[]) => (isCompact(items) ? 26 : 32);
const estimateHeight = (items: MenuItem[]) =>
	8 + 2 + items.reduce((h, it) => h + (it.separator ? 9 : it.heading !== undefined ? 28 : rowH(items)), 0);
const maxHeightFor = (items: MenuItem[], lv: number) =>
	Math.min(windowSize().height - 16, lv > 0 ? SUB_MAX_H : isCompact(items) ? LONG_MAX_H : Number.POSITIVE_INFINITY);

/** One open menu: the root panel plus its open submenus, a transparent click-away backdrop, and the key handling for all of them. */
export function MenuLayerView(p: { layer: MenuLayer; priority: number }) {
	const layer = p.layer;
	const rootItems = layer.items();
	const [levels, setLevels] = createSignal<Level[]>([
		{
			items: rootItems,
			pos: placeAt(layer.at, Math.min(estimateHeight(rootItems), maxHeightFor(rootItems, 0))),
			minWidth: layer.minWidth,
		},
	]);
	const [active, setActive] = createSignal<number[]>([-1]);
	const rows = new Map<string, HostElement>();
	const key = (lv: number, i: number) => `${lv}:${i}`;

	const close = () => {
		removeLayer(layer.id);
		restoreFocus(layer.prevFocus);
	};

	const setActiveAt = (lv: number, i: number) =>
		setActive((a) => {
			const n = a.slice(0, lv + 1);
			n[lv] = i;
			return n;
		});

	function closeBelow(lv: number) {
		if (levels().length > lv + 1) {
			setLevels((l) => l.slice(0, lv + 1));
			setActive((a) => a.slice(0, lv + 1));
		}
	}
	function openSub(lv: number, i: number, keyboard = false) {
		const item = levels()[lv]?.items[i];
		if (!item?.submenu || item.disabled) return;
		const r = boundsOf(rows.get(key(lv, i)));
		const base = levels()[lv]!.pos;
		const win = windowSize();
		const subW = 200;
		let pos: Pos;
		if (r)
			pos =
				r.x + r.width + 4 + subW > win.width - 8
					? { x: r.x - 4, y: r.y - 5, anchor: "topRight" }
					: { x: r.x + r.width + 4, y: r.y - 5, anchor: "topLeft" };
		else pos = { x: base.x + 160, y: base.y, anchor: "topLeft" };
		const sub = item.submenu;
		setLevels((l) => [...l.slice(0, lv + 1), { items: sub, pos }]);
		const first = keyboard ? sub.findIndex(isSelectable) : -1;
		setActive((a) => [...a.slice(0, lv + 1), first]);
	}
	function hover(lv: number, i: number) {
		const item = levels()[lv]?.items[i];
		if (!isSelectable(item)) return;
		if (active()[lv] === i && (!item!.submenu || levels().length > lv + 1)) return;
		setActiveAt(lv, i);
		if (item!.submenu) openSub(lv, i);
		else closeBelow(lv);
	}
	function select(lv: number, i: number) {
		const item = levels()[lv]?.items[i];
		if (!isSelectable(item)) return;
		if (item!.submenu) {
			openSub(lv, i, true);
			return;
		}
		// the action first: when it opens a field that takes the keys (claimFocus), the focus is not given back over it
		removeLayer(layer.id);
		const claims = focusClaimCount();
		item!.onSelect?.();
		if (focusClaimCount() === claims) restoreFocus(layer.prevFocus);
	}
	function step(dir: 1 | -1) {
		const lv = levels().length - 1;
		const items = levels()[lv]!.items;
		const n = items.length;
		let i = active()[lv] ?? -1;
		for (let k = 0; k < n; k++) {
			i = i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n;
			if (isSelectable(items[i])) {
				setActiveAt(lv, i);
				return;
			}
		}
	}
	function edge(last: boolean) {
		const lv = levels().length - 1;
		const items = levels()[lv]!.items;
		const idx = last
			? items
					.map((it, i) => (isSelectable(it) ? i : -1))
					.filter((i) => i >= 0)
					.pop()
			: items.findIndex(isSelectable);
		if (idx !== undefined && idx >= 0) setActiveAt(lv, idx);
	}
	function onKeyDown(e: EventPayload) {
		const k = e.key;
		const lv = levels().length - 1;
		switch (k) {
			case "escape":
				close();
				break;
			case "down":
				step(1);
				break;
			case "up":
				step(-1);
				break;
			case "home":
				edge(false);
				break;
			case "end":
				edge(true);
				break;
			case "enter":
			case "space":
			case " ": {
				const i = active()[lv] ?? -1;
				if (i >= 0) select(lv, i);
				break;
			}
			case "right": {
				const i = active()[lv] ?? -1;
				if (i >= 0 && levels()[lv]!.items[i]?.submenu) openSub(lv, i, true);
				break;
			}
			case "left":
				if (lv > 0) closeBelow(lv - 1);
				break;
			case "tab":
				close();
				break;
		}
	}

	return (
		<anchored
			fill="window"
			priority={p.priority}
			style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}
			onClick={close}
			onAuxClick={close}
		>
			<div tabIndex={0} autoFocus onKeyDown={onKeyDown} style={{ width: "100%", height: "100%", keyboardFocusDim: false }}>
				<For each={levels()}>
					{(level, lv) => (
						<anchored
							position={{ x: level.pos.x, y: level.pos.y }}
							anchor={level.pos.anchor}
							fit="snap"
							priority={p.priority + 1 + lv()}
							style={{
								...t("flex flex-col rounded-md border bg-popover p-1 shadow-md"),
								minWidth: Math.max(128, level.minWidth ?? 0),
							}}
						>
							{/* the scrolling box sits inside the positioned panel, with its own height cap: GPUI scrolls a plain box with a
						    max height reliably, which the anchored panel itself did not do for submenus */}
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									minHeight: 0,
									maxHeight: maxHeightFor(level.items, lv()) - 10,
									overflowY: "scroll",
									scrollbarColor: tok("input"),
									scrollbarWidth: 6,
								}}
							>
								<MenuItems
									level={level}
									lv={lv()}
									active={() => active()[lv()] ?? -1}
									onHover={(i) => hover(lv(), i)}
									onSelect={(i) => select(lv(), i)}
									onRow={(i, el) => rows.set(key(lv(), i), el)}
								/>
							</div>
						</anchored>
					)}
				</For>
			</div>
		</anchored>
	);
}

function MenuItems(p: {
	level: Level;
	lv: number;
	active: () => number;
	onHover: (i: number) => void;
	onSelect: (i: number) => void;
	onRow: (i: number, el: HostElement) => void;
}) {
	const items = p.level.items;
	const hasChecks = items.some((it) => it.checked !== undefined);
	const hasLead = hasChecks || items.some((it) => !!it.icon);
	const compact = isCompact(items);
	const iconSize = compact ? 14 : 16;
	return (
		<For each={items}>
			{(it, i) => {
				if (it.separator) return <div style={{ ...t("-mx-1 my-1 h-px bg-border"), flexShrink: 0 }} />;
				if (it.heading !== undefined)
					return (
						<div style={{ ...t("flex px-2 py-1.5"), flexShrink: 0 }}>
							<text style={tx("text-xs font-semibold text-muted-foreground")}>{it.heading}</text>
						</div>
					);
				const on = () => p.active() === i() && !it.disabled;
				const fg = () => (it.danger ? tok("destructive") : on() ? tok("accent-foreground") : tok("popover-foreground"));
				return (
					<div
						ref={(el: HostElement) => p.onRow(i(), el)}
						onMouseEnter={() => p.onHover(i())}
						onClick={() => p.onSelect(i())}
						style={{
							...t(compact ? "flex items-center rounded-sm px-2 py-1" : "flex items-center rounded-sm px-2 py-1.5"),
							flexShrink: 0,
							cursor: "default",
							backgroundColor: on() ? (it.danger ? withAlpha(tok("destructive"), 0.12) : tok("accent")) : "transparent",
							opacity: it.disabled ? 0.5 : 1,
						}}
					>
						{hasLead ? (
							<div
								style={{
									width: iconSize,
									height: iconSize,
									flexShrink: 0,
									marginRight: 8,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
								}}
							>
								<Show
									when={it.checked}
									fallback={
										it.icon ? (
											<Icon
												name={it.icon}
												size={iconSize}
												color={it.danger ? tok("destructive") : (it.iconColor ?? tok("muted-foreground"))}
											/>
										) : undefined
									}
								>
									<Icon name="check" size={iconSize} color={fg()} />
								</Show>
							</div>
						) : undefined}
						<text
							style={{
								...tx(compact ? "text-[13px]" : "text-sm"),
								color: fg(),
								flexGrow: 1,
								minWidth: 0,
								maxWidth: LABEL_MAX_W,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{it.label ?? ""}
						</text>
						{it.shortcut ? (
							<text style={{ ...tx("text-xs"), color: fg(), opacity: 0.6, marginLeft: 24, whiteSpace: "nowrap" }}>
								{it.shortcut}
							</text>
						) : undefined}
						{it.submenu ? <Icon name="chevron-right" size={16} color={fg()} style={{ marginLeft: 16 }} /> : undefined}
					</div>
				);
			}}
		</For>
	);
}
