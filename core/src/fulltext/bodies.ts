// Body handle store. Large bodies never enter the engine: it only sees BodyRef {handle, len}.
//   page  text kept in memory (capped)       pdf  always a file in a temp directory under <dataDir>/storage
// Also the staging rules for fx_inspect: text bodies are cut at 2 MiB, PDFs are inspected as head 4 KiB + tail 2 KiB.

import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { INSPECT_TEXT_MAX, OpError } from "./http";
import type { BodyRef } from "./proto";

export const PDF_HEAD = 4096;
export const PDF_TAIL = 2048;
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const MEM_CAP_TOTAL = 64 * 1024 * 1024;

export interface Staged {
	bytes: Uint8Array;
	head_len: number | null;
	truncated: boolean;
	body_len: number;
}

export function stageBytes(bytes: Uint8Array, kind: "pdf" | "page"): Staged {
	const len = bytes.length;
	if (kind === "pdf") {
		if (len <= PDF_HEAD + PDF_TAIL) return { bytes, head_len: null, truncated: false, body_len: len };
		const out = new Uint8Array(PDF_HEAD + PDF_TAIL);
		out.set(bytes.subarray(0, PDF_HEAD), 0);
		out.set(bytes.subarray(len - PDF_TAIL), PDF_HEAD);
		return { bytes: out, head_len: PDF_HEAD, truncated: false, body_len: len };
	}
	const truncated = len > INSPECT_TEXT_MAX;
	return { bytes: truncated ? bytes.subarray(0, INSPECT_TEXT_MAX) : bytes, head_len: null, truncated, body_len: len };
}

function readRange(path: string, offset: number, length: number): Uint8Array {
	const fd = openSync(path, "r");
	try {
		const buf = new Uint8Array(length);
		const n = readSync(fd, buf, 0, length, offset);
		return n === length ? buf : buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}

export function stageFile(path: string, len?: number): Staged {
	const size = len ?? statSync(path).size;
	if (size === 0) return { bytes: new Uint8Array(0), head_len: null, truncated: false, body_len: 0 };
	if (size <= PDF_HEAD + PDF_TAIL) return { bytes: readRange(path, 0, size), head_len: null, truncated: false, body_len: size };
	const head = readRange(path, 0, PDF_HEAD);
	const tail = readRange(path, size - PDF_TAIL, PDF_TAIL);
	const out = new Uint8Array(head.length + tail.length);
	out.set(head, 0);
	out.set(tail, head.length);
	return { bytes: out, head_len: PDF_HEAD, truncated: false, body_len: size };
}

interface BodyInfo {
	handle: number;
	kind: "page" | "pdf";
	len: number;
	run: number | null;
	mem: Uint8Array | null;
	path: string | null;
	dir: string | null;
}

export class BodyStore {
	private bodies = new Map<number, BodyInfo>();
	private next = 1;
	private memBytes = 0;
	private slotCounter = 0;
	constructor(private tmpRoot: string) {}

	putMemory(bytes: Uint8Array, run: number | null): BodyRef {
		if (bytes.length > PAGE_MAX_BYTES) throw new OpError("too_large", `page body of ${bytes.length} bytes exceeds ${PAGE_MAX_BYTES}`);
		if (this.memBytes + bytes.length > MEM_CAP_TOTAL) throw new OpError("too_large", "in-memory bodies would exceed the cap");
		this.memBytes += bytes.length;
		const handle = this.next++;
		this.bodies.set(handle, { handle, kind: "page", len: bytes.length, run, mem: bytes.slice(), path: null, dir: null });
		return { handle, len: bytes.length };
	}

	putFile(f: { path: string; dir: string; len: number; run: number | null }): BodyRef {
		const handle = this.next++;
		this.bodies.set(handle, { handle, kind: "pdf", len: f.len, run: f.run, mem: null, path: f.path, dir: f.dir });
		return { handle, len: f.len };
	}

	/** A fresh temp directory for a streamed PDF. Lives under <dataDir>/storage so the final move is a rename. */
	allocSlot(): { dir: string; path: string } {
		const dir = join(this.tmpRoot, `slot-${process.pid}-${Date.now().toString(36)}-${this.slotCounter++}`);
		mkdirSync(dir, { recursive: true });
		return { dir, path: join(dir, "file.tmp") };
	}

	discardSlot(slot: { dir: string } | null): void {
		if (!slot) return;
		try {
			rmSync(slot.dir, { recursive: true, force: true });
		} catch {
			/* swept at the next start */
		}
	}

	get(handle: number): BodyInfo | null {
		return this.bodies.get(handle) ?? null;
	}

	release(handle: number): void {
		const info = this.bodies.get(handle);
		if (!info) return;
		this.bodies.delete(handle);
		if (info.mem) this.memBytes -= info.len;
		if (info.dir) this.discardSlot({ dir: info.dir });
	}

	releaseAll(run?: number): void {
		for (const info of Array.from(this.bodies.values())) if (run === undefined || info.run === run) this.release(info.handle);
	}

	/** Remove leftover slot directories from a crashed session. */
	sweep(): void {
		try {
			rmSync(this.tmpRoot, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	stats(): { count: number; memBytes: number } {
		return { count: this.bodies.size, memBytes: this.memBytes };
	}
}
