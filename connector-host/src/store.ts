// Where the host finds the library, and the little state that has to outlive one host process: the save target
// the user last picked in the connector, and the in-flight save sessions (so a host restart between
// saveItems -> saveAttachment -> updateSession does not lose them).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SerializedSession } from "../../core/src/connector/session";

const REPO = "C:/Users/abora/zotero-next";

/** Same order as the app (app/src/bun/index.ts): ZN_DB, else the repo's library, else the app's own data folder. */
export function resolveDbPath(env: Record<string, string | undefined> = process.env): string | null {
	if (env.ZN_DB) return env.ZN_DB;
	const repoDb = `${REPO}/data/library.sqlite`;
	if (existsSync(repoDb)) return repoDb;
	// Electrobun's userData for dev.zotero-next.app on Windows.
	const local = env.LOCALAPPDATA;
	if (local) {
		const own = join(local, "dev.zotero-next.app", "stable", "library.sqlite");
		if (existsSync(own)) return own;
	}
	return null;
}

export interface HostState {
	/** "L1" or "C<collectionKey>": the target of the last updateSession. */
	lastTarget?: string;
	sessions?: SerializedSession[];
}

export const stateFilePath = (dbPath: string) => join(dirname(dbPath), "connector-host-state.json");

export function readState(dbPath: string): HostState {
	try {
		const v = JSON.parse(readFileSync(stateFilePath(dbPath), "utf8"));
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
}

/** Merge `patch` into the state file atomically (several hosts can run: one per browser profile). */
export function writeState(dbPath: string, patch: (cur: HostState) => HostState): void {
	const file = stateFilePath(dbPath);
	const next = patch(readState(dbPath));
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, JSON.stringify(next));
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmp, file);
				return;
			} catch (e) {
				// Windows: the target may be open in another process for a moment.
				if (attempt >= 5) throw e;
				Bun.sleepSync(20);
			}
		}
	} catch (e) {
		console.error("[host] could not write state:", e instanceof Error ? e.message : e);
	}
}

/** Sessions merged by id (ours win), dropping the ones older than 30 minutes (SessionManager's own ttl). */
export function mergeSessions(a: SerializedSession[] | undefined, b: SerializedSession[]): SerializedSession[] {
	const byId = new Map<string, SerializedSession>();
	for (const s of a ?? []) byId.set(s.id, s);
	for (const s of b) byId.set(s.id, s);
	const cutoff = Date.now() - 30 * 60_000;
	return [...byId.values()].filter((s) => s.created >= cutoff);
}
