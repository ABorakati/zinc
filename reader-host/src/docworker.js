// The page's connection to Zotero's document worker (Reading Mode). (host.js bundles this file; keep it free of DOM and framework imports.)

/**
 * @param {{ base: string, newWorker?: () => Worker, fetchFn?: typeof fetch }} o
 *   `base` is the folder the worker's data files are fetched from.
 */
export function createDocumentWorker({ base, newWorker = () => new Worker(base + "worker.js"), fetchFn = (...a) => fetch(...a) }) {
	let documentWorker = null;
	let workerFailed = false;
	let lastPromiseID = 0;
	const workerPromises = {};

	function failAllPending(error) {
		for (let id of Object.keys(workerPromises)) {
			workerPromises[id].reject(error);
			delete workerPromises[id];
		}
	}

	function init() {
		if (documentWorker || workerFailed) return documentWorker;
		// The listeners answer on this worker, not on whatever `documentWorker` is by then: a fetch can finish after the worker failed.
		const worker = (documentWorker = newWorker());
		worker.addEventListener("error", (event) => {
			console.warn("Document worker failed:", event.message || event);
			workerFailed = true;
			failAllPending(new Error("Document worker unavailable"));
			documentWorker = null;
		});
		worker.addEventListener("message", async (event) => {
			let message = event.data;
			if (message.progressID) {
				workerPromises[message.progressID]?.onProgress?.(message.data.progress);
				return;
			}
			if (message.responseID) {
				let pending = workerPromises[message.responseID];
				if (!pending) return;
				delete workerPromises[message.responseID];
				if ("error" in message) pending.reject(new Error(JSON.stringify(message.error)));
				else pending.resolve(message.data);
				return;
			}
			if (message.id) {
				let respData = null;
				try {
					if (message.action === "FetchBuiltInCMap") {
						let res = await fetchFn(base + "cmaps/" + message.data + ".bcmap");
						respData = { isCompressed: true, cMapData: new Uint8Array(await res.arrayBuffer()) };
					} else if (message.action === "FetchStandardFontData") {
						let res = await fetchFn(base + "standard_fonts/" + message.data);
						respData = new Uint8Array(await res.arrayBuffer());
					} else if (message.action === "FetchWasm") {
						let res = await fetchFn(base + "wasm/" + message.data);
						respData = new Uint8Array(await res.arrayBuffer());
					} else if (message.action === "FetchData") {
						let res = await fetchFn(base + message.data);
						respData = new Uint8Array(await res.arrayBuffer());
					}
				} catch (e) {
					console.warn(`Document worker ${message.action} failed:`, e);
				}
				if (worker === documentWorker) worker.postMessage({ responseID: message.id, data: respData });
			}
		});
		return worker;
	}

	function query(action, data, transfer, onProgress) {
		let worker = init();
		if (!worker) return Promise.reject(new Error("Document worker unavailable"));
		return new Promise((resolve, reject) => {
			lastPromiseID++;
			workerPromises[lastPromiseID] = { resolve, reject, onProgress };
			worker.postMessage({ id: lastPromiseID, action, data }, transfer || []);
		});
	}

	return { query };
}
