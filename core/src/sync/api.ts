// /api/sync/* routes and the per-database service registry.
//   GET    /api/sync/status      -> SyncStatus (+ changeCount, busy)
//   POST   /api/sync/now         -> SyncStatus
//   POST   /api/sync/enable      {enabled: boolean} -> SyncStatus
//   GET    /api/sync/conflicts   -> {conflicts: {id, type, key, title, local, remote, resolved, at}[]}
//   DELETE /api/sync/conflicts   (?id=N for one, else all) -> {ok: true}      (extension: dismiss reviewed conflicts)

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../db";
import { SyncService, type SyncOptions } from "./engine";

const services = new WeakMap<Database, SyncService>();

export function getSyncService(db: Database): SyncService | undefined {
	return services.get(db);
}

export function defaultZoteroDataDir(): string {
	return process.env.ZOTERO_DATA_DIR || join(homedir(), "Zotero");
}

/** Create, register and start the sync service for a library database. */
export function startSync(db: Database, opts: SyncOptions): SyncService {
	services.get(db)?.stop();
	const svc = new SyncService(db, opts);
	services.set(db, svc);
	svc.start();
	return svc;
}

export async function stopSync(db: Database): Promise<void> {
	const svc = services.get(db);
	services.delete(db);
	await svc?.stop();
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export async function handleSyncApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/sync/")) return null;
	try {
		const svc = services.get(db);
		const route = url.pathname.slice("/api/sync/".length).replace(/\/+$/, "");
		const m = req.method;
		if (!svc) {
			// Sync is not running in this process (tests, headless core): report it instead of failing.
			if (route === "status" && m === "GET") {
				return json({
					enabled: false,
					zotero: "missing",
					dataDir: defaultZoteroDataDir(),
					pending: 0,
					conflicts: 0,
					changeCount: 0,
					busy: false,
				});
			}
			throw new HttpError(503, "sync service is not running");
		}
		if (route === "status") {
			if (m !== "GET") throw new HttpError(405, "method not allowed");
			return json(await svc.status());
		}
		if (route === "now") {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			return json(await svc.syncNow());
		}
		if (route === "enable") {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			let body: { enabled?: unknown };
			try {
				body = await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			if (typeof body?.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
			return json(await svc.setEnabled(body.enabled));
		}
		if (route === "conflicts") {
			if (m === "GET") return json({ conflicts: svc.conflicts() });
			if (m === "DELETE") {
				const id = url.searchParams.get("id");
				if (id !== null && !/^\d+$/.test(id)) throw new HttpError(400, "invalid id");
				svc.dismissConflicts(id === null ? undefined : Number(id));
				return json({ ok: true });
			}
			throw new HttpError(405, "method not allowed");
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
