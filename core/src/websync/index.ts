// Entry point used by the app: start the zotero.org web sync service for a library database.
// Only one sync route runs per library: syncMode(db) says which ("zotero-local" | "zotero-org" | "off").

import type { Database } from "bun:sqlite";
import { WebSyncService, type WebSyncOptions } from "./service";

export { handleWebSyncApi, getWebSync, configureWebSync } from "./api";
export { WebSyncService } from "./service";
export type { WebSyncOptions, WebSyncStatus } from "./service";
export type { FilesCheck, FileJob } from "./files";
export { MemoryKeyStore, bunKeyStore, type KeyStore } from "./keystore";
export { syncMode, setSyncMode, filesMode, type SyncModeName, type FilesMode } from "./state";

import { configureWebSync, getWebSync, stopWebSyncService } from "./api";

/** Create, register and start the web sync service (pull always; push/files per the saved options). */
export function startWebSync(db: Database, opts: WebSyncOptions = {}): WebSyncService {
	configureWebSync(db, opts);
	const svc = getWebSync(db);
	svc.start();
	return svc;
}

export async function stopWebSync(db: Database): Promise<void> {
	await stopWebSyncService(db);
}
