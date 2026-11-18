// The four `fs` roots (lifecycle.wit) and file grants. Used by `fs`, `net.download` and `shell` (all three resolve a `path-ref`).
//
//  data      <dataRoot>/<plugin id>/         private, read/write, quota 512 MiB
//  bundled   the plugin's package folder     read only
//  temp      <tempRoot>/<plugin id>/         scratch, read/write (the app empties tempRoot at startup: `clearTempRoot()`)
//  granted   a file or folder the user picked or dropped: the grant registry below
//
// A plugin never sees a real path. Rules for a `path`: relative, "/" separators, no "..", no leading "/" or drive letter, no empty
// names, no characters Windows forbids, no reserved device names; symbolic links that leave the root are refused.
//
// The grant registry is a file per plugin (<dataRoot>/.grants/<id>.json), because the pick dialogs run in the Zinc process
// (`fs.zinc.ts`) and the reads and writes run in the plugin host process: both read and write the same file.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { witError, type HandlerContext } from "../registry";

export const QUOTA_BYTES = 512 * 1024 * 1024;
export const WHOLE_FILE_MAX = 256 * 1024 * 1024;

export interface FsConfig {
	dataRoot: string;
	tempRoot: string;
	/** Package folder of a plugin; default: `ctx.pluginDir` when the supervisor provides it, else <ZN_PLUGINS_DIR>/<sanitised id>. */
	bundledDirFor?: (pluginId: string) => string | undefined;
}

function defaults(): FsConfig {
	const base = process.env.ZN_PLUGIN_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), ".local", "share"), "zinc", "plugin-data");
	return { dataRoot: base, tempRoot: process.env.ZN_PLUGIN_TEMP_DIR ?? join(tmpdir(), "zinc-plugin-temp") };
}

let config: FsConfig = defaults();

/** The app (and the tests) set the folders. Idempotent. */
export function configureFs(c: Partial<FsConfig>): void {
	config = { ...config, ...c };
}
export function fsConfig(): Readonly<FsConfig> {
	return config;
}

/** The app calls this once at startup: the `temp` root is emptied when Zinc starts. */
export function clearTempRoot(): void {
	rmSync(config.tempRoot, { recursive: true, force: true });
}

export const safeId = (id: string): string => id.replace(/[^A-Za-z0-9._@+-]/g, "_").slice(0, 128);

// ------------------------------------------------------------------------------------------------ grants
export type GrantMode = "read" | "write" | "readwrite";

export interface StoredGrant {
	id: string;
	name: string;
	path: string;
	isDirectory: boolean;
	mode: GrantMode;
	persistent: boolean;
	/** Process (Zinc) that made a session grant. A session grant is valid while that process is the host's parent or the caller. */
	session?: number;
	size?: number;
}

const grantsFile = (pluginId: string) => join(config.dataRoot, ".grants", `${safeId(pluginId)}.json`);

function readGrants(pluginId: string): StoredGrant[] {
	try {
		return JSON.parse(readFileSync(grantsFile(pluginId), "utf8")) as StoredGrant[];
	} catch {
		return [];
	}
}

