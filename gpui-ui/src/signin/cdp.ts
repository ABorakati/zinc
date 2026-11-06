// A small Chrome DevTools Protocol client over a WebSocket (Bun's WebSocket). Used by the sign-in helper to watch the sign-in browser's
// navigations, read its cookies (including HttpOnly ones, which a page script cannot see), run a script in it, and catch its downloads.
// Not exported to anything outside src/signin.

export interface CdpEvent {
	method: string;
	params: any;
	sessionId?: string;
}

export class Cdp {
	private id = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private listeners = new Set<(e: CdpEvent) => void>();
	private closers = new Set<() => void>();
	closed = false;

	private constructor(private ws: WebSocket) {
		ws.addEventListener("message", (m) => {
			let d: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
			try {
				d = JSON.parse(String(m.data));
			} catch {
				return;
			}
			if (typeof d.id === "number") {
				const p = this.pending.get(d.id);
				if (!p) return;
				this.pending.delete(d.id);
				clearTimeout(p.timer);
				if (d.error) p.reject(new Error(String(d.error.message ?? "protocol error")));
				else p.resolve(d.result);
			} else if (d.method) {
				const e: CdpEvent = { method: d.method, params: d.params, ...(d.sessionId ? { sessionId: d.sessionId } : {}) };
				for (const l of [...this.listeners]) {
					try {
						l(e);
					} catch {
						/* a listener's failure is its own */
					}
				}
			}
		});
		const end = () => {
			if (this.closed) return;
			this.closed = true;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error("devtools connection closed"));
			}
			this.pending.clear();
			for (const c of [...this.closers]) c();
		};
		ws.addEventListener("close", end);
		ws.addEventListener("error", end);
	}

	static connect(url: string, timeoutMs = 8000): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			const t = setTimeout(() => {
				try {
					ws.close();
				} catch {
					/* gone */
				}
				reject(new Error("devtools connection timed out"));
			}, timeoutMs);
			ws.addEventListener("open", () => {
				clearTimeout(t);
				resolve(new Cdp(ws));
			});
			ws.addEventListener("error", () => {
				clearTimeout(t);
				reject(new Error("devtools connection failed"));
			});
		});
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("devtools connection closed"));
		const id = ++this.id;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	onEvent(cb: (e: CdpEvent) => void): void {
		this.listeners.add(cb);
	}

	onClose(cb: () => void): void {
		this.closers.add(cb);
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}
