// One stack of the frame (docs/developer-guide/layouts-phase2.md, "stacks"). In normal use a stack draws no header, so the window
// looks as it did before layouts; a stack holding two or more panes shows a quiet tab strip (the active tab underlined). In edit
// layout mode (shell/layoutEdit.tsx) every stack shows its header: a grip, the tabs (or the lone pane's title) and the menu button,
// with an outline around the stack. The header is the drag source and the place the pane menu opens from.
//
// The content area is an empty div handed to the parent through `contentRef`: Frame moves the pane elements into it (insert before
// remove, so GPUIX keeps their native state). This file never puts children there.
//
// Also here: the pane menu (right click or the menu button on a header or tab, Shift+F10 / Menu on a focused tab) and the one place
// that moves a library pane from a menu or the keyboard with its "Moved <title>" undo toast.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { EventPayload, HostElement } from "@gpuix/solid";
import { Icon } from "../icons";
import { openMenu, toast, type Anchor, type MenuItem } from "../ui";
import { boundsOf, native, overlayLayers, t, tok, tx } from "../ui/core";
import { focusRing, isActivateKey } from "../ui/controls";
import { store } from "../store";
import { registerDropHost, paneDragSource, paneDragging, panePressed } from "./dock";
import {
	canMove,
	isSectionPane,
	locatePane,
	paneShown,
	sectionIdOf,
	stackFace,
	type DropTarget,
	type Stack,
	type ViewLayout,
} from "./frameLayout";
import { activateLibraryPane, hideLibraryPane, libraryLayout, moveLibraryPane, undoLayout } from "./layout";
import { layoutEditing } from "./layoutEdit";
import { HIDDEN } from "./kit";
import { withAlpha } from "../theme";
import { paneDef, panesOf } from "./panes";
import { returnSection } from "./sectionPanes";
import { maximised, minimisePane, paneHeaderActions, toggleMaximise } from "./paneChrome";
import { IconBtn } from "../itempane/kit";

const HEADER_H = 26;
/** The hover header over a lone pane, and the centred grabber strip along the pane's top edge that brings it up. */
const HOVER_HEADER_H = 30;
const HOT_STRIP_H = 8;
const HOT_STRIP_W = 88;
/** Short hover-intent delay on the grabber strip so brushing past it toward the toolbar never drops the header down. */
export const HOVER_REVEAL_DELAY_MS = 120;
/** How long the hover header stays after the pointer leaves it (so a quick pass back over it does not flicker). */
export const HOVER_HIDE_DELAY_MS = 350;
/** The header is taller in edit layout mode: it is the handle then. */
const EDIT_HEADER_H = 34;
const TAB_H = 22;
/** One toast id for every layout change, so quick changes replace each other instead of stacking. */
const TOAST_ID = "layout-move";

const FILL = { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0 } as const;

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

type KeyEvent = EventPayload & {
	preventDefault?: () => void;
	stopPropagation?: () => void;
	modifiers?: { shift?: boolean; ctrl?: boolean; alt?: boolean; cmd?: boolean };
};
/** Key name as GPUIX reports it, without an "arrow" prefix ("left", "right", "f10", "menu"). */
const keyOf = (e: { key?: string }): string => {
	const k = (e.key ?? "").toLowerCase();
	return k.startsWith("arrow") ? k.slice(5) : k;
};
const isRightClick = (e: EventPayload): boolean => !!(e.isRightClick || e.button === 2);

const titleOf = (id: string): string => paneDef(id)?.title() ?? id;

// ---- moving and the pane menu ----------------------------------------------------------------------------------------------

function offerUndo(message: string): void {
	toast(message, {
		id: TOAST_ID,
		action: {
			label: "Undo",
			run: () => {
				undoLayout();
				toast.dismiss(TOAST_ID);
			},
		},
	});
}

/** Move a library pane (menu or keyboard); on success shows "Moved <title>" with an Undo action. Returns false when not allowed. */
export function movePaneFromMenu(id: string, to: DropTarget): boolean {
	const title = titleOf(id);
	const ok = moveLibraryPane(id, to);
	if (ok) offerUndo(`Moved ${title}`);
	return ok;
}

