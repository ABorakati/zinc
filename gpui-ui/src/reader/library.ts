// Get a PDF for an attachment key through the core, never by opening data/library.sqlite.
//
// The core serves an attachment's file as BYTES (GET /api/attachments/:key/file, Range-capable); item JSON only carries the
// stored path ("attachments:<relative>" for linked files), which only the core can resolve, and its MCP get_file_path is not an
// HTTP route. So the reader fetches the bytes and hands them to the cdylib (zpdf_open_bytes: one copy into the worker, which
// is the same single in-memory copy the path-based open makes with fs::read).
//
// Where the request goes: api.ts's apiFetch, the route of every UI call (the direct handler in ZN_CORE_DIRECT=1 mode and in the
// browser build, else BASE_URL: an external core at ZN_URL, or the in-process core's loopback server when ZN_DB is set);
// startCore() is awaited first so a starting in-process core is waited for. setFileFetcher() still overrides it (tests).
//
// Fallback (off by default): ZN_READER_SQLITE=1 resolves "key:ABCD1234" through the library database opened READ-ONLY, for
// diagnosing a core that is down. It cannot resolve relative ("attachments:...") paths.
import { existsSync } from "node:fs";
import { resolveLibrary } from "../../../core/src/library-location";
import { apiFetch, BASE_URL } from "../api";
import { startCore } from "../core";
import { PdfDoc } from "./pdf";

export type FileFetcher = (attachmentKey: string, signal?: AbortSignal) => Promise<Response>;
let fetcher: FileFetcher | undefined;
/** Override how attachment files are fetched (the in-process direct-handler mode, tests). */
export function setFileFetcher(f: FileFetcher | undefined): void { fetcher = f; }

export class PdfLoadError extends Error {}

/** Fetch an attachment's PDF bytes from the core. */
export async function fetchAttachment(key: string, signal?: AbortSignal): Promise<Uint8Array> {
	await startCore();
	let res: Response;
	try {
		res = fetcher ? await fetcher(key, signal) : await apiFetch(`/attachments/${encodeURIComponent(key)}/file`, { signal });
	} catch (e) {
		if (e instanceof PdfLoadError || (e as Error).name === "AbortError") throw e;
		throw new PdfLoadError(`cannot reach the core (${BASE_URL}): ${(e as Error).message}`);
	}
	if (!res.ok) {
		let msg = res.statusText || `HTTP ${res.status}`;
		try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
		throw new PdfLoadError(res.status === 404 ? `no file for this attachment (${msg})` : msg);
	}
	const type = res.headers.get("content-type") ?? "";
	if (type && !/pdf|octet-stream/i.test(type)) throw new PdfLoadError(`this attachment is ${type.split(";")[0]}, not a PDF`);
	return new Uint8Array(await res.arrayBuffer());
}

/** An attachment key, "key:<attachment key>", or a file path -> an open document (the caller closes it). */
export async function openPdf(spec: string, signal?: AbortSignal): Promise<PdfDoc> {
	const key = spec.startsWith("key:") ? spec.slice(4) : /^[A-Z0-9]{8}$/.test(spec) ? spec : undefined;
	if (!key) return PdfDoc.open(spec);
	if (process.env.ZN_READER_SQLITE === "1") return PdfDoc.open(sqlitePath(key));
	const bytes = await fetchAttachment(key, signal);
	if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new PdfLoadError("the file is not a PDF");
	try { return PdfDoc.openBytes(bytes); } catch (e) { throw new PdfLoadError(`cannot open the PDF: ${(e as Error).message}`); }
}

/** @deprecated kept so older callers still compile: openPdf() resolves "key:" specs through the core itself, so this is the identity. */
export const resolvePdf = (spec: string): string => spec;

// ------------------------------------------------------------------------------------------------ opt-in read-only fallback

function sqlitePath(key: string): string {
	// lazy so that bun:sqlite is only loaded when the flag is on
	const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
	const file = process.env.ZN_DB_FILE ?? process.env.ZN_DB ?? resolveLibrary({ adopt: false }).path;
	if (!file) throw new PdfLoadError("no library is configured (set ZN_DB_FILE)");
	const db = new Database(file, { readonly: true });
	try {
		const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string } | null;
		if (!row?.path) throw new PdfLoadError(`no path for attachment ${key}`);
		if (row.path.startsWith("attachments:")) throw new PdfLoadError(`attachment ${key} uses a relative path (${row.path}); the core must resolve it`);
		if (!existsSync(row.path)) throw new PdfLoadError(`file missing: ${row.path}`);
		return row.path;
	} finally { db.close(); }
}
