// The browser library's request handler (runs in db-worker.ts): the native host's protocol (connector-host/src/dispatch.ts) without the
// parts that need a computer: no translators (the connector has its own remote source in browser mode), no "reveal in app", no
// full-text extraction pool, no state file. It calls the same core code: handleApi for the library tab's /api/*, the connector routes
// (core/src/connector/handlers.ts) for saves, and connector-host/src/sessions.ts for the save popup's session methods.
//
// What differs from the host:
// - Policy (CONTRACT.md, "Transport"): every /api route is allowed except /api/integrations/* and /api/sync/* (403). /api/websync/* is
//   allowed: it is how the browser library syncs.
// - What the host keeps in connector-host-state.json (the save target the user last picked, the in-flight save sessions) is kept in the
//   library's own `meta` table here, so it survives the offscreen document being closed.
import type { Database } from "bun:sqlite";
import { SessionManager } from "../../../core/src/connector/session";
import { connectorRoutes, decodeRFC2047, isBusyError, runConnectorRoute } from "../../../core/src/connector/handlers";
import { setSelection } from "../../../core/src/connector/state";
import { resolveTarget } from "../../../core/src/connector/targets";
import { cancelSession, isCancelled, sessionItems, trashSession } from "../../../connector-host/src/sessions";

/** The version the extension sees as the "Zotero" version (as the host does: it only shows it in a few messages). */
export const ZOTERO_VERSION_HEADER = "7.0.0-zotero-next";

export type WireBody =
	| { kind: "text"; text: string }
	| { kind: "b64"; data: string }
	| { kind: "upload"; uid: string }
	| { kind: "form"; fields: Record<string, WireField> };
