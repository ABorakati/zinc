// The tab's half of "Import a Zotero or Zinc data folder" (the worker's half is import-run.ts), and the first-run flag.
//
// The folder arrives as a FileSystemDirectoryHandle: from showDirectoryPicker() when the user clicks, or any object shaped like one (the
// headless check hands in a real handle on a folder in the page's own OPFS, because a native folder dialog cannot be driven there).
// Files are sent one by one over the library port (`PUT /api/browser/import/file`; the transport turns large bodies into `up` frames),
// then `POST /api/browser/import/run` runs the import in the worker while this polls `GET /api/browser/import/status`.
import { apiFetch } from "../../src/api";

export interface FileHandleLike { kind: "file"; name: string; getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }> }
export interface DirHandleLike {
	kind: "directory";
	name: string;
	entries?(): AsyncIterable<[string, FileHandleLike | DirHandleLike]>;
	values?(): AsyncIterable<FileHandleLike | DirHandleLike>;
}
export type FolderKind = "zotero" | "zinc";
export interface FolderInfo { kind: FolderKind; root: DirHandleLike; /** the folder that holds the database: the one picked, or a folder inside it */ where: string }
export interface Progress { phase: string; done?: number; total?: number; message?: string; bytes?: number; totalBytes?: number }
export interface ImportSummary {
	kind: FolderKind; items: number; topLevelItems: number; collections: number; attachments: number; annotations: number;
	fileFolders: number; missingFiles: number; linkedFiles: number; warnings: string[]; ms: number;
}

async function* children(dir: DirHandleLike): AsyncGenerator<FileHandleLike | DirHandleLike> {
	if (dir.entries) for await (const [, h] of dir.entries()) yield h;
	else if (dir.values) for await (const h of dir.values()) yield h;
}

const DB_NAME: Record<FolderKind, string> = { zotero: "zotero.sqlite", zinc: "library.sqlite" };

async function find(dir: DirHandleLike, name: string): Promise<FileHandleLike | null> {
	for await (const h of children(dir)) if (h.kind === "file" && h.name === name) return h;
	return null;
}

/** Which kind of data folder this is: zotero.sqlite (Zotero) or library.sqlite (Zinc), in the folder itself or one level down. */
export async function inspectFolder(dir: DirHandleLike): Promise<FolderInfo | { problem: string }> {
	const look = async (d: DirHandleLike, where: string): Promise<FolderInfo | null> => {
		if (await find(d, DB_NAME.zotero)) return { kind: "zotero", root: d, where };
		if (await find(d, DB_NAME.zinc)) return { kind: "zinc", root: d, where };
		return null;
	};
	const here = await look(dir, dir.name);
	if (here) return here;
	for await (const h of children(dir)) {
		if (h.kind !== "directory") continue;
		const inner = await look(h, `${dir.name}/${h.name}`);
		if (inner) return inner;
	}
	return { problem: "That folder has no zotero.sqlite (a Zotero data folder) or library.sqlite (a Zinc library folder) in it." };
}

interface Entry { rel: string; file: FileHandleLike }
/** The database, and everything under storage/ (without Zotero's housekeeping files; the full-text cache is kept). */
async function collect(info: FolderInfo): Promise<Entry[]> {
	const out: Entry[] = [];
	const db = DB_NAME[info.kind];
	for await (const h of children(info.root)) {
		if (h.kind === "file" && (h.name === db || h.name === `${db}-wal`)) out.push({ rel: h.name, file: h });
	}
	const walk = async (dir: DirHandleLike, rel: string): Promise<void> => {
		for await (const h of children(dir)) {
			if (h.kind === "directory") { await walk(h, `${rel}/${h.name}`); continue; }
			if (h.name.startsWith(".") && h.name !== ".zotero-ft-cache") continue;
			out.push({ rel: `${rel}/${h.name}`, file: h });
		}
	};
	for await (const h of children(info.root)) if (h.kind === "directory" && h.name === "storage") await walk(h, "storage");
	return out;
}

const text = async (res: Response): Promise<string> => {
	const t = await res.text();
	try { return String((JSON.parse(t) as { error?: string }).error ?? t); } catch { return t; }
};

/**
 * Send the folder to the worker and import it. `onProgress` is called as files go over and while the worker runs the importer.
 * Resolves to what was imported; rejects with a message the screen can show. The worker deletes its temporary copy either way.
 */
