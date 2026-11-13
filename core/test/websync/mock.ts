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

/** What a library on the mock server holds. MockZotero itself is the user library; a GroupLib is one group. */
export interface LibState {
	version: number;
	objects: Map<string, Obj>;
	deleted: { type: "item" | "collection"; key: string; version: number }[];
	files: Map<string, Uint8Array>;
	canWrite: boolean;
}

function makeObject(lib: LibState, type: "item" | "collection", key: string, fields: Record<string, any>): number {
	const v = ++lib.version;
	const base =
		type === "item"
			? { itemType: "journalArticle", title: key, dateAdded: "2026-01-01T00:00:00Z", dateModified: "2026-06-01T10:00:00Z", tags: [], collections: [], relations: {} }
			: { name: key, parentCollection: false, relations: {} };
	lib.objects.set(`${type}:${key}`, { version: v, data: { ...base, ...fields, key, version: v } });
	return v;
}

/** A group library on the mock: its own version, objects, deletions and files, plus the group record zotero.org lists. */
export class GroupLib implements LibState {
	version = 1;
	objects = new Map<string, Obj>();
	deleted: { type: "item" | "collection"; key: string; version: number }[] = [];
	files = new Map<string, Uint8Array>();
	/** Whether the API key may write to this group (the key's own permission). */
	canWrite = true;
	/** The group record's own version (bumped when name or permissions change). */
	recordVersion = 1;
	/** Answer every library request for this group with this status (a broken or forbidden group). */
	failWith: number | null = null;
	constructor(
		readonly id: number,
		public record: Record<string, any>,
	) {}
	put(type: "item" | "collection", key: string, fields: Record<string, any>): number {
		return makeObject(this, type, key, fields);
	}
	remove(type: "item" | "collection", key: string): void {
		const v = ++this.version;
		this.objects.delete(`${type}:${key}`);
		this.deleted.push({ type, key, version: v });
	}
	item(key: string): Obj | undefined {
		return this.objects.get(`item:${key}`);
	}
}