export type WireField = { text: string } | { b64: string; type?: string; filename?: string } | { upload: string; type?: string; filename?: string; asText?: boolean };
export interface WireRequest {
	t: "req";
	id: string | number;
	method: string;
	http?: string;
	path?: string;
	query?: string;
	headers?: Record<string, string>;
	body?: WireBody;
}
export interface HostResult {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** /api/integrations (tokens of connected services) and /api/sync (the local Zotero sync) do not exist in the browser library. */
const API_REFUSED = /^\/api\/(sync|integrations)(\/|$)/;
const LIBRARY_FREE = new Set(["ping", "getClientHostnames", "proxies"]);
const NOT_SERVED = new Set(["getTranslators", "getTranslatorCode", "revealInApp"]);
const SELECTION_METHODS = new Set(["getSelectedCollection", "saveItems", "saveSnapshot", "saveStandaloneAttachment", "import"]);
const SESSION_MUTATING = new Set(["saveItems", "saveSnapshot", "saveSingleFile", "saveAttachment", "saveStandaloneAttachment", "saveAttachmentFromResolver", "updateSession", "import"]);
const SESSION_READING = new Set(["saveSingleFile", "saveAttachment", "saveAttachmentFromResolver", "updateSession", "getRecognizedItem"]);
const SESSION_ACTIONS = new Set(["sessionItems", "trashSession", "cancelSession"]);

export function uploadIdsOf(body: WireBody | undefined): string[] {
	if (!body) return [];
	if (body.kind === "upload") return [body.uid];
	if (body.kind === "form") return Object.values(body.fields).flatMap((f) => ("upload" in f ? [f.upload] : []));
	return [];
}

function takeUpload(uploads: Map<string, Uint8Array>, uid: string): Uint8Array {
	const bytes = uploads.get(uid);
	if (!bytes) throw new Error(`unknown upload ${uid}`);
	uploads.delete(uid);
	return bytes;
}

function bodyToInit(body: WireBody | undefined, uploads: Map<string, Uint8Array>): { body?: BodyInit } {
	if (!body) return {};
	switch (body.kind) {
		case "text":
			return { body: body.text };
		case "b64":
			return { body: fromB64(body.data) as BodyInit };
		case "upload":
			return { body: takeUpload(uploads, body.uid) as BodyInit };
		case "form": {
			const fd = new FormData();
			for (const [k, v] of Object.entries(body.fields)) {
				if ("text" in v) fd.append(k, v.text);
				else if ("upload" in v) {
					const bytes = takeUpload(uploads, v.upload);
					if (v.asText) fd.append(k, new TextDecoder().decode(bytes));
					else fd.append(k, new Blob([bytes as BlobPart], { type: v.type }), v.filename ?? k);
				} else fd.append(k, new Blob([fromB64(v.b64) as BlobPart], { type: v.type }), v.filename ?? k);
			}
			return { body: fd };
		}
	}
}

// ---- what the host keeps in its state file: here, rows of the library's `meta` table
const metaGet = (db: Database, name: string): string | undefined => (db.query("SELECT value FROM meta WHERE name = ?").get(name) as { value: string } | null)?.value;
const metaSet = (db: Database, name: string, value: string): void => {
	db.query("INSERT INTO meta(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
};
const META_TARGET = "browserLastTarget";
const META_SESSIONS = "browserSessions";

/** Who set the collection saves go to last: the library tab (POST /api/ui/selection) or the connector's popup (updateSession). */
let selectionFrom: "ui" | "connector" | null = null;

/** The collection the connector saves into: the library tab's own view while it is open, else the target last chosen in the popup, else My Library. */
function refreshSelection(db: Database): void {
	if (selectionFrom === "ui") return;
	const last = metaGet(db, META_TARGET);
	const t = last ? resolveTarget(db, last) : null;
	setSelection(t?.ok && t.collectionKey ? { kind: "collection", key: t.collectionKey } : { kind: "library" });
}

function sessionIdOf(msg: WireRequest): string | undefined {
	const q = new URLSearchParams(msg.query ?? "");
	const fromQuery = q.get("sessionID") ?? q.get("session");
	if (fromQuery) return fromQuery;
	try {
		const meta = Object.entries(msg.headers ?? {}).find(([k]) => k.toLowerCase() === "x-metadata")?.[1];
		if (meta) {
			const id = JSON.parse(decodeRFC2047(String(meta))).sessionID;
			if (id) return String(id);
		}
		if (msg.body?.kind === "text") {
			const id = JSON.parse(msg.body.text).sessionID;
			if (id) return String(id);
		}
	} catch {
		/* not JSON: no session id to look for */
	}
	return undefined;
}

/** Sessions live in memory; after the offscreen document was recreated, a call naming an unknown one reads the saved copy. */
function loadSessionsFor(db: Database, msg: WireRequest): void {
	const id = sessionIdOf(msg);
	if (!id || SessionManager.get(id)) return;
	try {
		const saved = JSON.parse(metaGet(db, META_SESSIONS) ?? "[]");
		if (Array.isArray(saved) && saved.length) SessionManager.importAll(saved);
	} catch {
		/* unreadable copy: the session is unknown, as after a long gap */
	}
}

function saveSessions(db: Database): void {
	const cutoff = Date.now() - 30 * 60_000;
	metaSet(db, META_SESSIONS, JSON.stringify(SessionManager.exportAll().filter((s) => s.created >= cutoff)));
}

export async function handleRequest(getDb: () => Database, msg: WireRequest, uploads: Map<string, Uint8Array>): Promise<HostResult> {
	const done = (status: number, text: string, contentType = "application/json"): HostResult => ({
		status,
		headers: { "Content-Type": contentType, "X-Zotero-Version": ZOTERO_VERSION_HEADER },
		body: new TextEncoder().encode(text),
	});
	const method = String(msg.method ?? "");
	const http = msg.http === "GET" ? "GET" : "POST";
	const path = `/connector/${method}`;
	const busy = (e: unknown) => isBusyError(e) ? done(503, JSON.stringify({ error: "The Zinc library is busy. Try again in a moment." })) : null;

	const headers = new Headers();
	for (const [k, v] of Object.entries(msg.headers ?? {})) headers.set(k, String(v));
	const readBody = (): { body?: BodyInit } | HostResult => {
		try {
			const init = bodyToInit(msg.body, uploads);
			// a multipart body gets its boundary from FormData: drop the declared type
			if (msg.body?.kind === "form") headers.delete("content-type");
			return init;
		} catch (e) {
			return done(400, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
		}
	};

	// the library tab: the app's own /api/* requests
	if (method === "api") {
		const init = readBody();
		if ("status" in init) return init;
		const http = String(msg.http ?? "GET").toUpperCase();
		let url: URL;
		try {
			url = new URL(String(msg.path ?? ""), "http://127.0.0.1");
		} catch {
			return done(400, JSON.stringify({ error: "malformed path" }));
		}
		if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return done(400, JSON.stringify({ error: "not an /api path" }));
		if (url.pathname.split("/").some((s) => s === ".." || s === ".")) return done(400, JSON.stringify({ error: "malformed path" }));
		if (API_REFUSED.test(url.pathname)) return done(403, JSON.stringify({ error: "not available in the browser library", method: http, path: url.pathname }));
		const req = new Request(url, { method: http, headers, body: http === "GET" || http === "HEAD" ? undefined : init.body });
		try {
			const { handleApi } = await import("../../../core/src/api");
			const res = await handleApi(req, getDb());
			if (!res) return done(404, JSON.stringify({ error: "not found" }));
			if (http === "POST" && url.pathname === "/api/ui/selection" && res.status === 200) selectionFrom = "ui";
			const rh: Record<string, string> = {};
			res.headers.forEach((v, k) => (rh[k] = v));
			return { status: res.status, headers: rh, body: http === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()) };
		} catch (e) {
			const b = busy(e);
			if (b) return b;
			throw e;
		}
	}

	// there is no app to reveal in, and the connector has its own translator source in browser mode
	if (NOT_SERVED.has(method)) return done(404, JSON.stringify({ error: "NOT_IMPLEMENTED", method }));

	// the save popup: list, trash or cancel what one save session created
	if (SESSION_ACTIONS.has(method)) {
		const id = sessionIdOf(msg);
		if (!id) return done(400, JSON.stringify({ error: "sessionID required" }));
		try {
			const db = getDb();
			loadSessionsFor(db, msg);
			const r = method === "sessionItems" ? sessionItems(db, id) : method === "trashSession" ? trashSession(db, id) : cancelSession(db, id);
			return done(r.status, JSON.stringify(r.body));
		} catch (e) {
			const b = busy(e);
			if (b) return b;
			throw e;
		}
	}

	const route = connectorRoutes.find((r) => r.path === path && r.methods.includes(http));
	if (!route) return done(404, JSON.stringify({ error: "NOT_IMPLEMENTED", method }));
	// a save the user cancelled in the popup: its remaining calls are refused
	const sid = SESSION_MUTATING.has(method) ? sessionIdOf(msg) : undefined;
	if (isCancelled(sid)) return done(409, JSON.stringify({ error: "SESSION_CANCELLED", sessionID: sid }));
	const init = readBody();
	if ("status" in init) return init;
	const url = new URL(`http://127.0.0.1:23119${path}${msg.query ? `?${msg.query.replace(/^\?/, "")}` : ""}`);
	const req = new Request(url, { method: http, headers, body: http === "GET" ? undefined : init.body });

	let res: Response;
	try {
		const db = LIBRARY_FREE.has(method) ? (null as unknown as Database) : getDb();
		if (!LIBRARY_FREE.has(method)) {
			if (SESSION_READING.has(method)) loadSessionsFor(db, msg);
			if (SELECTION_METHODS.has(method)) refreshSelection(db);
		}
		res = await runConnectorRoute(route, req, { db, url });
	} catch (e) {
		console.error(`[browser-db] ${method} failed:`, e);
		const b = busy(e);
		if (b) return b;
		return done(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
	}
	if (method === "updateSession" && res.status === 200) {
		// remember the target for the next save
		let target: unknown;
		try {
			if (msg.body?.kind === "text") target = JSON.parse(msg.body.text).target;
		} catch {
			/* no body */
		}
		const db = getDb();
		const t = resolveTarget(db, target);
		if (t.ok) {
			metaSet(db, META_TARGET, t.collectionKey ? `C${t.collectionKey}` : "L1");
			selectionFrom = "connector";
		}
	}
	// cancelled while this call ran: what it just created goes to the Trash too
	if (isCancelled(sid)) trashSession(getDb(), sid!);
	if (SESSION_MUTATING.has(method)) saveSessions(getDb());

	const out = new Uint8Array(await res.arrayBuffer());
	const rh: Record<string, string> = {};
	res.headers.forEach((v, k) => (rh[k] = v));
	rh["X-Zotero-Version"] = ZOTERO_VERSION_HEADER;
	return { status: res.status, headers: rh, body: out };
}
