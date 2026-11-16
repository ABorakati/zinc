// /connector/* endpoints, after Zotero 7's server_connector.js (+ saveSession.js). Status codes, content types and
// error bodies match Zotero's, so the extension's progress window, target picker and error handling work.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fulltextService } from "../fulltext/service";
import { retrieveOne } from "../additems/retrieve";
import { citeService } from "../cite/api";
import { createItem, getItemDetail, nowIso } from "../db";
import { parseBibtex } from "../io/bibtex";
import { parseCslJson } from "../io/csljson";
import { parseEndnoteXml } from "../io/endnote";
import { detectFormat } from "../io/import";
import { parseNbib } from "../io/pubmed";
import { parseRis } from "../io/ris";
import type { ParsedItem } from "../io/common";
import { itemDoi } from "../references/ids";
import { indexItem } from "../search";
import { isExtensionOrigin, isIntegrationOrigin, isWebRequest } from "../zport/routes";
import { storeWebAttachment } from "./attachments";
import { proxyFrom, toProper } from "./proxy";
import { convertTags, saveTranslatedItem } from "./items";
import { SaveSession, SessionManager, type SessionAction } from "./session";
import { bumpRev } from "./state";
import { resolveTarget, selectedCollection, selectedCollectionResponse, targetIdFor } from "./targets";

export const CONNECTOR_API_VERSION = 3;

/** Seams for tests (network and the Find Full Text engine). */
export const deps = {
	fetch: (url: string, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init),
	/** Open-access full text for an item (what Zotero's OA/custom resolvers do): the new attachment's key, or null. */
	findFullText: async (db: Database, itemKey: string): Promise<string | null> => {
		const svc = fulltextService(db);
		const id = await svc.start([itemKey], true);
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const job = svc.getJob(id);
			if (job?.done) return job.items.find((i) => i.key === itemKey)?.attachmentKey ?? null;
			await Bun.sleep(400);
		}
		return null;
	},
	/** "Retrieve metadata" for a standalone PDF. */
	recognize: async (db: Database, attachmentKey: string): Promise<void> => {
		await retrieveOne(db, attachmentKey);
	},
};

export interface Ctx {
	db: Database;
	url: URL;
}
export type Handler = (req: Request, ctx: Ctx) => Promise<Response> | Response;

// ---------------------------------------------------------------- response helpers

/** Zotero's [status, contentType, body] triple. */
function reply(status: number, contentType?: string, body?: string): Response {
	const headers: Record<string, string> = {};
	if (contentType) headers["Content-Type"] = contentType;
	return new Response(status === 204 || status === 304 ? null : (body ?? ""), { status, headers });
}
const errorReply = (status: number, error: string) => reply(status, "application/json", JSON.stringify({ error }));
const jsonReply = (status: number, body: unknown) => reply(status, "application/json", JSON.stringify(body));

class Bad extends Error {
	constructor(readonly response: Response) {
		super("bad request");
	}
}

/** SQLite refused the write because another process (the app, a second host) holds the library. */
export const isBusyError = (e: unknown): boolean =>
	/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(
		String((e as { code?: unknown })?.code ?? "") + " " + (e instanceof Error ? e.message : String(e)),
	);

/** What a failed save answers: 503 (the extension may retry) when the library is busy, else Zotero's plain 500. */
function failure(e: unknown): Response {
	return isBusyError(e)
		? errorReply(503, "The Zinc library is busy (another program is writing to it). Try again in a moment.")
		: reply(500);
}

const mediaType = (req: Request) => (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

async function readJson(req: Request): Promise<Record<string, any>> {
	const text = await req.text();
	if (!text.trim()) return {};
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" ? v : {};
	} catch {
		throw new Bad(reply(400, "text/plain", "Invalid JSON\n"));
	}
}

/** RFC 2047 encoded words in header values ("=?UTF-8?Q?...?="): the extension encodes non-ASCII titles that way. */
export function decodeRFC2047(value: string): string {
	return value.replace(/=\?([\w-]+)\?([QqBb])\?((?:[^? ]|\?(?!=))*)\?=/g, (_m, charset: string, enc: string, text: string) => {
		let bytes: Uint8Array;
		try {
			if (enc.toLowerCase() === "q") {
				const t = text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
				bytes = Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff);
			} else {
				bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
			}
			return new TextDecoder(charset, { fatal: true }).decode(bytes);
		} catch {
			return text;
		}
	});
}

