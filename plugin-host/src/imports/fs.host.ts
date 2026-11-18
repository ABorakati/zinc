// `fs` (lifecycle.wit) except the pick dialogs (those are `where: "zinc"`, see fs.zinc.ts): read, write and walk the plugin's four
// roots. No permission id: `data`, `bundled`, `temp` and user-granted files are free by design. Roots and rules: data/fs-roots.ts.
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { defineHandler, witError } from "./registry";
import { checkQuota, grantRecords, releaseGrant, resolveRef, WHOLE_FILE_MAX, type PathRef, type Resolved } from "./data/fs-roots";

const RANGE_MAX = 64 * 1024 * 1024;

/** Run a node fs call and map its failure to a `types.error`. */
async function io<T>(what: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e: any) {
		if (e?.payload) throw e; // already a WitError
		switch (e?.code) {
			case "ENOENT":
				throw witError("not-found", what);
			case "EEXIST":
			case "ENOTEMPTY":
				throw witError("conflict", `${what}: already exists`);
			case "EACCES":
			case "EPERM":
				throw witError("permission-denied", `${what}: ${e.code}`);
			case "EISDIR":
			case "ENOTDIR":
				throw witError("invalid-argument", `${what}: ${e.code === "EISDIR" ? "is a folder" : "is not a folder"}`);
			case "ENOSPC":
			case "EDQUOT":
				throw witError("limit-exceeded", `${what}: disk full`);
			default:
				throw witError("internal", `${what}: ${e?.message ?? e}`);
		}
	}
}

async function exists(p: string): Promise<boolean> {
	return stat(p).then(
		() => true,
		() => false,
	);
}

/** "name 2.ext", "name 3.ext", ... until free. */
async function uniquePath(abs: string): Promise<string> {
	if (!(await exists(abs))) return abs;
	const ext = extname(abs);
	const stem = basename(abs, ext);
	for (let n = 2; n < 10_000; n++) {
		const cand = join(dirname(abs), `${stem} ${n}${ext}`);
		if (!(await exists(cand))) return cand;
	}
	throw witError("conflict", "no free file name");
}

const withPath = (ref: PathRef, abs: string, r: Resolved): PathRef => {
	if (abs === r.abs) return ref;
	return { root: ref.root, path: ref.path.split("/").slice(0, -1).concat(basename(abs)).join("/") };
};

const kindOf = (s: { isFile(): boolean; isDirectory(): boolean }) => (s.isFile() ? "file" : s.isDirectory() ? "directory" : "other");

/** Write `data` as `file` with `opts` (jco `write-options`). Returns the ref actually written. */
export async function writeFileRef(ctx: any, file: PathRef, data: Uint8Array, opts: { createParents?: boolean; onConflict?: string; atomic?: boolean }): Promise<PathRef> {
	if (data.byteLength > WHOLE_FILE_MAX) throw witError("limit-exceeded", "a whole-file write is limited to 256 MiB");
	const r = resolveRef(ctx, file, "write");
	if (r.grant && !r.grant.isDirectory) {
		// a save target the user chose: the user's choice is the consent to replace it
		return io(file.path, async () => {
			await writeFile(r.abs, data);
			return file;
		});
	}
	let target = r.abs;
	if (opts.createParents) await io("create parents", () => mkdir(dirname(target), { recursive: true }));
	const mode = opts.onConflict ?? "fail";
	if (await exists(target)) {
		if (mode === "fail") throw witError("conflict", `${file.path || "target"} exists`);
		if (mode === "rename-unique") target = await uniquePath(target);
	}
	checkQuota(r, data.byteLength);
	await io(file.path, async () => {
		if (opts.atomic) {
			const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
			try {
				await writeFile(tmp, data);
				await rename(tmp, target);
			} catch (e) {
				await rm(tmp, { force: true }).catch(() => {});
				throw e;
			}
		} else await writeFile(target, data);
	});
	return withPath(file, target, r);
}

