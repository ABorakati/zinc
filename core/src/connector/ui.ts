// UI <-> core bridge for the Connector and the Word sidebar, under /api/ui/:
//   GET  /api/ui/selection  -> {selection: {kind, key?}, rev: number, ext: number, reveal: {key, title, seq} | null}
//   POST /api/ui/selection  {kind: "library"|"unfiled"|"trash"|"collection"|"search", key?} -> {ok: true, rev}
//   POST /api/ui/reveal     {key} -> {ok: true, rev, seq}   404 when the item does not exist (or is in the trash)
// The UI posts its current view (the Connector saves into the selected collection) and polls `rev`, which the
// Connector endpoints bump after saving, to reload its lists. A reveal request (a top-level item key, or a
// child, which resolves to its parent) makes the UI show that item in the library tab: it acts when `reveal.seq`
// changes.
import type { Database } from "bun:sqlite";
import { getReveal, getRev, getSelection, requestReveal, setSelection } from "./state";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export async function handleUiApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (pathname !== "/api/ui/selection" && pathname !== "/api/ui/reveal") return null;
	if (pathname === "/api/ui/reveal") {
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		let b: { key?: unknown };
		try {
			b = (await req.json()) as { key?: unknown };
		} catch {
			return json({ error: "invalid JSON body" }, 400);
		}
		if (typeof b?.key !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(b.key)) return json({ error: "key required" }, 400);
		type Row = { key: string; title: string | null; parent_key: string | null; deleted: number };
		const get = db.query("SELECT key, title, parent_key, deleted FROM items WHERE key = ?");
		let row = get.get(b.key) as Row | null;
		if (row?.parent_key) row = get.get(row.parent_key) as Row | null;
		if (!row || row.deleted) return json({ error: "item not found" }, 404);
		const r = requestReveal(row.key, row.title ?? "");
		return json({ ok: true, rev: getRev(), seq: r.seq });
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