function metadata(req: Request): Record<string, any> {
	const raw = req.headers.get("x-metadata");
	if (!raw) throw new Bad(errorReply(400, "METADATA_NOT_PROVIDED"));
	try {
		const m = JSON.parse(decodeRFC2047(raw));
		if (m && typeof m === "object") return m;
	} catch {
		/* fall through */
	}
	throw new Bad(reply(400, "text/plain", "Invalid X-Metadata\n"));
}

/**
 * Web pages must not drive the connector. Port 23119 answers CORS preflights only for extension origins (zport/index.ts), but
 * this guard does not rely on that: a request from a web page (an http(s) or "null" Origin, or a cross-site fetch without
 * one) is refused whatever headers it carries, because any page can set "X-Zotero-Connector-API-Version" itself. The
 * Connector extension calls from chrome-extension:// | moz-extension:// | safari-web-extension:// origins; programs send no
 * Origin. Zotero's /connector/ping stays open to a navigation and to the word-processor add-in origins.
 */
export function browserGuard(req: Request, url: URL): Response | null {
	const h = req.headers;
	if (isWebRequest(req)) {
		if (url.pathname === "/connector/ping" && (h.get("sec-fetch-mode") === "navigate" || isIntegrationOrigin(h.get("origin"))))
			return null;
		return new Response(null, { status: 403 });
	}
	// a browser-looking client with no extension origin and no connector header: Zotero refuses it as well
	const isBrowser = (h.get("user-agent") ?? "").startsWith("Mozilla/");
	if (!isBrowser || h.has("x-zotero-connector-api-version") || h.has("zotero-allowed-request") || isExtensionOrigin(h.get("origin")))
		return null;
	if (url.pathname === "/connector/ping" && h.get("sec-fetch-mode") === "navigate") return null;
	return new Response(null, { status: 403 });
}

/** saveItems / saveSnapshot answer 400 CONNECTOR_VERSION_OUTDATED to an extension older than API version 3. */
function versionOutdated(req: Request): Response | null {
	const v = req.headers.get("x-zotero-connector-api-version");
	if (v && Number(v) < CONNECTOR_API_VERSION) return errorReply(400, "CONNECTOR_VERSION_OUTDATED");
	return null;
}

function newSession(id: unknown, action: SessionAction): SaveSession | Response {
	try {
		return SessionManager.create(typeof id === "string" || typeof id === "number" ? String(id) : undefined, action);
	} catch {
		return errorReply(409, "SESSION_EXISTS");
	}
}

/** The collection saves go to right now: the one the UI has selected, else the library. */
function currentCollection(db: Database): string | null {
	return selectedCollection(db)?.key ?? null;
}

function findSession(data: Record<string, any>, req?: Request, url?: URL, metaSession?: unknown): SaveSession | Response {
	const id = metaSession || data?.sessionID || url?.searchParams.get("sessionID");
	if (!id) return errorReply(400, "SESSION_ID_NOT_PROVIDED");
	const s = SessionManager.get(String(id));
	if (!s) return errorReply(400, "SESSION_NOT_FOUND");
	return s;
}

// ---------------------------------------------------------------- endpoints

export const ping: Handler = async (req) => {
	if (req.method === "GET") return reply(200, "text/html", "<!DOCTYPE html><html><body>Zotero is running</body></html>");
	return jsonReply(200, {
		prefs: {
			automaticSnapshots: true,
			downloadAssociatedFiles: true,
			supportsAttachmentUpload: true,
			supportsTagsAutocomplete: true,
			googleDocsAddNoteEnabled: false,
			googleDocsAddAnnotationEnabled: false,
			canUserAddNote: true,
			googleDocsCitationExplorerEnabled: false,
			reportActiveURL: false,
		},
	});
};

export const getSelectedCollection: Handler = (_req, { db }) => jsonReply(200, selectedCollectionResponse(db));

export const saveItems: Handler = async (req, { db }) => {
	const outdated = versionOutdated(req);
	if (outdated) return outdated;
	const data = await readJson(req);
	if (!Array.isArray(data.items)) return reply(400, "text/plain", "items must be an array\n");
	const session = newSession(data.sessionID, "saveItems");
	if (session instanceof Response) return session;
	try {
		const collectionKey = currentCollection(db);
		session.update(db, targetIdFor(collectionKey));
		session.proxy = proxyFrom(data.proxy); // URLs of this save are stored without the university proxy
		for (const raw of data.items) {
			if (!raw || typeof raw !== "object") continue;
			const saved = saveTranslatedItem(db, raw as Record<string, unknown>, collectionKey, [], session.proxy);
			session.addItem(db, saved.connectorId || saved.key, saved.key);
			for (const [aid, key] of Object.entries(saved.attachments)) session.items.set(aid, key);
		}
		bumpRev();
		return reply(201, "application/json");
	} catch (e) {
		console.error("[connector] saveItems failed:", e);
		SessionManager.remove(session.id);
		return failure(e);
	}
};

