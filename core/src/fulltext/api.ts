// Find Full Text routes (/api/fulltext/*). Contract: core/src/api-types.ts.
// Stub until the zotero-fulltext integration lands; returns null for other paths.
import type { Database } from "bun:sqlite";

export async function handleFulltextApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/fulltext/")) return null;
	void db;
	return Response.json({ error: "Find Full Text is not available yet" }, { status: 501 });
}
