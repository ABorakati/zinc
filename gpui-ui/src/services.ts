// The background services of zotero-next's main process (app/src/bun/index.ts), run inside the GPUI process so the packaged app is a
// complete replacement for the Electrobun app:
//   - the core HTTP API (started by core.ts on :23120: Word add-in sidebar, MCP clients, the browser Connector's UI selection),
//   - the "Zotero port" 23119 for the browser Connector and Word (startZoteroPort, retried every 30 s while Zotero itself holds it),
//   - two-way sync with the local Zotero library (reading always on, writing opt-in in the UI),
//   - the PDF full-text extraction pool (worker + document-worker build shipped next to the exe),
//   - the native folder dialog for Settings > Files and folders,
//   - clean shutdown when the window closes (stop zport and sync, stop the extract pool, close the database).
// Left out: the institution sign-in browser bridge of Find Full Text (Electrobun webviews; the core then reports "no sign-in window").
//
// Only ONE sync engine may ever run on a library. When the wanted port is held by another zotero-next (core.ts probes it), this core
// takes another port and starts neither sync nor the Zotero port: the other app keeps doing those. The UI shows it (sync/owner.ts).
//
// Environment: ZN_SYNC=0 no sync, ZN_ZPORT=0 no Zotero port (ZN_ZPORT=<n> another port, for tests), ZN_ZOTERO_DIR the Zotero data
// folder, ZN_SERVICES=1 run the services in an unpackaged run too (a packaged run always does).
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { packaged } from "./packaged";
import { setSyncOwner } from "./sync/owner";
import { mark } from "./trace";

interface Stoppable { stop(): void | Promise<void> }

export interface ServicesInput {
	db: Database;
	dbPath: string;
	/** false: another zotero-next holds the wanted port, so it owns sync and the Zotero port. */
	primary: boolean;
	/** The port the HTTP API was asked for (for the notice). */
	wantedPort: number | null;
}

export interface Services {
	/** zport + sync + extract pool; the caller closes the database afterwards. */
	stop(): Promise<void>;
}

/** The packaged app always runs the services; an unpackaged run (dev, tests, scripts) only with ZN_SERVICES=1. */
export const servicesWanted = (): boolean => packaged || process.env.ZN_SERVICES === "1";

