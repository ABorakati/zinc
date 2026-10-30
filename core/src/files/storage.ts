// Attachment storage location (ZotMoov style) and moving existing attachments there.
//
// Default: imported files live in zotero-next's own <db folder>/storage/<KEY>/<name> (the layout Zotero uses).
// Custom: files go to <folder>/<subfolder pattern>/<name>, e.g. "{%a}/{%y}", either as linked files (default, like
// ZotMoov) or as imported files.
//
// For a feature that stores a new file (core/src/additems/files.ts addFile), call storageTargetFor():
//     const t = storageTargetFor(db, { key, name, parentKey: req.parentKey });
//     mode = t.mode; dir = t.dir; stored = t.path;     // then create dir, copy/write the bytes, insert the rows as usual
import type { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { nowIso } from "../db";
import { isInside } from "../maintenance/erase";
import { readConfig, updateConfig, type StorageConfig } from "./config";
import { ownStorageDir, resolveStoredPath, storedFormForNewLink } from "./paths";

// ---------------------------------------------------------------- settings

export const PATTERN_HELP = "{%a} first author, {%y} year, {%t} title, {%j} publication, {%T} item type, {%F} first letter of author";
const TOKENS = new Set(["a", "y", "t", "j", "T", "F"]);

/** null when the pattern is acceptable, else why not. */
export function validatePattern(p: string): string | null {
	if (p.length > 200) return "the pattern is too long";
	for (const m of p.matchAll(/\{%([^}]*)\}/g)) if (!TOKENS.has(m[1])) return `unknown placeholder {%${m[1]}}. Available: ${PATTERN_HELP}`;
	if (/\{%[^}]*$/.test(p)) return "unfinished placeholder";
	if (/^(?:[a-zA-Z]:|[\\/])/.test(p.trim())) return "the pattern must be relative to the storage folder";
	return null;
}

export interface StorageView {
	/** Custom folder, or null for zotero-next's own storage. */
	dir: string | null;
	subfolder: string;
	linked: boolean;
	ownDir: string | null;
	patternHelp: string;
}

export function storageView(db: Database): StorageView {
	const s = readConfig(db).storage ?? {};
	return { dir: s.dir || null, subfolder: s.subfolder ?? "", linked: s.linked ?? true, ownDir: ownStorageDir(db), patternHelp: PATTERN_HELP };
}

export function setStorage(db: Database, patch: { dir?: string | null; subfolder?: string; linked?: boolean }): StorageView {
	const cur: StorageConfig = { ...(readConfig(db).storage ?? {}) };
	if (patch.dir !== undefined) {
		if (patch.dir === null || patch.dir === "") delete cur.dir;
		else {
			const d = resolve(patch.dir);
			if (existsSync(d) && !statSync(d).isDirectory()) throw new Error("that path is a file, not a folder");
			cur.dir = d;
		}
	}
	if (patch.subfolder !== undefined) {
		const bad = validatePattern(patch.subfolder);
		if (bad) throw new Error(bad);
		cur.subfolder = patch.subfolder.trim();
	}
	if (patch.linked !== undefined) cur.linked = !!patch.linked;
	updateConfig(db, { storage: cur });
	return storageView(db);
}

// ---------------------------------------------------------------- patterns

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function cleanSegment(s: string, max = 80): string {
	let out = s
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	if (out.length > max) out = out.slice(0, max).trim().replace(/[.\s]+$/, "");
	if (RESERVED.test(out)) out = `_${out}`;
	return out;
}

export interface PatternMeta {
	author: string;
	year: string;
	title: string;
	publication: string;
	itemType: string;
}

export function metaOfItem(db: Database, itemKey: string | null | undefined): PatternMeta {
	const blank: PatternMeta = { author: "", year: "", title: "", publication: "", itemType: "" };
	if (!itemKey) return blank;
	const row = db.query("SELECT item_type, title, year, publication, data FROM items WHERE key = ?").get(itemKey) as
		| { item_type: string; title: string | null; year: number | null; publication: string | null; data: string }
		| null;
	if (!row) return blank;
	let author = "";
	try {
		const creators = (JSON.parse(row.data).creators ?? []) as { creatorType?: string; lastName?: string; name?: string; firstName?: string }[];
		const c = creators.find((x) => x.creatorType === "author") ?? creators[0];
		author = (c?.lastName || c?.name || c?.firstName || "").trim();
	} catch {
		// no creators
	}
	return { author, year: row.year ? String(row.year) : "", title: row.title ?? "", publication: row.publication ?? "", itemType: row.item_type };
}

