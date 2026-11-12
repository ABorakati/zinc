// UI <-> core bridge for the Connector and the Word sidebar, under /api/ui/:
//   GET  /api/ui/selection  -> {selection: {kind, key?}, rev: number, ext: number, reveal: {key, title, seq} | null}
//   POST /api/ui/selection  {kind: "library"|"unfiled"|"trash"|"collection"|"search", key?} -> {ok: true, rev}
//   POST /api/ui/reveal     {key, open?} -> {ok: true, rev, seq, opened}   404 when the item does not exist (or is in the trash);
//                           open: true also opens the item's PDF / EPUB / snapshot (or the attachment `key` names) in the reader
// The UI posts its current view (the Connector saves into the selected collection) and polls `rev`, which the
// Connector endpoints bump after saving, to reload its lists. A reveal request (a top-level item key, or a
// child, which resolves to its parent) makes the UI show that item in the library tab: it acts when `reveal.seq`
// changes.
import type { Database } from "bun:sqlite";
import { getReveal, getRev, getSelection, requestReveal, setSelection } from "./state";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** The attachment a reader can open: `asked` when it has a file, else the item's first PDF, then EPUB, then HTML snapshot. */
function readableAttachment(db: Database, asked: string | null, parent: string): { key: string; title: string } | undefined {
	type A = { key: string; title: string | null; content_type: string | null };
	const rows = db
		.query(
			`SELECT i.key, i.title, a.content_type FROM items i JOIN attachments a ON a.item_key = i.key
			 WHERE i.parent_key = ? AND i.deleted = 0 AND a.link_mode IN ('imported_file', 'imported_url', 'linked_file')`,
		)
		.all(parent) as A[];
	const rank = (ct: string | null) => (/pdf/i.test(ct ?? "") ? 0 : /epub/i.test(ct ?? "") ? 1 : /html/i.test(ct ?? "") ? 2 : 9);
	const pick = (asked ? rows.filter((r) => r.key === asked) : rows).filter((r) => rank(r.content_type) < 9).sort((x, y) => rank(x.content_type) - rank(y.content_type))[0];
	return pick ? { key: pick.key, title: pick.title ?? "" } : undefined;
}

export async function handleUiApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (pathname !== "/api/ui/selection" && pathname !== "/api/ui/reveal") return null;
	if (pathname === "/api/ui/reveal") {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		let b: { key?: unknown; open?: unknown };
		try {
			b = (await req.json()) as { key?: unknown; open?: unknown };
		} catch {
			return json({ error: "invalid JSON body" }, 400);
		}
		if (typeof b?.key !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(b.key)) return json({ error: "key required" }, 400);
		type Row = { key: string; title: string | null; parent_key: string | null; deleted: number };
		const get = db.query("SELECT key, title, parent_key, deleted FROM items WHERE key = ?");
		const asked = get.get(b.key) as Row | null;
		const row = asked?.parent_key ? (get.get(asked.parent_key) as Row | null) : asked;
		if (!row || row.deleted) return json({ error: "item not found" }, 404);
		// {open: true}: also open a file of the item in the reader (the attachment asked for, else its best one); none: select only
		const open = b.open === true ? readableAttachment(db, asked!.parent_key ? asked!.key : null, row.key) : undefined;
		const r = requestReveal(row.key, row.title ?? "", open);
		return json({ ok: true, rev: getRev(), seq: r.seq, opened: open?.key ?? null });
	}
	if (req.method === "GET") {
		// `ext` moves when another process (the browser connector's host, the MCP server) commits to the database;
		// SQLite's data_version ignores this connection's own writes, so the UI reloads only for outside changes
		const ext = (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
		return json({ selection: getSelection(), rev: getRev(), ext, reveal: getReveal() });
	}
	if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid JSON body" }, 400);
	}
	if (!setSelection(body)) return json({ error: "invalid selection" }, 400);
	return json({ ok: true, rev: getRev() });
}
