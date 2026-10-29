// Entry point used by the app: start the Zotero sync service for a library database.

import type { Database } from "bun:sqlite";
import { defaultZoteroDataDir, startSync, stopSync } from "./api";
import type { SyncService } from "./engine";
import type { ZoteroReader, ZoteroWriter } from "./protocol";

export { handleSyncApi, getSyncService, startSync, stopSync, defaultZoteroDataDir } from "./api";
export { SyncService } from "./engine";
export type { SyncOptions, SyncStatusEx, SyncConflict } from "./engine";
export * from "./protocol";

export interface StartSyncServiceOptions {
	/** Zotero data directory. Default: $ZOTERO_DATA_DIR or ~/Zotero. */
	dataDir?: string;
	/** Backends from core/src/zotero-db; when omitted they are looked up by name (best effort). */
	reader?: ZoteroReader;
	writer?: ZoteroWriter;
}

/**
 * Starts pulling from Zotero (always) and, once the user turns it on, pushing into Zotero.
 * Returns null (after logging) when the zotero-db backends are not available.
 */
export async function startSyncService(db: Database, opts: StartSyncServiceOptions = {}): Promise<SyncService | null> {
	const dataDir = opts.dataDir ?? defaultZoteroDataDir();
	let { reader, writer } = opts;
	if (!reader || !writer) {
		try {
			const spec = "../zotero-db/index"; // variable specifier: optional dependency, resolved at run time
			const m = (await import(spec)) as Record<string, any>;
			if (typeof m.createZoteroBackends === "function") ({ reader, writer } = await m.createZoteroBackends(dataDir));
			else if (m.createZoteroReader && m.createZoteroWriter) {
				reader = await m.createZoteroReader(dataDir);
				writer = await m.createZoteroWriter(dataDir);
			}
		} catch (e) {
			console.warn("[sync] zotero-db backends unavailable:", e instanceof Error ? e.message : e);
		}
	}
	if (!reader || !writer) return null;
	return startSync(db, { dataDir, reader, writer });
}
