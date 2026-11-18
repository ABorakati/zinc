// Resizable panels (corvu/resizable + ui/resizable.tsx in the web UI): panels share a row (or, with dir="column", a column) by
// flex-grow fractions with a drag handle between each pair. While a handle is dragged a transparent window-sized layer captures the
// pointer, so the drag keeps working when the cursor leaves the thin handle.
// Focused handles resize with arrows (2%, Shift 10%) and Home / End, using the same neighbour minimums as pointer drags.
import { children, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { withAlpha } from "../theme";
import { boundsOf, t, tok } from "./core";
import { focusRing } from "./controls";

/**
 * `sizes` are fractions (they are normalised if they do not sum to 1) of the width left after the handles, `minSizes` the
 * least fraction per panel (default 0.05). Additions: `gutter` is the handle width in px (default 5, the hit area; the
 * visible line is 1px), `line={false}` hides the line until the handle is hovered or dragged (for a gutter that is part of
 * the layout, as App.tsx's GutterHandle). `dir` (default "row") stacks the panels top to bottom with "column"; `minPx` is a least
 * size per panel in px, applied on top of `minSizes` while dragging (capped at 45% each, so a small window can still be resized).
 * `shown` (default all) keeps a panel mounted but not drawn: it takes no room and has no handle, so the drawn panels share the
 * length, and showing it again does not rebuild it (GPUIX destroys a removed element's native state, such as its scroll offset).
 * `onSizes` reports every panel: hidden ones keep their `sizes` entry, the drawn ones share what they had between them.
 */
const OFF = { display: "none", width: 0, height: 0, flexGrow: 0 } as const;

export function Resizable(p: {
	sizes: number[];
	onSizes: (s: number[]) => void;
	minSizes?: number[];
	children: JSX.Element;
	gutter?: number;
	line?: boolean;
	dir?: "row" | "column";
	minPx?: number[];
	shown?: boolean[];
}): JSX.Element {
	const col = () => p.dir === "column";
	const gpuix = useGpuix();
	const kids = children(() => p.children);
	const panels = createMemo(() => kids.toArray());
	const handle = () => p.gutter ?? 5;
	const [length, setLength] = createSignal(0); // from onLayout, used when the painted bounds are not readable
	const [hot, setHot] = createSignal(-1);
	const [drag, setDrag] = createSignal<{ i: number; j: number; x0: number; sizes: number[]; total: number } | null>(null);
	let root: HostElement | undefined;

	const isShown = (i: number) => p.shown?.[i] ?? true;
	const raw = (i: number) => Math.max(0, p.sizes[i] ?? 1 / panels().length);
	/** the room the drawn panels have between them, in `sizes` units */
	const room = () => panels().reduce<number>((a, _, i) => a + (isShown(i) ? raw(i) : 0), 0) || 1;
	/** fractions of the drawn length (0 for a hidden panel) */
	const sizes = () => {
		const r = room();
		return panels().map((_, i) => (isShown(i) ? raw(i) / r : 0));
	};
	const drawnCount = () => panels().filter((_, i) => isShown(i)).length;
	/** the next drawn panel after `i`, or -1 */
	const nextShown = (i: number) => {
		for (let k = i + 1; k < panels().length; k++) if (isShown(k)) return k;
		return -1;
	};
	const minOf = (i: number, total: number) =>
		Math.max(p.minSizes?.[i] ?? 0.05, Math.min(0.45, total > 0 ? (p.minPx?.[i] ?? 0) / total : 0));
	const along = (e: EventPayload) => (col() ? e.y : e.x);
	const availableLength = () => {
		const b = boundsOf(root);
		const w = (col() ? b?.height : b?.width) ?? length();
		return Math.max(0, w - handle() * Math.max(0, drawnCount() - 1));
	};
	// If the pair is smaller than its minimums, share its room in their ratio.
	const limits = (i: number, j: number, total: number, pair: number) => {
		const a = minOf(i, total), b = minOf(j, total);
		const scale = Math.min(1, pair / (a + b || 1));
		return { min: a * scale, max: pair - b * scale };
	};
	function resize(i: number, j: number, before: number[], total: number, want: number) {
		const pair = before[i]! + before[j]!;
		const { min, max } = limits(i, j, total, pair);
		const a = Math.min(Math.max(want, min), max);
		// Hidden panels keep their entry. Only the adjacent drawn pair changes.
		const r = room();
		const next = panels().map((_, k) => (isShown(k) ? before[k]! * r : raw(k)));
		next[i] = a * r;
		next[j] = (pair - a) * r;
		p.onSizes(next);
	}
	function onKey(i: number, e: EventPayload & { preventDefault?(): void; stopPropagation?(): void }) {
		if (e.modifiers?.ctrl || e.modifiers?.cmd || e.modifiers?.alt) return;
		const k = (e.key ?? "").toLowerCase();
		const back = col() ? "up" : "left", forward = col() ? "down" : "right";
		if (k !== back && k !== forward && k !== "home" && k !== "end") return;
		const j = nextShown(i);
		if (j < 0) return;
		e.preventDefault?.();
		e.stopPropagation?.();
		const before = sizes();
		const step = e.modifiers?.shift ? 0.1 : 0.02;
		const want = k === "home" ? -Infinity : k === "end" ? Infinity : before[i]! + (k === back ? -step : step);
		resize(i, j, before, availableLength(), want);
	}

	function start(i: number, e: EventPayload) {
		const j = nextShown(i);
		if (j < 0) return;
		const total = availableLength();
		if (total <= 0) return;
		setDrag({ i, j, x0: along(e) ?? 0, sizes: sizes(), total });
	}
	function move(e: EventPayload) {
		const d = drag();
		if (!d) return;
		if (e.pressedButton === undefined || e.pressedButton === null) {
			setDrag(null);
			setHot(-1);
			return;
		} // released outside the window
		const delta = ((along(e) ?? d.x0) - d.x0) / d.total;
		resize(d.i, d.j, d.sizes, d.total, d.sizes[d.i]! + delta);
	}

	return (
		<div
			ref={(x: HostElement) => {
				root = x;
			}}
			onLayout={(e: EventPayload) => setLength((col() ? e.height : e.width) ?? 0)}
			style={{ display: "flex", flexDirection: col() ? "column" : "row", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
		>
			<For each={panels()}>
				{(panel, i) => {
					let separator: HostElement | undefined;
					return (
						<>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									flexGrow: sizes()[i()] ?? 0,
									flexShrink: 1,
									flexBasis: 0,
									minWidth: 0,
									minHeight: 0,
									...(col() ? { width: "100%" } : { height: "100%" }),
									...(isShown(i()) ? {} : OFF),
								}}
							>
								{panel}
							</div>
							<Show when={isShown(i()) && nextShown(i()) >= 0}>
								<div
									ref={(el: HostElement) => { separator = el; }}
									role="separator"
									tabIndex={0}
									aria-label={col() ? "Resize pane heights" : "Resize pane widths"}
									aria-orientation={col() ? "horizontal" : "vertical"}
									aria-valuenow={Math.round((sizes()[i()] ?? 0) * 100)}
									// GPUIX 0.11 exposes string values but drops numeric ARIA ranges and orientation.
									aria-valuetext={`${Math.round((sizes()[i()] ?? 0) * 100)}%`}
									aria-description={col() ? "Horizontal separator. Up and Down resize pane heights." : "Vertical separator. Left and Right resize pane widths."}
									onKeyDown={(e) => onKey(i(), e)}
									onMouseDown={(e: EventPayload) => {
										if (separator) gpuix?.renderer.focusElement?.(separator.id);
										start(i(), e);
									}}
									onMouseEnter={() => setHot(i())}
									onMouseLeave={() => {
										if (!drag()) setHot(-1);
									}}
									style={{
										keyboardFocusDim: false,
										...focusRing(),
										...(col() ? { height: handle(), width: "100%" } : { width: handle(), height: "100%" }),
										flexShrink: 0,
										display: "flex",
										flexDirection: col() ? "column" : "row",
										justifyContent: "center",
										cursor: col() ? "row-resize" : "col-resize",
									}}
								>
									<div
										style={{
											...(col() ? { ...t("w-full"), height: 1 } : { ...t("h-full"), width: 1 }),
											pointerEvents: "none",
											backgroundColor:
												drag()?.i === i()
													? tok("primary")
													: hot() === i()
														? withAlpha(tok("primary"), 0.6)
														: p.line === false
															? "transparent"
															: tok("border"),
										}}
									/>
								</div>
							</Show>
						</>
					);
				}}
			</For>
			<Show when={drag()}>
				<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
					<div
						onMouseMove={move}
						onMouseUp={() => {
							setDrag(null);
							setHot(-1);
						}}
						style={{ width: "100%", height: "100%", cursor: col() ? "row-resize" : "col-resize" }}
					/>
				</anchored>
			</Show>
		</div>
	);
}
