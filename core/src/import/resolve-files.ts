// Attachment file resolution shared by the importer and core/scripts/relink-files.ts.
//
// Zotero's own rule: "storage:<name>" -> <dataDir>/storage/<KEY>/<name>,
// "attachments:<rel>" -> <baseAttachmentPath>/<rel>, anything else is an absolute path.
// Real libraries drift from that (ZotMoov / ZotFile / Mendeley imports move or copy files while the
// DB row keeps its old path, and Zotero file-sync only downloads on demand), so when the
// canonical location is empty we fall back to searching a set of roots by filename.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export type MatchHow = "canonical" | "storage-dir" | "exact" | "normalized" | "title" | "md5";

export interface FileSpec {
	key: string; // attachment key
	filename?: string; // original file name (from "storage:<name>" / "attachments:<rel>")
	md5?: string | null; // itemAttachments.storageHash (Zotero imported files only)
	parentTitle?: string | null;
	parentAuthor?: string | null; // creators_summary-style: "Smith", "Smith and Jones", "Smith et al."
}

export interface FileMatch {
	path: string;
	how: MatchHow;
}

export interface FileIndex {
	byName: Map<string, string[]>; // lowercase basename -> paths
	byNorm: Map<string, string[]>; // normalised basename (no ext, alnum only) -> paths
	files: { path: string; norm: string }[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "$recycle.bin", "system volume information"]);

export function normName(name: string): string {
	return basename(name)
		.toLowerCase()
		.replace(/\.[a-z0-9]{1,5}$/, "")
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "");
}

export function newFileIndex(): FileIndex {
	return { byName: new Map(), byNorm: new Map(), files: [] };
}

export function addToIndex(idx: FileIndex, path: string): void {
	const name = basename(path);
	const lk = name.toLowerCase();
	const norm = normName(name);
	let a = idx.byName.get(lk);
	if (!a) idx.byName.set(lk, (a = []));
	a.push(path);
	let b = idx.byNorm.get(norm);
	if (!b) idx.byNorm.set(norm, (b = []));
	b.push(path);
	idx.files.push({ path, norm });
}

// Walk the roots (directory listings only; never opens file contents, so OneDrive
// cloud-only placeholders are not hydrated).
export function buildFileIndex(roots: string[], opts: { extensions?: string[]; maxDepth?: number } = {}): FileIndex {
	const exts = new Set((opts.extensions ?? [".pdf", ".epub"]).map((e) => e.toLowerCase()));
	const maxDepth = opts.maxDepth ?? 12;
	const idx = newFileIndex();
	const seen = new Set<string>();
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = `${dir}/${e.name}`;
			if (e.isDirectory()) {
				if (depth < maxDepth && !IGNORED_DIRS.has(e.name.toLowerCase())) walk(p, depth + 1);
			} else if (exts.has(extname(e.name).toLowerCase())) {
				const k = p.toLowerCase();
				if (seen.has(k)) continue;
				seen.add(k);
				addToIndex(idx, p);
			}
		}
	};
	for (const r of roots) if (existsSync(r)) walk(r.replaceAll("\\", "/").replace(/\/+$/, ""), 0);
	return idx;
}

export function defaultSearchRoots(opts: { zoteroDir?: string; baseAttachmentPath?: string | null; home?: string }): string[] {
	const home = opts.home ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
	const roots = [
		opts.baseAttachmentPath ?? "",
		opts.zoteroDir ? join(opts.zoteroDir, "storage") : "",
		home ? join(home, "OneDrive", "Documents") : "",
		home ? join(home, "Documents") : "",
		home ? join(home, "Downloads") : "",
	].filter((r) => r && existsSync(r));
	// drop roots nested inside another root
	const norm = (p: string) => resolve(p).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
	return roots.filter((r, i) => !roots.some((o, j) => j !== i && (norm(r) === norm(o) ? j < i : norm(r).startsWith(`${norm(o)}/`))));
}

export function zoteroRawPathFilename(rawPath: string | null | undefined): string | undefined {
	if (!rawPath) return undefined;
	if (rawPath.startsWith("storage:")) return rawPath.slice("storage:".length);
	if (rawPath.startsWith("attachments:")) return basename(rawPath.slice("attachments:".length).replaceAll("\\", "/"));
	return basename(rawPath.replaceAll("\\", "/"));
}

// Zotero's canonical location for a raw `path` value, without any fallback.
export function canonicalPath(
	rawPath: string | null | undefined,
	key: string,
	storageDir: string,
	baseAttach: string | null | undefined,
): string | null {
	if (!rawPath) return null;
	if (rawPath.startsWith("storage:")) return join(storageDir, key, rawPath.slice("storage:".length));
	if (rawPath.startsWith("attachments:")) {
		return baseAttach ? join(baseAttach, rawPath.slice("attachments:".length).replaceAll("\\", "/")) : null;
	}
	return rawPath;
}

// storage/<KEY>/ exists but the file name differs (renamed on disk): accept the only non-hidden
// file with the same extension. Also a case-insensitive name match for case-sensitive filesystems.
export function resolveInStorageDir(storageDir: string, key: string, filename: string | undefined): string | null {
	const dir = join(storageDir, key);
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => !n.startsWith("."));
	} catch {
		return null;
	}
	if (filename) {
		const ci = names.find((n) => n.toLowerCase() === filename.toLowerCase());
		if (ci) return join(dir, ci);
		const ext = extname(filename).toLowerCase();
		const same = names.filter((n) => extname(n).toLowerCase() === ext);
		if (same.length === 1) return join(dir, same[0]);
	}
	return null;
}

