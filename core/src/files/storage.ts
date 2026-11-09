// Attachment storage location (ZotMoov style) and moving existing attachments there.
//
// Default: imported files live in zotero-next's own <db folder>/storage/<KEY>/<name> (the layout Zotero uses).
// Custom: files go to <folder>/<subfolder pattern>/<name>, e.g. "{%a}/{%y}", either as linked files (default, like
// ZotMoov) or as imported files. Further ZotMoov behaviour (see StorageView): automatic or manual only, move or copy,
// allowed file types, rename from the parent item, tag, delete files with the item. organize.ts holds the commands built
// on this (move / copy / convert, attach the newest file); pattern.ts the wildcard language.
//
// For a feature that stores a new file (core/src/additems/files.ts addFile), call storageTargetFor():
//     const t = storageTargetFor(db, { key, name, parentKey: req.parentKey });
//     mode = t.mode; dir = t.dir; stored = t.path;     // then create dir, copy/write the bytes, insert the rows as usual
import type { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { addTags, deriveColumns, nowIso, removeTags } from "../db";
import { isInside } from "../maintenance/erase";
import { baseNameFor } from "../maintenance/rename-files";
import { indexItem } from "../search";
import { pruneEmptyDirs } from "./cleanup";
import { readConfig, updateConfig, type StorageConfig } from "./config";
import { assertFilesWritable, USER_LIBRARY } from "../libraries";
import { ownStorageDir, resolveStoredPath, storedFormForNewLink } from "./paths";
import { cleanSegment, expandPattern, metaOfItem, PATTERN_HELP, stripAccents, validatePattern, type PatternMeta } from "./pattern";

export { PATTERN_HELP, expandPattern, metaOfItem, validatePattern };
export type { PatternMeta };

// ---------------------------------------------------------------- settings

export interface StorageView {
	/** Custom folder, or null for zotero-next's own storage. */
	dir: string | null;
	subfolder: string;
	linked: boolean;
	ownDir: string | null;
	patternHelp: string;
	/** New files are placed in `dir` by themselves (default true). */
	auto: boolean;
	/** move: the file lives in `dir`; copy: it stays in zotero-next's storage and a copy is placed in `dir`. */
	behavior: "move" | "copy";
	/** Extensions handled (lower case, no dot); empty: every file type. */
	allowedExt: string[];
	rename: boolean;
	renameTitle: boolean;
	addTag: boolean;
	tag: string;
	stripDiacritics: boolean;
	undefinedStr: string;
	deleteFiles: boolean;
	pruneEmptyDirs: boolean;
	attachDir: string | null;
	attachConfirm: boolean;
	/** Folders worth offering in Settings (not checked on disk): the "Zotero Library" folder of the user's OneDrive. */
	suggestions: string[];
}

export const ZOTMOOV_EXTENSIONS = ["pdf", "epub", "docx", "djvu"];

function suggestedFolders(): string[] {
	const out = new Set<string>();
	for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
		const v = process.env[k];
		if (v) out.add(join(v, "Zotero Library"));
	}
	return [...out];
}

export function storageView(db: Database): StorageView {
	const s = readConfig(db).storage ?? {};
	return {
		dir: s.dir || null,
		subfolder: s.subfolder ?? "",
		linked: s.linked ?? true,
		ownDir: ownStorageDir(db),
		patternHelp: PATTERN_HELP,
		auto: s.auto ?? true,
		behavior: s.behavior === "copy" ? "copy" : "move",
		allowedExt: s.allowedExt ?? [],
		rename: s.rename ?? false,
		renameTitle: s.renameTitle ?? true,
		addTag: s.addTag ?? false,
		tag: s.tag || "zotmoov",
		stripDiacritics: s.stripDiacritics ?? false,
		undefinedStr: s.undefinedStr || "undefined",
		deleteFiles: s.deleteFiles ?? false,
		pruneEmptyDirs: s.pruneEmptyDirs ?? true,
		attachDir: s.attachDir || null,
		attachConfirm: s.attachConfirm ?? false,
		suggestions: suggestedFolders(),
	};
}