/** Folder names for a pattern such as "{%a}/{%y}" (empty values become Unknown author / n.d. / Untitled ...). */
export function expandPattern(pattern: string, meta: PatternMeta): string[] {
	const value = (t: string): string => {
		switch (t) {
			case "a": return meta.author || "Unknown author";
			case "y": return meta.year || "undated"; // not "n.d.": Windows folder names cannot end with a dot
			case "t": return meta.title || "Untitled";
			case "j": return meta.publication || "No publication";
			case "T": return meta.itemType || "item";
			case "F": return (meta.author || "?").charAt(0).toUpperCase();
			default: return "";
		}
	};
	const out: string[] = [];
	for (const seg of pattern.split(/[\\/]+/)) {
		const s = cleanSegment(seg.replace(/\{%(.)\}/g, (_m, t: string) => value(t)));
		if (s) out.push(s);
	}
	return out;
}

// ---------------------------------------------------------------- where a new file goes

export interface StorageTarget {
	mode: "imported_file" | "linked_file";
	/** Folder to create and put the file in. */
	dir: string;
	/** Full path of the file to write (the name is made unique inside `dir`). */
	path: string;
	custom: boolean;
}

/** Unique file name in dir: "name.pdf", "name (2).pdf", ... (`taken` holds names reserved by a plan). */
export function uniqueName(dir: string, name: string, taken?: Set<string>): string {
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	let n = name;
	for (let i = 2; (existsSync(join(dir, n)) || taken?.has(join(dir, n).toLowerCase())) && i < 1000; i++) n = `${stem} (${i})${ext}`;
	return n;
}

export function storageTargetFor(db: Database, req: { key: string; name: string; parentKey?: string | null }): StorageTarget {
	const s = storageView(db);
	const name = cleanSegment(req.name, 150) || "file";
	if (!s.dir) {
		const dir = join(ownStorageDir(db) ?? join(process.env.TEMP ?? ".", "zotero-next-storage"), req.key);
		return { mode: "imported_file", dir, path: join(dir, name), custom: false };
	}
	const dir = join(s.dir, ...expandPattern(s.subfolder, metaOfItem(db, req.parentKey)));
	if (resolve(dir) !== resolve(s.dir) && !isInside(dir, s.dir)) throw new Error("the subfolder pattern leaves the storage folder");
	return { mode: s.linked ? "linked_file" : "imported_file", dir, path: join(dir, uniqueName(dir, name)), custom: true };
}

// ---------------------------------------------------------------- online-only (OneDrive) placeholders

const ATTR_OFFLINE = 0x1000;
const ATTR_RECALL_ON_OPEN = 0x40000;
const ATTR_RECALL_ON_DATA_ACCESS = 0x400000;

let getAttrs: ((p: Buffer) => number) | undefined;
function windowsAttributes(path: string): number {
	try {
		if (!getAttrs) {
			const lib = dlopen("kernel32.dll", { GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 } });
			getAttrs = (p) => lib.symbols.GetFileAttributesW(p) as number;
		}
		const r = getAttrs(Buffer.from(`${path}\0`, "utf16le"));
		return r === 0xffffffff ? 0 : r; // INVALID_FILE_ATTRIBUTES
	} catch {
		return 0;
	}
}

let attributeProbe: (path: string) => number = (p) => (process.platform === "win32" ? windowsAttributes(p) : 0);
/** Tests: replace the Windows file-attribute probe. Call with no argument to restore it. */
export function setAttributeProbe(fn?: (path: string) => number): void {
	attributeProbe = fn ?? ((p) => (process.platform === "win32" ? windowsAttributes(p) : 0));
}

/** True for a cloud placeholder whose content is not on this disk (reading it would make OneDrive download it). */
export function isOnlineOnly(path: string): boolean {
	return (attributeProbe(path) & (ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA_ACCESS)) !== 0;
}

// ---------------------------------------------------------------- moving existing attachments

export interface MoveItem {
	key: string;
	kind: "imported" | "linked";
	from: string;
	to: string;
	size: number;
	/** An imported file in zotero-next's storage becomes a linked file at its new place. */
	becomesLinked: boolean;
}

