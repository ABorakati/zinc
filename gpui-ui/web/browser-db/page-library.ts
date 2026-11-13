// The browser library on a plain web page (browser-db/CONTRACT.md, "Plain web page"): no extension, no offscreen document, no chrome.*.
// The page starts db-worker.js itself as a module worker (`db-worker.js?mode=page`) and is that worker's port 0: it speaks the native
// host's frames over the worker's postMessage, through the same nativeApiTransport the extension's library tab uses.
//
// One page per library. The worker opens an OPFS sync-access-handle pool, which one context at a time can own, so a Web Lock
// ("zinc-library") is taken before the worker is started and held for the life of the page. A second tab does not get the lock, so it
// never starts a worker and never touches the pool: its promise rejects with PageLibraryBusyError, which the platform code can show.
import { nativeApiTransport, type NativePort } from "../native-host";

export const LIBRARY_LOCK = "zinc-library";
export const BUSY_MESSAGE = "Zinc is open in another tab. Close that tab, then reload this one.";

export class PageLibraryBusyError extends Error {
	constructor() {
		super(BUSY_MESSAGE);
		this.name = "PageLibraryBusyError";
	}
}

export interface PageLibrary {
	/** A fetch for /api/* requests (give it to setDirect). */
	transport: (req: Request) => Promise<Response>;
	/** `cb` runs after the library changed (a write committed: here, or by the sync). */
	onChanged(cb: () => void): void;
}

/** One try at the library lock, held for the life of the page; null when another page holds it. */
function tryLock(locks: LockManager): Promise<(() => void) | null> {
	return new Promise((resolve, reject) => {
		locks
			.request(LIBRARY_LOCK, { mode: "exclusive", ifAvailable: true }, (lock) => {
				if (!lock) { resolve(null); return; }
				// the callback's promise is the lock: it is held until release() (or until the page goes away)
				return new Promise<void>((release) => resolve(() => release()));
			})
			.catch(reject);
	});
}

/**
 * The library lock, or null when another page holds it. A reload of the one open tab hands the lock over when the old document is gone,
 * which may be a moment after the new one starts: a busy lock is retried for about 2 seconds before it counts as "another tab".
 */
async function takeLock(): Promise<(() => void) | null> {
	const locks = (navigator as { locks?: LockManager }).locks;
	// no Web Locks (very old browsers): go on; opening the pool then fails by itself if another tab owns it, without harm
	if (!locks) return () => {};
	for (let i = 0; ; i++) {
		const got = await tryLock(locks);
		if (got || i >= 13) return got;
		await new Promise((r) => setTimeout(r, 150));
	}
}

export async function startPageLibrary(): Promise<PageLibrary> {
	const release = await takeLock();
	if (!release) throw new PageLibraryBusyError();
	let worker: Worker | undefined;
	try {
		worker = new Worker(new URL("db-worker.js?mode=page", document.baseURI), { type: "module" });
		const w = worker;
		const changed: (() => void)[] = [];
		const listeners: ((m: any) => void)[] = [];
		const gone: (() => void)[] = [];
		let lastError: string | undefined;

		const ready = new Promise<void>((ok, fail) => {
			w.addEventListener("message", (e: MessageEvent) => {
				const d = e.data as { t?: string; error?: string; p?: number; m?: unknown };
				if (d.t === "ready") ok();
				else if (d.t === "failed") fail(new Error(`Zinc cannot open its library: ${d.error}`));
				else if (d.t === "changed") for (const cb of changed) cb();
				else if (d.p === 0) for (const l of listeners) l(d.m);
			});
			w.addEventListener("error", (e: ErrorEvent) => {
				lastError = e.message || "the database worker stopped";
				fail(new Error(`Zinc's database worker stopped: ${lastError}`));
				for (const g of gone) g();
			});
		});
		await ready;

		// the worker as a "port": frames in as {p: 0, m}, out as {p: 0, m}
		const port: NativePort = {
			postMessage: (m) => w.postMessage({ p: 0, m }),
			onMessage: { addListener: (f) => void listeners.push(f) },
			onDisconnect: { addListener: (f) => void gone.push(f) },
		};
		return {
			transport: nativeApiTransport(() => port, () => lastError, { peer: "Zinc's database worker" }),
			onChanged: (cb) => void changed.push(cb),
		};
	} catch (e) {
		worker?.terminate();
		release();
		throw e;
	}
}
