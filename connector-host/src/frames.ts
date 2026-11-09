// Chrome native-messaging framing: each message is a 4-byte little-endian length followed by that many bytes of
// UTF-8 JSON. Chrome limits a message to the host to 64 MB and a message from the host to 1 MB (the extension
// side chunks uploads, and this side chunks responses).

/** Largest frame accepted from the extension (Chrome's own limit is 64 MB). */
export const MAX_IN_FRAME = 64 * 1024 * 1024;
/** Largest frame sent to the extension (Chrome's limit is 1 MB; stay under it). */
export const MAX_OUT_FRAME = 1_000_000;
/** Raw bytes per response chunk: base64 makes it 4/3 larger, plus a small JSON envelope. */
export const RESPONSE_CHUNK_BYTES = 600_000;

export function encodeFrame(msg: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(msg), "utf8");
	if (body.length > MAX_OUT_FRAME) throw new Error(`frame of ${body.length} bytes exceeds the 1 MB native-messaging limit`);
	const out = Buffer.allocUnsafe(4 + body.length);
	out.writeUInt32LE(body.length, 0);
	body.copy(out, 4);
	return out;
}

/** Incremental decoder: feed it stdin chunks, get back the complete messages. */
export class FrameReader {
	// Pieces not yet decoded. A big frame arrives in many small pipe reads: collecting them and joining once keeps
	// this linear (re-joining the whole buffer on every read is quadratic, and starves everything behind a PDF).
	private parts: Buffer[] = [];
	private have = 0;
	/** largest frame length seen (tests check it against the 1 MB limit) */
	maxLen = 0;

	/** the first n bytes, joined (and consumed from the pieces) */
	private take(n: number): Buffer {
		const first = this.parts[0]!;
		if (first.length >= n) {
			this.parts[0] = first.subarray(n);
			if (!this.parts[0]!.length) this.parts.shift();
			this.have -= n;
			return first.subarray(0, n);
		}
		const out = Buffer.allocUnsafe(n);
		let at = 0;
		while (at < n) {
			const p = this.parts[0]!;
			const k = Math.min(p.length, n - at);
			p.copy(out, at, 0, k);
			at += k;
			if (k === p.length) this.parts.shift();
			else this.parts[0] = p.subarray(k);
		}
		this.have -= n;
		return out;
	}

	push(chunk: Uint8Array): unknown[] {
		if (chunk.length) {
			this.parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			this.have += chunk.length;
		}
		const out: unknown[] = [];
		for (;;) {
			if (this.have < 4) break;
			// the length prefix may itself be split across reads
			const len = this.parts[0]!.length >= 4 ? this.parts[0]!.readUInt32LE(0) : Buffer.concat(this.parts).readUInt32LE(0);
			this.maxLen = Math.max(this.maxLen, len);
			if (len > MAX_IN_FRAME) throw new Error(`incoming frame of ${len} bytes exceeds the 64 MB limit`);
			if (this.have < 4 + len) break;
			this.take(4);
			out.push(JSON.parse(this.take(len).toString("utf8")));
		}
		return out;
	}
}

/** A response as frames: one `res` header, then the body as base64 `rc` chunks (each under the 1 MB limit). */
export function responseFrames(id: string | number, status: number, headers: Record<string, string>, body: Uint8Array): Buffer {
	const n = Math.ceil(body.length / RESPONSE_CHUNK_BYTES);
	const parts: Buffer[] = [encodeFrame({ t: "res", id, status, headers, n })];
	for (let i = 0; i < n; i++) {
		const slice = body.subarray(i * RESPONSE_CHUNK_BYTES, (i + 1) * RESPONSE_CHUNK_BYTES);
		parts.push(encodeFrame({ t: "rc", id, seq: i, data: Buffer.from(slice).toString("base64") }));
	}
	return Buffer.concat(parts);
}
