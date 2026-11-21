// Draws persistent stack slots from the layout. Pane elements move with insertNode, never remove/recreate:
// GPUIX destroys native state on removal. Empty slots and unplaced panes stay mounted, hidden.
import { createEffect, createMemo, For, getOwner, onCleanup, runWithOwner, untrack, type JSX } from "solid-js";
import { insertNode, type HostElement } from "@gpuix/solid";
import { Resizable } from "../ui";
import { focusedId, restoreFocus } from "../ui/core";
import { DockOverlay, registerDropHost } from "./dock";
import { drawnColumns, locatePane, stackFace, type Column, type ColumnId, type ViewKind, type ViewLayout } from "./frameLayout";
import { PaneStack } from "./PaneStack";
import { paneDef, panesOf } from "./panes";
import { clearMaximise, maximised, minimisedPanes, restorePane } from "./paneChrome";
import { IconBtn } from "../itempane/kit";
import { t, tok } from "../ui/core";
import { HIDDEN } from "./kit";

/** The strip at the frame's right edge with the minimised library panes, one button each. */
const RAIL_W = 34;

const GUTTER = 12;
const MIN_FRACTION: Record<ColumnId, number> = { left: 0.1, centre: 0.25, right: 0.15 };
const FILL = { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0 } as const;
const OFF = { display: "none", width: 0, height: 0 } as const;
const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const focusCycles = new Map<ViewKind, (delta: 1 | -1) => void>();

/** App actions use the mounted frame, including its fixed left pane. */
export function focusFramePane(view: ViewKind, delta: 1 | -1): void {
	focusCycles.get(view)?.(delta);
}

