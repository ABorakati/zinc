// Routes under /api/maintenance/ (stub until the feature lands). Returns null for other paths.
import type { Database } from "bun:sqlite";

export async function handleMaintenanceApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/maintenance/")) return null;
	void db;
	return Response.json({ error: "not implemented yet" }, { status: 501 });
}
