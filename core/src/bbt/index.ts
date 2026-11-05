// Better BibTeX, native: citation keys, Better exports, auto-export and BBT's local HTTP endpoints.
// Importing this module registers the /better-bibtex/* routes on the Zotero port (see http.ts).
import type { Database } from "bun:sqlite";
import { startAutoExport } from "./autoexport";
import { backfillKeys, flushDirty } from "./keys";
import "./http";

export { handleBbtApi } from "./api";
export * from "./autoexport";
export * from "./cite";
export * from "./hooks";
export * from "./keys";
export * from "./settings";
export * from "./types";
export { compile, generate, FormulaError } from "./formula";
export { exportBetterFormat, isBbtFormat, keysFor } from "./export";

/** Start the background parts: backfill the keys, then the auto-export scheduler. Returns stop(). */
export function startBbt(db: Database, o: { pollMs?: number } = {}): { stop(): void } {
	try {
		backfillKeys(db);
	} catch (e) {
		console.warn("[bbt] key backfill failed:", e instanceof Error ? e.message : e);
	}
	const ae = startAutoExport(db, { pollMs: o.pollMs });
	// keys of items written since the last look (any writer) are brought up to date in the background
	const keys = setInterval(() => {
		try {
			flushDirty(db);
		} catch (e) {
			console.warn("[bbt] key update failed:", e instanceof Error ? e.message : e);
		}
	}, 1000);
	(keys as { unref?: () => void }).unref?.();
	return { stop: () => { ae.stop(); clearInterval(keys); } };
}