export interface StoragePatch {
	dir?: string | null;
	subfolder?: string;
	linked?: boolean;
	auto?: boolean;
	behavior?: "move" | "copy";
	allowedExt?: string[];
	rename?: boolean;
	renameTitle?: boolean;
	addTag?: boolean;
	tag?: string;
	stripDiacritics?: boolean;
	undefinedStr?: string;
	deleteFiles?: boolean;
	pruneEmptyDirs?: boolean;
	attachDir?: string | null;
	attachConfirm?: boolean;
}

function folderOf(v: string, what: string): string {
	const d = resolve(v);
	if (existsSync(d) && !statSync(d).isDirectory()) throw new Error(`${what} is a file, not a folder`);
	return d;
}

/** Lower-case extensions without dots; anything that is not a plain extension is rejected. */
export function normalizeExtensions(list: string[]): string[] {
	const out: string[] = [];
	for (const raw of list) {
		const e = String(raw).trim().replace(/^\*?\./, "").toLowerCase();
		if (!e) continue;
		if (!/^[a-z0-9]{1,12}$/.test(e)) throw new Error(`"${raw}" is not a file extension`);
		if (!out.includes(e)) out.push(e);
	}
	return out;
}

export function setStorage(db: Database, patch: StoragePatch): StorageView {
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
	if (patch.auto !== undefined) cur.auto = !!patch.auto;
	if (patch.behavior !== undefined) {
		if (patch.behavior !== "move" && patch.behavior !== "copy") throw new Error("behavior must be move or copy");
		cur.behavior = patch.behavior;
	}
	if (patch.allowedExt !== undefined) cur.allowedExt = normalizeExtensions(patch.allowedExt);
	if (patch.rename !== undefined) cur.rename = !!patch.rename;
	if (patch.renameTitle !== undefined) cur.renameTitle = !!patch.renameTitle;
	if (patch.addTag !== undefined) cur.addTag = !!patch.addTag;
	if (patch.tag !== undefined) {
		const t = patch.tag.trim();
		if (!t) throw new Error("the tag cannot be empty");
		cur.tag = t;
	}
	if (patch.stripDiacritics !== undefined) cur.stripDiacritics = !!patch.stripDiacritics;
	if (patch.undefinedStr !== undefined) {
		const u = cleanSegment(patch.undefinedStr);
		if (!u) throw new Error("the text for an undefined value cannot be empty");
		cur.undefinedStr = u;
	}
	if (patch.deleteFiles !== undefined) cur.deleteFiles = !!patch.deleteFiles;
	if (patch.pruneEmptyDirs !== undefined) cur.pruneEmptyDirs = !!patch.pruneEmptyDirs;
	if (patch.attachDir !== undefined) {
		if (patch.attachDir === null || patch.attachDir === "") delete cur.attachDir;
		else cur.attachDir = folderOf(patch.attachDir, "the folder to attach files from");
	}
	if (patch.attachConfirm !== undefined) cur.attachConfirm = !!patch.attachConfirm;
	updateConfig(db, { storage: cur });
	return storageView(db);
}

/** ZotMoov's own defaults around one destination folder: automatic move, linked files, rename from the parent, tag, pdf/epub/docx/djvu. */
export function applyZotMoovPreset(db: Database, dir: string): StorageView {
	return setStorage(db, {
		dir,
		subfolder: "",
		linked: true,
		auto: true,
		behavior: "move",
		allowedExt: ZOTMOOV_EXTENSIONS,
		rename: true,
		renameTitle: true,
		addTag: true,
		tag: "zotmoov",
		deleteFiles: false,
		pruneEmptyDirs: true,
	});
}

// ---------------------------------------------------------------- where a new file goes

