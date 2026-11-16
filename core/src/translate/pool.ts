import { logError } from "../log";

// Small pool of translation workers. One job at a time per worker; every job has a hard timeout, after which the
// worker is terminated (translator code cannot be interrupted any other way) and replaced.
export type JobOp = "web" | "import" | "export";

export class TranslateError extends Error {
	constructor(
		public code: "timeout" | "worker" | "failed",
		message: string,
	) {
		super(message);
		this.name = "TranslateError";
	}
}

// ZN_TRANSLATE_WORKER: a pre-bundled worker (translate-worker.js) beside the packaged exe, where the sources are not on disk
// (gpui-ui/scripts/translate-worker.ts builds it; src/packaged.ts sets it). Unset: the source worker next to this file.
const WORKER_ENTRY = process.env.ZN_TRANSLATE_WORKER
	? Bun.pathToFileURL(process.env.ZN_TRANSLATE_WORKER)
	: new URL("./worker.ts", import.meta.url);
const MAX_WORKERS = 2;
const RECYCLE_AFTER_JOBS = 50;
const DEFAULT_TIMEOUT_MS = 60_000;

interface Slot {
	worker: Worker;
	busy: boolean;
	jobs: number;
	ready: Promise<void>;
	settle?: (r: { ok: boolean; result?: unknown; error?: string }) => void;
}

const slots: Slot[] = [];
const waiting: Array<() => void> = [];
let nextId = 1;

function spawn(): Slot {
	// env: the packaged app sets ZN_ZOTERO_VENDOR at run time, after the process started; a worker's default env is the start-up one
	const worker = new Worker(WORKER_ENTRY.href, { env: process.env as Record<string, string> });
	(worker as unknown as { unref?: () => void }).unref?.();
	const slot: Slot = { worker, busy: false, jobs: 0, ready: Promise.resolve() };
	slot.ready = new Promise<void>((resolve, reject) => {
		worker.onmessage = (e: MessageEvent) => {
			const m = e.data;
			if (m?.ready) return resolve();
			slot.settle?.(m);
		};
		worker.onerror = (e: ErrorEvent) => {
			// A stray error from a translator's leftover callbacks is not the current job's failure; the worker's own
			// handlers swallow those. Anything that still gets here before the worker is ready is fatal for the slot.
			e.preventDefault?.();
			logError("translate", e.error ?? e.message, "translation worker", { jobRunning: !!slot.settle });
			if (!slot.settle) return;
			const err = new TranslateError("worker", `translation worker error: ${String(e.message ?? "")}`);
			reject(err);
			slot.settle({ ok: false, error: err.message });
		};
	});
	slot.ready.catch(() => {});
	return slot;
}

function release(slot: Slot, dispose: boolean): void {
	slot.busy = false;
	slot.settle = undefined;
	if (dispose || slot.jobs >= RECYCLE_AFTER_JOBS) {
		slot.worker.terminate();
		const i = slots.indexOf(slot);
		if (i >= 0) slots.splice(i, 1);
	}
	waiting.shift()?.();
}

async function acquire(): Promise<Slot> {
	for (;;) {
		const idle = slots.find((s) => !s.busy);
		if (idle) {
			idle.busy = true;
			return idle;
		}
		if (slots.length < MAX_WORKERS) {
			const s = spawn();
			s.busy = true;
			slots.push(s);
			return s;
		}
		await new Promise<void>((r) => waiting.push(r));
	}
}

export async function runJob<T>(op: JobOp, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	const slot = await acquire();
	slot.jobs++;
	let dispose = false;
	try {
		await slot.ready;
		const id = nextId++;
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				dispose = true;
				slot.settle = undefined;
				reject(new TranslateError("timeout", `translation timed out after ${Math.round(timeoutMs / 1000)} s`));
			}, timeoutMs);
			slot.settle = (m: any) => {
				clearTimeout(timer);
				if (m.ok) resolve(m.result as T);
				else {
					// a failed translator may leave callbacks running that throw later, into whatever job comes next
					dispose = true;
					reject(new TranslateError("failed", String(m.error)));
				}
			};
			slot.worker.postMessage({ id, op, params });
		});
	} catch (e) {
		if (e instanceof TranslateError && e.code === "worker") dispose = true;
		throw e;
	} finally {
		release(slot, dispose);
	}
}

/** Stops all workers (tests, shutdown). */
export function shutdownTranslatePool(): void {
	for (const s of slots.splice(0)) s.worker.terminate();
}
