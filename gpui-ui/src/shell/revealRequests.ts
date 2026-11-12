// "Show this item in Zinc" from outside the app. The Word sidebar (word/addin/ZnClient.cs) and the browser connector's native host
// (connector-host/src/reveal.ts) POST /api/ui/reveal; the core keeps the latest request in memory with a sequence number
// (core/src/connector/state.ts) and returns it from GET /api/ui/selection. This polls that route and, when the sequence moves,
// shows the item in the library tab. Until now the GPUI app never read these requests, so "Open in Zinc" answered ok and nothing
// happened. Raising the window is left to the caller that asked (the Word add-in does it; see docs/design/web-connector-wasm.md).
import { apiRequest } from "../api";

export interface RevealRequest { key: string; title: string; seq: number; at: number }

/** A request older than this when the app first sees it is not acted on (an external core may hold one from before). */
const FRESH_MS = 60_000;

/** The request to act on now, given the last sequence seen (null: this is the first poll). */
export function pendingReveal(last: number | null, r: RevealRequest | null | undefined, now = Date.now()): RevealRequest | null {
	if (!r || typeof r.seq !== "number" || typeof r.key !== "string") return null;
	if (last === null) return now - (r.at ?? 0) < FRESH_MS ? r : null;
	// `!==`, not `>`: a restarted core counts from 1 again
	return r.seq !== last ? r : null;
}

/** Poll every `intervalMs`; `show` gets the item key of each new request. Returns a stop function. */
export function startRevealPolling(show: (key: string) => void, intervalMs = 1500): () => void {
	let last: number | null = null;
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			const s = await apiRequest<{ reveal?: RevealRequest | null }>("GET", "/ui/selection");
			const r = pendingReveal(last, s.reveal);
			if (s.reveal && typeof s.reveal.seq === "number") last = s.reveal.seq;
			else if (last === null) last = 0;
			if (r) show(r.key);
		} catch {
			/* core not up yet, or an older core: try again next tick */
		} finally {
			busy = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	return () => clearInterval(timer);
}