export class MockZotero implements LibState {
	version = 1;
	objects = new Map<string, Obj>(); // "item:KEY" | "collection:KEY"
	deleted: { type: "item" | "collection"; key: string; version: number }[] = [];
	files = new Map<string, Uint8Array>(); // item key -> bytes served by /file
	/** Per file key: force this status from GET /file instead of the normal 302/404. */
	fileStatus = new Map<string, number>();
	log: Logged[] = [];
	canWrite = true;
	/** Groups of the account, by zotero.org group id (see addGroup). */
	groups = new Map<number, GroupLib>();
	/** Override the key's group access reported by /keys/current (default: every group, read and write). */
	groupAccess: Record<string, { library?: boolean; write?: boolean }> | null = null;
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
	/** When set (a page's origin), every response carries CORS headers for it and a preflight is answered: a plain web page's view of the API. */
	corsOrigin: string | null = null;
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
		return makeObject(this, type, key, fields);
	}

	/** Add a group the account belongs to. `record` overrides the group data zotero.org sends (name, libraryEditing, fileEditing, owner, admins, members). */
	addGroup(id: number, record: Record<string, any> = {}): GroupLib {
		const g = new GroupLib(id, {
			id,
			name: `Group ${id}`,
			owner: 7,
			type: "Private",
			libraryEditing: "members",
			libraryReading: "members",
			fileEditing: "members",
			admins: [],
			members: [USER_ID],
			...record,
		});
		this.groups.set(id, g);
		return g;
	}

	/** The account leaves a group. */
	leaveGroup(id: number): void {
		this.groups.delete(id);
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

	private reply(body: unknown, status = 200, extra: Record<string, string> = {}, lib: LibState = this): Response {
		const headers: Record<string, string> = { "Last-Modified-Version": String(lib.version), ...extra };
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
			if (this.corsOrigin && req.method === "OPTIONS") return this.withCors(new Response(null, { status: 204 }));
			const query = Object.fromEntries(url.searchParams);
			const entry: Logged = { method: req.method, path: url.pathname, query, ifUnmodified: req.headers.get("if-unmodified-since-version"), status: 0 };
			this.log.push(entry);
			const res = await this.route(req, url, query, entry);
			entry.status = res.status;
			return this.corsOrigin ? this.withCors(res) : res;
		} finally {
			this.inFlight--;
		}
	}

	private withCors(res: Response): Response {
		const h = new Headers(res.headers);
		h.set("Access-Control-Allow-Origin", this.corsOrigin!);
		h.set("Access-Control-Allow-Headers", "Zotero-API-Key, Zotero-API-Version, Content-Type, If-Match, If-None-Match, If-Unmodified-Since-Version, If-Modified-Since-Version, Zotero-Write-Token");
		h.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
		h.set("Access-Control-Expose-Headers", "Last-Modified-Version, Backoff, Retry-After, Total-Results, Link");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	}

	private async route(req: Request, url: URL, query: Record<string, string>, entry: Logged): Promise<Response> {
		const path = url.pathname;
		// blob host: no API key needed (a real file host never gets the key)
		if (path.startsWith("/blob/")) {
			if (req.headers.get("zotero-api-key") || url.searchParams.has("key")) return new Response("key leaked to the file host", { status: 400 });
			const blobKey = path.slice("/blob/".length);
			const bytes = this.files.get(blobKey) ?? [...this.groups.values()].map((g) => g.files.get(blobKey)).find(Boolean);
			return bytes ? new Response(Buffer.from(bytes)) :new Response("gone", { status: 404 });
		}
		if (path.startsWith("/upload/")) {
			this.uploads.set(path.slice("/upload/".length), new Uint8Array(await req.arrayBuffer()));
			return new Response(null, { status: 201 });
		}
		// the key: the Zotero-API-Key header, or (a web page, keyIn "query") the key parameter, which the real API accepts too
		if ((req.headers.get("zotero-api-key") ?? url.searchParams.get("key")) !== API_KEY) return new Response("Forbidden", { status: 403 });
		if ((req.headers.get("zotero-api-version") ?? url.searchParams.get("v")) !== "3") return new Response("bad version", { status: 400 });
		this.onRequest?.(path, query);
		if (this.throttle > 0) {
			this.throttle--;
			return new Response("slow down", { status: 429, headers: { "Retry-After": String(this.retryAfter) } });
		}

		if (path === "/keys/current") {
			return this.reply({ key: "x", userID: USER_ID, username: "tester", access: { user: { library: true, files: true, notes: true, write: this.canWrite }, groups: this.groupAccess ?? { all: { library: true, write: this.canWrite } } } });
		}
		if (path === `/users/${USER_ID}/groups`) {
			const list = [...this.groups.values()];
			if (query.format === "versions") return this.reply(Object.fromEntries(list.map((g) => [String(g.id), g.recordVersion])));
			return this.reply(list.map((g) => ({ id: g.id, version: g.recordVersion, data: { ...g.record, id: g.id, version: g.recordVersion } })));
		}
		const m = path.match(new RegExp(`^/(?:users/${USER_ID}|groups/(\\d+))/(items|collections|deleted)(?:/([A-Z0-9]{8})/file)?$`));
		if (!m) return new Response("not found", { status: 404 });
		const [, groupId, kind, fileKey] = m;
		const lib: LibState = groupId ? (this.groups.get(Number(groupId)) ?? null)! : this;
		if (!lib) return new Response("no such group", { status: 404 });
		if (lib instanceof GroupLib && lib.failWith) return new Response("broken group", { status: lib.failWith });
		// the key's write permission for this library: the user library's flag, or the group's own
		const keyWrites = lib === this ? this.canWrite : lib.canWrite;
		const r = (body: unknown, status = 200, extra: Record<string, string> = {}) => this.reply(body, status, extra, lib);

		if (fileKey) return this.fileRoute(req, url, fileKey, lib, r, keyWrites);
		if (kind === "deleted") {
			const since = Number(query.since) || 0;
			const d = lib.deleted.filter((x) => x.version > since);
			return r({ collections: d.filter((x) => x.type === "collection").map((x) => x.key), items: d.filter((x) => x.type === "item").map((x) => x.key), searches: [], tags: [], settings: [] });
		}
		const type = kind === "items" ? "item" : "collection";

		if (req.method === "GET") {
			const since = Number(query.since) || 0;
			const all = [...lib.objects.entries()].filter(([k]) => k.startsWith(`${type}:`)).map(([k, o]) => [k.slice(type.length + 1), o] as const);
			if (query.format === "versions") {
				const out: Record<string, number> = {};
				for (const [k, o] of all) if (o.version > since && (type !== "item" || !o.data.deleted || query.includeTrashed === "1")) out[k] = o.version;
				return r(out);
			}
			const wanted = (query.itemKey ?? query.collectionKey ?? "").split(",").filter(Boolean);
			return r(all.filter(([k]) => wanted.includes(k)).map(([k, o]) => ({ key: k, version: o.version, data: o.data })));
		}

		// writes
		if (!keyWrites) return new Response("read-only key", { status: 403 });
		if (Number(req.headers.get("if-unmodified-since-version")) !== lib.version) return new Response("Library has been modified since specified version", { status: 412, headers: { "Last-Modified-Version": String(lib.version) } });
		if (req.method === "DELETE") {
			const keys = (query.itemKey ?? query.collectionKey ?? "").split(",").filter(Boolean);
			entry.size = keys.length;
			lib.version++;
			for (const k of keys) if (lib.objects.delete(`${type}:${k}`)) lib.deleted.push({ type, key: k, version: lib.version });
			return r(null, 204);
		}
		if (req.method === "POST") {
			const objs = (await req.json()) as Record<string, any>[];
			entry.size = objs.length;
			const out: { successful: Record<string, unknown>; success: Record<string, string>; unchanged: Record<string, string>; failed: Record<string, unknown> } = { successful: {}, success: {}, unchanged: {}, failed: {} };
			const newVersion = lib.version + 1;
			let wrote = false;
			objs.forEach((o, i) => {
				const key = String(o.key);
				const id = `${type}:${key}`;
				const existing = lib.objects.get(id);
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
				lib.objects.set(id, { version: newVersion, data });
				out.successful[i] = { key, version: newVersion, data };
				out.success[i] = key;
			});
			if (wrote) lib.version = newVersion;
			return r(out);
		}
		return new Response("method not allowed", { status: 405 });
	}

	private async fileRoute(req: Request, url: URL, key: string, lib: LibState, r: (body: unknown, status?: number, extra?: Record<string, string>) => Response, keyWrites: boolean): Promise<Response> {
		if (req.method === "GET") {
			const forced = this.fileStatus.get(key);
			if (forced) return new Response("forced", { status: forced });
			if (!lib.files.has(key)) return new Response("no file", { status: 404 });
			return new Response(null, { status: 302, headers: { Location: `${url.origin}/blob/${key}` } });
		}
		if (!keyWrites) return new Response("read-only key", { status: 403 });
		const form = new URLSearchParams(await req.text());
		if (form.has("upload")) {
			const bytes = this.uploads.get(key);
			if (!bytes) return new Response("no such upload", { status: 400 });
			lib.files.set(key, bytes);
			const o = lib.objects.get(`item:${key}`)!;
			const v = ++lib.version;
			lib.objects.set(`item:${key}`, { version: v, data: { ...o.data, version: v, md5: createHash("md5").update(bytes).digest("hex"), mtime: Date.now() } });
			return r(null, 204);
		}
		if (lib.files.has(key) && createHash("md5").update(lib.files.get(key)!).digest("hex") === form.get("md5")) return r({ exists: 1 });
		return r({ url: `${url.origin}/upload/${key}`, contentType: "application/octet-stream", prefix: "", suffix: "", uploadKey: `UP-${key}` });
	}
}

function sortKeys(v: any): any {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
	return v;
}
