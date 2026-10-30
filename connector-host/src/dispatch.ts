// Maps one extension call onto the Zotero-port connector handlers (core/src/connector/handlers.ts) by building the
// same synthetic Request the HTTP server would have received.
import type { Database } from "bun:sqlite";
import { hooks } from "../../core/src/additems/files";
import { existsSync } from "node:fs";
import { configureExtractPool, extractFulltext } from "../../core/src/extract";
import { connectorRoutes, runConnectorRoute } from "../../core/src/connector/handlers";
import { SessionManager } from "../../core/src/connector/session";
import { setSelection } from "../../core/src/connector/state";
import { resolveTarget } from "../../core/src/connector/targets";
import { mergeSessions, readState, writeState } from "./store";

export const HOST_VERSION = "0.1.0";
/** What the extension sees as the "Zotero" version (it only shows it in a few messages). */
export const ZOTERO_VERSION_HEADER = "7.0.0-zotero-next";

/** A request body as it crosses native messaging. */
export type WireBody =
	| { kind: "text"; text: string }
	| { kind: "b64"; data: string }
	| { kind: "upload"; uid: string }
	| { kind: "form"; fields: Record<string, { text: string } | { b64: string; type?: string; filename?: string }> };

export interface WireRequest {
	t: "req";
	id: string | number;
	/** connector method name, e.g. "saveItems" (no "connector/" prefix) */
	method: string;
	http?: "GET" | "POST";
	query?: string;
	headers?: Record<string, string>;
	body?: WireBody;
}

