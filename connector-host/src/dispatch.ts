// Maps one extension call onto the Zotero-port connector handlers (core/src/connector/handlers.ts) by building the
// same synthetic Request the HTTP server would have received.
import type { Database } from "bun:sqlite";
import { hooks } from "../../core/src/additems/files";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureExtractPool, extractFulltext } from "../../core/src/extract";
import { connectorRoutes, decodeRFC2047, isBusyError, runConnectorRoute } from "../../core/src/connector/handlers";
import { SessionManager } from "../../core/src/connector/session";
import { setSelection } from "../../core/src/connector/state";
import { resolveTarget } from "../../core/src/connector/targets";
import { mergeSessions, readState, writeState } from "./store";
import { translatorCode, translatorMetadata } from "./translators";

export const HOST_VERSION = "0.1.0";
/** What the extension sees as the "Zotero" version (it only shows it in a few messages). */
export const ZOTERO_VERSION_HEADER = "7.0.0-zotero-next";

/** A request body as it crosses native messaging. */
export type WireBody =
	| { kind: "text"; text: string }
	| { kind: "b64"; data: string }
	| { kind: "upload"; uid: string }
	| { kind: "form"; fields: Record<string, WireField> };

/** One multipart field: inline text, inline base64 bytes, or bytes/text sent earlier as `up` frames (uid). */
export type WireField = { text: string } | { b64: string; type?: string; filename?: string } | { upload: string; type?: string; filename?: string; asText?: boolean };

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
	/** Opens the library on first use: methods that need no library (ping, translators) never call it. Throws when it cannot be opened. */
	getDb: () => Database;
	/** null when no library was found (only the library-free methods work then) */
	dbPath: string | null;
	/** port of a running zotero-next app, to read its UI selection from (0 disables) */
	appPort: number;
}

// Full-text indexing of what was saved. HTML is plain text extraction; PDFs go through zotero-next's Bun Worker
// pool (Zotero's document-worker), which the compiled host cannot embed, so it runs the worker script and build
// from the zotero-next checkout when that exists (ZNH_REPO, default <home>/zotero-next). Without it PDFs
// stay un-indexed until something else extracts them. The host waits for running jobs before it exits.
const REPO = (process.env.ZNH_REPO ?? join(process.env.USERPROFILE ?? homedir(), "zotero-next")).replace(/[\\/]+$/, "");
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

const BUSY_MESSAGE = "The Zinc library is busy (another program is writing to it). Try again in a moment.";
const SELECTION_METHODS = new Set(["getSelectedCollection", "saveItems", "saveSnapshot", "saveStandaloneAttachment", "import"]);

/** The UI's own selection when the app is running, else the target last chosen in the connector, else My Library. */
export async function refreshSelection(env: { db: Database; dbPath: string | null; appPort: number }): Promise<void> {
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
	const last = env.dbPath ? readState(env.dbPath).lastTarget : undefined;
	const t = last ? resolveTarget(env.db, last) : null;
	setSelection(t?.ok && t.collectionKey ? { kind: "collection", key: t.collectionKey } : { kind: "library" });
}

// Methods that need no library at all: answered before the database is opened (a cold host answers ping in ~1 ms).
const LIBRARY_FREE = new Set(["ping", "getClientHostnames", "proxies"]);
// Answered by the host itself from the bundled translators (see translators.ts).
const TRANSLATOR_METHODS = new Set(["getTranslators", "getTranslatorCode"]);
// Methods that create, change or finish a save session: the only ones whose result is written to the state file.
const SESSION_MUTATING = new Set(["saveItems", "saveSnapshot", "saveSingleFile", "saveAttachment", "saveStandaloneAttachment", "saveAttachmentFromResolver", "updateSession", "import"]);
// Methods that look an existing session up (and so may need the persisted copy, after a host restart). The ones that
// start a session (saveItems, saveSnapshot, saveStandaloneAttachment, import) name a new id: nothing to load.
const SESSION_READING = new Set(["saveSingleFile", "saveAttachment", "saveAttachmentFromResolver", "updateSession", "getRecognizedItem"]);

/** The save session id a call refers to (query, X-Metadata header or JSON body), if any. */
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

