// "Is the list scrolling?" without a signal, and hover state that waits for the scroll to end.
//
// GPUIX re-renders the whole window as one GPUI view, and on Windows every JS commit (a signal write that changes the native tree)
// invalidates it, which bypasses GPUI's view and paint caching: a frame in which JS committed is a full, uncached rebuild. While the
// list scrolls, cards slide under a still mouse and fire onMouseEnter / onMouseLeave at ~50 rows a second; each one used to flip a
// `hovered` signal that mounts / unmounts the card's buttons. These helpers keep that (and any other scroll-time bookkeeping) in
// plain variables until the scroll has been quiet for QUIET_MS, then apply it in a single batch.
import { batch } from "solid-js";

/** The list counts as scrolling until this long after its last scroll event. */
export const QUIET_MS = 80;

let lastScroll = -1e9;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Set<() => void>();

/** Call from every scroll signal the list gets (wheel onScroll, onVisibleRange). Cheap: no signals. */
export function markScroll(): void {
	lastScroll = performance.now();
}

export const isScrolling = (): boolean => performance.now() - lastScroll < QUIET_MS;

function flush(): void {
	flushTimer = undefined;
	const wait = QUIET_MS - (performance.now() - lastScroll);
	if (wait > 0) {
		flushTimer = setTimeout(flush, wait + 1);
		return;
	} // scrolled again meanwhile
	const run = [...pending];
	pending.clear();
	batch(() => {
		for (const f of run) f();
	});
}

/** Run `f` now, or once the scroll has been quiet (batched with the other deferred work). */
export function whenQuiet(f: () => void): void {
	if (!isScrolling()) {
		f();
		return;
	}
	pending.add(f);
	flushTimer ??= setTimeout(flush, QUIET_MS + 1);
}

/**
 * A hover flag for one row: `enter` / `leave` are its mouse handlers. While the list scrolls they only record the wanted state;
 * the row's signal (`set`) is written when the scroll has been quiet for QUIET_MS, so a scroll commits nothing for hover.
 */
export function gatedHover(set: (v: boolean) => void): { enter: () => void; leave: () => void } {
	let want = false,
		shown = false;
	const apply = () => {
		if (want !== shown) {
			shown = want;
			set(want);
		}
	};
	const to = (v: boolean) => () => {
		want = v;
		if (isScrolling()) whenQuiet(apply);
		else apply();
	};
	return { enter: to(true), leave: to(false) };
}

/**
 * Coalesces "move the mounted window" requests: `move(urgent)` runs `commit` immediately when urgent (the view is at the edge of
 * the mounted rows) or when `gapMs` passed since the last commit, else once at the end of that gap. `commit` reads the list's
 * current position itself, so a late call uses the latest.
 */
export function throttledCommit(commit: () => void, gapMs = 100): (urgent: boolean) => void {
	let last = -1e9;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		last = performance.now();
		commit();
	};
	return (urgent) => {
		const now = performance.now();
		if (urgent || now - last >= gapMs) {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			last = now;
			commit();
			return;
		}
		timer ??= setTimeout(run, gapMs - (now - last));
	};
}