/** True if something accepts connections on this loopback port. */
export function portInUse(port: number, timeoutMs = 600): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection({ port, host: "127.0.0.1" });
		const done = (v: boolean) => { s.destroy(); resolve(v); };
		s.setTimeout(timeoutMs, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

// ---- shutdown -----------------------------------------------------------------------------------------------------------------

type Closer = { name: string; run: () => void | Promise<void> };
const closers: Closer[] = [];
let hooked = false;
let closing: Promise<void> | undefined;

/** Run every registered closer once (in reverse order of registration), each failure logged; resolves after at most `limitMs`. */
export function shutdown(limitMs = 5000): Promise<void> {
	closing ??= (async () => {
		const all = (async () => {
			for (const c of closers.splice(0).reverse()) {
				try { await c.run(); } catch (e) { console.warn(`[shutdown] ${c.name}:`, e instanceof Error ? e.message : e); }
			}
		})();
		await Promise.race([all, new Promise((r) => { const t = setTimeout(r, limitMs); (t as { unref?: () => void }).unref?.(); })]);
	})();
	return closing;
}

/** Register work for shutdown (window close, Ctrl+C, SIGTERM). The first call hooks process.exit so async work can finish first. */
export function onShutdown(name: string, run: () => void | Promise<void>): void {
	closers.push({ name, run });
	if (hooked) return;
	hooked = true;
	// @gpuix/solid calls process.exit(0) when the window is closed, which would skip anything asynchronous: the first call starts the
	// shutdown and returns, the real exit follows once it is done; further calls while it runs are ignored.
	const realExit = process.exit.bind(process) as (code?: number) => never;
	let exiting = false;
	process.exit = ((code?: number) => {
		if (exiting) return undefined as never;
		exiting = true;
		void shutdown().finally(() => realExit(code ?? (Number(process.exitCode) || 0)));
		return undefined as never;
	}) as typeof process.exit;
	for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(sig, () => process.exit(0));
}

// ---- start --------------------------------------------------------------------------------------------------------------------

/** Where the packaged app keeps the extraction worker and the document-worker build (packaged.ts sets ZN_ROOT / ZN_PDF_WORKER_ENTRY). */
function extractPaths(): { buildDir?: string; workerEntry?: string } {
	const entry = process.env.ZN_PDF_WORKER_ENTRY;
	const root = process.env.ZN_ROOT;
	const buildDir = root ? join(root, "vendor", "document-worker", "build") : undefined;
	return {
		...(entry && existsSync(entry) ? { workerEntry: entry } : {}),
		...(buildDir && existsSync(join(buildDir, "worker.js")) ? { buildDir } : {}),
	};
}

export async function startServices(o: ServicesInput): Promise<Services> {
	const { db, dbPath } = o;
	const stoppers: { name: string; run: () => void | Promise<void> }[] = [];

	// Settings > Files and folders > Browse...: the GPUI window's native folder dialog
	void (async () => {
		const [{ setFolderPicker }, { pickFolder }] = await Promise.all([
			import("../../core/src/files/api" as string) as Promise<{ setFolderPicker(f: ((startIn?: string) => Promise<string | null>) | null): void }>,
			import("./shell/native"),
		]);
		setFolderPicker(() => pickFolder("Choose folder"));
	})().catch((e) => console.warn("[services] folder picker:", e instanceof Error ? e.message : e));

	// PDF full-text extraction: the exe's loose worker + document-worker build (the repo defaults inside core/ only work from sources)
	const ex = extractPaths();
	const { configureExtractPool, shutdownExtractPool } = await import("../../core/src/extract" as string) as unknown as {
		configureExtractPool(o: { buildDir?: string; workerEntry?: string }): void;
		shutdownExtractPool(): void;
	};
	if (ex.buildDir || ex.workerEntry) configureExtractPool(ex);
	stoppers.push({ name: "extract pool", run: () => shutdownExtractPool() });
	mark("extract-configured");

	if (!o.primary) {
		const note = `Another zotero-next is already running${o.wantedPort ? ` (it holds port ${o.wantedPort})` : ""}, so it handles the Zotero sync and the browser Connector port. This window shows the same library; close the other zotero-next and restart this app to take over.`;
		console.warn(`[services] ${note}`);
		setSyncOwner("other", note);
	} else {
		// Zotero's port (23119) for the browser Connector and Word: taken only while Zotero itself isn't running, re-checked every 30 s
		if (process.env.ZN_ZPORT !== "0") {
			const { startZoteroPort } = await import("../../core/src/zport" as string) as unknown as {
				startZoteroPort(db: Database, o: { port?: number; retryMs?: number; onStart?: (p: number) => void }): { stop(): void; readonly listening: boolean };
			};
			const zport = startZoteroPort(db, {
				port: Number(process.env.ZN_ZPORT) || undefined,
				retryMs: 30_000,
				onStart: (p) => console.log(`[zport] answering Zotero Connector / Word requests on ${p}`),
			});
			stoppers.push({ name: "zport", run: () => zport.stop() });
			mark("zport-started");
		}

		// Two-way sync with the local Zotero library (reading always on, writing opt-in in the UI)
		if (process.env.ZN_SYNC !== "0") {
			try {
				const [{ startSyncService, stopSync }, zdb, { configuredZoteroDataDir }] = await Promise.all([
					import("../../core/src/sync" as string) as Promise<{
						startSyncService(db: Database, o: Record<string, unknown>): Promise<unknown>;
						stopSync(db: Database): Promise<void>;
					}>,
					import("../../core/src/zotero-db" as string) as Promise<{
						findZoteroDataDir(): string;
						createZoteroBackends(dir: string, o: { keepBackups: number }): { reader: unknown; writer: unknown };
						isZoteroProcessRunning(): Promise<boolean>;
					}>,
					import("../../core/src/files/config" as string) as Promise<{ configuredZoteroDataDir(dbFile: string): string | undefined }>,
				]);
				// Zotero data folder: ZN_ZOTERO_DIR, else the one chosen in Settings, else what Zotero's own prefs say. Each write session
				// backs up zotero.sqlite (~180 MB); keep only the last 2 because disk space is tight.
				const dataDir = configuredZoteroDataDir(dbPath) ?? zdb.findZoteroDataDir();
				const backends = zdb.createZoteroBackends(dataDir, { keepBackups: 2 });
				await startSyncService(db, { dataDir, ...backends, isZoteroRunning: zdb.isZoteroProcessRunning });
				stoppers.push({ name: "sync", run: () => stopSync(db) });
				mark("sync-started");
			} catch (e) {
				console.warn("[sync] not started:", e instanceof Error ? e.message : e);
				setSyncOwner("off", `Zotero sync could not start: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			setSyncOwner("off", "Zotero sync is turned off for this run (ZN_SYNC=0).");
		}
	}

	return {
		async stop() {
			for (const s of stoppers.splice(0).reverse()) {
				try { await s.run(); } catch (e) { console.warn(`[services] stop ${s.name}:`, e instanceof Error ? e.message : e); }
			}
		},
	};
}