export interface MoveSkip {
	key: string;
	path: string;
	reason: string;
	onlineOnly?: boolean;
}

export interface MovePlan {
	target: { dir: string; subfolder: string; linked: boolean };
	items: MoveItem[];
	count: number;
	totalBytes: number;
	skipped: MoveSkip[];
	/** Online-only OneDrive files that were left alone. */
	onlineOnly: number;
	sample: { key: string; from: string; to: string }[];
}

export function planMove(db: Database, sampleSize = 10): MovePlan {
	const s = storageView(db);
	if (!s.dir) throw new Error("choose an attachment storage folder first");
	const own = s.ownDir;
	const rows = db
		.query(
			`SELECT a.item_key AS key, a.link_mode, a.path, i.parent_key
			 FROM attachments a JOIN items i ON i.key = a.item_key
			 WHERE i.deleted = 0 AND a.link_mode IN ('imported_file', 'linked_file') AND a.path IS NOT NULL
			 ORDER BY i.date_added, i.key`,
		)
		.all() as { key: string; link_mode: string; path: string; parent_key: string | null }[];
	const plan: MovePlan = {
		target: { dir: s.dir, subfolder: s.subfolder, linked: s.linked },
		items: [],
		count: 0,
		totalBytes: 0,
		skipped: [],
		onlineOnly: 0,
		sample: [],
	};
	const taken = new Set<string>();
	for (const r of rows) {
		const from = resolveStoredPath(db, r.path);
		const skip = (reason: string, onlineOnly = false) => void plan.skipped.push({ key: r.key, path: from ?? r.path, reason, onlineOnly });
		if (!from) {
			skip("the base directory for this relative path is not set");
			continue;
		}
		if (!existsSync(from)) {
			skip("file is missing");
			continue;
		}
		const imported = r.link_mode === "imported_file";
		if (imported && !(own && isInside(from, own))) {
			skip("stored in Zotero's own folder; zotero-next leaves it where Zotero keeps it");
			continue;
		}
		if (!r.parent_key) {
			skip("standalone attachment has no parent item to name a folder from");
			continue;
		}
		if (isOnlineOnly(from)) {
			plan.onlineOnly++;
			skip("online-only OneDrive file (not downloaded)", true);
			continue;
		}
		const dir = join(s.dir, ...expandPattern(s.subfolder, metaOfItem(db, r.parent_key)));
		const name = basename(from);
		if (resolve(dirname(from)).toLowerCase() === resolve(dir).toLowerCase()) {
			skip("already in the right folder");
			continue;
		}
		// a file already at the destination with other content gets a numbered name (identical content is reused at run time)
		const to = join(dir, uniqueNameForPlan(dir, name, taken, from));
		taken.add(to.toLowerCase());
		let size = 0;
		try {
			size = statSync(from).size;
		} catch {
			// size stays 0
		}
		plan.items.push({ key: r.key, kind: imported ? "imported" : "linked", from, to, size, becomesLinked: imported && s.linked });
		plan.totalBytes += size;
	}
	plan.count = plan.items.length;
	plan.sample = plan.items.slice(0, sampleSize).map((i) => ({ key: i.key, from: i.from, to: i.to }));
	return plan;
}

function uniqueNameForPlan(dir: string, name: string, taken: Set<string>, from: string): string {
	const first = join(dir, name);
	if (!existsSync(first) && !taken.has(first.toLowerCase())) return name;
	// same size at the destination: probably an earlier, interrupted run of this very move; run() compares content
	try {
		if (existsSync(first) && !taken.has(first.toLowerCase()) && statSync(first).size === statSync(from).size) return name;
	} catch {
		// fall through
	}
	return uniqueName(dir, name, taken);
}

export interface MoveHooks {
	/** After the copy was verified, before the database is touched (tests inject failures). */
	afterCopy?: (item: MoveItem) => void | Promise<void>;
	/** Inside the database transaction, before it commits (tests inject failures). */
	beforeCommit?: (item: MoveItem) => void;
	onProgress?: (done: number, total: number) => void;
}

export interface MoveReport {
	moved: number;
	failed: { key: string; from: string; error: string }[];
	/** Originals that could not be deleted after the database was updated (harmless duplicates). */
	leftBehind: { key: string; path: string; error: string }[];
	skipped: MoveSkip[];
	onlineOnly: number;
	bytes: number;
}

