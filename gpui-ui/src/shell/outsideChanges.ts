// Changes another program makes to the library while this UI is open: the desktop app, the connector saving a page, the MCP
// server. GET /api/ui/selection returns `ext`, the core connection's PRAGMA data_version (core/src/connector/ui.ts). SQLite moves
// it on every commit by another connection and never for the connection's own writes, so a change means "someone else wrote":
// reload the lists then. Used by the browser extension's library page (src/platform.web.ts), whose core runs in the connector's
// native host; the desktop app's own writes go through its own core and refresh the lists where they happen.
import { apiRequest } from "../api";

/** true when `next` is a new data_version after `last` (null: the first answer, which only sets the baseline). */
export function extMoved(last: number | null, next: unknown): boolean {
	return last !== null && typeof next === "number" && next !== last;
}

/** Poll every `intervalMs` (skipped while the page is hidden); `onChange` runs once per detected change. Returns a stop function. */
export function startOutsideChangeWatch(onChange: () => void, intervalMs = 2000): () => void {
	let last: number | null = null;
	let busy = false;
	const tick = async () => {
		if (busy) return;
		if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
		busy = true;
		try {
			const s = await apiRequest<{ ext?: unknown }>("GET", "/ui/selection");
			if (extMoved(last, s.ext)) onChange();
			if (typeof s.ext === "number") last = s.ext;
		} catch {
			/* host restarting, or library busy: try again next tick */
		} finally {
			busy = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	return () => clearInterval(timer);
}
