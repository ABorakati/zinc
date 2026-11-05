// A local stand-in for the Zotero Web API v3 (just the parts web sync uses), served on a random port.
// Tests point the code at it with ZN_ZOTERO_API. Nothing here ever contacts zotero.org.

import { createHash } from "node:crypto";

export const API_KEY = "test-key-not-a-secret";
export const USER_ID = 42;

interface Obj {
	version: number;
	data: Record<string, any>;
}

export interface Logged {
	method: string;
	path: string;
	query: Record<string, string>;
	ifUnmodified: string | null;
	status: number;
	/** Number of objects in a write body. */
	size?: number;
}

export class MockZotero {
	version = 1;
	objects = new Map<string, Obj>(); // "item:KEY" | "collection:KEY"
	deleted: { type: "item" | "collection"; key: string; version: number }[] = [];
	files = new Map<string, Uint8Array>(); // item key -> bytes served by /file
	/** Per file key: force this status from GET /file instead of the normal 302/404. */
	fileStatus = new Map<string, number>();
	log: Logged[] = [];
	canWrite = true;
	/** Send a Backoff header (seconds) on the next response. */
	backoffNext = 0;
	/** Answer the next n requests with 429 + Retry-After. */
	throttle = 0;
	retryAfter = 2;
	/** Called before each request is handled (tests change the library from here). */
	onRequest: ((path: string, query: Record<string, string>) => void) | null = null;
	inFlight = 0;
	maxInFlight = 0;
	delayMs = 0;
	private uploads = new Map<string, Uint8Array>();
	private server: ReturnType<typeof Bun.serve>;

	constructor() {
		this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}

	// ------------------------------------------------------------ helpers for tests

	/** Create or replace an object as another client would: bumps the library version. */
	put(type: "item" | "collection", key: string, fields: Record<string, any>): number {
		const v = ++this.version;
		const base =
			type === "item"
				? { itemType: "journalArticle", title: key, dateAdded: "2026-01-01T00:00:00Z", dateModified: "2026-06-01T10:00:00Z", tags: [], collections: [], relations: {} }
				: { name: key, parentCollection: false, relations: {} };
		this.objects.set(`${type}:${key}`, { version: v, data: { ...base, ...fields, key, version: v } });
		return v;
	}

	remove(type: "item" | "collection", key: string): void {
		const v = ++this.version;
		this.objects.delete(`${type}:${key}`);
		this.deleted.push({ type, key, version: v });
	}

	item(key: string): Obj | undefined {
		return this.objects.get(`item:${key}`);
	}

	posts(): Logged[] {
		return this.log.filter((l) => l.method === "POST" && /\/(items|collections)$/.test(l.path));
	}

	// ------------------------------------------------------------ server

	private reply(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
		const headers: Record<string, string> = { "Last-Modified-Version": String(this.version), ...extra };
		if (this.backoffNext > 0) {
			headers.Backoff = String(this.backoffNext);
			this.backoffNext = 0;
		}
		if (body === null) return new Response(null, { status, headers });
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
	}

