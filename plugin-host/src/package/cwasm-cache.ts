// Per-machine Wasmtime `.cwasm` cache (`<cacheRoot>/<safeCacheKey>/<wasmSha256>.cwasm`).
// `cacheKey` comes from `zhw version` (encoding zhw version, Wasmtime version, OS/CPU and engine settings), so an upgrade of Zinc or
// `zhw` moves to a fresh subfolder and `prune()` deletes stale directories automatically.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveZhwPath } from "../transport-wasmtime";

export interface CwasmCacheOptions {
	cacheRoot: string;
	zhwPath?: string;
	/** Test hook: overrides the engine `cacheKey` reported by `zhw version` to simulate a `zhw` upgrade. */
	zhwVersionOverride?: string;
}

const versionKeyCache = new Map<string, string>();

export function sanitizeCacheKey(raw: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9._+-]/g, "_");
	if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.includes("..")) return "default";
	return cleaned.slice(0, 128);
}

function queryZhwCacheKey(zhwPath: string): string | undefined {
	const cached = versionKeyCache.get(zhwPath);
	if (cached) return cached;
	if (!existsSync(zhwPath)) return undefined;
	try {
		const r = Bun.spawnSync([zhwPath, "version"], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode === 0) {
			const text = r.stdout.toString().trim();
			const line = text.split(/\r?\n/).find(Boolean);
			if (line) {
				const parsed = JSON.parse(line) as { cacheKey?: string; version?: string; wasmtime?: string };
				const raw = parsed.cacheKey || (parsed.version ? `zhw-${parsed.version}-${parsed.wasmtime ?? ""}-${process.platform}-${process.arch}` : "");
				if (raw) {
					const safe = sanitizeCacheKey(raw);
					versionKeyCache.set(zhwPath, safe);
					return safe;
				}
			}
		}
	} catch {
		/* fall back to binary stat fingerprint */
	}
	try {
		const st = statSync(zhwPath);
		const safe = sanitizeCacheKey(`zhw-${st.size}-${Math.floor(st.mtimeMs)}-${process.platform}-${process.arch}`);
		versionKeyCache.set(zhwPath, safe);
		return safe;
	} catch {
		return undefined;
	}
}

export class CwasmCache {
	constructor(private opts: CwasmCacheOptions) {}

	/** Current sanitized cache directory name under `cacheRoot`, or undefined if `zhw` is unavailable and no override was given. */
	cacheKey(): string | undefined {
		if (this.opts.zhwVersionOverride) return sanitizeCacheKey(this.opts.zhwVersionOverride);
		return queryZhwCacheKey(resolveZhwPath(this.opts.zhwPath));
	}

	/** Expected `.cwasm` path under the current `cacheKey`, whether or not the file exists yet. */
	pathFor(wasmSha256: string): string | undefined {
		const key = this.cacheKey();
		if (!key) return undefined;
		return join(this.opts.cacheRoot, key, `${wasmSha256}.cwasm`);
	}

	/** Returns the `.cwasm` path if present and non-empty under the current `cacheKey`, else `undefined` (caller may JIT or rebuild). */
	getIfFresh(wasmSha256: string): string | undefined {
		const p = this.pathFor(wasmSha256);
		if (!p || !existsSync(p)) return undefined;
		try {
			return statSync(p).size > 0 ? p : undefined;
		} catch {
			return undefined;
		}
	}

	/** Precompile `wasmPath` into `<cacheRoot>/<cacheKey>/<wasmSha256>.cwasm`. Throws if `zhw precompile` rejects the component. */
	async precompile(wasmPath: string, wasmSha256: string): Promise<string> {
		const zhw = resolveZhwPath(this.opts.zhwPath);
		if (!existsSync(zhw)) throw new Error(`zhw binary not found at ${zhw}`);
		const key = this.cacheKey() ?? "default";
		const dir = join(this.opts.cacheRoot, key);
		const target = join(dir, `${wasmSha256}.cwasm`);
		const existing = this.getIfFresh(wasmSha256);
		if (existing) return existing;

		await mkdir(dir, { recursive: true });
		const part = join(dir, `${wasmSha256}.${crypto.randomUUID().slice(0, 8)}.tmp.cwasm`);
		try {
			const p = Bun.spawn([zhw, "precompile", wasmPath, part], { stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			if (code !== 0) {
				throw new Error((err || out || `zhw precompile failed (exit ${code})`).trim());
			}
			rmSync(target, { force: true });
			try {
				renameSync(part, target);
			} catch {
				cpSync(part, target);
				rmSync(part, { force: true });
			}
			return target;
		} catch (e) {
			await rm(part, { force: true }).catch(() => {});
			throw e;
		}
	}

	/** Return cached `.cwasm` if fresh, else precompile and return it. */
	async getOrBuild(wasmPath: string, wasmSha256: string): Promise<string | undefined> {
		const hit = this.getIfFresh(wasmSha256);
		if (hit) return hit;
		return this.precompile(wasmPath, wasmSha256);
	}

	/**
	 * Remove any directory under `cacheRoot` whose name !== current `cacheKey`, and if `validWasmHashes` is given, remove `.cwasm`
	 * files in `<cacheRoot>/<cacheKey>/` whose sha256 is not in `validWasmHashes`.
	 */
	prune(validWasmHashes?: Set<string>): void {
		if (!existsSync(this.opts.cacheRoot)) return;
		const key = this.cacheKey();
		if (!key) return;
		mkdirSync(this.opts.cacheRoot, { recursive: true });
		for (const e of readdirSync(this.opts.cacheRoot, { withFileTypes: true })) {
			const full = join(this.opts.cacheRoot, e.name);
			if (e.name !== key) {
				rmSync(full, { recursive: true, force: true });
				continue;
			}
			if (validWasmHashes && e.isDirectory()) {
				for (const f of readdirSync(full)) {
					if (!f.endsWith(".cwasm") || f.endsWith(".tmp.cwasm")) continue;
					const sha = f.slice(0, -".cwasm".length);
					if (!validWasmHashes.has(sha)) rmSync(join(full, f), { force: true });
				}
			}
		}
	}
}
