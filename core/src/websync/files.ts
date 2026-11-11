// Attachment files: check what zotero.org holds, download what is missing here, upload what zotero.org lacks.
// Files live in zotero-next's own storage (<db dir>/storage/<KEY>/<name>), where core/src/files resolves them.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { failure, type ZoteroWebClient } from "./client";
import { userRef, type LibraryRef } from "./library";
import { entryTarget, isZip, readZip } from "./zip";

/** Errors a file system gives for a name it cannot store (macOS refuses unassigned Unicode code points with EILSEQ). */
export const UNSTORABLE_NAME = new Set(["EILSEQ", "ENAMETOOLONG", "EINVAL"]);

export interface FileJob {
	done: number;
	total: number;
	failed: number;
	bytes: number;
	running: boolean;
}

export interface FilesCheck {
	imported: number;
	missingLocally: number;
	/** Web snapshots (zipped on zotero.org); already included in the counts above. */
	snapshots: { imported: number; missingLocally: number; onServer: number };
	onServer: number;
	notOnServer: number;
	unknown: number;
	sample: { key: string; title: string; onServer: boolean | null }[];
}

export interface FilesContext {
	db: Database;
	client: ZoteroWebClient;
	userId: number;
	/** The library whose files are handled (default: My Library). */
	ref?: LibraryRef;
	/** <db dir>/storage */
	storageDir: string;
}

const refOf = (ctx: FilesContext): LibraryRef => ctx.ref ?? userRef(ctx.userId);

interface Att {
	key: string;
	title: string;
	path: string | null;
	filename: string;
	md5: string | null;
	linkMode: string;
	/** imported_url HTML page: zotero.org holds it as a ZIP of the page and its resources. */
	snapshot: boolean;
}

const DOWNLOAD_WORKERS = 6;

