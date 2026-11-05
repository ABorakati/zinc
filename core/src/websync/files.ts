// Attachment files: check what zotero.org holds, download what is missing here, upload what zotero.org lacks.
// Files live in zotero-next's own storage (<db dir>/storage/<KEY>/<name>), where core/src/files resolves them.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { failure, type ZoteroWebClient } from "./client";
import { isZip, readZip, safeEntryName } from "./zip";

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
	/** <db dir>/storage */
	storageDir: string;
}

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
export function importedAttachments(db: Database): Att[] {
	const rows = db
		.query(
			`SELECT a.item_key AS key, a.link_mode, a.content_type, a.path, i.title, i.data
			 FROM attachments a JOIN items i ON i.key = a.item_key
			 WHERE a.link_mode IN ('imported_file', 'imported_url') ORDER BY a.item_key`,
		)
		.all() as { key: string; link_mode: string; content_type: string | null; path: string | null; title: string | null; data: string }[];
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

export function missingLocally(db: Database): Att[] {
	return importedAttachments(db).filter((a) => !a.path || !existsSync(a.path));
}

/** Does zotero.org hold the file? 302 (redirect to the file) means yes; the redirect itself is never followed. */
async function onServer(ctx: FilesContext, key: string): Promise<boolean | null> {
	try {
		const res = await ctx.client.request("GET", `/users/${ctx.userId}/items/${key}/file`, { redirect: "manual" });
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
	const all = importedAttachments(ctx.db);
	const imported = all.length;
	const missing = missingLocally(ctx.db);
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

async function downloadOne(ctx: FilesContext, a: Att): Promise<number> {
	const res = await ctx.client.request("GET", `/users/${ctx.userId}/items/${a.key}/file`, { redirect: "manual" });
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
	const target = join(dir, a.filename);
	const put = (file: string, data: Uint8Array) => {
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
		for (const e of entries) put(join(dir, safeEntryName(e.name) ?? e.name), e.data);
		if (!existsSync(target)) {
			const alt = entries.find((e) => decode(e.name) === a.filename);
			if (!alt) throw new Error("the snapshot archive does not contain its main file");
			put(target, alt.data);
		}
	} else {
		if (a.md5 && createHash("md5").update(bytes).digest("hex") !== a.md5.toLowerCase()) throw new Error("downloaded file does not match its checksum");
		put(target, bytes);
	}
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
	const todo = missingLocally(ctx.db);
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
	const todo = importedAttachments(db).filter((a) => a.linkMode === "imported_file" && !a.md5 && a.path && existsSync(a.path) && onServerItems.has(a.key));
	let uploaded = 0;
	let failed = 0;
	for (const a of todo) {
		try {
			const bytes = readFileSync(a.path!);
			const md5 = createHash("md5").update(bytes).digest("hex");
			const auth = await client.request("POST", `/users/${ctx.userId}/items/${a.key}/file`, {
				headers: { "Content-Type": "application/x-www-form-urlencoded", "If-None-Match": "*" },
				body: new URLSearchParams({ md5, filename: basename(a.path!), filesize: String(bytes.length), mtime: String(Math.floor(statSync(a.path!).mtimeMs)) }).toString(),
			});
			if (!auth.ok) throw await failure(auth);
			const j = (await auth.json()) as { exists?: number; url?: string; contentType?: string; prefix?: string; suffix?: string; uploadKey?: string };
			if (j.exists) {
				uploaded++;
				continue;
			}
			if (!j.url || !j.uploadKey) throw new Error("unexpected upload authorization");
			const put = await fetch(j.url, {
				method: "POST",
				headers: { "Content-Type": j.contentType ?? "application/octet-stream" },
				body: new Blob([j.prefix ?? "", bytes, j.suffix ?? ""]),
			});
			if (!put.ok) throw new Error(`file upload answered ${put.status}`);
			const reg = await client.request("POST", `/users/${ctx.userId}/items/${a.key}/file`, {
				headers: { "Content-Type": "application/x-www-form-urlencoded", "If-None-Match": "*" },
				body: new URLSearchParams({ upload: j.uploadKey }).toString(),
			});
			if (!reg.ok && reg.status !== 204) throw await failure(reg);
			uploaded++;
		} catch {
			failed++;
		}
	}
	return { uploaded, failed };
}
