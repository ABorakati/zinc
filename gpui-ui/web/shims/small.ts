// Small node built-ins for the browser demo: node:os, node:url and node:crypto's hash (a non-cryptographic stand-in: the demo only
// uses hashes as cache keys). Each is mapped to this module by web/build.ts.
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

/** FNV-1a over the input, repeated to the digest length: stable, fast, NOT cryptographic. */
export function createHash(_alg?: string) {
	const chunks: Uint8Array[] = [];
	const enc = new TextEncoder();
	const self = {
		update(d: string | Uint8Array) {
			chunks.push(typeof d === "string" ? enc.encode(d) : d);
			return self;
		},
		digest(fmt?: string) {
			let h = 0x811c9dc5;
			const out: number[] = [];
			for (const c of chunks)
				for (const b of c) {
					h ^= b;
					h = Math.imul(h, 0x01000193) >>> 0;
				}
			for (let i = 0; i < 16; i++) {
				h ^= i;
				h = Math.imul(h, 0x01000193) >>> 0;
				out.push(h & 0xff);
			}
			const bytes = new Uint8Array(out);
			return fmt === "hex"
				? [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
				: fmt === "base64"
					? btoa(String.fromCharCode(...bytes))
					: bytes;
		},
	};
	return self;
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