export default defineHandler({
	interface: "zinc:plugin/fs",
	where: "host",
	functions: {
		async read(ctx, file: PathRef) {
			const r = resolveRef(ctx, file, "read");
			return io(file.path, async () => {
				const s = await stat(r.abs);
				if (!s.isFile()) throw witError("invalid-argument", "not a file");
				if (s.size > WHOLE_FILE_MAX) throw witError("limit-exceeded", "a whole-file read is limited to 256 MiB; use read-range");
				return new Uint8Array(await readFile(r.abs));
			});
		},

		async "read-range"(ctx, file: PathRef, offset: bigint, length: number) {
			const r = resolveRef(ctx, file, "read");
			const n = Math.min(length, RANGE_MAX);
			return io(file.path, async () => {
				const fh = await open(r.abs, "r");
				try {
					const buf = new Uint8Array(n);
					const { bytesRead } = await fh.read(buf, 0, n, Number(offset));
					return buf.subarray(0, bytesRead);
				} finally {
					await fh.close();
				}
			});
		},

		async "read-text"(ctx, file: PathRef) {
			const r = resolveRef(ctx, file, "read");
			return io(file.path, async () => {
				const s = await stat(r.abs);
				if (!s.isFile()) throw witError("invalid-argument", "not a file");
				if (s.size > WHOLE_FILE_MAX) throw witError("limit-exceeded", "a whole-file read is limited to 256 MiB");
				return new TextDecoder("utf-8", { fatal: false }).decode(await readFile(r.abs));
			});
		},

		async write(ctx, file: PathRef, data: Uint8Array, options: any) {
			return writeFileRef(ctx, file, data, options ?? {});
		},

		async "write-text"(ctx, file: PathRef, text: string, options: any) {
			return writeFileRef(ctx, file, new TextEncoder().encode(text), options ?? {});
		},

		async append(ctx, file: PathRef, data: Uint8Array) {
			const r = resolveRef(ctx, file, "write");
			checkQuota(r, data.byteLength);
			await io(file.path, () => appendFile(r.abs, data));
		},

		async stat(ctx, file: PathRef) {
			const r = resolveRef(ctx, file, "read");
			try {
				const s = await stat(r.abs);
				return { kind: kindOf(s), size: BigInt(s.size), modified: BigInt(Math.floor(s.mtimeMs)) };
			} catch (e: any) {
				if (e?.code === "ENOENT") return undefined;
				return io(file.path, () => Promise.reject(e));
			}
		},

		async "list-dir"(ctx, dir: PathRef) {
			const r = resolveRef(ctx, dir, "read");
			return io(dir.path, async () => {
				const names = await readdir(r.abs, { withFileTypes: true });
				return names.map((d) => ({ name: d.name, kind: d.isFile() ? "file" : d.isDirectory() ? "directory" : "other" })).sort((a, b) => a.name.localeCompare(b.name));
			});
		},

		async "make-dir"(ctx, dir: PathRef, parents: boolean) {
			const r = resolveRef(ctx, dir, "write");
			await io(dir.path, async () => {
				if (parents) await mkdir(r.abs, { recursive: true });
				else {
					await mkdir(dirname(r.abs));
					await mkdir(r.abs);
				}
			});
		},

		async remove(ctx, target: PathRef, recursive: boolean) {
			const r = resolveRef(ctx, target, "write");
			if (target.path === "" && r.root !== "granted") throw witError("invalid-argument", "cannot remove a root");
			if (r.grant && !r.grant.isDirectory) throw witError("permission-denied", "a granted file is removed by the user, not by the plugin");
			if (target.path === "" && r.grant) throw witError("permission-denied", "a granted folder itself cannot be removed");
			await io(target.path, async () => {
				const s = await stat(r.abs).catch(() => undefined);
				if (!s) return; // missing is not an error
				if (s.isDirectory() && !recursive) await rm(r.abs, { recursive: false });
				else await rm(r.abs, { recursive, force: true });
			});
		},

		async move(ctx, from: PathRef, to: PathRef, onConflict: string) {
			const a = resolveRef(ctx, from, "write");
			const b = resolveRef(ctx, to, "write");
			if (from.path === "" && a.root !== "granted") throw witError("invalid-argument", "cannot move a root");
			let dest = b.abs;
			if (await exists(dest)) {
				if (onConflict === "fail") throw witError("conflict", `${to.path} exists`);
				if (onConflict === "rename-unique") dest = await uniquePath(dest);
			}
			const size = await stat(a.abs).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0);
			checkQuota(b, size);
			await io(from.path, async () => {
				await mkdir(dirname(dest), { recursive: true });
				try {
					await rename(a.abs, dest);
				} catch (e: any) {
					if (e?.code !== "EXDEV") throw e;
					await cp(a.abs, dest, { recursive: true, force: onConflict === "overwrite" });
					await rm(a.abs, { recursive: true, force: true });
				}
			});
			return withPath(to, dest, b);
		},

		async copy(ctx, from: PathRef, to: PathRef, onConflict: string) {
			const a = resolveRef(ctx, from, "read");
			const b = resolveRef(ctx, to, "write");
			let dest = b.abs;
			if (await exists(dest)) {
				if (onConflict === "fail") throw witError("conflict", `${to.path} exists`);
				if (onConflict === "rename-unique") dest = await uniquePath(dest);
			}
			const s = await stat(a.abs).catch(() => undefined);
			if (!s) throw witError("not-found", from.path);
			checkQuota(b, s.isFile() ? s.size : 0);
			await io(from.path, async () => {
				await mkdir(dirname(dest), { recursive: true });
				await cp(a.abs, dest, { recursive: true, force: onConflict === "overwrite" });
			});
			return withPath(to, dest, b);
		},

		"list-grants"(ctx) {
			return grantRecords(ctx.pluginId);
		},

		"release-grant"(ctx, id: string) {
			releaseGrant(ctx.pluginId, id);
		},
	},
});