export const saveSnapshot: Handler = async (req, { db }) => {
	const outdated = versionOutdated(req);
	if (outdated) return outdated;
	const data = await readJson(req);
	const session = newSession(data.sessionID, "saveSnapshot");
	if (session instanceof Response) return session;
	try {
		const collectionKey = currentCollection(db);
		session.update(db, targetIdFor(collectionKey));
		const url = String(data.url ?? "");
		const detail = createItem(db, {
			itemType: "webpage",
			title: String(data.title || url),
			url,
			accessDate: nowIso(),
			collections: collectionKey ? [collectionKey] : [],
		});
		indexItem(db, detail.data.key);
		session.addItem(db, url, detail.data.key);
		bumpRev();
		return reply(201, "application/json");
	} catch (e) {
		console.error("[connector] saveSnapshot failed:", e);
		return failure(e);
	}
};

/** The fallback download may only fetch the saved page itself: an http(s) URL equal (but for the fragment) to the saved item's URL. */
function isPageUrl(db: Database, parentKey: string, url: unknown): boolean {
	if (typeof url !== "string") return false;
	try {
		const wanted = new URL(url);
		if (wanted.protocol !== "http:" && wanted.protocol !== "https:") return false;
		const own = getItemDetail(db, parentKey)?.data.url;
		if (typeof own !== "string") return false;
		const have = new URL(own);
		wanted.hash = "";
		have.hash = "";
		return wanted.href === have.href;
	} catch {
		return false;
	}
}

export const saveSingleFile: Handler = async (req, { db }) => {
	let data: Record<string, any>;
	if (mediaType(req) === "multipart/form-data") {
		const form = await req.formData();
		data = {};
		for (const [k, v] of form.entries()) data[k] = typeof v === "string" ? v : await (v as File).text();
		if (typeof data.items === "string") {
			try {
				data.items = JSON.parse(data.items);
			} catch {
				/* keep the string */
			}
		}
	} else data = await readJson(req);
	const s = findSession(data);
	if (s instanceof Response) return s;
	let parentKey: string | undefined;
	if (s.action === "saveSnapshot") parentKey = s.getItem(data.url);
	else if (s.action === "saveItems") parentKey = s.getItem(data.items?.[0]?.id);
	if (!parentKey) return s.action === "saveSnapshot" || s.action === "saveItems" ? errorReply(400, "PARENT_ITEM_NOT_FOUND") : reply(201);

	let html: string = typeof data.snapshotContent === "string" ? data.snapshotContent : "";
	if (!html.trim() && isPageUrl(db, parentKey, data.url)) {
		// "If snapshotContent is empty, the save failed in the Connector and we fall back to saving in Zotero."
		try {
			const res = await deps.fetch(String(data.url), { headers: { "User-Agent": "zinc" } });
			if (res.ok) html = await res.text();
		} catch {
			/* reported below */
		}
	}
	if (!html.trim()) return reply(500, "text/plain", "Snapshot content is empty\n");
	try {
		storeWebAttachment(db, {
			parentKey,
			bytes: new TextEncoder().encode(html),
			url: toProper(s.proxy, String(data.url ?? "")),
			title: String(data.title || "Snapshot"),
			contentType: "text/html",
		});
		bumpRev();
		return reply(201);
	} catch (e) {
		console.error("[connector] saveSingleFile failed:", e);
		return failure(e);
	}
};

export const saveAttachment: Handler = async (req, { db, url }) => {
	const meta = metadata(req);
	const s = findSession({}, req, url, meta.sessionID);
	if (s instanceof Response) return s;
	const parentKey = s.getItem(meta.parentItemID);
	if (!parentKey) return errorReply(400, "PARENT_ITEM_NOT_FOUND");
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength === 0) return reply(400, "text/plain", "Empty attachment\n");
	try {
		const key = storeWebAttachment(db, {
			parentKey,
			bytes,
			url: toProper(s.proxy, String(meta.url ?? "")),
			title: typeof meta.title === "string" ? meta.title : undefined,
			contentType: mediaType(req) || String(meta.contentType ?? ""),
		});
		if (meta.id) s.items.set(String(meta.id), key);
		bumpRev();
		return reply(201);
	} catch (e) {
		console.error("[connector] saveAttachment failed:", e);
		return failure(e);
	}
};

