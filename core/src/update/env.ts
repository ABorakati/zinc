// The real UpdateEnv: fetch for the manifest and the (resumable) installer download, node:fs for the files, node:child_process to start
// the installer detached. Nothing here decides anything; updater.ts does.
//
// Private-repo feeds: ZN_UPDATE_TOKEN (a GitHub token) is sent as "Authorization: Bearer" to the feed's own origin ONLY - not to a
// different host the manifest points at. Not recommended for end users (see UPDATES.md); fetch itself drops it on a cross-origin redirect.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, truncate, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { UpdateError, assertSecureUrl } from "./manifest";
import type { UpdateEnv } from "./updater";

/** %LOCALAPPDATA%\zotero-next-gpui\updates (ZN_UPDATE_DIR overrides, for tests). */
export function defaultUpdatesDir(): string {
	if (process.env.ZN_UPDATE_DIR) return process.env.ZN_UPDATE_DIR;
	return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "zotero-next-gpui", "updates");
}

export interface RealEnvOptions {
	updatesDir?: string;
	/** Sent as a Bearer token to requests whose origin equals `tokenOrigin` (the feed URL's origin). */
	token?: string;
	tokenOrigin?: string | (() => string | undefined);
	/** Manifest request timeout (default 20 s). */
	timeoutMs?: number;
	/** A download that receives nothing for this long fails (default 30 s). */
	idleMs?: number;
	exit?: (code: number) => void;
}

export function createRealEnv(o: RealEnvOptions = {}): UpdateEnv {
	const updatesDir = (o.updatesDir ?? defaultUpdatesDir()).replaceAll("\\", "/");
	const headers = (url: string, extra: Record<string, string> = {}): Record<string, string> => {
		const h: Record<string, string> = { "User-Agent": "zinc-updater", ...extra };
		try { const origin = typeof o.tokenOrigin === "function" ? o.tokenOrigin() : o.tokenOrigin;
			if (o.token && origin && new URL(url).origin === origin) h.Authorization = `Bearer ${o.token}`; } catch { /* no token */ }
		return h;
	};
	const net = (e: unknown): never => { throw e instanceof UpdateError ? e : new UpdateError("network", `network error: ${e instanceof Error ? e.message : String(e)}`); };

	return {
		updatesDir,
		pid: process.pid,

		async fetchText(url, { maxBytes }) {
			assertSecureUrl(url);
			try {
				const res = await fetch(url, { headers: headers(url, { Accept: "application/json, application/octet-stream" }), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
				if (!res.ok) throw new UpdateError("http", `the update feed answered ${res.status} ${res.statusText}`.trim());
				const len = Number(res.headers.get("content-length") ?? 0);
				if (len > maxBytes) throw new UpdateError("too-large", "the update manifest is too large");
				const chunks: Uint8Array[] = [];
				let n = 0;
				for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
					n += c.length;
					if (n > maxBytes) throw new UpdateError("too-large", "the update manifest is too large");
					chunks.push(c);
				}
				return Buffer.concat(chunks).toString("utf8");
			} catch (e) { return net(e); }
		},

		async download(url, dest, { offset, onProgress }) {
			assertSecureUrl(url);
			await mkdir(updatesDir, { recursive: true });
			let from = offset;
			for (let attempt = 0; attempt < 2; attempt++) {
				const ac = new AbortController();
				let idle = setTimeout(() => ac.abort(), o.idleMs ?? 30_000);
				const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), o.idleMs ?? 30_000); };
				try {
					const res = await fetch(url, { headers: headers(url, { Accept: "application/octet-stream", ...(from > 0 ? { Range: `bytes=${from}-` } : {}) }), signal: ac.signal });
					if (res.status === 416 && from > 0) { await truncate(dest, 0).catch(() => {}); from = 0; continue; } // our partial file is not valid for the server's: start over
					if (!res.ok) throw new UpdateError("http", `the installer download answered ${res.status} ${res.statusText}`.trim());
					let resumed = from > 0 && res.status === 206;
					if (resumed) {
						const start = /bytes (\d+)-/.exec(res.headers.get("content-range") ?? "");
						if (!start || Number(start[1]) !== from) resumed = false;
					}
					if (from > 0 && !resumed) { from = 0; } // the server sent the whole file: overwrite the partial one
					const total = (Number(res.headers.get("content-length") ?? 0) || 0) + from;
					const fh = await open(dest, from > 0 ? "a" : "w");
					try {
						let got = from;
						for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
							bump();
							await fh.write(chunk);
							got += chunk.length;
							onProgress(got, total);
						}
						onProgress(got, got);
					} finally { await fh.close(); }
					return;
				} catch (e) {
					return net(ac.signal.aborted ? new UpdateError("network", "the download stalled") : e);
				} finally { clearTimeout(idle); }
			}
		},

		async fileSize(path) { try { return (await stat(path)).size; } catch { return null; } },
		sha256(path) {
			return new Promise((resolve, reject) => {
				const h = createHash("sha256");
				createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
			});
		},
		rename: (a, b) => rename(a, b),
		remove: (p) => unlink(p).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }),
		list: (d) => readdir(d).catch(() => [] as string[]),

		runInstaller(file, args) {
			// .cmd / .bat only exist as stubs in tests; the real installer is an .exe
			const script = /\.(cmd|bat)$/i.test(file);
			const child = script
				? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", file, ...args], { detached: true, stdio: "ignore", windowsHide: true })
				: spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
		},
		exit: o.exit ?? ((code) => process.exit(code)),
	};
}