function sha256(path: string): Promise<string> {
	return new Promise((res, rej) => {
		const h = createHash("sha256");
		createReadStream(path)
			.on("data", (c) => h.update(c))
			.on("error", rej)
			.on("end", () => res(h.digest("hex")));
	});
}

const running = new WeakSet<Database>();

/**
 * Move the planned files. Per file: copy to a temporary name, verify size and SHA-256, rename into place, update the
 * database in one transaction, and only then delete the original. A failure at any step leaves the original and the
 * database exactly as they were; re-running continues where an interrupted run stopped (a finished copy is reused).
 */
export async function runMove(db: Database, plan: MovePlan = planMove(db), hooks: MoveHooks = {}): Promise<MoveReport> {
	if (running.has(db)) throw new Error("a move is already running");
	running.add(db);
	const report: MoveReport = { moved: 0, failed: [], leftBehind: [], skipped: plan.skipped, onlineOnly: plan.onlineOnly, bytes: 0 };
	const own = ownStorageDir(db);
	try {
		let done = 0;
		for (const item of plan.items) {
			done++;
			hooks.onProgress?.(done, plan.items.length);
			let created: string | null = null; // the destination file this run created (removed again if the database step fails)
			try {
				if (!existsSync(item.from)) throw new Error("file is missing");
				if (isOnlineOnly(item.from)) {
					report.onlineOnly++;
					report.skipped.push({ key: item.key, path: item.from, reason: "online-only OneDrive file (not downloaded)", onlineOnly: true });
					continue;
				}
				let to = item.to;
				mkdirSync(dirname(to), { recursive: true });
				const srcHash = await sha256(item.from);
				if (existsSync(to)) {
					if (statSync(to).size !== statSync(item.from).size || (await sha256(to)) !== srcHash) {
						to = join(dirname(to), uniqueName(dirname(to), basename(to)));
					}
				}
				if (!existsSync(to)) {
					const tmp = `${to}.zn-part`;
					rmSync(tmp, { force: true });
					await copyFile(item.from, tmp);
					if (statSync(tmp).size !== statSync(item.from).size || (await sha256(tmp)) !== srcHash) {
						rmSync(tmp, { force: true });
						throw new Error("the copy did not match the original");
					}
					await rename(tmp, to);
					created = to;
				}
				await hooks.afterCopy?.(item);
				commitMove(db, item, to, hooks);
				report.moved++;
				report.bytes += item.size;
				// the database now points at the copy: the original can go
				try {
					rmSync(item.from, { force: true });
					const dir = dirname(item.from);
					if (own && isInside(dir, own)) removeIfEmpty(dir);
				} catch (e) {
					report.leftBehind.push({ key: item.key, path: item.from, error: e instanceof Error ? e.message : String(e) });
				}
			} catch (e) {
				if (created) rmSync(created, { force: true });
				rmSync(`${item.to}.zn-part`, { force: true });
				report.failed.push({ key: item.key, from: item.from, error: e instanceof Error ? e.message : String(e) });
			}
		}
	} finally {
		running.delete(db);
	}
	return report;
}

function removeIfEmpty(dir: string): void {
	try {
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// not empty or already gone
	}
}

function commitMove(db: Database, item: MoveItem, to: string, hooks: MoveHooks): void {
	const row = db.query("SELECT data FROM items WHERE key = ?").get(item.key) as { data: string } | null;
	if (!row) throw new Error("the attachment was removed while moving");
	const data = JSON.parse(row.data) as Record<string, unknown>;
	const now = nowIso();
	const linked = item.kind === "linked" || item.becomesLinked;
	data.filename = basename(to);
	if (linked) {
		data.linkMode = "linked_file";
		data.path = to; // sync hands Zotero the absolute path; its writer relativises against Zotero's base directory
	}
	data.dateModified = now;
	const stored = linked ? storedFormForNewLink(db, to) : to;
	db.transaction(() => {
		db.query("UPDATE attachments SET path = ?, link_mode = ? WHERE item_key = ?").run(stored, linked ? "linked_file" : "imported_file", item.key);
		db.query("UPDATE items SET data = ?, date_modified = ? WHERE key = ?").run(JSON.stringify(data), now, item.key);
		hooks.beforeCommit?.(item);
	})();
}
