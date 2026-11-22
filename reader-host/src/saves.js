// Annotation saving for the reader host page: debounced PUTs and DELETEs sent one at a time, in the order they were made.
// (host.js bundles this file; keep it free of DOM and framework imports.)
//
// A batch that fails for a reason that can pass (no connection, a 5xx, 408, 429) is queued again, except for ids that were
// deleted or saved again after it was taken: those would come back from the dead or overwrite newer text.

/** Browsers refuse a keepalive request whose body is over 64 KiB; stay a little under it. Measured in bytes of the JSON body. */
export const KEEPALIVE_MAX_BYTES = 60000;

export function fitsKeepalive(body) {
	return new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES;
}

function retryable(status) {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * @param {{ send: (init: RequestInit) => Promise<{ ok: boolean, status: number }>, delay?: number }} o
 *   `send` makes the request to the attachment's annotations route with the given method, headers and body.
 */
export function createAnnotationSaver({ send, delay = 300 }) {
	let seq = 0;
	const pending = new Map(); // id -> { ann, v }: not sent yet
	const version = new Map(); // id -> the version of its latest save or delete
	const failedDeletes = new Map(); // id -> version of the delete that must be tried again
	const queue = []; // { kind: "put", entries } | { kind: "delete", ids, v }
	let running = null; // promise of the loop that drains the queue
	let timer = null;
	let failures = 0;

	function request(op, keepalive) {
		const method = op.kind === "put" ? "PUT" : "DELETE";
		const body = JSON.stringify(op.kind === "put" ? op.entries.map((e) => e.ann) : { ids: op.ids });
		return send({
			method,
			keepalive: keepalive && fitsKeepalive(body),
			headers: { "Content-Type": "application/json" },
			body,
		});
	}

	function requeue(op) {
		if (op.kind === "put") {
			for (const e of op.entries) if (version.get(e.ann.id) === e.v && !pending.has(e.ann.id)) pending.set(e.ann.id, e);
		} else {
			for (const id of op.ids) if (version.get(id) === op.v) failedDeletes.set(id, op.v);
		}
	}

	async function run(op, keepalive) {
		try {
			const r = await request(op, keepalive);
			if (r.ok) return true;
			failures++;
			console.error(`Saving annotations failed: status ${r.status}`);
			if (retryable(r.status)) requeue(op);
		} catch (e) {
			failures++;
			console.error("Saving annotations failed", e);
			requeue(op);
		}
		return false;
	}

	function pump() {
		if (running) return running;
		running = (async () => {
			while (queue.length) await run(queue.shift(), false);
		})().finally(() => {
			running = null;
		});
		return running;
	}

	/** Move what is waiting (and deletes to try again) into the queue. */
	function enqueue() {
		clearTimeout(timer);
		timer = null;
		if (failedDeletes.size) {
			for (const [id, v] of failedDeletes) if (version.get(id) === v) queue.push({ kind: "delete", ids: [id], v });
			failedDeletes.clear();
		}
		if (pending.size) {
			queue.push({ kind: "put", entries: [...pending.values()] });
			pending.clear();
		}
	}

	/** Send what is waiting. At unload (`keepalive`) everything queued goes out at once, without waiting for a running request. */
	function flush(keepalive = false) {
		enqueue();
		if (keepalive) {
			const ops = queue.splice(0);
			return Promise.all(ops.map((op) => run(op, true)));
		}
		return pump();
	}

	return {
		queueSave(annotations) {
			for (const a of annotations) {
				const v = ++seq;
				version.set(a.id, v);
				pending.set(a.id, { ann: a, v });
			}
			clearTimeout(timer);
			timer = setTimeout(() => void flush(), delay);
		},
		deleteAnnotations(ids) {
			if (!ids.length) return;
			const v = ++seq;
			for (const id of ids) {
				pending.delete(id);
				failedDeletes.delete(id);
				version.set(id, v);
			}
			queue.push({ kind: "delete", ids: [...ids], v });
			void pump();
		},
		flush,
		/** Send everything and wait for it: true when every request succeeded. */
		async drain() {
			const before = failures;
			enqueue();
			while (running || queue.length) await pump();
			return failures === before && !pending.size && !failedDeletes.size;
		},
		/** For tests and for the page's "anything unsent?" checks. */
		get unsent() {
			return pending.size + failedDeletes.size + queue.length;
		},
	};
}
