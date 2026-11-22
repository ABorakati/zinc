// Which origins the note host page talks to. (host.js bundles this file; keep it free of DOM and framework imports.)
//
// The page is opened as note-host/index.html?note=<key>[&api=<origin>]. The app itself loads editor.html directly and does this
// bridge on its own side (gpui-ui/src/webview/notes.ts), so nothing in the repository embeds index.html today; these rules decide
// what a page that somebody does embed may reach.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for exactly `http://<127.0.0.1 | localhost | [::1]>[:port]`: no userinfo, path, query or fragment, no other scheme. */
export function isLoopbackHttpOrigin(origin: string): boolean {
	let u: URL;
	try {
		u = new URL(origin);
	} catch {
		return false;
	}
	return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && u.origin === origin;
}

/**
 * The prefix for API requests: "" (same origin) or an origin string; null when `?api=` names somewhere the page must not send
 * the note and the user's requests to. A foreign origin is accepted only when it is exactly a loopback http origin and the
 * page itself was loaded from one (a page served from the real app's origin or the extension never follows `?api=` elsewhere).
 */
export function resolveApiBase(raw: string | null, pageOrigin: string): string | null {
	if (!raw) return "";
	const wanted = raw.endsWith("/") ? raw.slice(0, -1) : raw;
	if (wanted === pageOrigin) return "";
	if (isLoopbackHttpOrigin(wanted) && isLoopbackHttpOrigin(pageOrigin)) return wanted;
	return null;
}

/** The origin to name in postMessage to the embedding page: its own, which is where the app embeds it. null = it has none (file:, data:). */
export function messageOrigin(pageOrigin: string): string | null {
	return pageOrigin && pageOrigin !== "null" ? pageOrigin : null;
}

/** True when a message event came from `source` and from the page's own origin. */
export function fromOwnOrigin(event: { source: unknown; origin: string }, source: unknown, pageOrigin: string): boolean {
	return event.source === source && event.origin === pageOrigin && messageOrigin(pageOrigin) !== null;
}
