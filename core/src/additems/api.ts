// Routes under /api/add/ (stub until the feature lands). Returns null for other paths.
import type { Database } from "bun:sqlite";

export async function handleAddItemsApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/add/")) return null;
	void db;
	return Response.json({ error: "not implemented yet" }, { status: 501 });
}