/** Read the persisted sessions only when this call names one the process does not know (restart, or another host made it). */
function loadSessionsFor(env: HostEnv, msg: WireRequest): void {
	if (!env.dbPath) return;
	const id = sessionIdOf(msg);
	if (!id || SessionManager.get(id)) return;
	const saved = readState(env.dbPath).sessions;
	if (saved?.length) SessionManager.importAll(saved);
}

function saveSessions(env: HostEnv): void {
	if (!env.dbPath) return;
	const mine = SessionManager.exportAll();
	writeState(env.dbPath, (cur) => ({ ...cur, sessions: mergeSessions(cur.sessions, mine) }));
}

function takeUpload(uploads: Map<string, Uint8Array>, uid: string): Uint8Array {
	const bytes = uploads.get(uid);
	if (!bytes) throw new Error(`unknown upload ${uid}`);
	uploads.delete(uid);
	return bytes;
}

/** Every upload uid a body refers to (so the host can free the ones a request never consumed). */
export function uploadIdsOf(body: WireBody | undefined): string[] {
	if (!body) return [];
	if (body.kind === "upload") return [body.uid];
	if (body.kind === "form") return Object.values(body.fields).flatMap((f) => ("upload" in f ? [f.upload] : []));
	return [];
}

function bodyToInit(body: WireBody | undefined, uploads: Map<string, Uint8Array>): { body?: BodyInit } {
	if (!body) return {};
	switch (body.kind) {
		case "text":
			return { body: body.text };
		case "b64":
			return { body: Buffer.from(body.data, "base64") };
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
				} else fd.append(k, new Blob([Buffer.from(v.b64, "base64")], { type: v.type }), v.filename ?? k);
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

	// The translators come from the bundled copy (offline, instant): the extension asks "the client" for them
	// before it ever tries the translator repository.
	if (TRANSLATOR_METHODS.has(method)) {
		try {
			if (method === "getTranslators") {
				// none bundled: 404, so the extension asks the translator repository instead
				const meta = translatorMetadata(env.dbPath);
				return meta === null ? done(404, JSON.stringify({ error: "NOT_IMPLEMENTED", method })) : done(200, meta);
			}
			let id = "";
			try {
				id = String(JSON.parse(msg.body?.kind === "text" ? msg.body.text : "{}").translatorID ?? "");
			} catch {
				/* no id */
			}
			const code = id ? translatorCode(env.dbPath, id) : null;
			return code === null ? done(404, JSON.stringify({ error: "TRANSLATOR_NOT_FOUND", method })) : done(200, code, "text/plain");
		} catch (e) {
			console.error(`[host] ${method} failed:`, e);
			return done(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
		}
	}
	const route = connectorRoutes.find((r) => r.path === path && r.methods.includes(http));
	// document/* belongs to the Zotero client (Word / LibreOffice integration): unknown here, no integration UI.
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

	let res: Response;
	try {
		// ping & co. never touch the library: do not open it (nor read the state file) for them.
		const db = LIBRARY_FREE.has(method) ? (null as unknown as Database) : env.getDb();
		if (SESSION_READING.has(method)) loadSessionsFor(env, msg);
		if (SELECTION_METHODS.has(method)) await refreshSelection({ db, dbPath: env.dbPath, appPort: env.appPort });
		res = await runConnectorRoute(route, req, { db, url });
	} catch (e) {
		console.error(`[host] ${method} failed:`, e);
		if (isBusyError(e)) return done(503, JSON.stringify({ error: BUSY_MESSAGE }));
		return done(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
	}
	if (method === "updateSession" && res.status === 200 && env.dbPath) {
		const dbPath = env.dbPath;
		// Remember the target for the next save (and for getSelectedCollection when the app is closed).
		let target: unknown;
		try {
			if (msg.body?.kind === "text") target = JSON.parse(msg.body.text).target;
		} catch {
			/* no body */
		}
		const t = resolveTarget(env.getDb(), target);
		if (t.ok) writeState(dbPath, (cur) => ({ ...cur, lastTarget: t.collectionKey ? `C${t.collectionKey}` : "L1" }));
	}
	if (SESSION_MUTATING.has(method)) saveSessions(env);

	const out = new Uint8Array(await res.arrayBuffer());
	const rh: Record<string, string> = {};
	res.headers.forEach((v, k) => (rh[k] = v));
	rh["X-Zotero-Version"] = ZOTERO_VERSION_HEADER;
	return { status: res.status, headers: rh, body: out };
}