function writeGrants(pluginId: string, list: StoredGrant[]): void {
	const f = grantsFile(pluginId);
	mkdirSync(dirname(f), { recursive: true });
	const tmp = `${f}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(list));
	renameSync(tmp, f);
}

const sessionOk = (g: StoredGrant) => g.persistent || g.session === process.pid || g.session === process.ppid;

/** Live grants of a plugin (session grants of a dead Zinc session are left out). */
export function listStoredGrants(pluginId: string): StoredGrant[] {
	return readGrants(pluginId).filter(sessionOk);
}

/**
 * Record what the user gave a plugin: a pick in a dialog or a drop on a drop target. Called in the Zinc process by the dialog code
 * (`fs.zinc.ts`) and by the ui / extend areas for drops. Returns the `types.file-grant` record to hand to the plugin.
 */
export function addGrant(pluginId: string, g: { path: string; isDirectory: boolean; mode: GrantMode; persistent?: boolean; name?: string; size?: number }): {
	id: string;
	name: string;
	isDirectory: boolean;
	size: bigint | undefined;
} {
	const id = crypto.randomUUID();
	const stored: StoredGrant = {
		id,
		name: g.name ?? basename(g.path),
		path: resolve(g.path),
		isDirectory: g.isDirectory,
		mode: g.mode,
		persistent: !!g.persistent,
		session: process.pid,
		size: g.size,
	};
	// drop grants of other, dead sessions while we are here
	writeGrants(pluginId, [...readGrants(pluginId).filter(sessionOk), stored]);
	return { id, name: stored.name, isDirectory: stored.isDirectory, size: stored.size === undefined ? undefined : BigInt(stored.size) };
}

export function releaseGrant(pluginId: string, id: string): void {
	writeGrants(pluginId, readGrants(pluginId).filter((g) => g.id !== id));
}

export function grantRecords(pluginId: string) {
	return listStoredGrants(pluginId).map((g) => ({ id: g.id, name: g.name, isDirectory: g.isDirectory, size: g.size === undefined ? undefined : BigInt(g.size) }));
}

// ----------------------------------------------------------------------------------------------- paths
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** Validate a relative `path` and return its segments. "" is the root itself. */
export function pathSegments(path: string): string[] {
	if (path === "") return [];
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw witError("invalid-argument", "path must be relative");
	if (path.length > 1024) throw witError("invalid-argument", "path is too long");
	const segs = path.split("/");
	for (const s of segs) {
		if (s === "" || s === "." || s === "..") throw witError("invalid-argument", `path has an empty, "." or ".." name: ${JSON.stringify(path)}`);
		if (BAD_CHARS.test(s)) throw witError("invalid-argument", `path has a character that is not allowed: ${JSON.stringify(s)}`);
		if (RESERVED.test(s)) throw witError("invalid-argument", `${s} is a reserved name`);
		if (/[. ]$/.test(s)) throw witError("invalid-argument", `a name may not end in a dot or space: ${JSON.stringify(s)}`);
	}
	return segs;
}

export interface Resolved {
	abs: string;
	/** The root folder (or granted file) the path lives in. */
	rootDir: string;
	root: "data" | "bundled" | "temp" | "granted";
	writable: boolean;
	readable: boolean;
	grant?: StoredGrant;
}

export interface PathRef {
	root: { tag: string; val?: string };
	path: string;
}

function bundledDir(ctx: HandlerContext): string | undefined {
	const fromCtx = (ctx as unknown as { pluginDir?: string }).pluginDir;
	if (fromCtx) return fromCtx;
	const c = config.bundledDirFor?.(ctx.pluginId);
	if (c) return c;
	return process.env.ZN_PLUGINS_DIR ? join(process.env.ZN_PLUGINS_DIR, safeId(ctx.pluginId)) : undefined;
}

/** The deepest existing ancestor's real path must stay inside the real root: no symlink may lead out. */
function checkInside(abs: string, rootDir: string): void {
	let realRoot: string;
	try {
		realRoot = realpathSync(rootDir);
	} catch {
		return; // the root does not exist yet: nothing to follow
	}
	let p = abs;
	while (!existsSync(p)) {
		const up = dirname(p);
		if (up === p) return;
		p = up;
	}
	const real = realpathSync(p);
	const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
	if (norm(real) !== norm(realRoot) && !norm(real).startsWith(norm(realRoot) + sep)) throw witError("permission-denied", "path leaves its root through a link");
}

/** Resolve a `path-ref` for the plugin in `ctx`. `need`: what the call does. Creates the data and temp root folders. */
export function resolveRef(ctx: HandlerContext, ref: PathRef, need: "read" | "write"): Resolved {
	const segs = pathSegments(ref.path);
	const tag = ref.root?.tag;
	let rootDir: string;
	let root: Resolved["root"];
	let grant: StoredGrant | undefined;
	let writable = true;
	let readable = true;
	if (tag === "data" || tag === "temp") {
		rootDir = join(tag === "data" ? config.dataRoot : config.tempRoot, safeId(ctx.pluginId));
		mkdirSync(rootDir, { recursive: true });
		root = tag;
	} else if (tag === "bundled") {
		const d = bundledDir(ctx);
		if (!d) throw witError("not-found", "the plugin package folder is not known to the host");
		rootDir = d;
		root = "bundled";
		writable = false;
	} else if (tag === "granted") {
		const id = ref.root.val ?? "";
		grant = listStoredGrants(ctx.pluginId).find((g) => g.id === id);
		if (!grant) throw witError("permission-denied", `no such grant: ${id}`);
		root = "granted";
		writable = grant.mode !== "read";
		readable = grant.mode !== "write";
		if (!grant.isDirectory) {
			if (segs.length) throw witError("invalid-argument", "a granted file has the path \"\"");
			if (need === "write" && !writable) throw witError("permission-denied", "the grant does not allow writing");
			if (need === "read" && !readable) throw witError("permission-denied", "the grant does not allow reading");
			return { abs: grant.path, rootDir: grant.path, root, writable, readable, grant };
		}
		rootDir = grant.path;
	} else throw witError("invalid-argument", `unknown root ${tag}`);
	if (need === "write" && !writable) throw witError(root === "bundled" ? "read-only" : "permission-denied", root === "bundled" ? "the bundled root is read only" : "the grant does not allow writing");
	if (need === "read" && !readable) throw witError("permission-denied", "the grant does not allow reading");
	const abs = segs.length ? join(rootDir, ...segs) : rootDir;
	checkInside(abs, rootDir);
	return { abs, rootDir, root, writable, readable, grant };
}

// ------------------------------------------------------------------------------------------------ quota
const sizeCache = new Map<string, { at: number; bytes: number }>();

export function dirBytes(dir: string): number {
	let total = 0;
	const walk = (d: string) => {
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				try {
					total += statSync(p).size;
				} catch {
					// raced with a delete
				}
			}
		}
	};
	walk(dir);
	return total;
}

/** Refuse a write that would take the plugin's data folder over its quota. `adding` is the size of the new data. */
export function checkQuota(r: Resolved, adding: number): void {
	if (r.root !== "data") return;
	const c = sizeCache.get(r.rootDir);
	const bytes = c && Date.now() - c.at < 1500 ? c.bytes : dirBytes(r.rootDir);
	if (bytes + adding > QUOTA_BYTES) throw witError("limit-exceeded", "the plugin's data folder is over its 512 MiB quota");
	sizeCache.set(r.rootDir, { at: Date.now(), bytes: bytes + adding });
}
