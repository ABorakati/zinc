// Loads DocStructure (see ../contract.ts) from Zotero's document worker (the engine behind Reading Mode).
// Same approach as reader-host/src/host.js: run worker.js in the page, ask it for the SDT pack, cache the pack
// bytes in the Cache API (the SAME cache + keys as host.js, so Reading Mode and this reader share the work),
// then decode the pack and convert it. The converted DocStructure is cached too.
import type { DocStructure, LoadStructure } from "../contract";
import { CONVERTER_VERSION, convertSdt, type Sdt } from "./convert";
import { openPack, SDT_PACK_VERSION, SDT_SCHEMA_VERSION } from "./vendor";
import { DocumentWorker } from "./worker";

const SDT_CACHE = "zotero-next-sdt-v1"; // shared with reader-host/src/host.js
const STRUCT_CACHE = "reader-next-structure-v1";
const WORKER_URL = "/reader-host/document-worker/worker.js";

const sdtPrefix = (key: string) => `https://sdt.zotero-next.invalid/${encodeURIComponent(key)}?`;
const structPrefix = (key: string) => `https://structure.zotero-next.invalid/${encodeURIComponent(key)}?`;
const sdtCacheUrl = (key: string, size: number) => `${sdtPrefix(key)}size=${size}&pack=${SDT_PACK_VERSION}&schema=${SDT_SCHEMA_VERSION}`;
const structCacheUrl = (key: string, size: number) =>
	`${structPrefix(key)}size=${size}&conv=${CONVERTER_VERSION}&pack=${SDT_PACK_VERSION}&schema=${SDT_SCHEMA_VERSION}`;

// The worker requires sourceHash to be a 32-char lowercase hex string. Must match host.js exactly.
export async function stableSourceHash(key: string): Promise<string> {
	if (/^[0-9a-f]{32}$/.test(key)) return key;
	try {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zotero-next:" + key));
		return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	catch {
		let out = "";
		for (let seed = 0; seed < 4; seed++) {
			let h = 0x811c9dc5 ^ seed;
			for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
			out += (h >>> 0).toString(16).padStart(8, "0");
		}
		return out;
	}
}

async function cacheGet(name: string, url: string): Promise<Response | null> {
	try { return (await (await caches.open(name)).match(url)) ?? null; } catch { return null; }
}
async function cachePut(name: string, prefix: string, url: string, body: BodyInit, type?: string) {
	try {
		const cache = await caches.open(name);
		for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req); // stale sizes/versions
		await cache.put(url, new Response(body, type ? { headers: { "Content-Type": type } } : undefined));
	}
	catch (e) { console.warn("[structure] cache write failed", e); }
}

let worker: DocumentWorker | null = null;
const inflight = new Map<string, Promise<DocStructure>>();
const progressListeners = new Map<string, Set<(pct: number) => void>>();

async function build(key: string, pdf: ArrayBuffer): Promise<DocStructure> {
	const size = pdf.byteLength;
	const emit = (pct: number) => { for (const f of progressListeners.get(key) ?? []) f(pct); };
	emit(0);

	const sUrl = structCacheUrl(key, size);
	const hit = await cacheGet(STRUCT_CACHE, sUrl);
	if (hit) {
		try { const d = (await hit.json()) as DocStructure; emit(100); return d; } catch { /* rebuild */ }
	}

	// SDT pack: cached bytes, else ask the worker
	const pUrl = sdtCacheUrl(key, size);
	let packBytes: ArrayBuffer | null = null;
	const cached = await cacheGet(SDT_CACHE, pUrl);
	if (cached) packBytes = await cached.arrayBuffer();
	if (!packBytes) {
		worker ??= new DocumentWorker(WORKER_URL);
		const buf = pdf.slice(0); // the worker transfers (detaches) its copy
		const result = await worker.query<{ buf?: ArrayBuffer }>(
			"getStructuredDocumentText",
			{ buf, contentType: "application/pdf", sourceHash: await stableSourceHash(key), reportProgress: true },
			[buf],
			(p) => emit(Math.max(0, Math.min(95, p <= 1 ? p * 95 : p))),
		);
		if (!result?.buf) throw new Error("The document worker produced no structure");
		packBytes = result.buf;
		await cachePut(SDT_CACHE, sdtPrefix(key), pUrl, packBytes.slice(0));
	}
	emit(96);

	const reader = await openPack(packBytes);
	const sdt = (await reader.materialize()) as Sdt;
	const doc = convertSdt(sdt);
	emit(100);
	await cachePut(STRUCT_CACHE, structPrefix(key), sUrl, JSON.stringify(doc), "application/json");
	return doc;
}

/**
 * Concurrent callers for the same attachment (reflow + academic) share one run.
 * onProgress receives 0..100.
 */
export const loadStructure: LoadStructure = (attachmentKey, pdfBytes, onProgress) => {
	if (onProgress) {
		let set = progressListeners.get(attachmentKey);
		if (!set) progressListeners.set(attachmentKey, (set = new Set()));
		set.add(onProgress);
	}
	let p = inflight.get(attachmentKey);
	if (!p) {
		p = build(attachmentKey, pdfBytes).finally(() => { progressListeners.delete(attachmentKey); });
		inflight.set(attachmentKey, p);
		// keep successes (a re-open in the same page is instant); drop failures so a retry can happen
		p.catch(() => inflight.delete(attachmentKey));
	}
	return p;
};
