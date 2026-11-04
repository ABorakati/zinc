// Worker thread of src/prefetch.ts: answers the app's first GET requests (collections, first page of items, ...) from the library
// while the main thread is still busy creating the window (GpuixRenderer.init() blocks it for 300-500 ms) and loading the UI.
//
// It loads the core's request handler (api.ts, the same code the real core answers with) and opens its OWN read-only connection to the
// library: it never writes, never runs migrations, and closes the connection when it is done. Anything that goes wrong (older schema,
// a WAL that needs recovery, a handler that wants to write) just reports a miss, and the main thread asks the real core as before.
import { Database } from "bun:sqlite";

declare const self: Worker;
interface Job { db: string; paths: string[] }

const t0 = performance.now();
// the core's request handler loads while the main thread is still creating the window; the job arrives meanwhile
const loading = import("../../core/src/api" as string) as Promise<{ handleApi(req: Request, db: Database): Promise<Response | null> }>;
loading.catch(() => {});

self.onmessage = async (e: MessageEvent<Job>) => {
	const { db: dbPath, paths } = e.data;
	let db: Database | undefined;
	try {
		const { handleApi } = await loading;
		db = new Database(dbPath, { readonly: true });
		db.run("PRAGMA busy_timeout = 2000; PRAGMA query_only = ON; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456;");
		for (const path of paths) {
			let text: string | null = null;
			try {
				const res = await handleApi(new Request("http://127.0.0.1/api" + path), db);
				if (res && res.ok) text = await res.text();
			} catch { /* a miss: the main thread asks the core */ }
			postMessage({ path, text, ms: Math.round(performance.now() - t0) });
		}
	} catch {
		for (const path of paths) postMessage({ path, text: null, ms: Math.round(performance.now() - t0) });
	} finally {
		try { db?.close(); } catch { /* ignore */ }
		postMessage({ done: true });
	}
};
