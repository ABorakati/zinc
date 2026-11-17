// A scrollbar you can drag, for the item lists' <virtual-list>s (cards and table). GPUIX paints a thumb for `scrollbarColor` but the
// thumb "takes no pointer input" (@gpuix/native host.d.ts), so in the app the scrollbar could never be dragged (the headless test
// renderer lets you, which hid it). The painted thumb stays the visible part: it follows the scroll every frame at no cost. This is
// a transparent strip over the list's right edge that takes the mouse:
//   - press on the thumb, then move: the thumb follows the pointer, keeping where it was grabbed;
//   - press elsewhere on the track: the list jumps so the thumb centres on the pointer, and the drag goes on from there.
// The strip reads the list's row count and visible range only when pressed / moved (no signal per scroll frame).
// An element with onMouseDown + onMouseMove gets the whole press in GPUIX (the pointer is captured), so the drag keeps working when
// the pointer leaves the strip.
import { createSignal, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";

/** Width of the strip that takes the mouse (the painted thumb is 6 px at its right edge). */
export const SCROLL_STRIP = 14;
/** Smallest thumb GPUIX paints, used to estimate where the thumb is. */
const MIN_THUMB = 24;

export interface ListScrollbarProps {
	/** Rows in the list. */
	count: () => number;
	/** The rows on screen now, [first, last). */
	visible: () => [number, number];
	/** Scroll so `row` is the top row (the list moves its mounted window as needed). */
	scrollTo: (row: number) => void;
	/** Space above the track (a table's column header). */
	top?: number;
}

export function ListScrollbar(p: ListScrollbarProps): JSX.Element {
	let trackY = 0;
	let trackH = 0;
	const [hot, setHot] = createSignal(false);
	/** The drag in progress: the grab point's offset from the thumb's top, in px. */
	let drag: { grab: number } | null = null;

	/** Thumb size and the track length its top can travel, from the visible fraction of the rows. */
	const geometry = () => {
		const n = Math.max(1, p.count());
		const [a, b] = p.visible();
		const vis = Math.max(1, b - a);
		const thumb = Math.min(trackH, Math.max(MIN_THUMB, (trackH * vis) / n));
		const span = Math.max(1, n - vis); // rows the top row can travel over
		const travel = Math.max(1, trackH - thumb);
		return { a, vis, span, thumb, travel, top: (Math.min(a, span) / span) * travel };
	};
	/** Put the thumb's top at `y` px down the track. */
	const scrollThumbTo = (y: number) => {
		const g = geometry();
		const row = Math.round((Math.max(0, Math.min(g.travel, y)) / g.travel) * g.span);
		p.scrollTo(Math.max(0, Math.min(g.span, row)));
	};
	const end = () => {
		drag = null;
		setHot(false);
	};

	return (
		<div
			testId="list-scrollbar"
			onLayout={(e: EventPayload) => {
				trackY = e.y ?? trackY;
				trackH = e.height ?? trackH;
			}}
			onMouseDown={(e: EventPayload) => {
				if ((e.button ?? 0) !== 0 || p.count() <= 0) return;
				const g = geometry();
				if (g.vis >= p.count()) return; // everything is on screen: nothing to scroll
				const y = (e.y ?? 0) - trackY;
				if (y >= g.top && y <= g.top + g.thumb) drag = { grab: y - g.top };
				else {
					// on the track: jump so the thumb centres on the pointer, then keep dragging from its middle
					drag = { grab: g.thumb / 2 };
					scrollThumbTo(y - drag.grab);
				}
				setHot(true);
			}}
			onMouseMove={(e: EventPayload) => {
				if (!drag) return;
				if (e.pressedButton === undefined || e.pressedButton === null) return end(); // released outside the window
				scrollThumbTo((e.y ?? 0) - trackY - drag.grab);
			}}
			onMouseUp={end}
			style={{
				position: "absolute",
				right: 0,
				top: p.top ?? 0,
				bottom: 0,
				width: SCROLL_STRIP,
				// a faint band while dragging, so the press visibly "took"
				backgroundColor: hot() ? "rgba(127,127,127,0.12)" : "rgba(0,0,0,0)",
			}}
		/>
	);
}
