// Local HTTPS dev server for the Office.js task pane on 127.0.0.1 and ::1 (default port 44321, PORT overrides).
// Reads ~/.office-addin-dev-certs/localhost.crt and localhost.key; if missing, prints instructions and exits cleanly.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_PORT = 44321;
export const CERT_DIR_ENV = "ZN_OFFICEJS_CERT_DIR";

export interface ServeOptions {
	port?: number;
	distDir?: string;
	certDir?: string;
	hostnames?: string[];
}

export interface ServeResult {
	started: boolean;
	port: number;
	servers: ReturnType<typeof Bun.serve>[];
	message: string;
}

const NO_STORE_HEADERS = {
	"Cache-Control": "no-store",
} as const;

export function missingCertMessage(certPath: string, keyPath: string): string {
	return [
		"HTTPS development certificate not found:",
		`  cert: ${certPath}`,
		`  key:  ${keyPath}`,
		"",
		"Create and trust a localhost development certificate first (Bun only):",
		"  bunx office-addin-dev-certs install",
		"",
		"Or generate localhost.crt and localhost.key in ~/.office-addin-dev-certs with OpenSSL",
		"(SAN: DNS:localhost, IP:127.0.0.1, IP:::1) and trust localhost.crt in your OS certificate store.",
		"See word/officejs/docs/INSTALL.md for platform-specific steps.",
	].join("\n");
}

/** Build the static-file request handler for `distDir` with `Cache-Control: no-store` on every response. */
export function createFetchHandler(distDir: string): (req: Request) => Promise<Response> {
	const root = resolve(distDir);
	return async (req: Request): Promise<Response> => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("method not allowed", { status: 405, headers: NO_STORE_HEADERS });
		}
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(req.url).pathname);
		} catch {
			return new Response("bad request", { status: 400, headers: NO_STORE_HEADERS });
		}
		const relReq = pathname === "/" ? "taskpane.html" : pathname.replace(/^\/+/, "");
		if (!relReq || relReq.includes("\0")) {
			return new Response("not found", { status: 404, headers: NO_STORE_HEADERS });
		}
		const fullPath = resolve(root, relReq);
		const relCheck = relative(root, fullPath);
		if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
			return new Response("not found", { status: 404, headers: NO_STORE_HEADERS });
		}
		const file = Bun.file(fullPath);
		if (!(await file.exists())) {
			return new Response("not found", { status: 404, headers: NO_STORE_HEADERS });
		}
		const headers = new Headers(NO_STORE_HEADERS);
		if (file.type) headers.set("Content-Type", file.type);
		return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
	};
}

export function startServer(opts: ServeOptions = {}): ServeResult {
	const rawPort = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
	const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : DEFAULT_PORT;
	const distDir = opts.distDir ?? process.env.ZN_OFFICEJS_DIST ?? join(import.meta.dir, "dist");
	const certDir = opts.certDir ?? process.env[CERT_DIR_ENV] ?? join(homedir(), ".office-addin-dev-certs");
	const certPath = join(certDir, "localhost.crt");
	const keyPath = join(certDir, "localhost.key");

	if (!existsSync(certPath) || !existsSync(keyPath)) {
		return {
			started: false,
			port,
			servers: [],
			message: missingCertMessage(certPath, keyPath),
		};
	}

	const fetch = createFetchHandler(distDir);
	const tls = {
		cert: Bun.file(certPath),
		key: Bun.file(keyPath),
	};
	const hostnames = opts.hostnames ?? ["127.0.0.1", "::1"];
	const servers: ReturnType<typeof Bun.serve>[] = [];
	const bound: string[] = [];

	for (const hostname of hostnames) {
		try {
			const actualPort = servers[0]?.port ?? port;
			const srv = Bun.serve({
				hostname,
				port: actualPort,
				tls,
				fetch,
			});
			servers.push(srv);
			bound.push(hostname.includes(":") ? `[${hostname}]:${srv.port}` : `${hostname}:${srv.port}`);
		} catch (err) {
			// If IPv6 loopback is disabled on the host OS, keep serving on 127.0.0.1; fail only if nothing bound.
			if (hostname === "127.0.0.1" || hostnames.length === 1) {
				for (const s of servers) s.stop(true);
				throw err;
			}
		}
	}

	const shownPort = servers[0]?.port ?? port;
	return {
		started: true,
		port: shownPort,
		servers,
		message: `serving ${distDir} over HTTPS on ${bound.join(", ")} (https://localhost:${shownPort}/taskpane.html)`,
	};
}

if (import.meta.main) {
	const res = startServer();
	console.log(res.message);
}
