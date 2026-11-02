// Client for Zotero's document worker running in a Bun Worker (see docworker-entry.ts), modelled on
// reader-next/src/structure/worker.ts and reader-host/src/host.js: request/response by numeric id, plus the worker's own Fetch*
// requests for cmaps / fonts / wasm / models, answered from the build directory on disk.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }
interface WorkerMessage {
	__ready?: boolean; progressID?: number; responseID?: number; id?: number;
	action?: string; data?: any; error?: unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const ROOT = process.env.ZN_ROOT ?? join(import.meta.dir, "../../../..");
export const WORKER_DIR = join(ROOT, "vendor", "document-worker", "build");

export class DocumentWorker {
	private worker: Worker | null;
	private pending = new Map<number, Pending>();
	private last = 0;
	private ready: Promise<void>;

	constructor() {
		// ZN_DOCWORKER_ENTRY: an on-disk copy of docworker-entry.ts (the packaged app ships one next to the exe)
		const entry = process.env.ZN_DOCWORKER_ENTRY;
		const bundle = join(WORKER_DIR, "worker.js");
		// say what is missing (a copy of the exe without its folder, or an install without vendor/) instead of failing inside the worker
		if (!existsSync(bundle)) throw new Error(`The reading view needs Zotero's document worker, which was not found (${bundle}). Keep the vendor folder next to zotero-next-gpui.exe, or set ZN_ROOT.`);
		if (entry && !existsSync(entry)) throw new Error(`The document worker's entry script was not found (${entry}); keep docworker-entry.ts next to zotero-next-gpui.exe.`);
		const w = new Worker(entry ? pathToFileURL(entry).href : new URL("./docworker-entry.ts", import.meta.url).href);
		this.worker = w;
		(w as unknown as { unref?: () => void }).unref?.(); // never keeps a headless script alive
		this.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("The document worker did not start")), 60_000);
			w.addEventListener("message", (ev: MessageEvent) => {
				if ((ev.data as WorkerMessage)?.__ready) { clearTimeout(timer); resolve(); }
			});
			w.addEventListener("error", (ev: ErrorEvent) => {
				clearTimeout(timer);
				const msg = ev.message || String(ev);
				console.warn("[structure] document worker failed:", msg);
				for (const p of this.pending.values()) p.reject(new Error("Document worker unavailable"));
				this.pending.clear();
				this.worker = null;
				reject(new Error(`Document worker unavailable: ${msg}`));
			});
		});
		this.ready.catch(() => {});
		w.addEventListener("message", (ev: MessageEvent) => void this.onMessage(ev.data as WorkerMessage));
	}

	private async onMessage(m: WorkerMessage): Promise<void> {
		if (m.__ready) return;
		if (m.progressID) { this.pending.get(m.progressID)?.onProgress?.(m.data?.progress); return; }
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
				const bytes = async (path: string) => new Uint8Array(await readFile(join(WORKER_DIR, path)));
				switch (m.action) {
					case "FetchBuiltInCMap": data = { isCompressed: true, cMapData: await bytes(`cmaps/${m.data}.bcmap`) }; break;
					case "FetchStandardFontData": data = await bytes(`standard_fonts/${m.data}`); break;
					case "FetchWasm": data = await bytes(`wasm/${m.data}`); break;
					case "FetchData": data = await bytes(String(m.data)); break;
				}
			} catch (e) { console.warn(`[structure] document worker ${m.action} failed:`, e); }
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
