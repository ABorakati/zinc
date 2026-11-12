// zotero.org sync in the browser library's worker (browser-db/CONTRACT.md, "zotero.org sync"; core/src/websync/CONTRACT.md "In a browser
// worker"). The storage plumbing is in sync-storage.ts (a worker has no `chrome`).
import type { Database } from "bun:sqlite";
import { configureWebSync, startWebSync, syncMode, setDefaultKeyStore, type WebSyncOptions } from "../../../core/src/websync";
import { chromeKeyStore, type StorageArea } from "./keystore-chrome";
import { apiBaseFrom, TEST_API_BASE_NAME, type StorageClient } from "./sync-storage";

export interface BrowserSyncHandle {
	/** Where the key store reads from: "chrome" (chrome.storage in this worker) or "proxy" (through the offscreen document). */
	storage: "chrome" | "proxy";
	apiBase: string;
	mode: string;
	started: boolean;
}

/**
 * Called by db-worker.ts after the library is open: set the key store, register the sync options and, when the library's sync mode is
 * zotero.org, start the service. In any other mode the options are still registered, so Settings > Sync > "zotero.org" (POST
 * /api/websync/mode) starts it later with the same ones.
 */
export async function startBrowserSync(db: Database, client: StorageClient, extra: WebSyncOptions = {}): Promise<BrowserSyncHandle> {
	const direct = (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome?.storage?.local;
	const area = direct ?? client.area;
	setDefaultKeyStore(chromeKeyStore(area));
	let override: unknown;
	try { override = (await area.get(TEST_API_BASE_NAME))[TEST_API_BASE_NAME]; } catch { /* no override */ }
	const apiBase = apiBaseFrom(override);
	const opts: WebSyncOptions = { fileRedirect: "follow", apiBase: () => apiBase, ...extra };
	const mode = syncMode(db);
	if (mode === "zotero-org") startWebSync(db, opts);
	else configureWebSync(db, opts);
	return { storage: direct ? "chrome" : "proxy", apiBase, mode, started: mode === "zotero-org" };
}