function menuFor(id: string, l: ViewLayout, registered: ReadonlySet<string>): MenuItem[] {
	const loc = locatePane(l, id);
	const to = (target: DropTarget) => () => void movePaneFromMenu(id, target);
	const splitEnd = (column: "centre" | "right"): DropTarget => ({ kind: "split", column, at: l[column].stacks.length });

	// the other stacks that draw something, by their face's title
	const stacks: MenuItem[] = [];
	for (const column of ["centre", "right"] as const)
		l[column].stacks.forEach((s, stack) => {
			if (s.panes.includes(id)) return;
			const face = stackFace(l, s, registered);
			if (!face) return;
			const target: DropTarget = { kind: "tab", column, stack };
			stacks.push({ label: titleOf(face), icon: paneDef(face)?.icon, disabled: !canMove(l, id, target), onSelect: to(target) });
		});

	const items: MenuItem[] = [
		{
			label: "Move to",
			icon: "move",
			submenu: (["centre", "right"] as const).map((column) => ({
				label: column === "centre" ? "Centre column" : "Right column",
				disabled: !canMove(l, id, splitEnd(column)),
				onSelect: to(splitEnd(column)),
			})),
		},
		{ label: "Stack with", icon: "layers", disabled: stacks.length === 0, submenu: stacks },
	];

	if (loc) {
		const col = l[loc.column];
		const alone = col.stacks[loc.stack]!.panes.length === 1;
		const drawn = (i: number) => stackFace(l, col.stacks[i]!, registered) !== null;
		let up: DropTarget | null = alone ? null : { kind: "split", column: loc.column, at: loc.stack };
		let down: DropTarget | null = alone ? null : { kind: "split", column: loc.column, at: loc.stack + 1 };
		if (alone) {
			for (let i = loc.stack - 1; i >= 0; i--)
				if (drawn(i)) {
					up = { kind: "split", column: loc.column, at: i };
					break;
				}
			for (let i = loc.stack + 1; i < col.stacks.length; i++)
				if (drawn(i)) {
					down = { kind: "split", column: loc.column, at: i + 1 };
					break;
				}
		}
		items.push(
			{ label: "Move up", icon: "arrow-up", disabled: !up || !canMove(l, id, up), onSelect: up ? to(up) : undefined },
			{ label: "Move down", icon: "arrow-down", disabled: !down || !canMove(l, id, down), onSelect: down ? to(down) : undefined },
		);
	}

	const sectionId = sectionIdOf(id);
	if (sectionId !== null && isSectionPane(id))
		items.push(
			{ separator: true },
			{
				label: "Return to item pane",
				disabled: !canMove(l, id, { kind: "section" }),
				icon: "corner-up-left",
				onSelect: () => {
					const title = titleOf(id);
					if (returnSection(sectionId)) offerUndo(`Moved ${title}`);
				},
			},
		);

	items.push(
		{ separator: true },
		{
			label: maximised() === id ? "Restore size" : "Maximise",
			icon: maximised() === id ? "minimize-2" : "maximize-2",
			onSelect: () => toggleMaximise(id),
		},
	);
	if (!paneDef(id)?.required) {
		items.push(
			{ label: "Minimise to the edge", icon: "minus", onSelect: () => minimisePane(id) },
			{ label: "Hide", icon: "eye-off", onSelect: () => closePane(id) },
		);
	}
	return items;
}

/** Hide a library pane in place (the header's close button, the menu's Hide), with an Undo toast. */
function closePane(id: string): void {
	const title = titleOf(id);
	hideLibraryPane(id, true);
	offerUndo(`Hid ${title}`);
}

