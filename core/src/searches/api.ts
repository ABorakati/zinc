// Routes under /api/searches/ (stub until the feature lands). Returns null for other paths.
import type { Database } from "bun:sqlite";

export async function handleSearchesApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/searches/")) return null;
	void db;
	return Response.json({ error: "not implemented yet" }, { status: 501 });
}
