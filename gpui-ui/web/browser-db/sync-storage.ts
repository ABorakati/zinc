// The few chrome.storage values zotero.org sync needs, for a worker that has no `chrome` (browser-db/CONTRACT.md, "zotero.org sync").
// Pure code with no imports from the core, so offscreen.ts can use the answering half without pulling the sync code into its bundle.
//
// - storageClient (worker): a StorageArea whose calls become {t:"storage", rid, op, name, value} messages to the offscreen document.
// - answerStorage (offscreen): answers them. Only STORAGE_NAMES are reachable and only the API key is writable. With chrome.storage in
//   this page it is used directly; otherwise (an offscreen document gets only chrome.runtime) the extension's service worker is asked
//   with {zincStorage: {op, name, value}} and replies {ok: true, value} or {ok: false, error}.
// - The test-only API base: chrome.storage.local "zincTestZoteroApiBase", honoured only when it is exactly http://127.0.0.1:<port>.
import { KEY_STORAGE_NAME, type StorageArea } from "./keystore-chrome";

export const TEST_API_BASE_NAME = "zincTestZoteroApiBase";
export const DEFAULT_API_BASE = "https://api.zotero.org";
const TEST_API_BASE = /^http:\/\/127\.0\.0\.1:\d+$/;

/** The base URL sync talks to: zotero.org, or (test only) a local mock when the stored override matches the pattern. */
export function apiBaseFrom(stored: unknown): string {
	return typeof stored === "string" && TEST_API_BASE.test(stored) ? stored : DEFAULT_API_BASE;
}

/** The storage names the worker may reach through the offscreen document. Nothing else is readable or writable. */
export const STORAGE_NAMES: readonly string[] = [KEY_STORAGE_NAME, TEST_API_BASE_NAME];
/** The override is set by a test through the extension's own page, never by the worker: only the key is writable. */
const WRITABLE = new Set<string>([KEY_STORAGE_NAME]);

export type StorageOp = { op: "get" | "set" | "remove"; name: string; value?: unknown };

export interface StorageClient {
	area: StorageArea;
	/** Feed the offscreen document's {t:"storage-res"} messages here. */
	onReply(m: { rid: number; value?: unknown; error?: string }): void;
}

export function storageClient(send: (m: { t: "storage"; rid: number } & StorageOp) => void): StorageClient {
	let next = 1;
	const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
	const ask = (o: StorageOp) =>
		new Promise<unknown>((ok, fail) => {
			const rid = next++;
			const timer = setTimeout(() => { waiting.delete(rid); fail(new Error("the extension did not answer a storage request")); }, 10_000);
			waiting.set(rid, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
			send({ t: "storage", rid, ...o });
		});
	return {
		area: {
			async get(name) { return { [name]: await ask({ op: "get", name }) }; },
			async set(items) { for (const [name, value] of Object.entries(items)) await ask({ op: "set", name, value }); },
			async remove(name) { await ask({ op: "remove", name }); },
		},
		onReply(m) {
			const w = waiting.get(m.rid);
			if (!w) return;
			waiting.delete(m.rid);
			if (m.error) w.fail(new Error(m.error)); else w.ok(m.value);
		},
	};
}

interface ChromeLike {
	storage?: { local?: StorageArea };
	runtime: { sendMessage(m: unknown): Promise<unknown> };
}

export async function answerStorage(chrome: ChromeLike, m: { rid: number } & StorageOp): Promise<{ t: "storage-res"; rid: number; value?: unknown; error?: string }> {
	const rid = m.rid;
	try {
		if (!STORAGE_NAMES.includes(m.name)) throw new Error("storage name not allowed");
		if (m.op !== "get" && !WRITABLE.has(m.name)) throw new Error("storage name is read-only here");
		const area = chrome.storage?.local;
		if (area) {
			if (m.op === "get") return { t: "storage-res", rid, value: (await area.get(m.name))[m.name] };
			if (m.op === "set") await area.set({ [m.name]: m.value });
			else await area.remove(m.name);
			return { t: "storage-res", rid };
		}
		const r = (await chrome.runtime.sendMessage({ zincStorage: { op: m.op, name: m.name, value: m.value } })) as { ok?: boolean; value?: unknown; error?: string } | undefined;
		if (!r?.ok) throw new Error(r?.error ?? "the extension's service worker did not handle zincStorage");
		return { t: "storage-res", rid, value: r.value };
	} catch (e) {
		return { t: "storage-res", rid, error: e instanceof Error ? e.message : String(e) };
	}
}

// ---- plain web page (page-library.ts): the key area is IndexedDB, not chrome.storage
//
// The database worker of a plain page can use IndexedDB itself, so no proxy through another document is needed. The same two names as
// above live in one object store of one database of the page's origin. This is NOT private from the page: any script of the same
// origin can read it (browser-db/CONTRACT.md, "Plain web page"), so the page must load no third-party scripts.

export const PAGE_KEYS_DB = "zinc-page-keys";
const PAGE_KEYS_STORE = "kv";

/** A StorageArea over IndexedDB (db "zinc-page-keys", store "kv"). `idb` is the IDBFactory (a fake in tests). */
export function pageStorageArea(idb: IDBFactory = indexedDB): StorageArea {
	let opened: Promise<IDBDatabase> | null = null;
	const open = () =>
		(opened ??= new Promise<IDBDatabase>((ok, fail) => {
			const r = idb.open(PAGE_KEYS_DB, 1);
			r.onupgradeneeded = () => r.result.createObjectStore(PAGE_KEYS_STORE);
			r.onsuccess = () => ok(r.result);
			r.onerror = () => { opened = null; fail(r.error ?? new Error("cannot open the page key store")); };
		}));
	const run = async (mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | IDBRequest[]): Promise<unknown> => {
		const d = await open();
		return new Promise<unknown>((ok, fail) => {
			const tx = d.transaction(PAGE_KEYS_STORE, mode);
			const req = f(tx.objectStore(PAGE_KEYS_STORE));
			tx.oncomplete = () => ok(Array.isArray(req) ? undefined : req.result);
			tx.onerror = tx.onabort = () => fail(tx.error ?? new Error("the page key store failed"));
		});
	};
	return {
		async get(name) {
			const v = await run("readonly", (s) => s.get(name));
			return v === undefined ? {} : { [name]: v };
		},
		async set(items) {
			await run("readwrite", (s) => Object.entries(items).map(([k, v]) => s.put(v, k)));
		},
		async remove(name) {
			await run("readwrite", (s) => s.delete(name));
		},
	};
}