export async function importFolder(dir: DirHandleLike, onProgress: (p: Progress) => void): Promise<ImportSummary> {
	const info = await inspectFolder(dir);
	if ("problem" in info) throw new Error(info.problem);
	onProgress({ phase: "upload", message: "Looking through the folder" });
	const entries = await collect(info);
	let totalBytes = 0;
	const sizes = new Map<string, number>();
	for (const e of entries) { const s = (await e.file.getFile()).size; sizes.set(e.rel, s); totalBytes += s; }
	let done = 0;
	let bytes = 0;
	const put = async (e: Entry): Promise<void> => {
		const f = await e.file.getFile();
		const body = new Uint8Array(await f.arrayBuffer());
		const res = await apiFetch(`/browser/import/file?path=${encodeURIComponent(`${info.kind}/${e.rel}`).replace(/%2F/g, "/")}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body });
		if (!res.ok) throw new Error(`Could not copy ${e.rel}: ${await text(res)}`);
		done++;
		bytes += body.length;
		onProgress({ phase: "upload", done, total: entries.length, bytes, totalBytes });
	};
	try {
		// the database first (it is what the import needs), then the files, a few at a time
		for (const e of entries.filter((x) => !x.rel.includes("/"))) await put(e);
		const rest = entries.filter((x) => x.rel.includes("/"));
		let next = 0;
		await Promise.all(Array.from({ length: 3 }, async () => { while (next < rest.length) await put(rest[next++]!); }));

		onProgress({ phase: "snapshot", message: "Reading the database" });
		let finished = false;
		const poll = (async () => {
			while (!finished) {
				await new Promise((r) => setTimeout(r, 250));
				if (finished) break;
				try {
					const s = (await (await apiFetch("/browser/import/status")).json()) as { phase: string; done?: number; total?: number; message?: string };
					if (!finished && s.phase !== "idle" && s.phase !== "done") onProgress({ phase: s.phase, done: s.done, total: s.total, message: s.message });
				} catch { /* the next poll */ }
			}
		})();
		let res: Response;
		try {
			res = await apiFetch("/browser/import/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: info.kind }) });
		} finally { finished = true; await poll; }
		if (!res.ok) throw new Error(await text(res));
		return (await res.json()) as ImportSummary;
	} catch (e) {
		await apiFetch("/browser/import", { method: "DELETE" }).catch(() => {});
		throw e;
	}
}

// ---- the first-run flag: chrome.storage.local "zincBrowserLibrary" = {saveTarget, firstRunDone} (browser-db/CONTRACT.md)

const KEY = "zincBrowserLibrary";
interface Store { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> }
const storage = (): Store => {
	const c = (globalThis as { chrome?: { storage?: { local?: Store } } }).chrome?.storage?.local;
	if (c) return c;
	// no storage permission (a page outside the extension): this tab's own storage
	return { get: async (k) => { try { return { [k]: JSON.parse(localStorage.getItem(k) ?? "null") }; } catch { return {}; } }, set: async (o) => { for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); } };
};
export async function readFirstRunDone(): Promise<boolean> {
	const v = (await storage().get(KEY))[KEY] as { firstRunDone?: boolean } | undefined;
	return v?.firstRunDone === true;
}
/** Keeps the other setting (saveTarget) as it is. */
export async function setFirstRunDone(): Promise<void> {
	const cur = ((await storage().get(KEY))[KEY] ?? {}) as Record<string, unknown>;
	await storage().set({ [KEY]: { saveTarget: "browser", ...cur, firstRunDone: true } });
}

/** Is the library empty? (Items and collections: a library with only collections is not new.) */
export async function libraryIsEmpty(): Promise<boolean> {
	const res = await apiFetch("/browser/state");
	if (!res.ok) return false;
	const n = (await res.json()) as { items: number; collections: number };
	return n.items + n.collections === 0;
}

/** The Export library command: download the library as one zip. Resolves to what was exported. */
export async function exportLibrary(): Promise<{ bytes: number; name: string; summary: Record<string, number> }> {
	const res = await apiFetch("/browser/export");
	if (!res.ok) throw new Error(await text(res));
	const data = await res.arrayBuffer();
	const name = `zinc-library-${new Date().toISOString().slice(0, 10)}.zip`;
	const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	let summary: Record<string, number> = {};
	try { summary = JSON.parse(res.headers.get("X-Zinc-Export") ?? "{}"); } catch { /* none */ }
	return { bytes: data.byteLength, name, summary };
}
