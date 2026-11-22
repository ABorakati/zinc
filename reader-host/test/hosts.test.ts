// The reader host page's annotation saving, document-worker client and citation lookups (reader-host/src/saves.js, docworker.js,
// citations.js), called as the page calls them.
import { describe, expect, test } from "bun:test";
import { installCitationActions } from "../src/citations.js";
import { createDocumentWorker } from "../src/docworker.js";
import { KEEPALIVE_MAX_BYTES, createAnnotationSaver, fitsKeepalive } from "../src/saves.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Call {
	init: RequestInit;
	body: any;
	release: (status?: number) => void;
	fail: (e?: unknown) => void;
}
/** A server the test controls: each request waits until it is answered. */
function manualServer() {
	const calls: Call[] = [];
	const send = (init: RequestInit) =>
		new Promise<{ ok: boolean; status: number }>((resolve, reject) => {
			calls.push({
				init,
				body: JSON.parse(String(init.body)),
				release: (status = 200) => resolve({ ok: status < 300, status }),
				fail: (e = new Error("offline")) => reject(e),
			});
		});
	return { calls, send };
}
const ann = (id: string, text = "t") => ({ id, type: "highlight", text });

describe("annotation saving", () => {
	test("saves and deletes go out one at a time, in the order they were made", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A")]);
		const first = s.flush();
		s.deleteAnnotations(["B"]);
		await tick();
		expect(calls.map((c) => c.init.method)).toEqual(["PUT"]); // the DELETE waits for the PUT
		calls[0]!.release();
		await tick();
		expect(calls.map((c) => c.init.method)).toEqual(["PUT", "DELETE"]);
		expect(calls[1]!.body).toEqual({ ids: ["B"] });
		calls[1]!.release();
		await first;
		await s.drain();
	});

	test("a batch that failed to send comes back, but not an id deleted in the meantime", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A"), ann("B")]);
		const p = s.flush();
		await tick();
		s.deleteAnnotations(["A"]); // A is deleted while the batch is on its way
		calls[0]!.fail();
		await tick();
		expect(calls[1]!.init.method).toBe("DELETE");
		calls[1]!.release();
		await p;
		const d = s.drain(); // sends what came back
		await tick();
		const puts = calls.filter((c) => c.init.method === "PUT");
		expect(puts).toHaveLength(2);
		expect(puts[1]!.body.map((a: any) => a.id)).toEqual(["B"]);
		puts[1]!.release();
		await d;
	});

	test("a batch that failed does not overwrite a newer save of the same id", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A", "old")]);
		const p = s.flush();
		await tick();
		s.queueSave([ann("A", "new")]);
		calls[0]!.release(503);
		await p;
		const d = s.drain();
		await tick();
		const puts = calls.filter((c) => c.init.method === "PUT");
		expect(puts).toHaveLength(2);
		expect(puts[1]!.body).toEqual([ann("A", "new")]);
		puts[1]!.release();
		expect(await d).toBe(true);
	});

	test("a failed batch is not sent again over a newer save that has already gone out", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A", "old")]);
		const p1 = s.flush();
		await tick();
		s.queueSave([ann("A", "new")]);
		s.flush(); // queued behind the first
		calls[0]!.release(503);
		await tick();
		calls[1]!.release(); // "new" is saved
		await p1;
		expect(s.unsent).toBe(0); // "old" did not come back
		expect(calls).toHaveLength(2);
		expect(await s.drain()).toBe(true);
	});

	test("a request the server refuses for good (4xx) is dropped, not sent again for ever", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A")]);
		const p = s.flush();
		await tick();
		calls[0]!.release(400);
		await p;
		expect(s.unsent).toBe(0);
		expect(await s.drain()).toBe(true); // nothing left to send
		expect(calls).toHaveLength(1);
	});

	test("a delete that failed is tried again, unless the id was saved again", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.deleteAnnotations(["A", "B"]);
		await tick();
		calls[0]!.fail();
		await tick();
		s.queueSave([ann("B")]); // B was restored (undo)
		const d = s.drain();
		await tick();
		const del = calls.filter((c) => c.init.method === "DELETE");
		expect(del).toHaveLength(2);
		expect(del[1]!.body).toEqual({ ids: ["A"] });
		del[1]!.release();
		await tick();
		calls[calls.length - 1]!.release(); // the PUT of B
		await d;
	});

	test("the keepalive limit is counted in bytes of the JSON body", async () => {
		expect(fitsKeepalive(JSON.stringify([ann("A", "字".repeat(25000))]))).toBe(false);
		expect(25000).toBeLessThan(KEEPALIVE_MAX_BYTES);
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A", "字".repeat(25000))]);
		const big = s.flush(true);
		expect(calls[0]!.init.keepalive).toBe(false);
		calls[0]!.release();
		await big;
		s.queueSave([ann("B", "small")]);
		const small = s.flush(true);
		expect(calls[1]!.init.keepalive).toBe(true);
		calls[1]!.release();
		await small;
	});

	test("at unload everything queued is sent at once, without waiting for a running request", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A")]);
		s.flush();
		await tick();
		s.deleteAnnotations(["X"]);
		s.queueSave([ann("B")]);
		const unload = s.flush(true);
		expect(calls.map((c) => c.init.method)).toEqual(["PUT", "DELETE", "PUT"]);
		for (const c of calls) c.release();
		await unload;
	});

	test("drain answers false when a request failed", async () => {
		const { calls, send } = manualServer();
		const s = createAnnotationSaver({ send });
		s.queueSave([ann("A")]);
		const d = s.drain();
		await tick();
		calls[0]!.release(500);
		expect(await d).toBe(false);
		expect(s.unsent).toBe(1); // kept for the next try
	});
});

