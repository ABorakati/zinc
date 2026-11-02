// Runs the zotero-next core inside the GPUI process (like app/src/bun/index.ts does for the Electrobun app), so there is no
// second bun process holding its own copy of the runtime (~315 MB private measured).
//
//   ZN_DB=<library.sqlite>   run the core in-process on that database; api.ts is pointed at it.
//   ZN_PORT=<n>              loopback port for the in-process HTTP server (default 23161; if taken, an ephemeral port).
//   ZN_CORE_DIRECT=1         no HTTP at all: api.ts calls the core's handleApi(Request, db) directly (smaller and faster, but
//                            nothing else - MCP, Connector, a browser - can reach the core).
//   (no ZN_DB)               today's behaviour: an external core at ZN_URL (default http://127.0.0.1:23160).
//
// SAFETY: the core WRITES to its database (sync, migrations, WAL). ZN_DB is never defaulted. Point it at a copy
// (bun:sqlite `VACUUM INTO`); the real library (data/library.sqlite) is refused unless ZN_ALLOW_REAL_DB=1.
//
// The core's modules are imported lazily (dynamic import of literal specifiers, which a bundler can follow; `as string` keeps TypeScript out of them): they cost ~400 ms to
// load, so they must not delay the first frame.
import { holdRequestsUntil, setBaseUrl, setDirect } from "./api";
import { mark } from "./trace";

const REAL_LIBRARY = "c:/users/abora/zotero-next/data/library.sqlite";
const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

interface Db { close(): void }
interface Started { url: string; db: Db; stop(): void }

export interface Core {
	/** Loopback URL of the in-process HTTP server; null in direct mode. */
	url: string | null;
	direct: boolean;
	stop(): void;
}

let core: Promise<Core | null> | undefined;

/** The database the in-process core would use (ZN_DB), if any. */
export const inProcessDb = (): string | undefined => process.env.ZN_DB || undefined;

async function start(dbPath: string): Promise<Core> {
	if (norm(dbPath) === REAL_LIBRARY && process.env.ZN_ALLOW_REAL_DB !== "1") {
		throw new Error(`ZN_DB points at the real library (${dbPath}); the core writes to its database. Use a copy, or set ZN_ALLOW_REAL_DB=1.`);
	}
	mark("core-start");
	if (process.env.ZN_CORE_DIRECT === "1") {
		// string literals (the `as string` is erased on transpile, so a bundler sees a plain literal and can follow it) typed as string for
		// TypeScript, which keeps the core's sources out of this app's `bun check`
		const [dbMod, apiMod] = await Promise.all([import("../../core/src/db" as string), import("../../core/src/api" as string)]) as unknown as [
			{ openDb(path: string): Db },
			{ handleApi(req: Request, db: Db): Promise<Response | null> },
		];
		const db = dbMod.openDb(dbPath);
		setDirect((req) => apiMod.handleApi(req, db));
		// the reader fetches attachment bytes too, and there is no socket in this mode
		const { setFileFetcher } = await import("./reader/library");
		setFileFetcher(async (key, signal) =>
			(await apiMod.handleApi(new Request(`http://127.0.0.1/api/attachments/${encodeURIComponent(key)}/file`, { signal }), db)) ?? new Response("not found", { status: 404 }));
		mark("core-ready");
		return { url: null, direct: true, stop: () => db.close() };
	}
	const { startServer } = await import("../../core/src/server" as string) as unknown as { startServer(o: { dbPath: string; port?: number; hostname?: string }): Started };
	const want = Number(process.env.ZN_PORT) || 23161;
	let s: Started;
	try {
		s = startServer({ dbPath, port: want, hostname: "127.0.0.1" });
	} catch (e) {
		if ((e as { code?: string })?.code !== "EADDRINUSE") throw e;
		s = startServer({ dbPath, port: 0, hostname: "127.0.0.1" }); // taken: any free loopback port
	}
	setBaseUrl(s.url);
	mark("core-ready");
	return { url: s.url, direct: false, stop: () => s.stop() };
}

/**
 * Start the in-process core when ZN_DB is set (resolves to null otherwise). Requests made through api.ts wait for it, so call
 * this before anything fetches; it returns at once with a promise, the heavy imports happen asynchronously.
 */
export function startCore(): Promise<Core | null> {
	if (core) return core;
	const db = inProcessDb();
	if (!db) return (core = Promise.resolve(null));
	core = start(db);
	holdRequestsUntil(core);
	return core;
}
