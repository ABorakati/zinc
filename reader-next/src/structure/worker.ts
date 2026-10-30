// Thin client for Zotero's document worker (vendor/document-worker/build/worker.js), modelled on
// reader-host/src/host.js: request/response by numeric id, plus the worker's own Fetch* requests for
// cmaps / fonts / wasm / models, answered from the same base URL.

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }

export class DocumentWorker {
	private worker: Worker | null;
	private pending = new Map<number, Pending>();
	private last = 0;
	private base: string;

	constructor(workerUrl: string) {
		this.base = workerUrl.slice(0, workerUrl.lastIndexOf("/") + 1);
		this.worker = new Worker(workerUrl);
		this.worker.addEventListener("error", (event) => {
			console.warn("[structure] document worker failed:", event.message || event);
			for (const p of this.pending.values()) p.reject(new Error("Document worker unavailable"));
			this.pending.clear();
			this.worker = null;
		});
		this.worker.addEventListener("message", (event) => void this.onMessage(event.data));
	}

	private async onMessage(message: any) {
		if (message.progressID) {
			this.pending.get(message.progressID)?.onProgress?.(message.data?.progress);
			return;
		}
		if (message.responseID) {
			const p = this.pending.get(message.responseID);
			if (!p) return;
			this.pending.delete(message.responseID);
			if ("error" in message) p.reject(new Error(JSON.stringify(message.error)));
			else p.resolve(message.data);
			return;
		}
		if (message.id) {
			let data: unknown = null;
			try {
				const fetchBytes = async (path: string) => new Uint8Array(await (await fetch(this.base + path)).arrayBuffer());
				switch (message.action) {
					case "FetchBuiltInCMap": data = { isCompressed: true, cMapData: await fetchBytes("cmaps/" + message.data + ".bcmap") }; break;
					case "FetchStandardFontData": data = await fetchBytes("standard_fonts/" + message.data); break;
					case "FetchWasm": data = await fetchBytes("wasm/" + message.data); break;
					case "FetchData": data = await fetchBytes(message.data); break;
				}
			}
			catch (e) { console.warn(`[structure] document worker ${message.action} failed:`, e); }
			this.worker?.postMessage({ responseID: message.id, data });
		}
	}

	query<T>(action: string, data: unknown, transfer: Transferable[] = [], onProgress?: (p: number) => void): Promise<T> {
		const w = this.worker;
		if (!w) return Promise.reject(new Error("Document worker unavailable"));
		return new Promise<T>((resolve, reject) => {
			const id = ++this.last;
			this.pending.set(id, { resolve, reject, onProgress });
			w.postMessage({ id, action, data }, transfer);
		});
	}
}
