// Small node built-ins for the browser demo: node:os, node:url and node:crypto's createHash (md5, sha1, sha256 in pure TypeScript).
// Each is mapped to this module by web/build.ts.
export const homedir = () => "/home/demo";
export const tmpdir = () => "/tmp";
export const arch = () => "x64";
export const release = () => "10.0.26100";
export const type = () => "Windows_NT";
export const platform = () => "win32";
export const hostname = () => "demo";
export const cpus = () => [{ model: "browser" }];
export const totalmem = () => 8 * 2 ** 30;
export const EOL = "\n";

export const pathToFileURL = (p: string) => new URL(`file:///${String(p).replace(/\\/g, "/").replace(/^\//, "")}`);
export const fileURLToPath = (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname).replace(/^\/([a-zA-Z]:)/, "$1");

// Pure TypeScript md5 (RFC 1321), sha1 (FIPS 180-4) and sha256 (FIPS 180-4), so that zotero.org file sync can check checksums
// in the browser demo. Other algorithms throw when requested.
type HashAlgorithm = "md5" | "sha1" | "sha256";
type Input = string | ArrayBufferLike | ArrayBufferView;

const TEXT = new TextEncoder();

function toBytes(d: Input): Uint8Array {
	if (typeof d === "string") return TEXT.encode(d);
	if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
	return new Uint8Array(d.slice(0));
}

/** Pads a message as Merkle-Damgard hashes do: a 0x80 byte, zeros, then the bit length in 8 bytes (big or little endian). */
function pad(msg: Uint8Array, littleEndian: boolean): Uint8Array {
	const total = (Math.floor((msg.length + 8) / 64) + 1) * 64;
	const buf = new Uint8Array(total);
	buf.set(msg);
	buf[msg.length] = 0x80;
	const bits = msg.length * 8;
	const view = new DataView(buf.buffer);
	const lo = bits >>> 0;
	const hi = Math.floor(bits / 2 ** 32) >>> 0;
	if (littleEndian) {
		view.setUint32(total - 8, lo, true);
		view.setUint32(total - 4, hi, true);
	} else {
		view.setUint32(total - 8, hi, false);
		view.setUint32(total - 4, lo, false);
	}
	return buf;
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

const MD5_SHIFT = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4,
	11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5(msg: Uint8Array): Uint8Array {
	const buf = pad(msg, true);
	const dv = new DataView(buf.buffer);
	let a0 = 0x67452301,
		b0 = 0xefcdab89 | 0,
		c0 = 0x98badcfe | 0,
		d0 = 0x10325476;
	const M = new Int32Array(16);
	for (let off = 0; off < buf.length; off += 64) {
		for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
		let A = a0,
			B = b0,
			C = c0,
			D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) % 16;
			}
			F = (F + A + MD5_K[i]! + M[g]!) | 0;
			A = D;
			D = C;
			C = B;
			B = (B + rotl(F, MD5_SHIFT[i]!)) | 0;
		}
		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}
	const out = new Uint8Array(16);
	const ov = new DataView(out.buffer);
	ov.setInt32(0, a0, true);
	ov.setInt32(4, b0, true);
	ov.setInt32(8, c0, true);
	ov.setInt32(12, d0, true);
	return out;
}

function sha1(msg: Uint8Array): Uint8Array {
	const buf = pad(msg, false);
	const dv = new DataView(buf.buffer);
	const H = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0];
	const W = new Int32Array(80);
	for (let off = 0; off < buf.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = dv.getInt32(off + i * 4, false);
		for (let i = 16; i < 80; i++) W[i] = rotl(W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!, 1);
		let [a, b, c, d, e] = H as [number, number, number, number, number];
		for (let i = 0; i < 80; i++) {
			let f: number, k: number;
			if (i < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (i < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc | 0;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6 | 0;
			}
			const t = (rotl(a, 5) + f + e + k + W[i]!) | 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = t;
		}
		H[0] = (H[0]! + a) | 0;
		H[1] = (H[1]! + b) | 0;
		H[2] = (H[2]! + c) | 0;
		H[3] = (H[3]! + d) | 0;
		H[4] = (H[4]! + e) | 0;
	}
	const out = new Uint8Array(20);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < 5; i++) ov.setInt32(i * 4, H[i]!, false);
	return out;
}

const SHA256_K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
	0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
	0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
	0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
	0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
	0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map((x) => x | 0);

function sha256(msg: Uint8Array): Uint8Array {
	const buf = pad(msg, false);
	const dv = new DataView(buf.buffer);
	const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19].map((x) => x | 0);
	const W = new Int32Array(64);
	for (let off = 0; off < buf.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = dv.getInt32(off + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const w15 = W[i - 15]!,
				w2 = W[i - 2]!;
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
			W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
		}
		let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + SHA256_K[i]! + W[i]!) | 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		const v = [a, b, c, d, e, f, g, h];
		for (let i = 0; i < 8; i++) H[i] = (H[i]! + v[i]!) | 0;
	}
	const out = new Uint8Array(32);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) ov.setInt32(i * 4, H[i]!, false);
	return out;
}

const ALGORITHMS: Record<string, (msg: Uint8Array) => Uint8Array> = { md5, sha1, sha256 };

function hashAlgorithm(alg: string): (msg: Uint8Array) => Uint8Array {
	const name = String(alg)
		.toLowerCase()
		.replace(/^sha-(\d)/, "sha$1");
	const fn = ALGORITHMS[name];
	if (!fn) throw new Error(`createHash: the browser demo has no "${alg}" implementation (supported: md5, sha1, sha256)`);
	return fn;
}

class Hash {
	private readonly alg: (msg: Uint8Array) => Uint8Array;
	private chunks: Uint8Array[] = [];
	private done = false;
	constructor(alg: (msg: Uint8Array) => Uint8Array) {
		this.alg = alg;
	}
	update(data: Input): this {
		if (this.done) throw new Error("Digest already called");
		this.chunks.push(toBytes(data));
		return this;
	}
	digest(): Uint8Array;
	digest(encoding: "hex" | "base64"): string;
	digest(encoding?: "hex" | "base64"): Uint8Array | string {
		if (this.done) throw new Error("Digest already called");
		this.done = true;
		let n = 0;
		for (const c of this.chunks) n += c.length;
		const all = new Uint8Array(n);
		let o = 0;
		for (const c of this.chunks) {
			all.set(c, o);
			o += c.length;
		}
		const bytes = this.alg(all);
		if (encoding === undefined) return bytes;
		if (encoding === "hex") return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
		if (encoding === "base64") return btoa(String.fromCharCode(...bytes));
		throw new Error(`digest: unsupported encoding "${String(encoding)}" (use hex, base64 or no argument)`);
	}
}

/** createHash("md5" | "sha1" | "sha256"): a pure TypeScript hash with the node:crypto update/digest shape. */
export function createHash(alg: HashAlgorithm | string): Hash {
	return new Hash(hashAlgorithm(alg));
}
export const randomUUID = () => crypto.randomUUID();
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const createCipheriv = () => {
	throw new Error("encryption is not available in the browser demo");
};
export const createDecipheriv = createCipheriv;

export default {
	homedir,
	tmpdir,
	arch,
	release,
	type,
	platform,
	hostname,
	cpus,
	totalmem,
	EOL,
	pathToFileURL,
	fileURLToPath,
	createHash,
	randomUUID,
	randomBytes,
	createCipheriv,
	createDecipheriv,
};