export interface HostResult {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export interface HostEnv {
	db: Database;
	dbPath: string;
	/** port of a running zotero-next app, to read its UI selection from (0 disables) */
	appPort: number;
}

// Full-text indexing of what was saved. HTML is plain text extraction; PDFs go through zotero-next's Bun Worker
// pool (Zotero's document-worker), which the compiled host cannot embed, so it runs the worker script and build
// from the zotero-next checkout when that exists (ZNH_REPO, default C:/Users/abora/zotero-next). Without it PDFs
// stay un-indexed until something else extracts them. The host waits for running jobs before it exits.
const REPO = (process.env.ZNH_REPO ?? "C:/Users/abora/zotero-next").replace(/[\\/]+$/, "");
const WORKER_ENTRY = `${REPO}/core/src/extract/pdf-worker.ts`;
const DOC_WORKER = [`${REPO}/vendor/document-worker/build`, `${REPO}/reader-host/dist/document-worker`].find((p) => existsSync(p));
if (DOC_WORKER && existsSync(WORKER_ENTRY)) configureExtractPool({ buildDir: DOC_WORKER, workerEntry: WORKER_ENTRY, concurrency: 1 });
const canExtractPdf = !!DOC_WORKER && existsSync(WORKER_ENTRY);

export const extractions = new Set<Promise<unknown>>();

hooks.afterImport = (db: Database, attachmentKey: string) => {
	const row = db.query("SELECT content_type FROM attachments WHERE item_key = ?").get(attachmentKey) as { content_type: string | null } | null;
	const ct = row?.content_type ?? "";
	if (!/html/i.test(ct) && !(canExtractPdf && /pdf/i.test(ct))) return;
	const p = extractFulltext(db, attachmentKey)
		.catch((e) => console.error("[host] full-text extraction failed:", e instanceof Error ? e.message : e))
		.finally(() => extractions.delete(p));
	extractions.add(p);
};

const SELECTION_METHODS = new Set(["getSelectedCollection", "saveItems", "saveSnapshot", "saveStandaloneAttachment", "import"]);

/** The UI's own selection when the app is running, else the target last chosen in the connector, else My Library. */
export async function refreshSelection(env: HostEnv): Promise<void> {
	if (env.appPort) {
		try {
			const res = await fetch(`http://127.0.0.1:${env.appPort}/api/ui/selection`, { signal: AbortSignal.timeout(400) });
			if (res.ok) {
				const j = (await res.json()) as { selection?: unknown; rev?: unknown };
				if (typeof j.rev === "number" && setSelection(j.selection)) return;
			}
		} catch {
			/* app not running */
		}
	}
	const last = readState(env.dbPath).lastTarget;
	const t = last ? resolveTarget(env.db, last) : null;
	setSelection(t?.ok && t.collectionKey ? { kind: "collection", key: t.collectionKey } : { kind: "library" });
}

function loadSessions(env: HostEnv): void {
	const saved = readState(env.dbPath).sessions;
	if (saved?.length) SessionManager.importAll(saved);
}

function saveSessions(env: HostEnv): void {
	const mine = SessionManager.exportAll();
	writeState(env.dbPath, (cur) => ({ ...cur, sessions: mergeSessions(cur.sessions, mine) }));
}

function bodyToInit(body: WireBody | undefined, uploads: Map<string, Uint8Array>): { body?: BodyInit; contentType?: string } {
	if (!body) return {};
	switch (body.kind) {
		case "text":
			return { body: body.text };
		case "b64":
			return { body: Buffer.from(body.data, "base64") };
		case "upload": {
			const bytes = uploads.get(body.uid);
			if (!bytes) throw new Error(`unknown upload ${body.uid}`);
			uploads.delete(body.uid);
			return { body: bytes as BodyInit };
		}
		case "form": {
			const fd = new FormData();
			for (const [k, v] of Object.entries(body.fields)) {
				if ("text" in v) fd.append(k, v.text);
				else fd.append(k, new Blob([Buffer.from(v.b64, "base64")], { type: v.type }), v.filename ?? k);
			}
			return { body: fd };
		}
	}
}

export async function handleRequest(env: HostEnv, msg: WireRequest, uploads: Map<string, Uint8Array>): Promise<HostResult> {
	const done = (status: number, text: string, contentType = "application/json"): HostResult => ({
		status,
		headers: { "Content-Type": contentType, "X-Zotero-Version": ZOTERO_VERSION_HEADER },
		body: Buffer.from(text),
	});
	const method = String(msg.method ?? "");
	const http = msg.http === "GET" ? "GET" : "POST";
	const path = `/connector/${method}`;
	const route = connectorRoutes.find((r) => r.path === path && r.methods.includes(http));
	// getTranslators / getTranslatorCode / document/* belong to the Zotero client: unknown here, so the
	// extension falls back to the translator repository and shows no integration UI.
	if (!route) return done(404, JSON.stringify({ error: "NOT_IMPLEMENTED", method }));

	const headers = new Headers();
	for (const [k, v] of Object.entries(msg.headers ?? {})) headers.set(k, String(v));
	let init: { body?: BodyInit };
	try {
		init = bodyToInit(msg.body, uploads);
		// A multipart body gets its boundary from FormData: drop the declared type.
		if (msg.body?.kind === "form") headers.delete("content-type");
	} catch (e) {
		return done(400, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
	}
	const url = new URL(`http://127.0.0.1:23119${path}${msg.query ? `?${msg.query.replace(/^\?/, "")}` : ""}`);
	const req = new Request(url, { method: http, headers, body: http === "GET" ? undefined : init.body });

	loadSessions(env);
	if (SELECTION_METHODS.has(method)) await refreshSelection(env);
	let res: Response;
	try {
		res = await runConnectorRoute(route, req, { db: env.db, url });
	} catch (e) {
		console.error(`[host] ${method} failed:`, e);
		return done(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), "application/json");
	}
	if (method === "updateSession" && res.status === 200) {
		// Remember the target for the next save (and for getSelectedCollection when the app is closed).
		let target: unknown;
		try {
			if (msg.body?.kind === "text") target = JSON.parse(msg.body.text).target;
		} catch {
			/* no body */
		}
		const t = resolveTarget(env.db, target);
		if (t.ok) writeState(env.dbPath, (cur) => ({ ...cur, lastTarget: t.collectionKey ? `C${t.collectionKey}` : "L1" }));
	}
	saveSessions(env);

	const out = new Uint8Array(await res.arrayBuffer());
	const rh: Record<string, string> = {};
	res.headers.forEach((v, k) => (rh[k] = v));
	rh["X-Zotero-Version"] = ZOTERO_VERSION_HEADER;
	return { status: res.status, headers: rh, body: out };
}
