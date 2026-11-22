// PUT /api/attachments/:key/file: replace an attachment's PDF with new bytes (the reader's Rotate / Delete Pages, as Zotero does
// them: the edited document is written over the original file). The body is JSON {dataBase64: <the whole new file>}, like
// POST /api/add/file (the API's request guard only takes JSON for requests that change something).
//
// Delete Pages sends {dataBase64, deletedPages: [0-based page indexes of the OLD document]}: the annotations then follow
// their pages in the SAME database transaction as the file swap (files/pageops.ts). The original is copied to a
// "<name>.zn-bak-*" file first; if anything fails after the swap the original is put back and the annotations roll back, and
// the copy is removed only once both have succeeded (after a crash in between, that copy is the original).
//
// Atomic: the bytes go to a temporary file in the SAME folder (so the rename never crosses volumes), are flushed to disk, and the
// temporary file is then renamed over the original (MoveFileEx with replace on Windows), so a reader of the file sees either the
// old or the new document, never half of one. If the rename fails (the file is open in another program that locks it), the
// temporary file is removed and the original is left as it was.
import type { Database } from "bun:sqlite";
import { closeSync, copyFileSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as repo from "../db";
import { HttpError } from "../db";
import { assertItemFilesWritable } from "../libraries";
import { shiftAnnotations } from "./pageops";

export async function replaceAttachmentFile(db: Database, key: string, req: Request): Promise<{ ok: true; size: number }> {
	const att = repo.getAttachment(db, key);
	if (!att) throw new HttpError(404, "attachment not found");
	assertItemFilesWritable(db, key); // a read-only group, or one that forbids file changes, keeps its PDFs as they are
	if (!att.path) throw new HttpError(404, "file not found on disk");
	const type = (att.content_type || "").toLowerCase();
	if (type && type !== "application/pdf") throw new HttpError(415, `only PDF attachments can be replaced (this one is ${type})`);
	const st = (() => {
		try {
			return statSync(att.path!);
		} catch {
			return null;
		}
	})();
	if (!st?.isFile()) throw new HttpError(404, "file not found on disk");
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		throw new HttpError(400, "the body must be JSON {dataBase64}");
	}
	const b64 = (parsed as { dataBase64?: unknown } | null)?.dataBase64;
	const rawDeleted = (parsed as { deletedPages?: unknown } | null)?.deletedPages;
	if (rawDeleted !== undefined && (!Array.isArray(rawDeleted) || rawDeleted.some((p) => !Number.isInteger(p) || p < 0))) {
		throw new HttpError(400, "deletedPages must be an array of 0-based page indexes");
	}
	const deletedPages = (rawDeleted as number[] | undefined) ?? [];
	if (typeof b64 !== "string" || !b64) throw new HttpError(400, "dataBase64 (the new file) is required");
	const body = new Uint8Array(Buffer.from(b64, "base64"));
	if (body.byteLength < 8 || String.fromCharCode(...body.subarray(0, 5)) !== "%PDF-") throw new HttpError(400, "the body is not a PDF");

	const dir = dirname(att.path);
	const tmp = join(dir, `.${basename(att.path)}.${process.pid}.${Date.now().toString(36)}.zn-tmp`);
	const shift = deletedPages.length ? shiftAnnotations(repo.getAnnotations(db, key), deletedPages) : { changed: [], removed: [] };
	const withAnnotations = shift.changed.length > 0 || shift.removed.length > 0;
	let backup: string | null = null;
	let swapped = false;
	let fd = -1;
	try {
		fd = openSync(tmp, "wx");
		let off = 0;
		while (off < body.byteLength) off += writeSync(fd, body, off, body.byteLength - off);
		fsyncSync(fd);
		closeSync(fd);
		fd = -1;
		if (!withAnnotations) renameSync(tmp, att.path);
		else {
			const path = att.path;
			backup = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.zn-bak`);
			copyFileSync(path, backup);
			db.transaction(() => {
				if (shift.changed.length) repo.upsertAnnotations(db, key, shift.changed);
				if (shift.removed.length) repo.deleteAnnotations(db, key, shift.removed);
				// last step before the commit: if the swap fails the annotation changes roll back with it
				renameSync(tmp, path);
				swapped = true;
			})();
			// committed: the new file and the annotation changes are final, so nothing below may put the original back
			swapped = false;
			try {
				rmSync(backup, { force: true });
			} catch {
				/* the copy stays next to the file (a hidden dotfile); the replacement itself succeeded */
			}
			backup = null;
		}
	} catch (e) {
		if (swapped && backup) {
			// the database refused after the file was swapped: the annotations rolled back, so the original goes back
			try {
				renameSync(backup, att.path);
				backup = null;
			} catch {
				/* the copy stays next to the file */
			}
		}
		if (backup && !swapped) {
			try {
				rmSync(backup, { force: true });
			} catch {
				/* ignore */
			}
		}
		if (fd >= 0)
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
			throw new HttpError(
				409,
				`the file could not be replaced: it is in use or read-only (${code}). Close it in other programs and try again.`,
			);
		}
		throw new HttpError(500, `the file could not be replaced: ${e instanceof Error ? e.message : String(e)}`);
	}
	return { ok: true, size: body.byteLength };
}
