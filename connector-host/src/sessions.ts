// What the connector's save popup can do with a save after it started (methods sessionItems, trashSession, cancelSession).
// A save session (core/src/connector/session.ts) records every item it created, keyed by the extension's own ids, so the popup
// can show them, move them to the Trash ("Remove") or stop the save ("Cancel").
//
// The only write here is "to the Trash": the same soft delete as the app's Move to Trash (items.deleted = 1, synced, and
// restorable from the Trash). It touches only the top-level items the session itself created, and only those added after the
// session started (a guard against a session that ever pointed at an older item). Nothing is erased.
import type { Database } from "bun:sqlite";
import { SessionManager } from "../../core/src/connector/session";
import { bumpRev } from "../../core/src/connector/state";
import { getItemDetail, patchItem } from "../../core/src/db";

/** Sessions the user cancelled: their later save calls are refused, and whatever they still create goes to the Trash. */
const cancelled = new Set<string>();
export const isCancelled = (id: string | undefined): boolean => !!id && cancelled.has(id);

export interface SessionResult {
	status: number;
	body: unknown;
}

const notFound = (id: string): SessionResult => ({ status: 404, body: { error: "SESSION_NOT_FOUND", sessionID: id } });

/** "2026-11-12 03:04:05" (UTC, Zotero's format) or ISO -> ms; NaN when unreadable. */
function addedAt(s: string | null): number {
	if (!s) return NaN;
	const iso = s.includes("T") ? s : s.replace(" ", "T");
	return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

/** The items a save created (top level, not in the Trash), with their attachments. */
export function sessionItems(db: Database, id: string): SessionResult {
	const s = SessionManager.get(id);
	if (!s) return notFound(id);
	const items = s.topLevelKeys(db).flatMap((key) => {
		const d = getItemDetail(db, key);
		if (!d) return [];
		return [{
			key,
			itemType: d.data.itemType,
			title: String(d.data.title ?? ""),
			collections: d.collections,
			attachments: d.children
				.filter((c) => c.itemType === "attachment")
				.map((c) => ({ key: c.key, title: c.title ?? "", contentType: c.contentType ?? null, linkMode: c.linkMode ?? null })),
		}];
	});
	return { status: 200, body: { sessionID: id, targetId: s.targetId, cancelled: cancelled.has(id), items } };
}

/** Move what the session created to the Trash. */
export function trashSession(db: Database, id: string): SessionResult {
	const s = SessionManager.get(id);
	if (!s) return notFound(id);
	const since = s.created - 60_000; // clock slack between the session's start and the rows' timestamps
	const trashed: string[] = [];
	const skipped: string[] = [];
	for (const key of s.topLevelKeys(db)) {
		const row = db.query("SELECT date_added FROM items WHERE key = ?").get(key) as { date_added: string | null } | null;
		const t = addedAt(row?.date_added ?? null);
		if (!(t >= since)) {
			skipped.push(key);
			continue;
		}
		patchItem(db, key, { deleted: 1 } as never);
		trashed.push(key);
	}
	if (trashed.length) bumpRev();
	return { status: 200, body: { ok: true, trashed, skipped } };
}

/** Stop a save: refuse its later calls and trash what it created so far (the host trashes again if a call was in flight). */
export function cancelSession(db: Database, id: string): SessionResult {
	cancelled.add(id);
	const r = SessionManager.get(id) ? trashSession(db, id) : { status: 200, body: { ok: true, trashed: [], skipped: [] } };
	return { status: 200, body: { ...(r.body as object), cancelled: true } };
}

/** Tests only. */
export const resetCancelled = (): void => cancelled.clear();
