// `sync-control` (library.wit): sync state and "sync now", through core's /api/sync/*.
import { defineHandler } from "./registry";
import { coreJson } from "./data/core";
import { requirePermission } from "./data/perm";

export default defineHandler({
	interface: "zinc:plugin/sync-control",
	where: "host",
	functions: {
		async "get-state"(ctx) {
			requirePermission(ctx, "library.read");
			const s = await coreJson<{ enabled?: boolean; busy?: boolean; lastSync?: string; lastSyncAt?: string; conflicts?: number }>(ctx, "/api/sync/status");
			return {
				route: s.enabled ? "zotero-local" : "off",
				running: !!s.busy,
				lastSynced: s.lastSync ?? s.lastSyncAt ?? undefined,
				conflicts: s.conflicts ?? 0,
			};
		},

		async "sync-now"(ctx, libraries: number[] | undefined) {
			requirePermission(ctx, "library.sync");
			void libraries; // core syncs everything
			// core's POST /api/sync/now waits for the sync; the WIT returns at once and reports through notifier `sync` events
			void coreJson(ctx, "/api/sync/now", { json: {} }).catch(() => {});
		},
	},
});
