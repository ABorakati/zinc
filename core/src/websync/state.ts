// sync.mode and the other web-sync settings, kept in sync_state next to the local sync's own rows.

import type { Database } from "bun:sqlite";

export type SyncModeName = "zotero-local" | "zotero-org" | "off";
export type FilesMode = "off" | "download" | "sync";

export function getState(db: Database, name: string): string | undefined {
	const r = db.query("SELECT value FROM sync_state WHERE name = ?").get(name) as { value: string } | null;
	return r?.value;
}

export function setState(db: Database, name: string, value: string | null): void {
	if (value === null) db.query("DELETE FROM sync_state WHERE name = ?").run(name);
	else
		db.query("INSERT INTO sync_state(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(
			name,
			value,
		);
}

/** Which route syncs this library: "zotero-local" (default), "zotero-org" or "off". Exactly one runs. */
export function syncMode(db: Database): SyncModeName {
	const v = getState(db, "mode");
	return v === "zotero-org" || v === "off" ? v : "zotero-local";
}

export function setSyncMode(db: Database, mode: SyncModeName): void {
	if (mode !== "zotero-local" && mode !== "zotero-org" && mode !== "off") throw new Error(`unknown sync mode: ${String(mode)}`);
	setState(db, "mode", mode);
}

export function filesMode(db: Database): FilesMode {
	const v = getState(db, "files");
	return v === "download" || v === "sync" ? v : "off";
}
