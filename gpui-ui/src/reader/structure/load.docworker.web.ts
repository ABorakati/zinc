// src/reader/structure/load.ts for the browser builds that have layout analysis: the same loadStructure / shutdownStructureWorker, with
// Zotero's document worker (vendor/document-worker/build/worker.js, built for a browser Web Worker) running as a real Web Worker.
// Only load.web.ts imports this file, and only when web/build.ts defined __ZN_DOCWORKER__ (the worker's build is there and gets copied to
// <output>/docworker/, with a boot script that loads it and says when it is ready). The worker's own requests for cmaps, standard
// fonts, wasm and models are fetched from that folder (on the desktop src/reader/structure/worker.ts reads them from disk). The SDT pack
// is decoded with Zotero's reader (structured-document-text, bundled from the document-worker checkout, the same file as vendor/reader's),
// inflating with fflate where the desktop uses node:zlib. Results are kept for the tab's life (no disk cache).
import { inflateSync } from "fflate";
import { openStructuredDocumentTextPack } from "../../../../vendor/document-worker/structured-document-text/src/pack/reader.js";
import { convertSdt, type Sdt } from "./convert";
import { fingerprint, latestPerAttachment } from "./memo";
import type { DocStructure } from "./types";

const DIR = new URL("docworker/", import.meta.url);

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	onProgress?: (p: number) => void;
}
interface WorkerMessage {
	__ready?: boolean;
	progressID?: number;
	responseID?: number;
	id?: number;
	action?: string;
	data?: any;
	error?: unknown;
} // eslint-disable-line @typescript-eslint/no-explicit-any

class DocumentWorker {
	private worker: Worker | null;
	private pending = new Map<number, Pending>();
	private last = 0;
	private ready: Promise<void>;
	private failed = false;

	/** False once the worker crashed, never started in time or was terminated: every query then fails, so the owner makes a new one. */
	get usable(): boolean {
		return this.worker !== null && !this.failed;
	}

	constructor() {
		const w = new Worker(new URL("boot.js", DIR));
		this.worker = w;
		this.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.failed = true;
				reject(new Error("The document worker did not start"));
			}, 60_000);
			w.addEventListener("message", (ev: MessageEvent) => {
				if ((ev.data as WorkerMessage)?.__ready) {
					clearTimeout(timer);
					resolve();
				}
			});
			w.addEventListener("error", (ev: ErrorEvent) => {
				clearTimeout(timer);
				for (const p of this.pending.values()) p.reject(new Error("Document worker unavailable"));
				this.pending.clear();
				this.worker = null;
				this.failed = true;
				reject(new Error(`Document worker unavailable: ${ev.message || String(ev)}`));
			});
		});
		this.ready.catch(() => {});
		w.addEventListener("message", (ev: MessageEvent) => void this.onMessage(ev.data as WorkerMessage));
	}

	private async onMessage(m: WorkerMessage): Promise<void> {
		if (m.__ready) return;
		if (m.progressID) {
			this.pending.get(m.progressID)?.onProgress?.(m.data?.progress);
			return;
		}
		if (m.responseID) {
			const p = this.pending.get(m.responseID);
			if (!p) return;
			this.pending.delete(m.responseID);
			if ("error" in m) p.reject(new Error(JSON.stringify(m.error)));
			else p.resolve(m.data);
			return;
		}
		if (m.id) {
			let data: unknown = null;
			try {
				const bytes = async (path: string) => {
					const r = await fetch(new URL(path, DIR));
					if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
					return new Uint8Array(await r.arrayBuffer());
				};
				switch (m.action) {
					case "FetchBuiltInCMap":
						data = { isCompressed: true, cMapData: await bytes(`cmaps/${m.data}.bcmap`) };
						break;
					case "FetchStandardFontData":
						data = await bytes(`standard_fonts/${m.data}`);
						break;
					case "FetchWasm":
						data = await bytes(`wasm/${m.data}`);
						break;
					case "FetchData":
						data = await bytes(String(m.data));
						break;
				}
			} catch (e) {
				console.warn(`[structure] document worker ${m.action} failed:`, e);
			}
			this.worker?.postMessage({ responseID: m.id, data });
		}
	}

	async query<T>(action: string, data: unknown, transfer: Transferable[] = [], onProgress?: (p: number) => void): Promise<T> {
		await this.ready;
		const w = this.worker;
		if (!w) throw new Error("Document worker unavailable");
		return new Promise<T>((resolve, reject) => {
			const id = ++this.last;
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
			w.postMessage({ id, action, data }, transfer);
		});
	}

	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
		for (const p of this.pending.values()) p.reject(new Error("Document worker terminated"));
		this.pending.clear();
	}
}

// The worker requires sourceHash to be a 32-char lowercase hex string (reader-host/src/host.js stableSourceHash); any stable value works.
async function sourceHash(key: string): Promise<string> {
	if (/^[0-9a-f]{32}$/.test(key)) return key;
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`zotero-next:${key}`));
	return [...new Uint8Array(d)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
}

let worker: DocumentWorker | null = null;
/** The worker to use: a fresh one when the last one died or never started (it never recovers by itself). */
function usableWorker(): DocumentWorker {
	if (worker && !worker.usable) {
		worker.terminate();
		worker = null;
	}
	return (worker ??= new DocumentWorker());
}
const remember = latestPerAttachment<DocStructure>();
const listeners = new Map<string, Set<(pct: number) => void>>();

async function build(key: string, pdf: Uint8Array): Promise<DocStructure> {
	const emit = (pct: number) => {
		for (const f of listeners.get(key) ?? []) f(pct);
	};
	emit(0);
	const buf = pdf.slice().buffer as ArrayBuffer; // the worker takes (detaches) its copy
	const result = await usableWorker().query<{ buf?: ArrayBuffer }>(
		"getStructuredDocumentText",
		{ buf, contentType: "application/pdf", sourceHash: await sourceHash(key), reportProgress: true },
		[buf],
		(p) => emit(Math.max(0, Math.min(95, p <= 1 ? p * 95 : p))),
	);
	if (!result?.buf) throw new Error("The document worker produced no structure");
	emit(96);
	const reader = await openStructuredDocumentTextPack(new Uint8Array(result.buf), { inflate: (b: Uint8Array) => inflateSync(b) });
	const doc = convertSdt((await reader.materialize()) as Sdt);
	emit(100);
	return doc;
}

export function loadStructure(attachmentKey: string, pdfBytes: Uint8Array, onProgress?: (pct: number) => void): Promise<DocStructure> {
	if (onProgress) {
		let set = listeners.get(attachmentKey);
		if (!set) listeners.set(attachmentKey, (set = new Set()));
		set.add(onProgress);
	}
	// the structure of the file as it is NOW: the same attachment with other bytes (rotated, pages deleted) is built again
	return remember(attachmentKey, fingerprint(pdfBytes), () =>
		build(attachmentKey, pdfBytes).finally(() => {
			listeners.delete(attachmentKey);
		}),
	);
}

export function shutdownStructureWorker(): void {
	worker?.terminate();
	worker = null;
}