/** The pane's own buttons in its header: the pane menu, minimise, maximise / restore, close. */
function PaneControls(p: {
	/** "hover" (the hover header) or "tabs" (the tab strip): keeps the test ids apart */
	tag: string;
	id: () => string | null;
	menu: (id: string, el: HostElement | undefined) => void;
	/** Called right before running a pane action (e.g. to dismiss the hover header). */
	onAction?: () => void;
}): JSX.Element {
	let menuEl: HostElement | undefined;
	const req = () => !!paneDef(p.id() ?? "")?.required;
	const isMax = () => p.id() !== null && maximised() === p.id();
	const fg = tok("muted-foreground");
	return (
		<div style={{ ...t("flex flex-none flex-row items-center gap-0.5") }}>
			<div
				ref={(x: HostElement) => {
					menuEl = x;
				}}
			>
				<IconBtn
					testId={`pane-${p.tag}-menu-${p.id() ?? ""}`}
					icon="ellipsis"
					title="Pane menu"
					box={24}
					size={15}
					color={fg}
					onClick={() => {
						const id = p.id();
						if (id) p.menu(id, menuEl);
					}}
				/>
			</div>
			<div style={req() ? HIDDEN : { display: "flex" }}>
				<IconBtn
					testId={`pane-${p.tag}-min-${p.id() ?? ""}`}
					icon="minus"
					title="Minimise to the edge"
					box={24}
					size={15}
					color={fg}
					onClick={() => {
						const id = p.id();
						if (id) {
							p.onAction?.();
							minimisePane(id);
						}
					}}
				/>
			</div>
			<IconBtn
				testId={`pane-${p.tag}-max-${p.id() ?? ""}`}
				icon={isMax() ? "minimize-2" : "maximize-2"}
				title={isMax() ? "Restore size" : "Maximise"}
				box={24}
				size={14}
				color={fg}
				onClick={() => {
					const id = p.id();
					if (id) {
						p.onAction?.();
						toggleMaximise(id);
					}
				}}
			/>
			<div style={req() ? HIDDEN : { display: "flex" }}>
				<IconBtn
					testId={`pane-${p.tag}-close-${p.id() ?? ""}`}
					icon="x"
					title="Hide this pane"
					box={24}
					size={15}
					color={fg}
					onClick={() => {
						const id = p.id();
						if (id) {
							p.onAction?.();
							closePane(id);
						}
					}}
				/>
			</div>
		</div>
	);
}

/** The pane menu of a library pane as drawn now: what a right click on its tab opens (the headless harness calls its `onSelect`s). */
export function paneMenuItems(id: string): MenuItem[] {
	return menuFor(id, libraryLayout(), new Set(panesOf("library").map((d) => d.id)));
}

// ---- the stack -------------------------------------------------------------------------------------------------------------

