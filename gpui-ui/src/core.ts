// Runs the zotero-next core inside the GPUI process (like app/src/bun/index.ts does for the Electrobun app), so there is no
// second bun process holding its own copy of the runtime (~315 MB private measured).
//
//   ZN_DB=<library.sqlite>   run the core in-process on that database; api.ts is pointed at it.
//   ZN_PORT=<n>              loopback port for the in-process HTTP server (default 23161, in the packaged app 23120 like zotero-next's own
//                            core; if taken, an ephemeral port - and then another zotero-next owns sync / the Zotero port, see services.ts).
//   ZN_CORE_DIRECT=1         no HTTP at all: api.ts calls the core's handleApi(Request, db) directly (smaller and faster, but
//                            nothing else - MCP, Connector, a browser - can reach the core).
//   (no ZN_DB)               today's behaviour: an external core at ZN_URL (default http://127.0.0.1:23160).
//
// Services (services.ts: Zotero port 23119, Zotero sync, PDF extraction pool, folder dialog, clean shutdown) run in the packaged app, or with
// ZN_SERVICES=1; ZN_SYNC=0 / ZN_ZPORT=0 turn two of them off.
//
// SAFETY: the core WRITES to its database (sync, migrations, WAL). ZN_DB is never defaulted. Point it at a copy
// (bun:sqlite `VACUUM INTO`); the real library (data/library.sqlite) is refused unless ZN_ALLOW_REAL_DB=1.
//
// The core's modules are imported lazily (dynamic import of literal specifiers, which a bundler can follow; `as string` keeps TypeScript out of them): they cost ~400 ms to
// load, so they must not delay the first frame.
import type { Database } from "bun:sqlite";
import { packaged } from "./packaged";
import { holdRequestsUntil, setBaseUrl, setDirect } from "./api";
import { onShutdown, portInUse, startServices, servicesWanted } from "./services";
import { mark } from "./trace";
import { webMounts } from "./webview/mounts";
import { setNoteBase, setWebBase } from "./webview/config";

const REAL_LIBRARY = "c:/users/abora/zotero-next/data/library.sqlite";
const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

interface Started { url: string; db: Database; stop(): void }

export interface Core {
	/** Loopback URL of the in-process HTTP server; null in direct mode. */
	url: string | null;
	direct: boolean;
	/** false: another zotero-next holds the wanted port (so it owns sync and the Zotero port). */
	primary: boolean;
	stop(): Promise<void>;
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
			{ openDb(path: string): Database },
			{ handleApi(req: Request, db: Database): Promise<Response | null> },
		];
		const db = dbMod.openDb(dbPath) as Database;
		setDirect((req) => apiMod.handleApi(req, db));
		// the reader fetches attachment bytes too, and there is no socket in this mode
		const { setFileFetcher } = await import("./reader/library");
		setFileFetcher(async (key, signal) =>
			(await apiMod.handleApi(new Request(`http://127.0.0.1/api/attachments/${encodeURIComponent(key)}/file`, { signal }), db)) ?? new Response("not found", { status: 404 }));
		mark("core-ready");
		setWebBase(null); // no HTTP in this mode: web tabs fall back to the default app
		setNoteBase(null); // and notes to the built-in Markdown editor
		return finish({ url: null, direct: true, primary: true, db, dbPath, wantedPort: null, stopServer: () => db.close() });
	}
	const { startServer } = await import("../../core/src/server" as string) as unknown as { startServer(o: { dbPath: string; port?: number; hostname?: string; mounts?: { prefix: string; dir: string }[] }): Started };
	mark("core-imported");
	const mounts = webMounts(); // /reader-host/ (web tabs) and /note-host/, when their builds exist
	const serves = mounts.some((m) => m.prefix === "/reader-host/");
	const want = Number(process.env.ZN_PORT) || (packaged ? 23120 : 23161);
	let s: Started | undefined;
	let primary = true;
	if (await portInUse(want)) primary = false; // another zotero-next (or anything) answers there: do not even try to share it
	else {
		try {
			s = startServer({ dbPath, port: want, hostname: "127.0.0.1", mounts });
		} catch (e) {
			if ((e as { code?: string })?.code !== "EADDRINUSE") throw e;
			primary = false;
		}
	}
	s ??= startServer({ dbPath, port: 0, hostname: "127.0.0.1", mounts }); // taken: any free loopback port
	mark("core-server-started");
	setBaseUrl(s.url);
	setWebBase(serves ? s.url : null);
	setNoteBase(mounts.some((m) => m.prefix === "/note-host/") ? s.url : null);
	mark("core-ready");
	const server = s;
	return finish({ url: s.url, direct: false, primary, db: s.db, dbPath, wantedPort: want, stopServer: () => server.stop() });
}

/** Start the services (packaged app / ZN_SERVICES=1) and register the clean shutdown: services first, then the server and its database. */
async function finish(c: { url: string | null; direct: boolean; primary: boolean; db: Database; dbPath: string; wantedPort: number | null; stopServer: () => void }): Promise<Core> {
	let services: Promise<{ stop(): Promise<void> } | undefined> | undefined;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await (await services)?.stop();
		c.stopServer();
	};
	onShutdown("core", stop);
	if (servicesWanted()) {
		// not awaited: the UI's requests are held until the core resolves, and the services (sync, Zotero port) are not needed for the first page
		services = startServices({ db: c.db, dbPath: c.dbPath, primary: c.primary, wantedPort: c.wantedPort }).then(
			(sv) => (mark("services-ready"), sv),
			(e) => (console.error("[services]", e instanceof Error ? e.message : e), undefined),
		);
	}
	return { url: c.url, direct: c.direct, primary: c.primary, stop };
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
