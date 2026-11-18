// `attachments` (library.wit): attachment info, file bytes, import / link / rename, Find Full Text, view state.
// Bytes cross the boundary, paths do not: core reads and writes the files, this handler only moves bytes over HTTP.
import { mkdir, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineHandler, witError, type HandlerContext } from "./registry";
import { core, coreJson, parseJson, pmap } from "./data/core";
import { requirePermission } from "./data/perm";
import { getDetail, orderAttachments, type CoreDetail } from "./data/library-map";
import { fetchForHandler } from "./net.host";

const READ_CHUNK_MAX = 8 * 1024 * 1024;
const READ_ALL_MAX = 64 * 1024 * 1024;
const WRITE_MAX = 64 * 1024 * 1024;
const WRITER_MAX = 2 * 1024 * 1024 * 1024;

const linkMode = (m: string | undefined) => (m ?? "linked_url").replace(/_/g, "-");

async function attachmentDetail(ctx: HandlerContext, key: string): Promise<CoreDetail> {
	const d = await getDetail(ctx, key);
	if (!d) throw witError("not-found", `attachment ${key}`);
	if (d.data.itemType !== "attachment") throw witError("invalid-argument", `${key} is not an attachment`);
	return d;
}

interface ImportRequest {
	parent?: string;
	library?: number;
	filename: string;
	contentType?: string;
	title?: string;
	url?: string;
	collections: string[];
	data: Uint8Array;
}

/** Store `request` (bytes, or an existing file on disk that core copies) as a new attachment. */
async function importFile(ctx: HandlerContext, r: Omit<ImportRequest, "data">, source: { data?: Uint8Array; path?: string }): Promise<string> {
	if (!r.filename || /[\\/\0]/.test(r.filename)) throw witError("invalid-argument", "filename must be a plain file name");
	const body: Record<string, unknown> = {
		name: r.filename,
		contentType: r.contentType,
		mode: "imported_file",
		parentKey: r.parent,
		collectionKey: r.collections[0],
		library: r.library,
	};
	if (source.path) body.path = source.path;
	else body.dataBase64 = Buffer.from(source.data!).toString("base64");
	const made = await coreJson<{ data: { key: string } }>(ctx, "/api/add/file", { json: body });
	const key = made.data.key;
	const patch: Record<string, unknown> = {};
	if (r.title) patch.title = r.title;
	if (r.url) patch.url = r.url;
	if (Object.keys(patch).length) await core(ctx, `/api/items/${key}`, { method: "PATCH", json: { data: patch } });
	for (const c of r.collections.slice(1)) await core(ctx, `/api/collections/${encodeURIComponent(c)}/items`, { json: { keys: [key] } });
	return key;
}

interface WriterState {
	request: Omit<ImportRequest, "data">;
	dir: string;
	file: string;
	size: number;
	done: boolean;
	failed?: string;
}