export const saveStandaloneAttachment: Handler = async (req, { db, url }) => {
	const meta = metadata(req);
	const sessionID = meta.sessionID || url.searchParams.get("sessionID");
	if (!sessionID) return errorReply(400, "SESSION_ID_NOT_PROVIDED");
	const session = newSession(sessionID, "saveStandaloneAttachment");
	if (session instanceof Response) return session;
	const collectionKey = currentCollection(db);
	session.update(db, targetIdFor(collectionKey));
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength === 0) {
		SessionManager.remove(session.id);
		return reply(400, "text/plain", "Empty attachment\n");
	}
	try {
		const contentType = (mediaType(req) || String(meta.contentType ?? "")).toLowerCase();
		const key = storeWebAttachment(db, {
			collectionKey,
			bytes,
			url: String(meta.url ?? ""),
			title: typeof meta.title === "string" ? meta.title : undefined,
			contentType,
		});
		session.addItem(db, String(meta.url ?? key), key);
		const canRecognize = contentType === "application/pdf";
		if (canRecognize)
			session.autoRecognize = deps
				.recognize(db, key)
				.then(() => bumpRev())
				.catch((e) => console.error("[connector] recognize failed:", e instanceof Error ? e.message : e));
		bumpRev();
		return jsonReply(201, { canRecognize });
	} catch (e) {
		console.error("[connector] saveStandaloneAttachment failed:", e);
		SessionManager.remove(session.id);
		return failure(e);
	}
};

export const getRecognizedItem: Handler = async (req, { db }) => {
	const data = await readJson(req);
	if (!data.sessionID) return errorReply(400, "SESSION_ID_NOT_PROVIDED");
	const s = SessionManager.get(data.sessionID);
	if (!s) return errorReply(400, "SESSION_NOT_FOUND");
	await s.autoRecognize;
	const first = [...s.items.values()][0];
	const parent = first
		? (db.query("SELECT parent_key FROM items WHERE key = ?").get(first) as { parent_key: string | null } | null)?.parent_key
		: null;
	const d = parent ? getItemDetail(db, parent) : null;
	if (!d) return reply(204);
	return jsonReply(200, { title: String(d.data.title ?? ""), itemType: d.data.itemType });
};

export const hasAttachmentResolvers: Handler = async (req, { db }) => {
	const data = await readJson(req);
	const s = SessionManager.get(data.sessionID);
	if (!s) return errorReply(400, "SESSION_NOT_FOUND");
	const key = s.getItem(data.itemID);
	const d = key ? getItemDetail(db, key) : null;
	return jsonReply(200, !!d && !!itemDoi(d.data));
};

export const saveAttachmentFromResolver: Handler = async (req, { db }) => {
	const data = await readJson(req);
	const s = SessionManager.get(data.sessionID);
	if (!s) return errorReply(400, "SESSION_NOT_FOUND");
	const key = s.getItem(data.itemID);
	if (!key) return reply(500, "text/plain", "Failed to save an attachment");
	try {
		const attKey = await deps.findFullText(db, key);
		if (attKey) {
			bumpRev();
			const title = getItemDetail(db, attKey)?.data.title;
			return reply(201, "text/plain", String(title ?? "Full Text PDF"));
		}
	} catch (e) {
		console.error("[connector] saveAttachmentFromResolver failed:", e instanceof Error ? e.message : e);
	}
	return reply(500, "text/plain", "Failed to save an attachment");
};

export const updateSession: Handler = async (req, { db }) => {
	const data = await readJson(req);
	if (!data.sessionID) return errorReply(400, "SESSION_ID_NOT_PROVIDED");
	const s = SessionManager.get(data.sessionID);
	if (!s) return errorReply(400, "SESSION_NOT_FOUND");
	const target = resolveTarget(db, data.target);
	if (!target.ok) return errorReply(400, target.error);
	let tags = data.tags;
	if (typeof tags === "string") tags = tags.split(",");
	if (tags !== undefined && !Array.isArray(tags)) tags = [];
	s.update(db, data.target, tags, typeof data.note === "string" ? data.note : "");
	return jsonReply(200, {});
};

export const delaySync: Handler = () => reply(204);

