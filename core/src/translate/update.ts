// Refreshes the translators folder in the data dir from zotero/translators (GitHub tarball, or a local folder /
// tarball URL for offline use). The app then prefers <data dir>/translators over the vendored copy
// (translators.ts: translatorsDirFor). Nothing else in the data dir is touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { listTranslators } from "./translators";

export const DEFAULT_SOURCE = "https://api.github.com/repos/zotero/translators/tarball/master";
const MIN_TRANSLATORS = 300; // a source with fewer is not the translators repo; keep what we have

export interface UpdateResult {
	dir: string;
	count: number;
	source: string;
	commit: string | null;
}

/** The regular files of a (gunzipped) ustar archive as [path, bytes]. */
export function readTar(tar: Uint8Array): [string, Uint8Array][] {
	const out: [string, Uint8Array][] = [];
	const dec = new TextDecoder();
	let longName: string | null = null;
	for (let off = 0; off + 512 <= tar.length; ) {
		const header = tar.subarray(off, off + 512);
		if (header.every((b) => b === 0)) break;
		const field = (start: number, len: number) => dec.decode(header.subarray(start, start + len)).replace(/\0.*$/s, "");
		let name = field(0, 100);
		const prefix = field(345, 155);
		if (prefix) name = `${prefix}/${name}`;
		const size = parseInt(field(124, 12).trim() || "0", 8);
		const type = field(156, 1);
		const body = tar.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "L") {
			longName = dec.decode(body).replace(/\0.*$/s, "");
			continue;
		}
		if (type === "x" || type === "g") {
			// pax header: "<len> path=<name>\n"; GitHub uses it for long names
			const m = /\d+ path=([^\n]+)\n/.exec(dec.decode(body));
			if (m && type === "x") longName = m[1]!;
			continue;
		}
		if (longName) {
			name = longName;
			longName = null;
		}
		if (type === "0" || type === "") out.push([name, body]);
	}
	return out;
}

async function loadSource(source: string): Promise<{ files: Map<string, Uint8Array>; commit: string | null }> {
	const files = new Map<string, Uint8Array>();
	if (!/^https?:\/\//i.test(source)) {
		for (const n of readdirSync(source)) {
			if (n[0] !== "." && (n.endsWith(".js") || n === "deleted.txt")) files.set(n, new Uint8Array(readFileSync(join(source, n))));
		}
		return { files, commit: null };
	}
	const res = await fetch(source, { headers: { "User-Agent": "zotero-next", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(120_000) });
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${source}`);
	const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
	let commit: string | null = null;
	for (const [path, bytes] of readTar(tar)) {
		// <repo>-<sha>/<name>.js at the top level of the repo only
		const m = /^([^/]+)\/([^/]+)$/.exec(path);
		if (!m) continue;
		const [, root, name] = m;
		if (name!.endsWith(".js") || name === "deleted.txt") files.set(name!, bytes);
		commit ??= /-([0-9a-f]{7,40})$/.exec(root!)?.[1] ?? null;
	}
	return { files, commit };
}

/** Downloads/copies the translators into <dataDir>/translators (replacing it only when the new set looks right). */
export async function updateTranslators(opts: { dataDir: string; source?: string }): Promise<UpdateResult> {
	const source = opts.source ?? DEFAULT_SOURCE;
	const { files, commit } = await loadSource(source);
	const target = join(opts.dataDir, "translators");
	const staging = join(opts.dataDir, `translators.new-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		for (const [name, bytes] of files) writeFileSync(join(staging, name), bytes);
		const count = listTranslators(staging).length;
		if (count < MIN_TRANSLATORS) throw new Error(`only ${count} valid translators in ${source}; not replacing the current set`);
		writeFileSync(join(staging, ".source.json"), JSON.stringify({ source, commit, fetchedAt: new Date().toISOString(), count }, null, "\t") + "\n");
		const old = `${target}.old-${process.pid}`;
		rmSync(old, { recursive: true, force: true });
		if (existsSync(target)) renameSync(target, old);
		try {
			renameSync(staging, target);
		} catch (e) {
			if (existsSync(old)) renameSync(old, target);
			throw e;
		}
		rmSync(old, { recursive: true, force: true });
		return { dir: target, count, source, commit };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
