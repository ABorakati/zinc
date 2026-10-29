// Bun.serve entry: /api -> handleApi, everything else -> static files from mounts.
// CLI: bun core/src/server.ts --db <path> [--port 23120] [--host 127.0.0.1] --mount /app/=<dir> ...

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { handleApi } from "./api";
import { openDb } from "./db";
import { handleMcp } from "./mcp/http";

export interface Mount {
	prefix: string;
	dir: string;
}

export interface ServerOptions {
	dbPath: string;
	port?: number;
	hostname?: string;
	mounts?: Mount[];
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".onnx": "application/octet-stream",
	".ftl": "text/plain; charset=utf-8",
	".bcmap": "application/octet-stream",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".pdf": "application/pdf",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

function normPrefix(p: string): string {
	if (!p.startsWith("/")) p = "/" + p;
	if (!p.endsWith("/")) p += "/";
	return p;
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function serveStatic(pathname: string, mounts: Mount[]): Response | null {
	for (const m of mounts) {
		const prefix = normPrefix(m.prefix);
		if (pathname + "/" === prefix) return new Response(null, { status: 302, headers: { Location: prefix } });
		if (!pathname.startsWith(prefix)) continue;
		let rel: string;
		try {
			rel = decodeURIComponent(pathname.slice(prefix.length));
		} catch {
			return new Response("bad request", { status: 400 });
		}
		if (rel.includes("\0")) return new Response("bad request", { status: 400 });
		const root = resolve(m.dir);
		let target = resolve(root, rel);
		if (target !== root && !target.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
		if (isDir(target)) target = join(target, "index.html");
		if (!isFile(target)) {
			// fall through to a shorter mount that may own this path
			continue;
		}
		const ext = target.slice(target.lastIndexOf(".")).toLowerCase();
		const file = Bun.file(target);
		return new Response(file, { headers: { "Content-Type": MIME[ext] ?? (file.type || "application/octet-stream") } });
	}
	return null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Guard for /api: the server only listens on loopback, but any web page in the user's browser can
 * still send requests to it. Reject (403) requests whose Host isn't loopback (DNS rebinding), and
 * state-changing requests that come from another origin or aren't JSON (cross-site request
 * forgery: a cross-origin JSON request needs a CORS preflight, which this server never grants).
 */
export function apiRequestRejected(req: Request): string | null {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return null;
	const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
	if (host && !LOOPBACK_HOSTS.has(host)) return "bad host";
	if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
	const origin = req.headers.get("origin");
	if (origin && origin !== url.origin) return "cross-origin request";
	const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (type !== "application/json" && req.body !== null) return "content-type must be application/json";
	return null;
}

export function startServer(opts: ServerOptions) {
	const db: Database = openDb(opts.dbPath);
	const mounts = [...(opts.mounts ?? [])].sort((a, b) => normPrefix(b.prefix).length - normPrefix(a.prefix).length);
	for (const m of mounts) if (!existsSync(m.dir)) console.warn(`mount directory missing: ${m.dir}`);
	const server = Bun.serve({
		port: opts.port ?? 23120,
		hostname: opts.hostname ?? "127.0.0.1",
		async fetch(req) {
			const mcp = await handleMcp(req, db);
			if (mcp) return mcp;
			const rejected = apiRequestRejected(req);
			if (rejected) return Response.json({ error: `forbidden: ${rejected}` }, { status: 403 });
			const api = await handleApi(req, db);
			if (api) return api;
			if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
			const res = serveStatic(new URL(req.url).pathname, mounts);
			return res ?? new Response("not found", { status: 404 });
		},
	});
	return {
		server,
		db,
		url: `http://${server.hostname}:${server.port}`,
		stop() {
			server.stop(true);
			db.close();
		},
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let dbPath = "";
	let port = 23120;
	let hostname = "127.0.0.1";
	const mounts: Mount[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--db") dbPath = args[++i];
		else if (a === "--port") port = Number(args[++i]);
		else if (a === "--host") hostname = args[++i];
		else if (a === "--mount") {
			const v = args[++i] ?? "";
			const eq = v.indexOf("=");
			if (eq < 1) {
				console.error(`bad --mount (expected /prefix/=dir): ${v}`);
				process.exit(2);
			}
			mounts.push({ prefix: v.slice(0, eq), dir: v.slice(eq + 1) });
		} else {
			console.error(`unknown argument: ${a}`);
			process.exit(2);
		}
	}
	if (!dbPath) {
		console.error("usage: bun core/src/server.ts --db <path> [--port N] [--host H] [--mount /prefix/=dir ...]");
		process.exit(2);
	}
	const s = startServer({ dbPath, port, hostname, mounts });
	console.log(`zotero-next core listening on ${s.url}`);
}