export default defineHandler({
	interface: "zinc:plugin/attachments",
	where: "host",
	functions: {
		async "get-info"(ctx, keys: string[]) {
			requirePermission(ctx, "library.read");
			if (keys.length > 1000) throw witError("limit-exceeded", "at most 1000 keys per call");
			return pmap(keys, 8, async (key) => {
				const d = await getDetail(ctx, key);
				if (!d || d.data.itemType !== "attachment") return undefined;
				const lm = linkMode(d.data.linkMode);
				let fileExists: boolean | undefined;
				let size: bigint | undefined;
				if (lm !== "linked-url") {
					const res = await fetch(`${ctx.coreUrl}/api/attachments/${key}/file`, { method: "HEAD" }).catch(() => undefined);
					fileExists = res?.ok === true;
					const len = res?.headers.get("content-length");
					if (fileExists && len) size = BigInt(len);
				}
				return {
					key,
					parent: d.data.parentItem || undefined,
					linkMode: lm,
					contentType: d.data.contentType || undefined,
					charset: undefined, // needs core: no charset column
					filename: d.data.filename || undefined,
					url: d.data.url || undefined,
					fileExists,
					size,
					path: undefined, // needs core: no HTTP route returns the path (library.files.paths)
					lastRead: undefined, // needs core: no lastRead column
				};
			});
		},

		async "best-attachment"(ctx, item: string) {
			requirePermission(ctx, "library.read");
			const d = await getDetail(ctx, item);
			if (!d) throw witError("not-found", `item ${item}`);
			return orderAttachments(d.children)[0];
		},

		async "best-attachments"(ctx, item: string) {
			requirePermission(ctx, "library.read");
			const d = await getDetail(ctx, item);
			if (!d) throw witError("not-found", `item ${item}`);
			return orderAttachments(d.children);
		},

		// ------------------------------------------------------------------------------- file bytes
		async "read-file"(ctx, key: string, offset: bigint, length: number) {
			requirePermission(ctx, "library.files.read");
			const len = Math.min(length, READ_CHUNK_MAX);
			if (len <= 0) return new Uint8Array(0);
			const res = await fetch(`${ctx.coreUrl}/api/attachments/${key}/file`, { headers: { Range: `bytes=${offset}-${offset + BigInt(len) - 1n}` } });
			if (res.status === 416) return new Uint8Array(0);
			if (res.status === 404) throw witError("not-found", `file of ${key}`);
			if (!res.ok && res.status !== 206) throw witError("internal", `core answered ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			return res.status === 200 ? bytes.subarray(Number(offset), Number(offset) + len) : bytes;
		},

		async "read-file-all"(ctx, key: string, maxBytes: bigint) {
			requirePermission(ctx, "library.files.read");
			const cap = maxBytes < BigInt(READ_ALL_MAX) ? maxBytes : BigInt(READ_ALL_MAX);
			const head = await fetch(`${ctx.coreUrl}/api/attachments/${key}/file`, { method: "HEAD" });
			if (head.status === 404) throw witError("not-found", `file of ${key}`);
			const size = BigInt(head.headers.get("content-length") ?? "0");
			if (size > cap) throw witError("limit-exceeded", `file is ${size} bytes, over the ${cap} byte limit`);
			const res = await core(ctx, `/api/attachments/${key}/file`);
			return new Uint8Array(await res.arrayBuffer());
		},

		// --------------------------------------------------------------------------- create attachments
		async "import-bytes"(ctx, r: ImportRequest) {
			requirePermission(ctx, "library.files.write");
			if (r.data.byteLength > WRITE_MAX) throw witError("limit-exceeded", `over ${WRITE_MAX} bytes: use file-writer`);
			return importFile(ctx, r, { data: r.data });
		},

		async "import-from-url"(ctx, r: { parent?: string; library?: number; url: string; title?: string; contentType?: string; collections: string[] }) {
			requirePermission(ctx, "library.files.write");
			const res = await fetchForHandler(ctx, r.url, WRITE_MAX);
			const data = res.body;
			const u = new URL(res.url || r.url);
			const filename = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/[\\/:*?"<>|\0]/g, "_") || "download";
			const contentType = r.contentType ?? res.contentType?.split(";")[0].trim();
			return importFile(ctx, { parent: r.parent, library: r.library, filename, contentType, title: r.title, url: r.url, collections: r.collections }, { data });
		},

		async "link-file"(ctx, r: { parent?: string; library?: number; path: string; title?: string; contentType?: string }) {
			requirePermission(ctx, "library.files.write");
			requirePermission(ctx, "library.files.paths");
			const made = await coreJson<{ data: { key: string } }>(ctx, "/api/add/file", {
				json: { name: r.path.split(/[\\/]/).pop(), contentType: r.contentType, mode: "linked_file", path: r.path, parentKey: r.parent, library: r.library },
			});
			if (r.title) await core(ctx, `/api/items/${made.data.key}`, { method: "PATCH", json: { data: { title: r.title } } });
			return made.data.key;
		},

		async "link-url"(ctx, r: { parent?: string; library?: number; url: string; title?: string }) {
			requirePermission(ctx, "library.files.write");
			const made = await coreJson<{ data: { key: string } }>(ctx, "/api/add/link", { json: { url: r.url, title: r.title, parentKey: r.parent, library: r.library } });
			return made.data.key;
		},

		// ------------------------------------------------------------------------------- change files
		async "replace-file"(ctx, key: string, data: Uint8Array, filename: string | undefined) {
			requirePermission(ctx, "library.files.write");
			if (data.byteLength > WRITE_MAX) throw witError("limit-exceeded", `over ${WRITE_MAX} bytes`);
			if (filename) throw witError("unavailable", "replace-file with a new file name needs core support; use rename-file after replacing");
			await attachmentDetail(ctx, key);
			await core(ctx, `/api/attachments/${key}/file`, { method: "PUT", json: { dataBase64: Buffer.from(data).toString("base64") } });
		},

		async "rename-file"(_ctx, _key: string, _newName: string, _overwrite: boolean) {
			requirePermission(_ctx, "library.files.write");
			throw witError("unavailable", "rename-file to an explicit name needs a core route (core renames by template only: rename-by-template)");
		},

		async "rename-by-template"(ctx, keys: string[]) {
			requirePermission(ctx, "library.files.write");
			const r = await coreJson<{ results: { key?: string; attachmentKey?: string; newName?: string; name?: string; error?: string; renamed?: boolean }[] }>(ctx, "/api/maintenance/rename-files", {
				json: { attachmentKeys: keys },
			});
			return keys.map((k, i) => {
				const x = r.results[i] ?? {};
				return { key: k, newName: x.newName ?? x.name ?? undefined, error: x.error ?? undefined };
			});
		},

		async "delete-file"(ctx, key: string) {
			requirePermission(ctx, "library.files.write");
			await attachmentDetail(ctx, key);
			throw witError("unavailable", "delete-file needs a core route that removes the file and keeps the item");
		},

		async "relink-file"(ctx, _key: string, _path: string) {
			requirePermission(ctx, "library.files.write");
			requirePermission(ctx, "library.files.paths");
			throw witError("unavailable", "relink-file needs a core route");
		},

		// ----------------------------------------------------------------------------- open and show
		async "reveal-file"(ctx, key: string) {
			requirePermission(ctx, "library.files.open");
			await core(ctx, `/api/attachments/${key}/reveal`, { method: "POST", json: {} });
		},

		async "open-file-external"(ctx, key: string) {
			requirePermission(ctx, "library.files.open");
			// core refuses a file that can run code unless {"confirm": true}; a plugin never sets it
			await core(ctx, `/api/attachments/${key}/open-external`, { method: "POST", json: {} });
		},

		async "storage-of"(ctx, key: string) {
			requirePermission(ctx, "library.read");
			const d = await attachmentDetail(ctx, key);
			const head = await fetch(`${ctx.coreUrl}/api/attachments/${key}/file`, { method: "HEAD" }).catch(() => undefined);
			const ok = head?.ok === true && linkMode(d.data.linkMode) !== "linked-url";
			return { fileCount: ok ? 1 : 0, totalBytes: ok ? BigInt(head!.headers.get("content-length") ?? "0") : 0n };
		},

		// ---------------------------------------------------------------------------------- view state
		async "get-view-state"(ctx, key: string) {
			requirePermission(ctx, "library.read");
			const v = await coreJson<unknown>(ctx, `/api/attachments/${key}/view-state`);
			return v === null ? undefined : JSON.stringify(v);
		},

		async "set-view-state"(ctx, key: string, state: string) {
			requirePermission(ctx, "library.write");
			const v = parseJson(state, "state");
			if (typeof v !== "object" || v === null || Array.isArray(v)) throw witError("invalid-argument", "state must be a JSON object");
			await core(ctx, `/api/attachments/${key}/view-state`, { method: "PUT", json: v });
		},

		// ------------------------------------------------------------------------------ find full text
		async "find-available-files"(ctx, keys: string[], openAccessOnly: boolean) {
			requirePermission(ctx, "library.files.write");
			const r = await coreJson<{ jobId: string }>(ctx, "/api/fulltext/find", { json: { keys, openAccessOnly } });
			return r.jobId;
		},

		async "get-find-job"(ctx, id: string) {
			requirePermission(ctx, "library.read");
			const j = await coreJson<{ id: string; done: boolean; items: { key: string; state: string; attachmentKey?: string; message?: string }[] }>(ctx, `/api/fulltext/jobs/${encodeURIComponent(id)}`);
			return { id: j.id, done: j.done, items: j.items.map((i) => ({ key: i.key, state: i.state, attachment: i.attachmentKey, message: i.message })) };
		},

		async "cancel-find-job"(ctx, id: string) {
			requirePermission(ctx, "library.files.write");
			await core(ctx, `/api/fulltext/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", json: {} });
		},
	},

	resources: {
		"file-writer": {
			create(ctx, request: ImportRequest) {
				requirePermission(ctx, "library.files.write");
				const { data: _d, ...rest } = request;
				if (!rest.filename || /[\\/\0]/.test(rest.filename)) throw witError("invalid-argument", "filename must be a plain file name");
				const dir = join(tmpdir(), "zinc-plugin-import", crypto.randomUUID());
				return mkdir(dir, { recursive: true }).then(async (): Promise<WriterState> => {
					const file = join(dir, rest.filename);
					await writeFile(file, new Uint8Array(0));
					return { request: rest, dir, file, size: 0, done: false };
				});
			},
			methods: {
				async append(_ctx, self: WriterState, chunk: Uint8Array) {
					if (self.done) throw witError("invalid-argument", "the writer is finished");
					self.size += chunk.byteLength;
					if (self.size > WRITER_MAX) throw witError("limit-exceeded", "over 2 GiB");
					await appendFile(self.file, chunk);
				},
				async finish(ctx, self: WriterState) {
					if (self.done) throw witError("invalid-argument", "the writer is finished");
					self.done = true;
					try {
						return await importFile(ctx, self.request, { path: self.file });
					} finally {
						await rm(self.dir, { recursive: true, force: true }).catch(() => {});
					}
				},
			},
			async drop(_ctx, self: WriterState | undefined) {
				if (self?.dir) await rm(self.dir, { recursive: true, force: true }).catch(() => {});
			},
		},
	},
});

