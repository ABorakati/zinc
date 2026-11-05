// /api/websync/* routes and the per-database service registry (contract: core/src/websync/CONTRACT.md).

import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { stopSync } from "../sync/api";
import { WebSyncService, type WebSyncOptions } from "./service";
import { setSyncMode, type FilesMode, type SyncModeName } from "./state";

const services = new WeakMap<Database, WebSyncService>();
const options = new WeakMap<Database, WebSyncOptions>();

/** Remember how to build this database's service (tests inject a key store and a fake clock here). */
export function configureWebSync(db: Database, opts: WebSyncOptions): void {
	options.set(db, opts);
	if (services.get(db)?.opts !== opts) {
		void services.get(db)?.stop();
		services.delete(db);
	}
}

/** The service for a database, created (not started) on first use. */
export function getWebSync(db: Database): WebSyncService {
	let svc = services.get(db);
	if (!svc) {
		svc = new WebSyncService(db, options.get(db) ?? {});
		services.set(db, svc);
	}
	return svc;
}

export async function stopWebSyncService(db: Database): Promise<void> {
	const svc = services.get(db);
	services.delete(db);
	await svc?.stop();
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const b = await req.json();
		if (b && typeof b === "object") return b as Record<string, unknown>;
	} catch {
		// fall through
	}
	throw new HttpError(400, "invalid JSON body");
}

const MODES = new Set<SyncModeName>(["zotero-local", "zotero-org", "off"]);
const FILES = new Set<FilesMode>(["off", "download", "sync"]);

export async function handleWebSyncApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/websync/")) return null;
	try {
		const route = url.pathname.slice("/api/websync/".length).replace(/\/+$/, "");
		const m = req.method;
		const svc = getWebSync(db);
		const need = (method: string) => {
			if (m !== method) throw new HttpError(405, "method not allowed");
		};
		const needKey = async () => {
			if (!(await svc.status()).account.userId) throw new HttpError(400, "set a zotero.org API key first");
		};
		switch (route) {
			case "status":
				need("GET");
				return json(await svc.status());
			case "key": {
				if (m === "DELETE") return json(await svc.clearKey());
				need("POST");
				const b = await body(req);
				if (typeof b.apiKey !== "string") throw new HttpError(400, "apiKey must be a string");
				return json(await svc.setKey(b.apiKey));
			}
			case "mode": {
				need("POST");
				const b = await body(req);
				const mode = b.mode as SyncModeName;
				if (!MODES.has(mode)) throw new HttpError(400, "mode must be zotero-local, zotero-org or off");
				if (mode === "zotero-org") {
					await needKey();
					await stopSync(db); // the local Zotero service must not run beside this one
					setSyncMode(db, mode);
					svc.start();
				} else {
					await svc.stop();
					setSyncMode(db, mode);
					if (mode === "off") await stopSync(db);
					// zotero-local: the app starts the local SyncService (it needs the Zotero backends)
				}
				return json(await svc.status());
			}
			case "options": {
				need("POST");
				const b = await body(req);
				if (b.push !== undefined && typeof b.push !== "boolean") throw new HttpError(400, "push must be a boolean");
				if (b.files !== undefined && !FILES.has(b.files as FilesMode)) throw new HttpError(400, "files must be off, download or sync");
				return json(await svc.setOptions({ push: b.push as boolean | undefined, files: b.files as FilesMode | undefined }));
			}
			case "now":
				need("POST");
				await needKey();
				return json(await svc.syncNow());
			case "files/check":
				need("POST");
				await needKey();
				return json(await svc.checkFiles());
			case "files/download-missing":
				need("POST");
				await needKey();
				return json(await svc.downloadMissing());
			default:
				return json({ error: "not found" }, 404);
		}
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e instanceof Error ? e.message : "websync error");
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