	private async handle(req: Request): Promise<Response> {
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.delayMs) await Bun.sleep(this.delayMs);
			const url = new URL(req.url);
			const query = Object.fromEntries(url.searchParams);
			const entry: Logged = { method: req.method, path: url.pathname, query, ifUnmodified: req.headers.get("if-unmodified-since-version"), status: 0 };
			this.log.push(entry);
			const res = await this.route(req, url, query, entry);
			entry.status = res.status;
			return res;
		} finally {
			this.inFlight--;
		}
	}

	private async route(req: Request, url: URL, query: Record<string, string>, entry: Logged): Promise<Response> {
		const path = url.pathname;
		// blob host: no API key needed (a real file host never gets the key)
		if (path.startsWith("/blob/")) {
			if (req.headers.get("zotero-api-key")) return new Response("key leaked to the file host", { status: 400 });
			const bytes = this.files.get(path.slice("/blob/".length));
			return bytes ? new Response(Buffer.from(bytes)) :new Response("gone", { status: 404 });
		}
		if (path.startsWith("/upload/")) {
			this.uploads.set(path.slice("/upload/".length), new Uint8Array(await req.arrayBuffer()));
			return new Response(null, { status: 201 });
		}
		if (req.headers.get("zotero-api-key") !== API_KEY) return new Response("Forbidden", { status: 403 });
		if (req.headers.get("zotero-api-version") !== "3") return new Response("bad version", { status: 400 });
		this.onRequest?.(path, query);
		if (this.throttle > 0) {
			this.throttle--;
			return new Response("slow down", { status: 429, headers: { "Retry-After": String(this.retryAfter) } });
		}

		if (path === "/keys/current") {
			return this.reply({ key: "x", userID: USER_ID, username: "tester", access: { user: { library: true, files: true, notes: true, write: this.canWrite } } });
		}
		const m = path.match(new RegExp(`^/users/${USER_ID}/(items|collections|deleted)(?:/([A-Z0-9]{8})/file)?$`));
		if (!m) return new Response("not found", { status: 404 });
		const [, kind, fileKey] = m;

		if (fileKey) return this.fileRoute(req, url, fileKey);
		if (kind === "deleted") {
			const since = Number(query.since) || 0;
			const d = this.deleted.filter((x) => x.version > since);
			return this.reply({ collections: d.filter((x) => x.type === "collection").map((x) => x.key), items: d.filter((x) => x.type === "item").map((x) => x.key), searches: [], tags: [], settings: [] });
		}
		const type = kind === "items" ? "item" : "collection";

		if (req.method === "GET") {
			const since = Number(query.since) || 0;
			const all = [...this.objects.entries()].filter(([k]) => k.startsWith(`${type}:`)).map(([k, o]) => [k.slice(type.length + 1), o] as const);
			if (query.format === "versions") {
				const out: Record<string, number> = {};
				for (const [k, o] of all) if (o.version > since && (type !== "item" || !o.data.deleted || query.includeTrashed === "1")) out[k] = o.version;
				return this.reply(out);
			}
			const wanted = (query.itemKey ?? query.collectionKey ?? "").split(",").filter(Boolean);
			return this.reply(all.filter(([k]) => wanted.includes(k)).map(([k, o]) => ({ key: k, version: o.version, data: o.data })));
		}

		// writes
		if (!this.canWrite) return new Response("read-only key", { status: 403 });
		if (Number(req.headers.get("if-unmodified-since-version")) !== this.version) return new Response("Library has been modified since specified version", { status: 412, headers: { "Last-Modified-Version": String(this.version) } });
		if (req.method === "DELETE") {
			const keys = (query.itemKey ?? query.collectionKey ?? "").split(",").filter(Boolean);
			entry.size = keys.length;
			this.version++;
			for (const k of keys) if (this.objects.delete(`${type}:${k}`)) this.deleted.push({ type, key: k, version: this.version });
			return this.reply(null, 204);
		}
		if (req.method === "POST") {
			const objs = (await req.json()) as Record<string, any>[];
			entry.size = objs.length;
			const out: { successful: Record<string, unknown>; success: Record<string, string>; unchanged: Record<string, string>; failed: Record<string, unknown> } = { successful: {}, success: {}, unchanged: {}, failed: {} };
			const newVersion = this.version + 1;
			let wrote = false;
			objs.forEach((o, i) => {
				const key = String(o.key);
				const id = `${type}:${key}`;
				const existing = this.objects.get(id);
				const { version, ...rest } = o;
				if (existing && Number(version) !== existing.version) {
					out.failed[i] = { key, code: 412, message: `${type} has been modified since specified version` };
					return;
				}
				if (existing) {
					const { version: _v, ...old } = existing.data;
					if (JSON.stringify(sortKeys(old)) === JSON.stringify(sortKeys(rest))) {
						out.unchanged[i] = key;
						return;
					}
				}
				wrote = true;
				const data = { ...rest, key, version: newVersion };
				this.objects.set(id, { version: newVersion, data });
				out.successful[i] = { key, version: newVersion, data };
				out.success[i] = key;
			});
			if (wrote) this.version = newVersion;
			return this.reply(out);
		}
		return new Response("method not allowed", { status: 405 });
	}

	private async fileRoute(req: Request, url: URL, key: string): Promise<Response> {
		if (req.method === "GET") {
			const forced = this.fileStatus.get(key);
			if (forced) return new Response("forced", { status: forced });
			if (!this.files.has(key)) return new Response("no file", { status: 404 });
			return new Response(null, { status: 302, headers: { Location: `${url.origin}/blob/${key}` } });
		}
		if (!this.canWrite) return new Response("read-only key", { status: 403 });
		const form = new URLSearchParams(await req.text());
		if (form.has("upload")) {
			const bytes = this.uploads.get(key);
			if (!bytes) return new Response("no such upload", { status: 400 });
			this.files.set(key, bytes);
			const o = this.objects.get(`item:${key}`)!;
			const v = ++this.version;
			this.objects.set(`item:${key}`, { version: v, data: { ...o.data, version: v, md5: createHash("md5").update(bytes).digest("hex"), mtime: Date.now() } });
			return this.reply(null, 204);
		}
		if (this.files.has(key) && createHash("md5").update(this.files.get(key)!).digest("hex") === form.get("md5")) return this.reply({ exists: 1 });
		return this.reply({ url: `${url.origin}/upload/${key}`, contentType: "application/octet-stream", prefix: "", suffix: "", uploadKey: `UP-${key}` });
	}
}

function sortKeys(v: any): any {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
	return v;
}
