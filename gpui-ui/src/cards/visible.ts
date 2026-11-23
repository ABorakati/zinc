// The rows on screen of a <virtual-list> (the cards and the table), as its onVisibleRange events tell them.
//
// GPUIX's scrollToItem reports a one-row range: just the row it scrolled to. In the app's window the real range only follows at the
// list's next scroll by the user, so after a key moved the focus the view seemed one row high: Page Down moved by one row and every
// arrow key scrolled again. Such a range is widened here to the last real height of the view, with the row where the scroll put it.

export interface VisibleRange {
	/** Call before scrollToItem(r, offset): the row will sit `-offset` px below the top of the view. */
	scrolling(offset: number): void;
	/** The range [first, end) an onVisibleRange event stands for. */
	range(a: number, b: number, count: number): [number, number];
	/** Rows the view holds (from its height until a real range arrived). */
	span(): number;
}

export function createVisibleRange(rowHeight: () => number, viewHeight: () => number): VisibleRange {
	let real = 0,
		above = 0;
	const span = () => (real > 1 ? real : Math.max(1, Math.floor(viewHeight() / Math.max(1, rowHeight()))));
	return {
		scrolling(offset) {
			above = Math.max(0, Math.round(-offset / Math.max(1, rowHeight())));
		},
		range(a, b, count) {
			if (b - a > 1 || count <= 1) {
				real = b - a > 1 ? b - a : real;
				above = 0;
				return [a, b];
			}
			const top = Math.max(0, a - above);
			above = 0;
			return [top, Math.min(Math.max(count, top + 1), top + span())];
		},
		span,
	};
}
