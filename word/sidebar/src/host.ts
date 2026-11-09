// The sidebar's link to the add-in: JSON requests over WebView2's postMessage channel (see addin/Bridge.cs and PaneControl.cs).
// Tests plug in a different Host (a mock, or the stdio harness that drives an invisible Word).

export interface Host {
	call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
	/** Subscribe to add-in events ("cursor", "command"). */
	on(event: string, cb: (data: any) => void): void;
}

interface WebViewApi {
	postMessage(msg: string): void;
	addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
}

/** A request the add-in never answers (a modal dialog in Word, a dropped message) fails after this long instead of locking the sidebar for good. */
export const CALL_TIMEOUT_MS = 120_000;

/** Host backed by window.chrome.webview. Throws when the page is not inside the add-in. */
export function createWebViewHost(timeoutMs = CALL_TIMEOUT_MS): Host {
	const wv = (window as unknown as { chrome?: { webview?: WebViewApi } }).chrome?.webview;
	if (!wv) throw new Error("not running inside the Word add-in");
	let seq = 0;
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	const handlers = new Map<string, ((d: any) => void)[]>();
	wv.addEventListener("message", (e) => {
		let m: any;
		try {
			m = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
		} catch {
			return;
		}
		if (m && typeof m.event === "string") {
			for (const cb of handlers.get(m.event) ?? []) cb(m.data);
			return;
		}
		const p = pending.get(m?.id);
		if (!p) return;
		pending.delete(m.id);
		if (m.error) p.reject(new Error(m.error.message ?? String(m.error)));
		else p.resolve(m.result);
	});
	return {
		call(method, params = {}) {
			const id = ++seq;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Word did not answer "${method}" in ${Math.round(timeoutMs / 1000)} s (is a dialog open in Word?). Close it and try again; the action may still have completed, so check the document.`));
				}, timeoutMs);
				pending.set(id, {
					resolve: (v) => (clearTimeout(timer), resolve(v)),
					reject: (e) => (clearTimeout(timer), reject(e)),
				});
				wv.postMessage(JSON.stringify({ id, method, params }));
			});
		},
		on(event, cb) {
			const l = handlers.get(event) ?? [];
			l.push(cb);
			handlers.set(event, l);
		},
	};
}
