// Horizontal resizable panels (corvu/resizable + ui/resizable.tsx in the web UI): panels share the row by flex-grow
// fractions with a drag handle between each pair. While a handle is dragged a transparent window-sized layer captures the
// pointer, so the drag keeps working when the cursor leaves the thin handle.
import { children, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { withAlpha } from "../theme";
import { boundsOf, t, tok } from "./core";

/**
 * `sizes` are fractions (they are normalised if they do not sum to 1) of the width left after the handles, `minSizes` the
 * least fraction per panel (default 0.05). Additions: `gutter` is the handle width in px (default 5, the hit area; the
 * visible line is 1px), `line={false}` hides the line until the handle is hovered or dragged (for a gutter that is part of
 * the layout, as App.tsx's GutterHandle).
 */
export function Resizable(p: {
	sizes: number[];
	onSizes: (s: number[]) => void;
	minSizes?: number[];
	children: JSX.Element[];
	gutter?: number;
	line?: boolean;
}): JSX.Element {
	const kids = children(() => p.children);
	const panels = createMemo(() => kids.toArray());
	const handle = () => p.gutter ?? 5;
	const [width, setWidth] = createSignal(0); // from onLayout, used when the painted bounds are not readable
	const [hot, setHot] = createSignal(-1);
	const [drag, setDrag] = createSignal<{ i: number; x0: number; sizes: number[]; total: number } | null>(null);
	let root: HostElement | undefined;

	const sizes = () => {
		const n = panels().length;
		const s = Array.from({ length: n }, (_, i) => Math.max(0, p.sizes[i] ?? 1 / n));
		const sum = s.reduce((a, b) => a + b, 0) || 1;
		return s.map((v) => v / sum);
	};
	const minOf = (i: number) => p.minSizes?.[i] ?? 0.05;

	function start(i: number, e: EventPayload) {
		const w = boundsOf(root)?.width ?? width();
		const total = w - handle() * Math.max(0, panels().length - 1);
		if (total <= 0) return;
		setDrag({ i, x0: e.x ?? 0, sizes: sizes(), total });
	}
	function move(e: EventPayload) {
		const d = drag();
		if (!d) return;
		if (e.pressedButton === undefined || e.pressedButton === null) {
			setDrag(null);
			setHot(-1);
			return;
		} // released outside the window
		let delta = ((e.x ?? d.x0) - d.x0) / d.total;
		const a = d.sizes[d.i]!,
			b = d.sizes[d.i + 1]!;
		// keep both neighbours at least at their minimum
		delta = Math.min(Math.max(delta, minOf(d.i) - a), b - minOf(d.i + 1));
		const next = d.sizes.slice();
		next[d.i] = a + delta;
		next[d.i + 1] = b - delta;
		p.onSizes(next);
	}

	return (
		<div
			ref={(x: HostElement) => {
				root = x;
			}}
			onLayout={(e: EventPayload) => setWidth(e.width ?? 0)}
			style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", minWidth: 0, minHeight: 0 }}
		>
			<For each={panels()}>
				{(panel, i) => (
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
								height: "100%",
							}}
						>
							{panel}
						</div>
						<Show when={i() < panels().length - 1}>
							<div
								onMouseDown={(e: EventPayload) => start(i(), e)}
								onMouseEnter={() => setHot(i())}
								onMouseLeave={() => {
									if (!drag()) setHot(-1);
								}}
								style={{
									width: handle(),
									flexShrink: 0,
									height: "100%",
									display: "flex",
									justifyContent: "center",
									cursor: "col-resize",
								}}
							>
								<div
									style={{
										...t("h-full"),
										width: 1,
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
				)}
			</For>
			<Show when={drag()}>
				<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
					<div
						onMouseMove={move}
						onMouseUp={() => {
							setDrag(null);
							setHot(-1);
						}}
						style={{ width: "100%", height: "100%", cursor: "col-resize" }}
					/>
				</anchored>
			</Show>
		</div>
	);
}