export interface StorageTarget {
	mode: "imported_file" | "linked_file";
	/** Folder to create and put the file in. */
	dir: string;
	/** Full path of the file to write (the name is made unique inside `dir`). */
	path: string;
	custom: boolean;
	/** The file name chosen (renamed from the parent when that is on). */
	name: string;
	/** The attachment title to use instead of the given name (rename + "title follows file name"). */
	title?: string;
	/** Tag to give the attachment. */
	tag?: string;
	/** "copy" behaviour: the file stays in `path` and a copy is also placed here. */
	copyTo?: { dir: string; path: string };
}

/** Unique file name in dir: "name.pdf", "name (2).pdf", ... (`taken` holds names reserved by a plan). */
export function uniqueName(dir: string, name: string, taken?: Set<string>): string {
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	let n = name;
	for (let i = 2; (existsSync(join(dir, n)) || taken?.has(join(dir, n).toLowerCase())) && i < 1000; i++) n = `${stem} (${i})${ext}`;
	return n;
}

/** True when the file's extension is on the allowed list (an empty list allows everything). */
export function extAllowed(name: string, allowed: string[]): boolean {
	return !allowed.length || allowed.includes(extname(name).slice(1).toLowerCase());
}

/** Keep folder + name inside the Windows path limit by shortening the name (the extension stays). */
function fitName(dir: string, name: string): string {
	const room = 250 - dir.length - 1;
	if (name.length <= room || room < 24) return name;
	const ext = extname(name);
	return name.slice(0, Math.max(8, room - ext.length)).trim() + ext;
}

/** The file name a file gets in the storage folder: from the parent item when renaming is on, else `name`. */
export function plannedName(db: Database, s: StorageView, name: string, parentKey: string | null | undefined): { name: string; renamed: boolean } {
	let out = name;
	let renamed = false;
	if (s.rename && parentKey) {
		const parent = db.query("SELECT creators_summary, year, title FROM items WHERE key = ?").get(parentKey) as {
			creators_summary: string | null;
			year: number | null;
			title: string | null;
		} | null;
		const base = parent && baseNameFor(parent);
		if (base) {
			out = base + extname(name);
			renamed = true;
		}
	}
	if (s.stripDiacritics) out = stripAccents(out);
	return { name: out, renamed };
}

export interface TargetRequest {
	key: string;
	name: string;
	parentKey?: string | null;
	/** The collection the user is looking at (for the %c wildcard). */
	collectionKey?: string | null;
	/** Place the file in the storage folder even when automatic placement is off (explicit commands). */
	force?: boolean;
	/** `name` is the final file name: do not rename it from the parent item. */
	keepName?: boolean;
}

export function storageTargetFor(db: Database, req: TargetRequest): StorageTarget {
	const s = storageView(db);
	const name = cleanSegment(req.name, 150) || "file";
	const own = (): StorageTarget => {
		const dir = join(ownStorageDir(db) ?? join(process.env.TEMP ?? ".", "zotero-next-storage"), req.key);
		return { mode: "imported_file", dir, path: join(dir, name), custom: false, name };
	};
	if (!s.dir || (!s.auto && !req.force) || !extAllowed(name, s.allowedExt)) return own();
	const meta = metaOfItem(db, req.parentKey, { collectionKey: req.collectionKey });
	const dir = join(s.dir, ...expandPattern(s.subfolder, meta, { undefinedStr: s.undefinedStr, stripDiacritics: s.stripDiacritics }));
	if (resolve(dir) !== resolve(s.dir) && !isInside(dir, s.dir)) throw new Error("the subfolder pattern leaves the storage folder");
	const planned = req.keepName ? { name: s.stripDiacritics ? stripAccents(name) : name, renamed: false } : plannedName(db, s, name, req.parentKey);
	const fileName = uniqueName(dir, fitName(dir, planned.name));
	if (s.behavior === "copy") return { ...own(), copyTo: { dir, path: join(dir, fileName) } };
	return {
		mode: s.linked ? "linked_file" : "imported_file",
		dir,
		path: join(dir, fileName),
		custom: true,
		name: fileName,
		title: planned.renamed && s.renameTitle ? fileName : undefined,
		tag: s.addTag ? s.tag : undefined,
	};
}

