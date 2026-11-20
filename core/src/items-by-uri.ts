// POST /api/items/by-uri: for cited item URIs whose key is not in the library, the item that replaced it. A merged duplicate
// keeps the old item's URI in its relations["dc:replaces"], so a citation written before the merge still finds its item.
// Port of Library.ByUri in the Word COM add-in (word/addin/Library.cs): the Office.js add-in cannot read the database itself.
import type { Database } from "bun:sqlite";

const URI_RE = /^https?:\/\/(?:www\.)?zotero\.org\/(users\/(?:local\/)?[A-Za-z0-9_-]+|groups\/\d+)\/items\/([A-Za-z0-9]{1,32})\/?$/;

/** At most this many URIs are looked at per request (as the COM add-in). */
export const BY_URI_LIMIT = 50;

/** Every URI the same item can be cited by: as cited, as this library's local URI, and as the linked zotero.org account's. */
export function identityAliases(uri: string, libraryKey: string | null, userId: string | null): string[] {
	const m = URI_RE.exec(uri);
	if (!m) return [];
	const [, scope, key] = m;
	const list = [`http://zotero.org/${scope}/items/${key}`];
	if (scope!.startsWith("users/")) {
		if (libraryKey) list.push(`http://zotero.org/users/local/${libraryKey}/items/${key}`);
		if (userId) list.push(`http://zotero.org/users/${userId}/items/${key}`);
	}
	return [...new Set(list)];
}

const value = (db: Database, sql: string): string | null => {
	try {
		return (db.query(sql).get() as { value: string } | null)?.value ?? null;
	} catch {
		return null; // the table is missing in an old or partial database
	}
};

/** The zotero.org user id: the linked account's, else the one most dc:replaces relations name (left by Zotero merges). */
function userIdOf(db: Database, given: unknown): string | null {
	if (typeof given === "string" && /^\d+$/.test(given)) return given;
	const linked = value(db, "SELECT value FROM sync_state WHERE name = 'web_user_id'");
	if (linked && /^\d+$/.test(linked)) return linked;
	const votes = new Map<string, number>();
	const rows = db
		.query("SELECT json_extract(data, '$.relations') AS r FROM items WHERE data LIKE '%zotero.org/users/%' LIMIT 400")
		.all() as {
		r: string | null;
	}[];
	for (const { r } of rows)
		for (const m of (r ?? "").matchAll(/zotero\.org\/users\/(\d+)\//g)) votes.set(m[1]!, (votes.get(m[1]!) ?? 0) + 1);
	return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** LIKE pattern text for a literal string ("%", "_" and the escape character itself escaped with "\"). */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/** cited URI -> key of the live top-level item whose dc:replaces relation names it (or one of its aliases). */
export function itemsByUri(db: Database, uris: unknown, userId?: unknown): Record<string, string> {
	if (!Array.isArray(uris)) return {};
	const libraryKey = value(db, "SELECT value FROM meta WHERE name = 'library_key'");
	const uid = userIdOf(db, userId);
	const q = db.query("SELECT key FROM items WHERE deleted = 0 AND parent_key IS NULL AND data LIKE ? ESCAPE '\\' LIMIT 1");
	const out: Record<string, string> = {};
	for (const u of uris.slice(0, BY_URI_LIMIT)) {
		if (typeof u !== "string") continue;
		for (const alias of identityAliases(u, libraryKey, uid)) {
			// the closing quote ends the URI inside the relation's JSON, so a longer key cannot match
			const row = q.get(`%"dc:replaces":%${likeLiteral(alias)}"%`) as { key: string } | null;
			if (row) {
				out[u] = row.key;
				break;
			}
		}
	}
	return out;
}
