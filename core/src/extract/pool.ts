// Small pool of Bun Workers running Zotero's document-worker (see pdf-worker.ts).
// Extraction never runs on the main thread; each job has a hard timeout, after which the worker is
// terminated (pdf.js cannot be interrupted) and replaced.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logError } from "../log";

// Defaults point into the repo; a bundled app passes its own copies to configureExtractPool.
let BUILD_DIR = new URL("../../../vendor/document-worker/build/", import.meta.url);
let WORKER_ENTRY = new URL("./pdf-worker.ts", import.meta.url);
let docWorkerDir: string | undefined; // set by configureExtractPool; handed to pdf-worker.ts as ZN_DOCWORKER_DIR
const RECYCLE_AFTER_JOBS = 40; // pdf.js leaks a little per document; start fresh workers periodically

export type ExtractErrorCode = "encrypted" | "corrupt" | "timeout" | "too-large" | "worker";

export class ExtractError extends Error {
	constructor(
		public code: ExtractErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ExtractError";
	}
}

export interface PdfText {
	text: string;
	pages: number;
}

interface Pending {
	resolve: (v: PdfText) => void;
	reject: (e: ExtractError) => void;
	timer: ReturnType<typeof setTimeout>;
}

class PoolWorker {
	worker: Worker;
	jobs = 0;
	ready: Promise<void>;
	pending = new Map<number, Pending>();
	dead = false;
	private nextId = 1;

	constructor() {
		// Workers don't see process.env changes made after startup, so pass the build folder explicitly.
		this.worker = new Worker(
			WORKER_ENTRY.href,
			docWorkerDir ? ({ env: { ...process.env, ZN_DOCWORKER_DIR: docWorkerDir } } as WorkerOptions) : undefined,
		);
		(this.worker as unknown as { unref?: () => void }).unref?.();
		let onReady!: () => void;
		let onFail!: (e: Error) => void;
		this.ready = new Promise<void>((res, rej) => {
			onReady = res;
			onFail = rej;
		});
		this.worker.onerror = (e: ErrorEvent) => {
			logError("worker", e.error ?? e.message, "pdf extraction worker");
			const err = new ExtractError("worker", String(e.message ?? "worker error"));
			onFail(err);
			this.fail(err);
		};
		this.worker.onmessage = (e: MessageEvent) => {
			const m = e.data;
			if (m?.ready) return onReady();
			if (m?.action === "FetchData") return void this.serveData(m.id, String(m.data));
			if (m?.responseID == null) return;
			const p = this.pending.get(m.responseID);
			if (!p) return;
			this.pending.delete(m.responseID);
			clearTimeout(p.timer);
			if (m.error) p.reject(classify(m.error));
			else p.resolve({ text: m.data.text, pages: m.data.totalPages });
		};
	}

	// The bundle asks the host for cmaps / standard fonts / wasm by relative path.
	private async serveData(id: number, rel: string): Promise<void> {
		try {
			if (rel.includes("..")) throw new Error("bad path");
			const b = await readFile(new URL(rel, BUILD_DIR));
			const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
			this.worker.postMessage({ responseID: id, data: ab }, [ab]);
		} catch (e) {
			this.worker.postMessage({ responseID: id, error: { message: String(e) } });
		}
	}

	private fail(err: ExtractError): void {
		this.dead = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	async run(buf: ArrayBuffer, timeoutMs: number): Promise<PdfText> {
		await this.ready;
		this.jobs++;
		const id = this.nextId++;
		return new Promise<PdfText>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.fail(new ExtractError("timeout", `extraction exceeded ${timeoutMs} ms`));
				this.terminate();
				reject(new ExtractError("timeout", `extraction exceeded ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.worker.postMessage({ id, action: "pdf.getFulltext", data: { buf } }, [buf]);
		});
	}

	terminate(): void {
		this.dead = true;
		void this.worker.terminate();
	}
}

function classify(e: { name?: string; message?: string }): ExtractError {
	const name = e.name ?? "";
	const msg = e.message ?? "extraction failed";
	if (name === "PasswordException" || /password/i.test(msg)) return new ExtractError("encrypted", msg);
	if (/invalid pdf|missing pdf|format error|xref|stream|unexpected end|bad end/i.test(`${name} ${msg}`) || name.endsWith("Exception"))
		return new ExtractError("corrupt", msg);
	return new ExtractError("worker", msg);
}

class Pool {
	size = 2;
	timeoutMs = 60_000;
	private idle: PoolWorker[] = [];
	private all = new Set<PoolWorker>();
	private waiters: (() => void)[] = [];
	private active = 0;
	/** Idle workers are stopped after this long without work (each holds a document worker's memory). */
	idleMs = 60_000;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	private async acquire(): Promise<PoolWorker> {
		clearTimeout(this.idleTimer);
		while (this.active >= this.size) await new Promise<void>((r) => this.waiters.push(r));
		this.active++;
		let w = this.idle.pop();
		if (!w) {
			w = new PoolWorker();
			this.all.add(w);
		}
		return w;
	}

	private release(w: PoolWorker): void {
		this.active--;
		if (w.dead || w.jobs >= RECYCLE_AFTER_JOBS) {
			w.terminate();
			this.all.delete(w);
		} else {
			this.idle.push(w);
		}
		this.waiters.shift()?.();
		if (this.active === 0) {
			clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(() => this.stopIdle(), this.idleMs);
			(this.idleTimer as { unref?: () => void }).unref?.();
		}
	}

	/** Stop workers with nothing to do; the next extraction starts a fresh one (about half a second). */
	private stopIdle(): void {
		if (this.active) return;
		for (const w of this.idle) {
			w.terminate();
			this.all.delete(w);
		}
		this.idle = [];
	}

	/** Tests only. */
	get workerCount(): number {
		return this.all.size;
	}

	async extractPdf(buf: ArrayBuffer): Promise<PdfText> {
		const w = await this.acquire();
		try {
			return await w.run(buf, this.timeoutMs);
		} finally {
			this.release(w);
		}
	}

	shutdown(): void {
		clearTimeout(this.idleTimer);
		for (const w of this.all) w.terminate();
		this.all.clear();
		this.idle = [];
	}
}

const pool = new Pool();

/**
 * buildDir: folder holding Zotero's built document-worker (worker.js, cmaps/, standard_fonts/...).
 * workerEntry: path to pdf-worker.ts. Both only matter before the first extraction starts a worker.
 */
export function configureExtractPool(opts: {
	concurrency?: number;
	timeoutMs?: number;
	idleMs?: number;
	buildDir?: string;
	workerEntry?: string;
}): void {
	if (opts.concurrency) pool.size = Math.max(1, Math.floor(opts.concurrency));
	if (opts.timeoutMs) pool.timeoutMs = opts.timeoutMs;
	if (opts.idleMs) pool.idleMs = opts.idleMs;
	if (opts.buildDir) {
		BUILD_DIR = pathToFileURL(opts.buildDir.replace(/[\\/]*$/, "/"));
		docWorkerDir = opts.buildDir;
	}
	if (opts.workerEntry) WORKER_ENTRY = pathToFileURL(opts.workerEntry);
}

export function extractPdfText(buf: ArrayBuffer): Promise<PdfText> {
	return pool.extractPdf(buf);
}

/** Running document workers (tests). */
export function extractWorkerCount(): number {
	return pool.workerCount;
}

export function shutdownExtractPool(): void {
	pool.shutdown();
}