export const importHandler: Handler = async (req, { db, url }) => {
	const text = await req.text();
	const format = detectFormat(text);
	if (!format) return reply(400);
	const parsed: { items: ParsedItem[] } =
		format === "bibtex"
			? parseBibtex(text)
			: format === "ris"
				? parseRis(text)
				: format === "csljson"
					? parseCslJson(text)
					: format === "pubmed-nbib"
						? parseNbib(text)
						: parseEndnoteXml(text);
	if (!parsed.items.length) return reply(400);
	const session = newSession(url.searchParams.get("session") ?? undefined, "import");
	if (session instanceof Response) return session;
	try {
		const collectionKey = currentCollection(db);
		session.update(db, targetIdFor(collectionKey));
		const out: { id: string; key: string; title: string; itemType: string }[] = [];
		db.transaction(() => {
			for (const it of parsed.items) {
				const tags = convertTags(it.data.tags, 1);
				const d = createItem(db, { ...it.data, tags, collections: collectionKey ? [collectionKey] : [] });
				for (const html of it.notes) createItem(db, { itemType: "note", note: html, parentItem: d.data.key });
				out.push({ id: d.data.key, key: d.data.key, title: String(d.data.title ?? ""), itemType: d.data.itemType });
			}
		})();
		for (const o of out) {
			indexItem(db, o.key);
			session.addItem(db, o.key, o.key);
		}
		bumpRev();
		return jsonReply(201, out);
	} catch (e) {
		console.error("[connector] import failed:", e);
		SessionManager.remove(session.id);
		return failure(e);
	}
};

export const installStyle: Handler = async (req, { db, url }) => {
	const xml = await req.text();
	const id = xml.match(/<id>\s*([^<]+?)\s*<\/id>/)?.[1];
	const title = xml.match(/<info>[\s\S]*?<title>\s*([^<]+?)\s*<\/title>/)?.[1];
	const styleId = id?.replace(/\/+$/, "").split("/").pop() ?? "";
	if (!/<style[\s>]/.test(xml) || !title || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(styleId))
		return reply(400, "text/plain", "Invalid style\n");
	void url;
	const dir = join(citeService(db).store.dir, "styles");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${styleId}.csl`), xml);
	return jsonReply(201, { name: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") });
};

export const getClientHostnames: Handler = () => jsonReply(200, []);
export const proxies: Handler = () => jsonReply(200, []);

export interface ConnectorRoute {
	path: string;
	methods: string[];
	handler: Handler;
}

export const connectorRoutes: ConnectorRoute[] = [
	{ path: "/connector/ping", methods: ["GET", "POST"], handler: ping },
	{ path: "/connector/getSelectedCollection", methods: ["POST"], handler: getSelectedCollection },
	{ path: "/connector/saveItems", methods: ["POST"], handler: saveItems },
	{ path: "/connector/saveSnapshot", methods: ["POST"], handler: saveSnapshot },
	{ path: "/connector/saveSingleFile", methods: ["POST"], handler: saveSingleFile },
	{ path: "/connector/saveAttachment", methods: ["POST"], handler: saveAttachment },
	{ path: "/connector/saveStandaloneAttachment", methods: ["POST"], handler: saveStandaloneAttachment },
	{ path: "/connector/getRecognizedItem", methods: ["POST"], handler: getRecognizedItem },
	{ path: "/connector/hasAttachmentResolvers", methods: ["POST"], handler: hasAttachmentResolvers },
	{ path: "/connector/saveAttachmentFromResolver", methods: ["POST"], handler: saveAttachmentFromResolver },
	{ path: "/connector/updateSession", methods: ["POST"], handler: updateSession },
	{ path: "/connector/delaySync", methods: ["POST"], handler: delaySync },
	{ path: "/connector/import", methods: ["POST"], handler: importHandler },
	{ path: "/connector/installStyle", methods: ["POST"], handler: installStyle },
	{ path: "/connector/getClientHostnames", methods: ["POST"], handler: getClientHostnames },
	{ path: "/connector/proxies", methods: ["POST"], handler: proxies },
];

/** Run a handler with the browser guard and Zotero's 400-on-bad-request behaviour. */
export async function runConnectorRoute(r: ConnectorRoute, req: Request, ctx: Ctx): Promise<Response> {
	const refused = browserGuard(req, ctx.url);
	if (refused) return refused;
	try {
		return await r.handler(req, ctx);
	} catch (e) {
		if (e instanceof Bad) return e.response;
		throw e;
	}
}