export function PaneStack(p: {
	column: "centre" | "right";
	/** this stack's position in its column */
	index: () => number;
	/** undefined while the slot is retained but its stack is gone */
	stack: () => Stack | undefined;
	layout: () => ViewLayout;
	registered: () => ReadonlySet<string>;
	/** receives the content div; the parent puts the pane elements there */
	contentRef: (el: HostElement) => void;
}): JSX.Element {
	const [root, setRoot] = createSignal<HostElement | undefined>(undefined);
	const tabEls = new Map<string, HostElement>();

	/** the pane the stack shows, null when the stack is gone or draws nothing */
	const face = createMemo((): string | null => {
		const s = p.stack();
		return s ? stackFace(p.layout(), s, p.registered()) : null;
	});
	/** the tabs: this stack's registered panes that are not hidden, in order */
	const tabs = createMemo(
		() => {
			const s = p.stack();
			const l = p.layout();
			const reg = p.registered();
			return s ? s.panes.filter((id) => paneShown(l, id, reg)) : [];
		},
		[],
		{ equals: sameList },
	);
	const single = () => tabs().length < 2;

	// a drop host only while the stack exists and draws something; the cleanup unregisters it when either stops being true
	const active = createMemo(() => face() !== null && root() !== undefined);
	createEffect(
		on(active, (isOn) => {
			const el = root();
			if (!isOn || !el) return;
			onCleanup(registerDropHost(() => ({ kind: "stack", column: p.column, stack: p.index() }), el));
		}),
	);

	// ---- the hover header of a lone pane: it lies over the pane's top and comes up after a short hover-intent pause on the
	// centred grabber pill (never across the whole toolbar, and unmounted whenever hidden so it can never intercept clicks).
	const hoverMode = () => !layoutEditing() && single() && face() !== null;
	const [revealed, setRevealed] = createSignal(false);
	const {
		wasDrag: hoverWasDrag,
		cancelPress: hoverCancelPress,
		...hoverDrag
	} = paneDragSource(() => face() ?? p.stack()?.panes[0] ?? "items");
	const [titleHot, setTitleHot] = createSignal(false);
	let revealTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let overHeader = false;
	const clearHoverTimers = () => {
		if (revealTimer !== undefined) clearTimeout(revealTimer);
		revealTimer = undefined;
		if (hideTimer !== undefined) clearTimeout(hideTimer);
		hideTimer = undefined;
	};
	/** Dismiss the hover header immediately and clear any pending reveal or un-started press. */
	const dismiss = () => {
		clearHoverTimers();
		overHeader = false;
		setRevealed(false);
		setTitleHot(false);
		hoverCancelPress();
	};
	const keepRevealed = () => {
		clearHoverTimers();
		if (hoverMode()) setRevealed(true);
	};
	const armReveal = () => {
		if (!hoverMode() || overlayLayers().length > 0) return;
		if (hideTimer !== undefined) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
		if (revealed() || revealTimer !== undefined) return;
		revealTimer = setTimeout(() => {
			revealTimer = undefined;
			if (hoverMode() && overlayLayers().length === 0) setRevealed(true);
		}, HOVER_REVEAL_DELAY_MS);
	};
	const hideSoon = () => {
		if (revealTimer !== undefined) {
			clearTimeout(revealTimer);
			revealTimer = undefined;
		}
		if (hideTimer !== undefined) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			hideTimer = undefined;
			setRevealed(false);
			setTitleHot(false);
		}, HOVER_HIDE_DELAY_MS);
	};
	const leaveHotstrip = () => {
		if (revealTimer !== undefined) {
			clearTimeout(revealTimer);
			revealTimer = undefined;
		}
		if (revealed() && !overHeader) hideSoon();
	};
	onCleanup(clearHoverTimers);
	createEffect(
		on(
			() => [hoverMode(), face(), store.activeTab(), maximised(), paneDragging(), overlayLayers().length > 0] as const,
			() => dismiss(),
			{ defer: true },
		),
	);

	const menuFrom = (id: string, at: Anchor) => {
		dismiss();
		openMenu(at, () => menuFor(id, p.layout(), p.registered()));
	};
	const menuUnder = (id: string, el: HostElement | undefined, e?: EventPayload) => {
		const b = boundsOf(el);
		menuFrom(id, b ? { rect: b, align: "start" } : { x: e?.x ?? 0, y: e?.y ?? 0 });
	};
	const focusTab = (id: string) => {
		const el = tabEls.get(id);
		try {
			if (el) native()?.focusElement?.(el.id);
		} catch {
			/* element is gone */
		}
	};

	/** Move `id` one tab along (among the shown tabs); the model's tab index is the layout before the move. */
	const reorder = (id: string, dir: 1 | -1) => {
		const s = p.stack();
		const vis = tabs();
		const nb = vis[vis.indexOf(id) + dir];
		if (!s || !nb) return;
		const i = s.panes.indexOf(id);
		const j = s.panes.indexOf(nb);
		const index = j > i ? j + 1 : j;
		if (movePaneFromMenu(id, { kind: "tab", column: p.column, stack: p.index(), index })) queueMicrotask(() => focusTab(id));
	};
	/** Activate the tab `delta` along (clamped) or the first / last one, and focus it. */
	const stepTo = (id: string, to: number | "first" | "last") => {
		const vis = tabs();
		const at = vis.indexOf(id);
		const k = to === "first" ? 0 : to === "last" ? vis.length - 1 : Math.max(0, Math.min(vis.length - 1, at + to));
		const next = vis[k];
		if (!next || next === id) return;
		activateLibraryPane(next);
		focusTab(next);
	};

	const Tab = (q: { id: string }): JSX.Element => {
		const id = q.id;
		const { wasDrag, cancelPress: _tabCancelPress, ...drag } = paneDragSource(() => id);
		const [hover, setHover] = createSignal(false);
		let el: HostElement | undefined;
		onCleanup(() => tabEls.delete(id));
		const on = () => face() === id;
		/** a lone pane's header is flat and muted; with several panes the active tab is underlined */
		const raised = () => on() && !single();
		const fg = () => tok(raised() || hover() ? "foreground" : "muted-foreground");
		const onKeyDown = (e: KeyEvent) => {
			const k = keyOf(e);
			const m = e.modifiers;
			if (isActivateKey(e)) {
				e.preventDefault?.();
				e.stopPropagation?.();
				if (!e.isHeld) activateLibraryPane(id);
			} else if (k === "menu" || k === "contextmenu" || (k === "f10" && m?.shift)) {
				e.preventDefault?.();
				e.stopPropagation?.();
				menuUnder(id, el);
			} else if (k === "left" || k === "right") {
				const dir = k === "left" ? -1 : 1;
				if ((m?.ctrl || m?.cmd) && m?.shift) reorder(id, dir);
				else if (!m?.ctrl && !m?.cmd && !m?.alt) stepTo(id, dir);
				else return;
				e.preventDefault?.();
				e.stopPropagation?.();
			} else if ((k === "home" || k === "end") && !m?.ctrl && !m?.cmd && !m?.alt) {
				stepTo(id, k === "home" ? "first" : "last");
				e.preventDefault?.();
				e.stopPropagation?.();
			}
		};
		return (
			<div
				ref={(x: HostElement) => {
					el = x;
					tabEls.set(id, x);
				}}
				testId={`pane-tab-${id}`}
				role="tab"
				aria-selected={on()}
				aria-label={titleOf(id)}
				tabIndex={0}
				{...drag}
				onClick={() => {
					if (wasDrag()) return;
					activateLibraryPane(id);
				}}
				onAuxClick={(e: EventPayload) => {
					if (isRightClick(e)) menuFrom(id, { x: e.x ?? 0, y: e.y ?? 0 });
				}}
				onKeyDown={onKeyDown}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				style={{
					...t("flex flex-none items-center gap-1.5 px-2"),
					height: TAB_H,
					borderBottomWidth: 2,
					borderColor: raised() ? tok("primary") : "transparent",
					minWidth: 0,
					maxWidth: 224,
					flexShrink: 1,
					cursor: layoutEditing() ? "grab" : "pointer",
					keyboardFocusDim: false,
					...focusRing(),
					...(panePressed() === id || paneDragging() === id
						? { backgroundColor: withAlpha(tok("primary"), 0.14), borderRadius: 6 }
						: {}),
				}}
			>
				<Icon name={paneDef(id)?.icon ?? "square"} size={14} color={fg()} style={{ flexShrink: 0 }} />
				<text
					style={{
						...tx(`min-w-0 truncate text-[13px] ${raised() ? "font-medium" : ""}`),
						color: fg(),
						flexShrink: 1,
						whiteSpace: "nowrap",
					}}
				>
					{titleOf(id)}
				</text>
			</div>
		);
	};

	const MenuButton = (): JSX.Element => {
		const [hover, setHover] = createSignal(false);
		let el: HostElement | undefined;
		return (
			<div
				ref={(x: HostElement) => {
					el = x;
				}}
				testId={`pane-menu-${face() ?? ""}`}
				role="button"
				aria-label="Pane menu"
				aria-haspopup="menu"
				tabIndex={0}
				onClick={(e: EventPayload) => {
					const f = face();
					if (f) {
						const b = boundsOf(el);
						menuFrom(f, b ? { rect: b, align: "end" } : { x: e.x ?? 0, y: e.y ?? 0 });
					}
				}}
				onKeyDown={(e: KeyEvent) => {
					if (!isActivateKey(e)) return;
					e.preventDefault?.();
					e.stopPropagation?.();
					const f = face();
					if (f && !e.isHeld) {
						const b = boundsOf(el);
						menuFrom(f, b ? { rect: b, align: "end" } : { x: 0, y: 0 });
					}
				}}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				style={{
					...t("flex flex-none items-center justify-center rounded"),
					width: TAB_H,
					height: TAB_H,
					cursor: "pointer",
					keyboardFocusDim: false,
					...focusRing(),
					...(hover() ? t("bg-foreground/10") : {}),
				}}
			>
				<Icon name="ellipsis" size={14} color={tok(hover() ? "foreground" : "muted-foreground")} />
			</div>
		);
	};

	// the free part of the header drags the lone pane; with several tabs (or no pane shown) its handlers do nothing, so only the tabs drag
	const { wasDrag: headWasDrag, cancelPress: _headCancelPress, ...head } = paneDragSource(() => face() ?? p.stack()?.panes[0] ?? "items");
	const dragsHere = () => single() && face() !== null;
	const { wasDrag: gripWasDrag, cancelPress: _gripCancelPress, ...grip } = paneDragSource(() => face() ?? p.stack()?.panes[0] ?? "items");
	const [gripHover, setGripHover] = createSignal(false);
	/** the pane this stack shows is held or dragged: its handle and the stack say so */
	const held = () => {
		const f = face();
		return f !== null && (panePressed() === f || paneDragging() === f);
	};
	const headDrag = {
		onMouseDown: (e: Parameters<typeof head.onMouseDown>[0]) => dragsHere() && head.onMouseDown(e),
		onMouseMove: (e: Parameters<typeof head.onMouseMove>[0]) => dragsHere() && head.onMouseMove(e),
		onMouseUp: () => dragsHere() && head.onMouseUp(),
	};

	const headerActions = () => {
		const f = face();
		return f ? paneHeaderActions(f) : undefined;
	};

	return (
		<div
			ref={(x: HostElement) => setRoot(x)}
			testId={`stack-${p.stack()?.panes[0]}`}
			onMouseLeave={dismiss}
			style={{
				...FILL,
				...(layoutEditing() && face() !== null
					? { borderWidth: 1, borderColor: withAlpha(tok("primary"), 0.45), borderRadius: 16, padding: 2 }
					: {}),
				// the pane being dragged fades, so it reads as "this is what moves"
				...(face() !== null && paneDragging() === face() ? { opacity: 0.45 } : {}),
			}}
		>
			{/* always mounted, so the tabs keep their focus and native nodes while the stack draws nothing */}
			<div
				style={{
					...t("flex flex-none flex-row items-center gap-0.5 px-1"),
					userSelect: "none",
					height: layoutEditing() ? EDIT_HEADER_H : HEADER_H,
					width: "100%",
					minWidth: 0,
					// HIDDEN, not display:none alone: GPUIX would still paint the header's children (shell/kit.tsx)
					...(face() === null || (!layoutEditing() && single()) ? HIDDEN : {}),
				}}
			>
				{/* the grip: a handle that drags the pane shown (the free part of the header drags a lone pane too) */}
				<div
					testId={`pane-grip-${face() ?? ""}`}
					role="button"
					aria-label="Drag to move this pane"
					{...grip}
					onClick={() => void gripWasDrag()}
					onMouseEnter={() => setGripHover(true)}
					onMouseLeave={() => setGripHover(false)}
					style={{
						...t("flex flex-none items-center justify-center rounded-md"),
						width: 28,
						height: 28,
						cursor: "grab",
						backgroundColor: held()
							? withAlpha(tok("primary"), 0.22)
							: gripHover()
								? withAlpha(tok("primary"), 0.12)
								: withAlpha(tok("foreground"), 0.05),
						...(layoutEditing() ? {} : HIDDEN),
					}}
				>
					<Icon name="grip-vertical" size={18} color={tok(held() || gripHover() ? "primary" : "muted-foreground")} />
				</div>
				<div
					role="tablist"
					aria-label="Pane tabs"
					style={{ ...t("flex flex-row items-center gap-0.5"), minWidth: 0, flexShrink: 1 }}
				>
					<For each={tabs()}>{(id) => <Tab id={id} />}</For>
				</div>
				{/* the free part of the header: drags a lone pane, and a right click opens the menu of the pane shown */}
				<div
					{...headDrag}
					onClick={() => void headWasDrag()}
					onAuxClick={(e: EventPayload) => {
						const f = face();
						if (f && isRightClick(e)) menuFrom(f, { x: e.x ?? 0, y: e.y ?? 0 });
					}}
					style={{
						flexGrow: 1,
						flexShrink: 1,
						height: "100%",
						minWidth: 0,
						cursor: layoutEditing() && dragsHere() ? "grab" : "default",
					}}
				/>
				<div style={layoutEditing() ? { display: "flex" } : HIDDEN}>
					<MenuButton />
				</div>
				{/* several tabs, outside edit mode: the pane's own buttons for the tab shown */}
				<div style={!layoutEditing() && !single() && face() !== null ? { display: "flex" } : HIDDEN}>
					<PaneControls tag="tabs" id={face} menu={(id, el) => menuUnder(id, el)} />
				</div>
			</div>
			<div
				ref={p.contentRef}
				onMouseDown={dismiss}
				style={{
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					flexShrink: 1,
					flexBasis: 0,
					width: "100%",
					minWidth: 0,
					minHeight: 0,
				}}
			/>
			{/* after the content, so they lie over it: a centred grabber pill along the top edge, and the hover header (unmounted when hidden) */}
			<Show when={hoverMode()}>
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: HOT_STRIP_H,
						...t("flex flex-row justify-center"),
						pointerEvents: "none",
					}}
				>
					<div
						testId={`pane-hotstrip-${face() ?? ""}`}
						onMouseEnter={armReveal}
						onMouseLeave={leaveHotstrip}
						style={{
							width: HOT_STRIP_W,
							height: HOT_STRIP_H,
							...t("flex flex-row justify-center"),
							pointerEvents: "auto",
						}}
					>
						{/* a short grabber line: the hint that there is a header here */}
						<div
							style={{
								marginTop: 2,
								width: 36,
								height: 3,
								borderRadius: 2,
								backgroundColor: withAlpha(tok("foreground"), revealed() ? 0 : 0.18),
								pointerEvents: "none",
							}}
						/>
					</div>
				</div>
			</Show>
			<Show when={hoverMode() && (revealed() || held())}>
				<div
					testId={`pane-hover-header-${face() ?? ""}`}
					role="toolbar"
					aria-label={`${titleOf(face() ?? "")} pane`}
					onMouseEnter={() => {
						overHeader = true;
						keepRevealed();
					}}
					onMouseLeave={() => {
						overHeader = false;
						hideSoon();
					}}
					onMouseDownOutside={dismiss}
					style={{
						...t("flex flex-row items-center gap-1 pl-1 pr-1"),
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: HOVER_HEADER_H,
						backgroundColor: tok("background"),
						borderBottomWidth: 1,
						borderColor: tok("border"),
						borderTopLeftRadius: 14,
						borderTopRightRadius: 14,
						// a press here starts a drag, never a text selection across the window
						userSelect: "none",
					}}
				>
					{/* the free part: icon, title and the empty space drag the pane; a double click maximises it; a right click opens the menu */}
					<div
						testId={`pane-hover-drag-${face() ?? ""}`}
						{...hoverDrag}
						onClick={(e: EventPayload) => {
							if (hoverWasDrag()) return;
							const f = face();
							if (f && (e.clickCount ?? 1) >= 2) {
								dismiss();
								toggleMaximise(f);
							}
						}}
						onAuxClick={(e: EventPayload) => {
							const f = face();
							if (f && isRightClick(e)) menuFrom(f, { x: e.x ?? 0, y: e.y ?? 0 });
						}}
						onMouseEnter={() => setTitleHot(true)}
						onMouseLeave={() => setTitleHot(false)}
						style={{
							...t("flex flex-row items-center gap-1.5 rounded-md px-2"),
							flexGrow: 1,
							flexShrink: 1,
							minWidth: 0,
							height: "100%",
							cursor: "grab",
							...(held() ? { backgroundColor: withAlpha(tok("primary"), 0.14) } : {}),
						}}
					>
						<Icon
							name={paneDef(face() ?? "")?.icon ?? "square"}
							size={14}
							color={tok(titleHot() ? "foreground" : "muted-foreground")}
						/>
						<text
							style={{
								...tx("min-w-0 truncate text-[13px] font-medium"),
								color: tok(titleHot() ? "foreground" : "muted-foreground"),
								flexShrink: 1,
								whiteSpace: "nowrap",
							}}
						>
							{titleOf(face() ?? "")}
						</text>
					</div>
					{/* buttons the pane's content hands over (a detached section's own actions) */}
					<div style={{ ...t("flex flex-none flex-row items-center gap-0.5") }}>{headerActions()?.()}</div>
					<PaneControls tag="hover" id={face} menu={(id, el) => menuUnder(id, el)} onAction={dismiss} />
				</div>
			</Show>
		</div>
	);
}