export function Frame(p: {
	view: ViewKind;
	layout: () => ViewLayout;
	setLayout: (l: ViewLayout) => void;
	left: () => JSX.Element;
	leftMinPx?: number;
}): JSX.Element {
	const owner = getOwner();
	const registered = createMemo(() => new Set(panesOf(p.view).map((d) => d.id)));
	const made = new Map<string, HostElement>();
	const hosts = { centre: new Map<number, HostElement>(), right: new Map<number, HostElement>() };
	let parking!: HostElement;
	let emptyRight!: HostElement;
	let left!: HostElement;

	const visible = (id: string): boolean => {
		if (!registered().has(id)) return false;
		const l = p.layout();
		const at = locatePane(l, id);
		return !!at && stackFace(l, l[at.column].stacks[at.stack]!, registered()) === id;
	};
	const paneEl = (id: string): HostElement => {
		let el = made.get(id);
		if (!el) {
			const def = paneDef(id)!;
			el = runWithOwner(owner, () =>
				untrack(() => (
					<div
						testId={`pane-${id}`}
						role="region"
						aria-label={def.title()}
						tabIndex={0}
						style={visible(id) ? FILL : OFF}
					>
						{def.render()}
					</div>
				)),
			) as unknown as HostElement;
			made.set(id, el);
		}
		return el;
	};

	/** Where the maximised pane is while it is drawn (library only); null shows the layout as it is. */
	const maxAt = createMemo(() => {
		const id = p.view === "library" ? maximised() : null;
		return id && visible(id) ? locatePane(p.layout(), id) : null;
	});
	// a maximised pane that stops being drawn (hidden, moved into a stack behind another tab) ends the maximise
	createEffect(() => {
		const id = maximised();
		if (p.view === "library" && id && !visible(id)) clearMaximise();
	});

	const ColumnView = (q: { which: "centre" | "right" }): JSX.Element => {
		const col = (): Column => p.layout()[q.which];
		// Keep ordinal slots, including empty ones, so no Solid cleanup can destroy a pane during a move.
		// The slot count only grows to the largest simultaneous stack count, not on every move.
		const slots = createMemo<number[]>((prev) => {
			const n = Math.max(prev.length, col().stacks.length);
			return n === prev.length ? prev : Array.from({ length: n }, (_, i) => i);
		}, []);
		const face = (i: number) => {
			const s = col().stacks[i];
			return s ? stackFace(p.layout(), s, registered()) : null;
		};
		return (
			<div testId={`column-${q.which}`} style={FILL}>
				<Resizable
					dir="column"
					gutter={GUTTER}
					line={false}
					sizes={slots().map((i) => col().sizes[i] ?? 0)}
					shown={slots().map((i) => {
						const m = maxAt();
						return m ? m.column === q.which && m.stack === i : face(i) !== null;
					})}
					minPx={slots().map((i) => (paneDef(face(i) ?? "")?.minSize.h ?? 0) + 26)}
					onSizes={(s) => p.setLayout({ ...p.layout(), [q.which]: { ...col(), sizes: s.slice(0, col().stacks.length) } })}
				>
					<For each={slots()}>
						{(i) => (
							<PaneStack
								column={q.which}
								index={() => i}
								stack={() => col().stacks[i]}
								layout={p.layout}
								registered={registered}
								contentRef={(el) => hosts[q.which].set(i, el)}
							/>
						)}
					</For>
				</Resizable>
			</div>
		);
	};

	// Render effects create new slot refs before this effect moves their existing pane elements.
	// The destination insert detaches the old parent without calling destroyElement.
	createEffect(() => {
		const l = p.layout();
		for (const def of panesOf(p.view)) {
			const at = locatePane(l, def.id);
			if (!at && !made.has(def.id)) continue;
			const target = at ? hosts[at.column].get(at.stack) : parking;
			const el = paneEl(def.id);
			if (target && el.parent !== target) insertNode(target, el);
		}
		for (const [id, el] of made) {
			if (!registered().has(id) && el.parent !== parking) insertNode(parking, el);
		}
	});
	createEffect(() => {
		if (drawnColumns(p.layout(), registered()).includes("right")) return;
		onCleanup(registerDropHost(() => ({ kind: "empty-right" }), emptyRight));
	});

	const remembered = new Map<string, number>();
	const contains = (el: HostElement, id: number): boolean =>
		el.id === id || el.children.some((child) => child.kind === "element" && contains(child, id));
	const ownsFocus = (id: string, el: HostElement, focus: number): boolean => {
		if (contains(el, focus)) return true;
		const stack = el.parent?.kind === "element" ? el.parent.parent : null;
		if (stack?.kind !== "element") return false;
		const inHeader = (node: HostElement): boolean => {
			const testId = node.props.get("testId");
			if (testId === `pane-tab-${id}` || testId === `pane-menu-${id}`) return contains(node, focus);
			return node.children.some((child) => child.kind === "element" && inHeader(child));
		};
		return inHeader(stack);
	};
	const cycle = (delta: 1 | -1) => {
		const l = p.layout();
		const order: [string, HostElement][] = l.left.shown ? [["left", left]] : [];
		for (const column of ["centre", "right"] as const) {
			for (const s of l[column].stacks) {
				const face = stackFace(l, s, registered());
				const el = face ? made.get(face) : undefined;
				if (face && el) order.push([face, el]);
			}
		}
		if (!order.length) return;
		const focus = focusedId();
		const current = focus === null ? -1 : order.findIndex(([id, el]) => ownsFocus(id, el, focus));
		if (current >= 0 && focus !== null) remembered.set(order[current]![0], focus);
		const index = current < 0 ? (delta > 0 ? 0 : order.length - 1) : (current + delta + order.length) % order.length;
		const [id, el] = order[index]!;
		const saved = remembered.get(id);
		restoreFocus(saved !== undefined && ownsFocus(id, el, saved) ? saved : el.id);
	};
	focusCycles.set(p.view, cycle);
	onCleanup(() => {
		if (focusCycles.get(p.view) === cycle) focusCycles.delete(p.view);
	});

	const cols = createMemo(() => drawnColumns(p.layout(), registered()), [], { equals: sameList });
	const minPx = (c: ColumnId): number => {
		if (c === "left") return p.leftMinPx ?? 0;
		const l = p.layout();
		const faces = l[c].stacks.map((s) => stackFace(l, s, registered()));
		return Math.max(0, ...faces.map((f) => (f ? (paneDef(f)?.minSize.w ?? 0) : 0)));
	};
	const ORDER: ColumnId[] = ["left", "centre", "right"];

	const rail = () => (p.view === "library" ? minimisedPanes() : []);

	return (
		<>
			<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}>
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%" }}>
			<Resizable
				gutter={GUTTER}
				line={false}
				sizes={p.layout().sizes}
				shown={ORDER.map((c) => {
					const m = maxAt();
					return m ? m.column === c : cols().includes(c);
				})}
				minSizes={ORDER.map((c) => MIN_FRACTION[c])}
				minPx={ORDER.map(minPx)}
				onSizes={(s) => p.setLayout({ ...p.layout(), sizes: [s[0]!, s[1]!, s[2]!] })}
			>
				<div ref={(el: HostElement) => { left = el; }} testId="column-left" role="region" aria-label="Collections" tabIndex={0} style={FILL}>
					{p.left()}
				</div>
				<ColumnView which="centre" />
				<ColumnView which="right" />
			</Resizable>
			</div>
			<div
				testId="pane-rail"
				role="toolbar"
				aria-label="Minimised panes"
				style={
					rail().length
						? { ...t("flex flex-none flex-col items-center gap-1"), width: RAIL_W, marginLeft: 6, paddingTop: 4, height: "100%" }
						: HIDDEN
				}
			>
				<For each={rail()}>
					{(id) => (
						<IconBtn
							testId={`pane-rail-${id}`}
							icon={paneDef(id)?.icon ?? "square"}
							title={`Show ${paneDef(id)?.title() ?? id}`}
							box={28}
							size={16}
							color={tok("muted-foreground")}
							onClick={() => restorePane(id)}
						/>
					)}
				</For>
			</div>
			</div>
			<div ref={(el: HostElement) => { parking = el; }} testId="pane-parking" style={OFF} />
			<div
				ref={(el: HostElement) => { emptyRight = el; }}
				testId="pane-empty-right"
				style={{ position: "absolute", top: 0, right: 0, width: 48, height: "100%", pointerEvents: "none" }}
			/>
			<DockOverlay />
		</>
	);
}