/** Characters that cannot appear in a file name on Windows; also strips any directory part. */
function safeName(name: string, fallback: string): string {
	const n = basename(name.replaceAll("\\", "/")).replace(/[<>:"|?*\x00-\x1f]/g, "_").trim();
	return n && n !== "." && n !== ".." ? n : fallback;
}

/** Imported attachments (files and web snapshots) with their expected local name. */
export function importedAttachments(db: Database, libraryId = 1): Att[] {
	const rows = db
		.query(
			`SELECT a.item_key AS key, a.link_mode, a.content_type, a.path, i.title, i.data
			 FROM attachments a JOIN items i ON i.key = a.item_key
			 WHERE a.link_mode IN ('imported_file', 'imported_url') AND i.library_id = ? ORDER BY a.item_key`,
		)
		.all(libraryId) as { key: string; link_mode: string; content_type: string | null; path: string | null; title: string | null; data: string }[];
	const out: Att[] = [];
	for (const r of rows) {
		const snapshot = r.link_mode === "imported_url" && /^(text\/html|application\/xhtml)/i.test(r.content_type ?? "");
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(r.data);
		} catch {
			// keep defaults
		}
		const filename = safeName(typeof data.filename === "string" && data.filename ? data.filename : r.path ? basename(r.path) : (r.title ?? ""), r.key);
		out.push({ key: r.key, title: r.title || r.key, path: r.path, filename, md5: typeof data.md5 === "string" && data.md5 ? data.md5 : null, linkMode: r.link_mode, snapshot });
	}
	return out;
}

export function missingLocally(db: Database, libraryId = 1): Att[] {
	return importedAttachments(db, libraryId).filter((a) => !a.path || !existsSync(a.path));
}

/** Does zotero.org hold the file? 302 (redirect to the file) means yes; the redirect itself is never followed. */
async function onServer(ctx: FilesContext, key: string): Promise<boolean | null> {
	try {
		const res = await ctx.client.request("GET", `${refOf(ctx).prefix}/items/${key}/file`, { redirect: "manual" });
		await res.body?.cancel();
		if (res.status === 302 || res.status === 301 || res.status === 303 || res.status === 307 || res.status === 200) return true;
		if (res.status === 404) return false;
		return null;
	} catch {
		return null;
	}
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

export async function checkFiles(ctx: FilesContext): Promise<FilesCheck> {
	const all = importedAttachments(ctx.db, refOf(ctx).id);
	const imported = all.length;
	const missing = missingLocally(ctx.db, refOf(ctx).id);
	const state = new Map<string, boolean | null>();
	await pool(missing, 4, async (a) => void state.set(a.key, await onServer(ctx, a.key)));
	const out: FilesCheck = {
		imported,
		missingLocally: missing.length,
		snapshots: { imported: all.filter((a) => a.snapshot).length, missingLocally: missing.filter((a) => a.snapshot).length, onServer: 0 },
		onServer: 0,
		notOnServer: 0,
		unknown: 0,
		sample: [],
	};
	for (const a of missing) {
		const s = state.get(a.key) ?? null;
		if (s === true && a.snapshot) out.snapshots.onServer++;
		if (s === true) out.onServer++;
		else if (s === false) out.notOnServer++;
		else out.unknown++;
		if (out.sample.length < 20) out.sample.push({ key: a.key, title: a.title, onServer: s });
	}
	return out;
}

/** What was last synchronised for an attachment file: its content hash and the file's mtime/size then (to skip re-hashing). */
interface FileBase {
	md5: string;
	mtime: number;
	size: number;
}

const baseName = (key: string): string => `web_file_md5:${key}`;

function getFileBase(db: Database, key: string): FileBase | null {
	const r = db.query("SELECT value FROM sync_state WHERE name = ?").get(baseName(key)) as { value: string } | null;
	if (!r) return null;
	try {
		const v = JSON.parse(r.value) as Partial<FileBase>;
		return typeof v.md5 === "string" ? { md5: v.md5, mtime: Number(v.mtime) || 0, size: Number(v.size) || 0 } : null;
	} catch {
		return null;
	}
}

function setFileBase(db: Database, key: string, path: string, md5: string): void {
	let mtime = 0;
	let size = 0;
	try {
		const st = statSync(path);
		mtime = Math.floor(st.mtimeMs);
		size = st.size;
	} catch {
		// the file vanished: the hash alone is still the baseline
	}
	db.query("INSERT INTO sync_state(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(
		baseName(key),
		JSON.stringify({ md5: md5.toLowerCase(), mtime, size }),
	);
}

/** @param conflictCopy write the server's file here instead of over the attachment's file (a divergence is never overwritten) */
async function downloadOne(ctx: FilesContext, a: Att, conflictCopy?: string): Promise<number> {
	const res = await ctx.client.request("GET", `${refOf(ctx).prefix}/items/${a.key}/file`, { redirect: "manual" });
	let bytes: Uint8Array;
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get("location");
		await res.body?.cancel();
		if (!loc) throw new Error("redirect without a location");
		// the file host is not zotero.org's API: it never receives the API key
		const file = await fetch(new URL(loc, ctx.client.base));
		if (!file.ok) throw new Error(`file download answered ${file.status}`);
		bytes = new Uint8Array(await file.arrayBuffer());
	} else if (res.ok) {
		bytes = new Uint8Array(await res.arrayBuffer());
	} else {
		throw await failure(res);
	}
	const dir = join(ctx.storageDir, a.key);
	const target = conflictCopy ?? join(dir, a.filename);
	const put = (file: string, data: Uint8Array) => {
		// (a .part file is written and renamed, so a failed write leaves no half file under the real name)
		mkdirSync(dirname(file), { recursive: true });
		const part = `${file}.part`;
		writeFileSync(part, data);
		renameSync(part, file);
	};
	if (a.snapshot && isZip(bytes)) {
		// zotero.org stores a snapshot as a ZIP of the page and its resources. Zotero's item md5 describes the
		// snapshot's main file, not the archive, so the zip is not checked against it: a complete, readable
		// archive that contains the main file is the integrity test.
		const entries = readZip(bytes).filter((e) => !e.name.startsWith(".zotero-"));
		const decode = (n: string) => {
			try {
				return decodeURIComponent(n);
			} catch {
				return n;
			}
		};
		// zip entry names may be percent-encoded; the item's filename is the decoded form
		for (const e of entries) {
			const file = entryTarget(dir, e.name); // null = the name would leave the attachment's folder
			if (!file) continue;
			try {
				put(file, e.data);
			} catch (err) {
				// a page resource whose name this file system refuses (macOS: a code point Unicode has not assigned yet, EILSEQ; an
				// over-long name) is left out instead of failing the whole snapshot; the main file is still required below
				if (!UNSTORABLE_NAME.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
			}
		}
		if (!existsSync(target)) {
			const alt = entries.find((e) => decode(e.name) === a.filename);
			if (!alt) throw new Error("the snapshot archive does not contain its main file");
			put(target, alt.data);
		}
	} else {
		if (a.md5 && createHash("md5").update(bytes).digest("hex") !== a.md5.toLowerCase()) throw new Error("downloaded file does not match its checksum");
		put(target, bytes);
		if (!conflictCopy && !a.snapshot) setFileBase(ctx.db, a.key, target, createHash("md5").update(bytes).digest("hex"));
	}
	if (conflictCopy) return bytes.length;
	// the attachment row is part of the item for sync: this local fact must not queue a push
	ctx.db.transaction(() => {
		ctx.db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			ctx.db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(target, a.key);
		} finally {
			ctx.db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	return bytes.length;
}

/** Download every imported attachment whose file is missing locally. `job` is updated as it goes. */
export async function downloadMissing(ctx: FilesContext, job: FileJob): Promise<void> {
	const todo = missingLocally(ctx.db, refOf(ctx).id);
	job.total = todo.length;
	job.done = 0;
	job.failed = 0;
	job.bytes = 0;
	job.running = true;
	try {
		await pool(todo, DOWNLOAD_WORKERS, async (a) => {
			try {
				job.bytes += await downloadOne(ctx, a);
				job.done++;
			} catch {
				job.failed++; // not on the server, offline, bad checksum: the check report says which
				rmSync(`${join(ctx.storageDir, a.key, a.filename)}.part`, { force: true });
			}
		});
	} finally {
		job.running = false;
	}
}

/**
 * Upload local files the server does not have yet (md5/mtime authorization flow). Only attachments whose server
 * item has no checksum: a file that differs from the server's is never overwritten.
 */
export async function uploadMissing(ctx: FilesContext): Promise<{ uploaded: number; failed: number }> {
	const { db, client } = ctx;
	const known = db.query("SELECT key FROM websync_versions WHERE type = 'item'").all() as { key: string }[];
	const onServerItems = new Set(known.map((k) => k.key));
	const todo = importedAttachments(db, refOf(ctx).id).filter((a) => a.linkMode === "imported_file" && !a.md5 && a.path && existsSync(a.path) && onServerItems.has(a.key));
	let uploaded = 0;
	let failed = 0;
	for (const a of todo) {
		try {
			await uploadFile(ctx, a, null);
			uploaded++;
		} catch {
			failed++;
		}
	}
	return { uploaded, failed };
}

/**
 * Upload a.path. `replaces` is the md5 the server holds now (a changed file: If-Match makes the server refuse when someone
 * replaced it meanwhile); null for a file the server has none of (If-None-Match: *).
 */
async function uploadFile(ctx: FilesContext, a: Att, replaces: string | null): Promise<void> {
	const { db, client } = ctx;
	const bytes = readFileSync(a.path!);
	const md5 = createHash("md5").update(bytes).digest("hex");
	const mtime = Math.floor(statSync(a.path!).mtimeMs);
	const cond: Record<string, string> = replaces ? { "If-Match": replaces } : { "If-None-Match": "*" };
	const auth = await client.request("POST", `${refOf(ctx).prefix}/items/${a.key}/file`, {
		headers: { "Content-Type": "application/x-www-form-urlencoded", ...cond },
		body: new URLSearchParams({ md5, filename: basename(a.path!), filesize: String(bytes.length), mtime: String(mtime) }).toString(),
	});
	if (!auth.ok) throw await failure(auth);
	const j = (await auth.json()) as { exists?: number; url?: string; contentType?: string; prefix?: string; suffix?: string; uploadKey?: string };
	if (!j.exists) {
		if (!j.url || !j.uploadKey) throw new Error("unexpected upload authorization");
		const put = await fetch(j.url, {
			method: "POST",
			headers: { "Content-Type": j.contentType ?? "application/octet-stream" },
			body: new Blob([j.prefix ?? "", bytes, j.suffix ?? ""]),
		});
		if (!put.ok) throw new Error(`file upload answered ${put.status}`);
		const reg = await client.request("POST", `${refOf(ctx).prefix}/items/${a.key}/file`, {
			headers: { "Content-Type": "application/x-www-form-urlencoded", ...cond },
			body: new URLSearchParams({ upload: j.uploadKey }).toString(),
		});
		if (!reg.ok && reg.status !== 204) throw await failure(reg);
	}
	// Remember what is on the server now, here and in the item's metadata (until the next pull brings the server's own copy of
	// the metadata): a later comparison must not take our own upload for a remote replacement.
	setFileBase(db, a.key, a.path!, md5);
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			db.query("UPDATE items SET data = json_set(data, '$.md5', ?, '$.mtime', ?) WHERE key = ?").run(md5, mtime, a.key);
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
}

export interface ReconcileResult {
	/** Local file unchanged, server's replaced: the server's file now replaces the local one. */
	downloaded: number;
	/** Local file changed, server's unchanged: uploaded. */
	uploaded: number;
	/** Both changed (or no common baseline and they differ): nothing overwritten; recorded in sync_conflicts. */
	conflicts: number;
	failed: number;
}

function conflictOnce(db: Database, key: string, localMd5: string, remoteMd5: string, extra: Record<string, unknown>): boolean {
	const dup = db.query("SELECT 1 FROM sync_conflicts WHERE type = 'item' AND key = ? AND remote LIKE ? LIMIT 1").get(key, `%"fileMd5":"${remoteMd5}"%`);
	if (dup) return false;
	db.query("INSERT INTO sync_conflicts(type, key, local, remote, resolved) VALUES('item', ?, ?, ?, 'local')").run(
		key,
		JSON.stringify({ title: "attachment file", fileMd5: localMd5 }),
		JSON.stringify({ title: "attachment file", fileMd5: remoteMd5, ...extra }),
	);
	return true;
}

/**
 * Attachments that already have a local file and a server checksum: compare both with the hash that was last synchronised.
 * Only the server changed: take its file. Only the local file changed: upload it (when allowed), guarded by If-Match. Both
 * changed, or no baseline and they differ: keep the local file, save the server's beside it as <name>.conflict-<md5>, and
 * record a conflict. Nothing is overwritten without a known-unchanged baseline.
 */
export async function reconcileFiles(ctx: FilesContext, opts: { upload: boolean }): Promise<ReconcileResult> {
	const { db } = ctx;
	const out: ReconcileResult = { downloaded: 0, uploaded: 0, conflicts: 0, failed: 0 };
	const todo = importedAttachments(db, refOf(ctx).id).filter((a) => a.linkMode === "imported_file" && a.md5 && a.path && existsSync(a.path));
	for (const a of todo) {
		try {
			const path = a.path!;
			const remote = a.md5!.toLowerCase();
			const base = getFileBase(db, a.key);
			const st = statSync(path);
			let local: string;
			if (base && base.mtime === Math.floor(st.mtimeMs) && base.size === st.size) local = base.md5;
			else {
				local = createHash("md5").update(readFileSync(path)).digest("hex");
				if (base && local === base.md5) setFileBase(db, a.key, path, local); // touched, not changed
			}
			if (local === remote) {
				if (!base || base.md5 !== local) setFileBase(db, a.key, path, local);
				continue;
			}
			if (!base) {
				// never synchronised since this feature: nobody can say which side changed
				if (conflictOnce(db, a.key, local, remote, { note: "the file here differs from the one on zotero.org; neither was replaced" })) out.conflicts++;
				continue;
			}
			const localChanged = local !== base.md5;
			const remoteChanged = remote !== base.md5;
			if (remoteChanged && !localChanged) {
				await downloadOne(ctx, a); // verifies the checksum, replaces atomically, moves the baseline
				out.downloaded++;
			} else if (localChanged && !remoteChanged) {
				if (!opts.upload) continue;
				await uploadFile(ctx, a, remote);
				out.uploaded++;
			} else {
				const ext = extname(path);
				const copy = join(dirname(path), `${basename(path, ext)}.conflict-${remote.slice(0, 8)}${ext}`);
				if (!existsSync(copy)) await downloadOne(ctx, a, copy);
				if (conflictOnce(db, a.key, local, remote, { conflictCopy: copy })) out.conflicts++;
			}
		} catch {
			out.failed++;
			rmSync(`${join(ctx.storageDir, a.key, a.filename)}.part`, { force: true });
		}
	}
	return out;
}
