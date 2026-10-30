// UI <-> core bridge for the Connector, under /api/ui/:
//   GET  /api/ui/selection  -> {selection: {kind, key?}, rev: number}
//   POST /api/ui/selection  {kind: "library"|"unfiled"|"trash"|"collection"|"search", key?} -> {ok: true, rev}
// The UI posts its current view (the Connector saves into the selected collection) and polls `rev`, which the
// Connector endpoints bump after saving, to reload its lists.
import type { Database } from "bun:sqlite";
import { getRev, getSelection, setSelection } from "./state";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export async function handleUiApi(req: Request, _db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (pathname !== "/api/ui/selection") return null;
	if (req.method === "GET") return json({ selection: getSelection(), rev: getRev() });
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
