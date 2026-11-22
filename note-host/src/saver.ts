// Debounced note saving for the host page. (host.js bundles this file; keep it free of DOM and framework imports.)

/** Browsers refuse a keepalive request whose body is over 64 KiB; stay a little under it. Measured in bytes of the JSON body. */
export const KEEPALIVE_MAX_BYTES = 60000;

export function fitsKeepalive(body: string): boolean {
	return new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES;
}

export interface SaverOptions {
	url: string;
	fetchFn: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
	onSaved: () => void;
	onError: (error: string) => void;
	delay?: number;
}

export function createNoteSaver(o: SaverOptions) {
	const delay = o.delay ?? 600;
	let pendingHtml: string | null = null; // latest html not yet confirmed saved
	let lastSaved: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inflight: Promise<void> = Promise.resolve();

	async function patch(html: string, keepalive: boolean) {
		const body = JSON.stringify({ data: { note: html } });
		const res = await o.fetchFn(o.url, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body,
			keepalive: keepalive && fitsKeepalive(body),
		});
		if (!res.ok) throw new Error("PATCH " + res.status);
	}

	function done(html: string) {
		lastSaved = html;
		o.onSaved();
	}
	function failed(html: string, e: unknown) {
		pendingHtml = pendingHtml ?? html;
		console.error("note save failed", e);
		o.onError(String(e));
	}

	/**
	 * Save what is pending. Normally one save runs at a time, in order. At unload (`keepalive`) nothing may wait for an earlier
	 * request: the page is going away, so the request is sent at once and the earlier one is already on its way.
	 */
	function flush(keepalive = false): Promise<void> {
		if (timer) clearTimeout(timer);
		timer = null;
		if (pendingHtml == null) return inflight;
		const html = pendingHtml;
		pendingHtml = null;
		if (html === lastSaved) return inflight;
		if (keepalive) {
			const sent = patch(html, true).then(
				() => done(html),
				(e) => failed(html, e),
			);
			inflight = inflight.then(() => sent);
			return sent;
		}
		inflight = inflight.then(() => patch(html, false)).then(
			() => done(html),
			(e) => failed(html, e),
		);
		return inflight;
	}

	return {
		/** The text the page loaded: an edit equal to it needs no save. */
		setBaseline(html: string) {
			lastSaved = html;
		},
		/** Replace the pending text without scheduling a save (the editor's current state, read at unload). */
		setPending(html: string) {
			pendingHtml = html;
		},
		onEdit(html: string) {
			pendingHtml = html;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void flush(), delay);
		},
		flush,
	};
}
