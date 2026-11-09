// A minimal stand-in for the extension side of the native-messaging protocol, used by the tests.
import { dirname, join } from "node:path";
import { FrameReader, MAX_OUT_FRAME } from "../src/frames";

// ZNH_EXE points the tests and the benchmark at another build (e.g. one compiled to a temp path)
export const HOST_EXE = process.env.ZNH_EXE ?? join(dirname(import.meta.dir), "dist", "zotero-next-host.exe");
export const UPLOAD_CHUNK = 4 * 1024 * 1024;

export interface Reply {
	status: number;
	headers: Record<string, string>;
	bytes: Uint8Array;
	text: string;
	json: any;
}

export interface CallOpts {
	http?: "GET" | "POST";
	query?: string;
	headers?: Record<string, string>;
	json?: unknown;
	text?: string;
	bytes?: Uint8Array;
	form?: Record<string, string | { bytes: Uint8Array; type?: string }>;
	/** send form fields as `up` frames (protocol 2) instead of inline base64 */
	formUploads?: boolean;
	/** the body was sent earlier with uploadBytes(): refer to it */
	uploadUid?: string;
}

export class HostClient {
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly stderr: string[] = [];
	private nextId = 1;
	private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; res?: any; chunks: Buffer[] }>();
	private hello?: (m: any) => void;
	maxFrame = 0;

	constructor(env: Record<string, string>, exe = HOST_EXE) {
		// ZNH_DEV=1 runs the sources with bun instead of the compiled exe (debugging)
		const cmd = process.env.ZNH_DEV ? ["bun", join(dirname(import.meta.dir), "src", "main.ts")] : [exe];
		this.proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ZNH_APP_PORT: "0", ...env } });
		void this.pump();
		const errors = this.proc.stderr as ReadableStream<Uint8Array>;
		const sink = this.stderr;
		void (async () => {
			for await (const c of errors) sink.push(Buffer.from(c).toString());
		})();
	}

	private async pump() {
		const reader = new FrameReader();
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			const msgs = reader.push(chunk) as any[];
			this.maxFrame = reader.maxLen;
			if (reader.maxLen > MAX_OUT_FRAME) throw new Error(`host sent a ${reader.maxLen}-byte frame`);
			for (const m of msgs) {
				if (m.t === "hello") this.hello?.(m);
				const p = this.pending.get(m.id);
				if (!p) continue;
				if (m.t === "res") {
					p.res = m;
					if (!m.n) this.finish(m.id);
				} else if (m.t === "rc") {
					p.chunks[m.seq] = Buffer.from(m.data, "base64");
					if (p.chunks.filter(Boolean).length === p.res.n) this.finish(m.id);
				}
			}
		}
		for (const p of this.pending.values()) p.reject(new Error("host exited"));
	}

	private finish(id: number) {
		const p = this.pending.get(id)!;
		this.pending.delete(id);
		const bytes = Buffer.concat(p.chunks);
		const text = bytes.toString("utf8");
		let json: any;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			/* not JSON */
		}
		p.resolve({ status: p.res.status, headers: p.res.headers, bytes, text, json });
	}

	send(msg: unknown) {
		const body = Buffer.from(JSON.stringify(msg));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		(this.proc.stdin as import("bun").FileSink).write(Buffer.concat([head, body]));
	}

	helloMsg(): Promise<any> {
		return new Promise((resolve) => {
			this.hello = resolve;
			this.send({ t: "hello", id: 0 });
		});
	}

	/** Sends `bytes` as up frames of `chunk` raw bytes; `interleave` yields to the event loop between frames (what the extension does). */
	async uploadBytes(uid: string, bytes: Uint8Array, chunk = UPLOAD_CHUNK, interleave = false): Promise<void> {
		const n = Math.max(1, Math.ceil(bytes.length / chunk));
		for (let i = 0; i < n; i++) {
			this.send({ t: "up", uid, seq: i, last: i === n - 1, data: Buffer.from(bytes.subarray(i * chunk, (i + 1) * chunk)).toString("base64") });
			if (interleave) await Bun.sleep(0);
		}
	}

	call(method: string, o: CallOpts = {}): Promise<Reply> {
		const id = this.nextId++;
		const headers: Record<string, string> = { "X-Zotero-Connector-API-Version": "3", "X-Zotero-Version": "5.0.0", ...o.headers };
		let body: unknown;
		if (o.json !== undefined) {
			headers["Content-Type"] = "application/json";
			body = { kind: "text", text: JSON.stringify(o.json) };
		} else if (o.text !== undefined) body = { kind: "text", text: o.text };
		else if (o.uploadUid) body = { kind: "upload", uid: o.uploadUid };
		else if (o.bytes) {
			const uid = `u${id}`;
			const n = Math.max(1, Math.ceil(o.bytes.length / UPLOAD_CHUNK));
			for (let i = 0; i < n; i++) {
				this.send({ t: "up", uid, seq: i, last: i === n - 1, data: Buffer.from(o.bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK)).toString("base64") });
			}
			body = { kind: "upload", uid };
		} else if (o.form) {
			const fields: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(o.form)) {
				if (!o.formUploads) fields[k] = typeof v === "string" ? { text: v } : { b64: Buffer.from(v.bytes).toString("base64"), type: v.type };
				else {
					const uid = `f${id}-${k}`;
					const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v.bytes;
					const n = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK));
					for (let i = 0; i < n; i++) this.send({ t: "up", uid, seq: i, last: i === n - 1, data: Buffer.from(bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK)).toString("base64") });
					fields[k] = typeof v === "string" ? { upload: uid, asText: true } : { upload: uid, type: v.type };
				}
			}
			headers["Content-Type"] = "multipart/form-data";
			body = { kind: "form", fields };
		}
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, chunks: [] });
			this.send({ t: "req", id, method, http: o.http ?? "POST", query: o.query, headers, body });
		});
	}

	async close() {
		(this.proc.stdin as import("bun").FileSink).end();
		await this.proc.exited;
	}
}
