// PUT /api/attachments/:key/file: replace an attachment's PDF with new bytes (the reader's Rotate / Delete Pages, as Zotero does
// them: the edited document is written over the original file). The body is JSON {dataBase64: <the whole new file>}, like
// POST /api/add/file (the API's request guard only takes JSON for requests that change something).
//
// Atomic: the bytes go to a temporary file in the SAME folder (so the rename never crosses volumes), are flushed to disk, and the
// temporary file is then renamed over the original (MoveFileEx with replace on Windows), so a reader of the file sees either the
// old or the new document, never half of one. If the rename fails (the file is open in another program that locks it), the
// temporary file is removed and the original is left as it was.
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as repo from "../db";
import { HttpError } from "../db";

export async function replaceAttachmentFile(db: Database, key: string, req: Request): Promise<{ ok: true; size: number }> {
	const att = repo.getAttachment(db, key);
	if (!att) throw new HttpError(404, "attachment not found");
	if (!att.path) throw new HttpError(404, "file not found on disk");
	const type = (att.content_type || "").toLowerCase();
	if (type && type !== "application/pdf") throw new HttpError(415, `only PDF attachments can be replaced (this one is ${type})`);
	const st = (() => { try { return statSync(att.path!); } catch { return null; } })();
	if (!st?.isFile()) throw new HttpError(404, "file not found on disk");
	let parsed: unknown;
	try { parsed = await req.json(); } catch { throw new HttpError(400, "the body must be JSON {dataBase64}"); }
	const b64 = (parsed as { dataBase64?: unknown } | null)?.dataBase64;
	if (typeof b64 !== "string" || !b64) throw new HttpError(400, "dataBase64 (the new file) is required");
	const body = new Uint8Array(Buffer.from(b64, "base64"));
	if (body.byteLength < 8 || String.fromCharCode(...body.subarray(0, 5)) !== "%PDF-") throw new HttpError(400, "the body is not a PDF");

	const dir = dirname(att.path);
	const tmp = join(dir, `.${basename(att.path)}.${process.pid}.${Date.now().toString(36)}.zn-tmp`);
	let fd = -1;
	try {
		fd = openSync(tmp, "wx");
		let off = 0;
		while (off < body.byteLength) off += writeSync(fd, body, off, body.byteLength - off);
		fsyncSync(fd);
		closeSync(fd);
		fd = -1;
		renameSync(tmp, att.path);
	} catch (e) {
		if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
		try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
			throw new HttpError(409, `the file could not be replaced: it is in use or read-only (${code}). Close it in other programs and try again.`);
		}
		throw new HttpError(500, `the file could not be replaced: ${e instanceof Error ? e.message : String(e)}`);
	}
	return { ok: true, size: body.byteLength };
}