function md5File(p: string): string | null {
	try {
		return createHash("md5").update(readFileSync(p)).digest("hex");
	} catch {
		return null;
	}
}

function rank(path: string): number {
	const p = path.toLowerCase();
	if (p.includes("/zotero/storage/")) return 0;
	if (p.includes("/zotero library/")) return 1;
	if (p.includes("/mendeley desktop/")) return 3;
	return 2;
}

function pickOne(cands: string[], spec: FileSpec): string | null {
	const uniq = [...new Set(cands)];
	if (uniq.length === 1) return uniq[0];
	if (uniq.length === 0) return null;
	// several files share the name: use the first author's surname in the path to tell them apart
	const surname = (spec.parentAuthor ?? "")
		.split(/\s+(?:and|et al\.?)\s*/i)[0]
		.trim()
		.toLowerCase();
	if (surname.length >= 3) {
		const hit = uniq.filter((c) => dirname(c).toLowerCase().includes(surname));
		if (hit.length === 1) return hit[0];
	}
	// same bytes everywhere -> any copy is right (compare sizes first; hashing may hydrate placeholders)
	try {
		const sizes = new Set(uniq.map((c) => statSync(c).size));
		if (sizes.size === 1) {
			const hashes = new Set(uniq.map(md5File));
			if (hashes.size === 1 && !hashes.has(null)) return [...uniq].sort((a, b) => rank(a) - rank(b))[0];
		}
	} catch {
		// fall through
	}
	return null;
}

// Title part of "Smith et al. - 2020 - The title.pdf" or "Smith-The title.pdf", normalised.
export function fileTitleNorm(path: string): string {
	const stem = basename(path).replace(/\.[a-z0-9]{1,5}$/i, "");
	const zot = /^.*? - (?:\d{4}|n\.d\.) - ([\s\S]*)$/.exec(stem);
	if (zot) return normName(`${zot[1]}.x`);
	const dash = /^[^-]+-([\s\S]*)$/.exec(stem);
	return normName(`${dash ? dash[1] : stem}.x`);
}

function titleCandidates(idx: FileIndex, title: string, ext: string): string[] {
	const t = normName(`${title}.x`);
	if (t.length < 25) return [];
	const out: string[] = [];
	for (const f of idx.files) {
		if (extname(f.path).toLowerCase() !== ext) continue;
		const ft = fileTitleNorm(f.path);
		if (ft.length < 25) continue;
		// "Author - 2020 - Title.pdf" / "Author-Title cut at ~50 chars.pdf": the title part of the file
		// name must be a prefix of the item title (truncated names) or the title a prefix of it (subtitles).
		// A short title only counts when the file title is barely longer, so "Machine perfusion" can't
		// claim a different paper that merely starts with those words.
		if (t.startsWith(ft) || (ft.startsWith(t) && ft.length <= t.length + 12)) out.push(f.path);
	}
	return out;
}

// Find a file for an attachment whose canonical location is empty. Returns null when nothing
// credible is found (including ambiguous matches).
export function findFile(spec: FileSpec, idx: FileIndex, opts: { fuzzy?: boolean; verifyMd5?: boolean } = {}): FileMatch | null {
	const fuzzy = opts.fuzzy ?? true;
	const filename = spec.filename;
	const ext = extname(filename ?? "").toLowerCase();

	const verify = (cands: string[]): string[] => {
		if (!spec.md5 || !(opts.verifyMd5 ?? true) || cands.length === 0 || cands.length > 6) return cands;
		const ok = cands.filter((c) => md5File(c) === spec.md5);
		return ok.length ? ok : cands;
	};

	if (filename) {
		const exact = idx.byName.get(filename.toLowerCase());
		if (exact?.length) {
			const c = pickOne(verify(exact), spec);
			if (c) return { path: c, how: spec.md5 && md5File(c) === spec.md5 ? "md5" : "exact" };
			return null; // ambiguous: do not guess among same-named files
		}
		const norm = idx.byNorm.get(normName(filename));
		if (norm?.length) {
			const c = pickOne(norm, spec);
			if (c) return { path: c, how: "normalized" };
			return null;
		}
	}
	if (fuzzy && spec.parentTitle && ext) {
		const c = pickOne(titleCandidates(idx, spec.parentTitle, ext), spec);
		if (c) return { path: c, how: "title" };
	}
	return null;
}

// Full resolution: canonical location, storage-dir rename, then index search.
export function resolveAttachmentFile(
	spec: FileSpec & { rawPath: string | null | undefined },
	ctx: { storageDir: string; baseAttach?: string | null; index?: () => FileIndex; fuzzy?: boolean },
): FileMatch | null {
	const canon = canonicalPath(spec.rawPath, spec.key, ctx.storageDir, ctx.baseAttach);
	if (canon && existsSync(canon)) return { path: resolve(canon), how: "canonical" };
	if (spec.rawPath?.startsWith("storage:") || !spec.rawPath) {
		const inDir = resolveInStorageDir(ctx.storageDir, spec.key, spec.filename);
		if (inDir) return { path: resolve(inDir), how: "storage-dir" };
	}
	const idx = ctx.index?.();
	if (!idx) return null;
	const m = findFile(spec, idx, { fuzzy: ctx.fuzzy });
	return m ? { path: resolve(m.path), how: m.how } : null;
}