// ---------------------------------------------------------------- file helpers

export function sha256Sync(path: string): string {
	const h = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
	} finally {
		closeSync(fd);
	}
	return h.digest("hex");
}

/** Copy a file and check the copy (size and SHA-256) against the original; a bad copy is removed and an error thrown. */
export function copyVerifiedSync(from: string, to: string): void {
	copyFileSync(from, to);
	try {
		const a = statSync(from);
		if (statSync(to).size !== a.size || sha256Sync(to) !== sha256Sync(from)) throw new Error("the copy did not match the original");
		utimesSync(to, a.atime, a.mtime);
	} catch (e) {
		rmSync(to, { force: true });
		throw e;
	}
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

// ---------------------------------------------------------------- files another program holds open

function renameLockProbe(path: string): boolean {
	const probe = `${path}.zn-lock`;
	try {
		renameSync(path, probe);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return code === "EBUSY" || code === "EPERM" || code === "EACCES";
	}
	try {
		renameSync(probe, path);
	} catch (e) {
		throw new Error(`could not restore ${path} after checking it is not open (it is called ${probe}): ${e instanceof Error ? e.message : e}`);
	}
	return false;
}

let lockProbe: (path: string) => boolean = renameLockProbe;
/** Tests: replace the check for a file another program has open. Call with no argument to restore it. */
export function setLockProbe(fn?: (path: string) => boolean): void {
	lockProbe = fn ?? renameLockProbe;
}

/** True when the file cannot be renamed or deleted right now (another program holds it open): such a file is skipped. */
export function isFileLocked(path: string): boolean {
	return lockProbe(path);
}

// ---------------------------------------------------------------- moving existing attachments

export interface MoveItem {
	key: string;
	kind: "imported" | "linked";
	/** attachments.link_mode before the move. */
	fromMode: string;
	from: string;
	to: string;
	size: number;
	/** An imported file in zotero-next's storage becomes a linked file at its new place. */
	becomesLinked: boolean;
	/** Only copy the file out; the attachment is not changed. */
	copyOnly?: boolean;
	/** Linked file -> imported file in zotero-next's own storage. */
	toOwn?: boolean;
	/** New attachment title (the new file name), when it follows the file name. */
	title?: string;
	/** Tag to add (or, with toOwn, the tag to remove). */
	tag?: string;
}

export interface MoveSkip {
	key: string;
	path: string;
	reason: string;
	onlineOnly?: boolean;
	locked?: boolean;
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

export interface RelocateOptions {
	/** Attachment keys; default: every attachment. */
	keys?: string[];
	/** Another destination folder (then no subfolder pattern is used unless `subfolder` is given). */
	dir?: string;
	subfolder?: string;
	/** Override the "linked files" setting. */
	linked?: boolean;
	/** Override move/copy. */
	behavior?: "move" | "copy";
	/** The collection the user is looking at (for the %c wildcard). */
	collectionKey?: string | null;
	/** Convert linked files to imported files in zotero-next's own storage. */
	toOwn?: boolean;
	sampleSize?: number;
}

const SNAPSHOT = /^(text\/html|application\/xhtml)/i;

export function planRelocate(db: Database, opts: RelocateOptions = {}): MovePlan {
	const s = storageView(db);
	const toOwn = !!opts.toOwn;
	const own = s.ownDir;
	if (toOwn && !own) throw new Error("this library has no storage folder of its own");
	const dest = opts.dir ? resolve(opts.dir) : s.dir;
	if (!toOwn && !dest) throw new Error("choose an attachment storage folder first");
	const subfolder = opts.subfolder ?? (opts.dir ? "" : s.subfolder);
	const linked = opts.linked ?? s.linked;
	const copy = !toOwn && (opts.behavior ?? s.behavior) === "copy";
	const wanted = opts.keys ? new Set(opts.keys) : null;
	const rows = db
		.query(
			`SELECT a.item_key AS key, a.link_mode, a.path, a.content_type, i.parent_key, i.library_id
			 FROM attachments a JOIN items i ON i.key = a.item_key
			 WHERE i.deleted = 0 AND a.link_mode IN ('imported_file', 'imported_url', 'linked_file') AND a.path IS NOT NULL
			 ORDER BY i.date_added, i.key`,
		)
		.all() as { key: string; link_mode: string; path: string; content_type: string | null; parent_key: string | null; library_id: number }[];
	const plan: MovePlan = {
		target: { dir: toOwn ? (own as string) : (dest as string), subfolder, linked },
		items: [],
		count: 0,
		totalBytes: 0,
		skipped: [],
		onlineOnly: 0,
		sample: [],
	};
	// a file two attachments point at is not moved (that would break the other one)
	const uses = new Map<string, number>();
	const resolved = new Map<string, string | null>();
	for (const r of rows) {
		const p = resolveStoredPath(db, r.path);
		resolved.set(r.key, p);
		if (p) uses.set(p.replaceAll("\\", "/").toLowerCase(), (uses.get(p.replaceAll("\\", "/").toLowerCase()) ?? 0) + 1);
	}
	const taken = new Set<string>();
	for (const r of rows) {
		if (wanted && !wanted.has(r.key)) continue;
		const from = resolved.get(r.key) ?? null;
		const skip = (reason: string, extra: Partial<MoveSkip> = {}) => void plan.skipped.push({ key: r.key, path: from ?? r.path, reason, ...extra });
		if (!from) {
			skip("the base directory for this relative path is not set");
			continue;
		}
		if (!existsSync(from)) {
			skip("file is missing");
			continue;
		}
		// copying a file out changes nothing; every other command rewrites the attachment, which a group may forbid
		if (!copy) {
			try {
				assertFilesWritable(db, r.library_id);
			} catch (e) {
				skip(e instanceof Error ? e.message : "this library does not allow file changes");
				continue;
			}
			if (r.library_id !== USER_LIBRARY) {
				skip("group library file: Zinc leaves it where sync keeps it");
				continue;
			}
		}
		const imported = r.link_mode !== "linked_file";
		if (toOwn && imported) {
			skip("already a stored file");
			continue;
		}
		if (r.link_mode === "imported_url" && SNAPSHOT.test(r.content_type ?? "")) {
			skip("web page snapshot (kept together with its resources)");
			continue;
		}
		if (!copy && !toOwn && imported && !(own && isInside(from, own))) {
			skip("stored in Zotero's own folder; Zinc leaves it where Zotero keeps it");
			continue;
		}
		if (!copy && (uses.get(from.replaceAll("\\", "/").toLowerCase()) ?? 0) > 1) {
			skip("the same file is used by another attachment");
			continue;
		}
		if (!toOwn && !extAllowed(from, s.allowedExt)) {
			skip("file type is not on the allowed list");
			continue;
		}
		if (!r.parent_key && subfolder && !toOwn) {
			skip("standalone attachment has no parent item to name a folder from");
			continue;
		}
		if (isOnlineOnly(from)) {
			plan.onlineOnly++;
			skip("online-only OneDrive file (not downloaded)", { onlineOnly: true });
			continue;
		}
		let dir: string;
		let name = basename(from);
		let title: string | undefined;
		if (toOwn) {
			dir = join(own as string, r.key);
			name = cleanSegment(name, 150) || "file";
		} else {
			dir = join(dest as string, ...expandPattern(subfolder, metaOfItem(db, r.parent_key, { collectionKey: opts.collectionKey }), { undefinedStr: s.undefinedStr, stripDiacritics: s.stripDiacritics }));
			if (resolve(dir) !== resolve(dest as string) && !isInside(dir, dest as string)) {
				skip("the subfolder pattern leaves the storage folder");
				continue;
			}
			const p = plannedName(db, s, name, r.parent_key);
			name = fitName(dir, p.name);
			if (p.renamed && s.renameTitle && !copy) title = name;
		}
		if (!copy && !toOwn && resolve(dirname(from)).toLowerCase() === resolve(dir).toLowerCase()) {
			skip("already in the right folder");
			continue;
		}
		if (copy && resolve(dirname(from)).toLowerCase() === resolve(dir).toLowerCase() && basename(from) === name) {
			skip("already in that folder");
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
		plan.items.push({
			key: r.key,
			kind: imported ? "imported" : "linked",
			fromMode: r.link_mode,
			from,
			to,
			size,
			becomesLinked: !toOwn && imported && linked,
			...(copy ? { copyOnly: true } : {}),
			...(toOwn ? { toOwn: true } : {}),
			...(title ? { title } : {}),
			...(!copy && s.addTag ? { tag: s.tag } : {}),
		});
		plan.totalBytes += size;
	}
	plan.count = plan.items.length;
	plan.sample = plan.items.slice(0, opts.sampleSize ?? 10).map((i) => ({ key: i.key, from: i.from, to: i.to }));
	return plan;
}

/** Plan for every attachment (the Settings "Move existing attachments to this folder" button). */
export function planMove(db: Database, sampleSize = 10): MovePlan {
	return planRelocate(db, { sampleSize });
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
	/** Files copied out (the "copy" commands); the attachments are unchanged. */
	copied: number;
	failed: { key: string; from: string; error: string }[];
	/** Originals that could not be deleted after the database was updated (harmless duplicates). */
	leftBehind: { key: string; path: string; error: string }[];
	skipped: MoveSkip[];
	/** Online-only OneDrive files that were left alone. */
	onlineOnly: number;
	/** Files another program had open (left alone). */
	locked: number;
	bytes: number;
}

/**
 * Copy `from` to `to` safely: a temporary name first, size and SHA-256 checked, then renamed into place. A file already
 * at `to` with the same content is reused; with other content the copy gets a numbered name. The modification time is kept.
 */
export async function placeCopy(from: string, to: string): Promise<{ to: string; created: boolean }> {
	mkdirSync(dirname(to), { recursive: true });
	const srcHash = await sha256(from);
	if (existsSync(to) && (statSync(to).size !== statSync(from).size || (await sha256(to)) !== srcHash)) to = join(dirname(to), uniqueName(dirname(to), basename(to)));
	if (existsSync(to)) return { to, created: false };
	const tmp = `${to}.zn-part`;
	rmSync(tmp, { force: true });
	try {
		await copyFile(from, tmp);
		const st = statSync(from);
		if (statSync(tmp).size !== st.size || (await sha256(tmp)) !== srcHash) throw new Error("the copy did not match the original");
		utimesSync(tmp, st.atime, st.mtime);
		await rename(tmp, to);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
	return { to, created: true };
}

const running = new WeakSet<Database>();

/**
 * Move the planned files. Per file: copy to a temporary name, verify size and SHA-256, rename into place, update the
 * database in one transaction, and only then delete the original. A failure at any step leaves the original and the
 * database exactly as they were; re-running continues where an interrupted run stopped (a finished copy is reused).
 * A file another program has open is skipped. Copy-only items stop after the verified copy.
 */
export async function runMove(db: Database, plan: MovePlan = planMove(db), hooks: MoveHooks = {}): Promise<MoveReport> {
	if (running.has(db)) throw new Error("a move is already running");
	running.add(db);
	const report: MoveReport = { moved: 0, copied: 0, failed: [], leftBehind: [], skipped: [...plan.skipped], onlineOnly: plan.onlineOnly, locked: 0, bytes: 0 };
	const own = ownStorageDir(db);
	const s = storageView(db);
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
				if (!item.copyOnly && isFileLocked(item.from)) {
					report.locked++;
					report.skipped.push({ key: item.key, path: item.from, reason: "the file is open in another program", locked: true });
					continue;
				}
				// what the original looked like before it was copied: if it differs when the database is updated, a program saved to it meanwhile
				const before = statSync(item.from);
				const source = { size: before.size, mtimeMs: before.mtimeMs };
				const placed = await placeCopy(item.from, item.to);
				const to = placed.to;
				if (placed.created) created = to;
				if (item.copyOnly) {
					report.copied++;
					report.bytes += item.size;
					continue;
				}
				await hooks.afterCopy?.(item);
				commitMove(db, item, to, hooks, item.copyOnly ? undefined : source);
				report.moved++;
				report.bytes += item.size;
				// the database now points at the copy: the original can go
				try {
					rmSync(item.from, { force: true });
					const dir = dirname(item.from);
					if (own && isInside(dir, own)) removeIfEmpty(dir);
					else if (s.dir && s.pruneEmptyDirs && isInside(dir, s.dir)) pruneEmptyDirs(dir, s.dir);
				} catch (e) {
					report.leftBehind.push({ key: item.key, path: item.from, error: e instanceof Error ? e.message : String(e) });
				}
			} catch (e) {
				if (created) {
					rmSync(created, { force: true });
					// a folder this run made for the file goes again (only empty folders are removed)
					if (item.toOwn && own) pruneEmptyDirs(dirname(created), own);
					else if (s.dir) pruneEmptyDirs(dirname(created), s.dir);
				}
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
	pruneEmptyDirs(dir, dirname(dir));
}

function commitMove(db: Database, item: MoveItem, to: string, hooks: MoveHooks, source?: { size: number; mtimeMs: number }): void {
	const row = db.query("SELECT data, library_id FROM items WHERE key = ?").get(item.key) as { data: string; library_id: number } | null;
	if (!row) throw new Error("the attachment was removed while moving");
	assertFilesWritable(db, row.library_id);
	const data = JSON.parse(row.data) as Record<string, unknown>;
	const now = nowIso();
	const linked = !item.toOwn && (item.kind === "linked" || item.becomesLinked);
	const linkMode = linked ? "linked_file" : item.toOwn || item.fromMode !== "imported_url" ? "imported_file" : "imported_url";
	data.filename = basename(to);
	data.linkMode = linkMode;
	if (linked) data.path = to; // sync hands Zotero the absolute path; its writer relativises against Zotero's base directory
	else delete data.path;
	if (item.title) data.title = item.title;
	data.dateModified = now;
	const stored = linked ? storedFormForNewLink(db, to) : to;
	db.transaction(() => {
		// the attachment must still be the one that was planned: same path and mode, and the original unchanged since it was copied
		const cur = db.query("SELECT path, link_mode FROM attachments WHERE item_key = ?").get(item.key) as { path: string | null; link_mode: string } | null;
		const curPath = cur ? resolveStoredPath(db, cur.path) : null;
		if (!cur || cur.link_mode !== item.fromMode || !curPath || resolve(curPath).toLowerCase() !== resolve(item.from).toLowerCase()) {
			throw new Error("the attachment changed while it was being moved; the original was kept");
		}
		if (source) {
			let now2: { size: number; mtimeMs: number } | null = null;
			try {
				const st = statSync(item.from);
				now2 = { size: st.size, mtimeMs: st.mtimeMs };
			} catch {
				// gone
			}
			if (!now2 || now2.size !== source.size || now2.mtimeMs !== source.mtimeMs) {
				throw new Error("the file was changed while it was being moved; the original was kept");
			}
		}
		db.query("UPDATE attachments SET path = ?, link_mode = ? WHERE item_key = ?").run(stored, linkMode, item.key);
		if (item.title) {
			db.query("UPDATE items SET data = ?, title = ?, date_modified = ? WHERE key = ?").run(JSON.stringify(data), deriveColumns(data as never).title, now, item.key);
		} else db.query("UPDATE items SET data = ?, date_modified = ? WHERE key = ?").run(JSON.stringify(data), now, item.key);
		if (item.tag && !item.toOwn) addTags(db, item.key, [item.tag]);
		if (item.tag && item.toOwn) removeTags(db, item.key, [item.tag]);
		hooks.beforeCommit?.(item);
	})();
	if (item.title) indexItem(db, item.key);
}
