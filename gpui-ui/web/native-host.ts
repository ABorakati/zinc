// The extension build's data path (web/build.ts --target extension): every /api request of the app goes over Chrome native
// messaging to the Zinc Connector's host (connector-host, method "api"), which answers it with the core's handleApi against the
// library file. The page opens its own port, so it gets its own host process (and its own database connection: SQLite's
// data_version then moves for every other writer, the desktop app and the connector's saves included).
//
// Frames (connector-host/src/dispatch.ts, the same protocol as the connector's src/browserExt/nativeHost.js):
//   -> {t:"req", id, method:"api", http, path, headers, body}   body: {kind:"text", text} | {kind:"upload", uid}
//   -> {t:"up", uid, seq, last, data}                            base64 pieces of a body larger than INLINE_BYTES
//   <- {t:"res", id, status, headers, n}, then n x {t:"rc", id, seq, data}   (base64 body chunks, each frame under 1 MB)

export const HOST_NAME = "com.zotero_next.connector_host";
/** A body up to this size goes in the request frame; larger ones as `up` frames of UPLOAD_CHUNK bytes. */
const INLINE_BYTES = 256 * 1024;
const UPLOAD_CHUNK = 1024 * 1024;

/** The part of chrome.runtime.Port this uses (a fake in the tests). */
export interface NativePort {
	postMessage(msg: unknown): void;
	onMessage: { addListener(f: (msg: any) => void): void };
	onDisconnect: { addListener(f: () => void): void };
}

interface Pending {
	resolve: (r: Response) => void;
	reject: (e: Error) => void;
	head?: { status: number; headers: Record<string, string>; n: number };
	chunks: Uint8Array[];
	got: number;
}

const toB64 = (b: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * A `fetch`-like function over native messaging. `connect` opens the port (chrome.runtime.connectNative in the page); it is
 * called again after the host goes away, so a crashed or restarted host costs the requests in flight, not the page.
 */
export function nativeApiTransport(
	connect: () => NativePort,
	lastError: () => string | undefined = () => undefined,
): (req: Request) => Promise<Response> {
	let port: NativePort | null = null;
	let nextId = 1;
	const pending = new Map<number, Pending>();

	const finish = (id: number, p: Pending) => {
		pending.delete(id);
		const size = p.chunks.reduce((n, c) => n + c.length, 0);
		const body = new Uint8Array(size);
		let at = 0;
		for (const c of p.chunks) {
			body.set(c, at);
			at += c.length;
		}
		const status = p.head!.status;
		p.resolve(new Response(NULL_BODY.has(status) ? null : body, { status, headers: p.head!.headers }));
	};

	const open = (): NativePort => {
		if (port) return port;
		const me = connect();
		port = me;
		me.onMessage.addListener((m) => {
			const p = pending.get(m?.id);
			if (!p) return;
			if (m.t === "res") {
				p.head = { status: m.status, headers: m.headers ?? {}, n: m.n ?? 0 };
				if (!p.head.n) finish(m.id, p);
			} else if (m.t === "rc" && p.head) {
				p.chunks[m.seq] = fromB64(m.data);
				if (++p.got === p.head.n) finish(m.id, p);
			}
		});
		me.onDisconnect.addListener(() => {
			if (port === me) port = null;
			const why = lastError() ?? "disconnected";
			const err = new Error(
				/not found|forbidden|not allowed/i.test(why)
					? `The Zinc Connector host is not installed or does not allow this extension (${why})`
					: `The Zinc Connector host stopped (${why})`,
			);
			for (const p of pending.values()) p.reject(err);
			pending.clear();
		});
		return me;
	};

	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const headers: Record<string, string> = {};
		req.headers.forEach((v, k) => (headers[k] = v));
		const bytes = req.method === "GET" || req.method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
		const id = nextId++;
		const p = open();
		let body: unknown;
		if (bytes.length > INLINE_BYTES) {
			const uid = `lib${id}`;
			const n = Math.ceil(bytes.length / UPLOAD_CHUNK);
			for (let i = 0; i < n; i++)
				p.postMessage({
					t: "up",
					uid,
					seq: i,
					last: i === n - 1,
					data: toB64(bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK)),
				});
			body = { kind: "upload", uid };
		} else if (bytes.length) {
			// JSON and text inline as they are; anything else (file bytes) as base64
			body = /json|^text\//i.test(headers["content-type"] ?? "")
				? { kind: "text", text: new TextDecoder().decode(bytes) }
				: { kind: "b64", data: toB64(bytes) };
		}
		return new Promise<Response>((resolve, reject) => {
			pending.set(id, { resolve, reject, chunks: [], got: 0 });
			req.signal?.addEventListener(
				"abort",
				() => {
					if (pending.delete(id)) reject(req.signal.reason ?? new DOMException("aborted", "AbortError"));
				},
				{ once: true },
			);
			p.postMessage({ t: "req", id, method: "api", http: req.method, path: url.pathname + url.search, headers, body });
		});
	};
}