describe("document worker client", () => {
	class FakeWorker {
		listeners: Record<string, ((e: any) => any)[]> = {};
		posted: any[] = [];
		addEventListener(type: string, fn: (e: any) => any) {
			(this.listeners[type] ??= []).push(fn);
		}
		postMessage(m: any) {
			this.posted.push(m);
		}
		emit(type: string, e: any) {
			return Promise.all((this.listeners[type] ?? []).map((fn) => fn(e)));
		}
	}

	test("a fetch the worker asked for that finishes after the worker failed does not throw", async () => {
		const w = new FakeWorker();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const client = createDocumentWorker({
			base: "document-worker/",
			newWorker: () => w as unknown as Worker,
			fetchFn: (async () => {
				await gate;
				return { arrayBuffer: async () => new ArrayBuffer(2) };
			}) as unknown as typeof fetch,
		});
		const q = client.query("getStructuredDocumentText", {}, [], undefined);
		q.catch(() => {});
		const answering = w.emit("message", { data: { id: 7, action: "FetchData", data: "x" } }); // the worker asks for a file
		await tick();
		await w.emit("error", { message: "boom" }); // then the worker dies
		release();
		await answering; // the listener must not throw
		await expect(q).rejects.toThrow("Document worker unavailable");
		// a later query is refused, not crashed
		await expect(client.query("a", {}, [], undefined)).rejects.toThrow("Document worker unavailable");
	});

	test("a request and its answer", async () => {
		const w = new FakeWorker();
		const client = createDocumentWorker({ base: "document-worker/", newWorker: () => w as unknown as Worker });
		const q = client.query("go", { n: 1 }, [], undefined);
		expect(w.posted[0]).toMatchObject({ id: 1, action: "go" });
		await w.emit("message", { data: { responseID: 1, data: "done" } });
		expect(await q).toBe("done");
	});
});

describe("citation lookups go through the page's API fetch", () => {
	class El {
		children: El[] = [];
		textContent = "";
		className = "";
		attrs: Record<string, string> = {};
		get childElementCount() {
			return this.children.length;
		}
		appendChild(c: El) {
			this.children.push(c);
			return c;
		}
		setAttribute(k: string, v: string) {
			this.attrs[k] = v;
		}
		addEventListener() {}
		remove() {}
		querySelector() {
			return null;
		}
		querySelectorAll() {
			return [];
		}
	}

	test("references are asked for with the supplied fetch, not the global one", async () => {
		const asked: string[] = [];
		const g = globalThis as any;
		const saved = { document: g.document, MutationObserver: g.MutationObserver, fetch: g.fetch };
		const row = new El();
		row.textContent = "Smith J. A study. 2020.";
		const popup = Object.assign(new El(), { querySelectorAll: (sel: string) => (sel === ".reference-row" ? [row] : []) });
		const root = Object.assign(new El(), { querySelectorAll: () => [popup] });
		g.document = {
			createElement: () => new El(),
			head: new El(),
			body: root,
			getElementById: () => root,
		};
		g.MutationObserver = class {
			observe() {}
			disconnect() {}
		};
		g.fetch = () => {
			throw new Error("the global fetch was used");
		};
		try {
			const stop = installCitationActions({
				attachment: "ATT12345",
				postToParent() {},
				onError() {},
				apiFetch: async (url: string) => {
					asked.push(url);
					return { ok: true, status: 200, json: async () => ({ references: [] }) } as any;
				},
			} as any);
			await tick();
			stop();
		} finally {
			Object.assign(g, saved);
		}
		expect(asked).toEqual(["/api/references/ATT12345"]);
	});
});
