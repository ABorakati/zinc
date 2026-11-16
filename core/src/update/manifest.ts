// The update manifest (latest.json) and its Ed25519 signature.
//
//   { "version": "0.2.0+1a2b3c4d-20261201", "releasedAt": "2026-12-01T09:00:00Z", "notes": "markdown ...",
//     "url": "https://.../zotero-next-0.2.0-setup.exe", "sha256": "<64 hex>", "size": 123456789,
//     "minVersion": "0.1.0",            // optional: older installs must update by hand
//     "platform": "linux-x64",          // optional: which build this is (absent = "win-x64"; see platform.ts)
//     "signature": "<base64 Ed25519>" }
//
// One manifest per platform: latest.json (Windows; never has "platform": Windows builds older than the per-platform feeds reject unknown fields),
// latest-linux-x64.json and latest-darwin-arm64.json (each with its signed "platform", so one platform's file cannot be served as another's).
//
// The signature covers the canonical bytes of the manifest WITHOUT the "signature" field: UTF-8 JSON, object keys sorted
// recursively, no whitespace. Every other field is signed, so a changed url / hash / size / version / notes fails verification.
// The app embeds only the PUBLIC key (raw 32 bytes, base64). The private key (JWK) never belongs in the repo (see UPDATES.md).
// Pure apart from WebCrypto (Bun and Node).
import { parseVersion } from "./version";

export interface UnsignedManifest {
	version: string;
	releasedAt: string;
	notes: string;
	url: string;
	sha256: string;
	size: number;
	minVersion?: string;
	/** "linux-x64" (an AppImage), "darwin-arm64" (Zinc.app, zipped); absent = "win-x64" (the installer). */
	platform?: string;
}
export interface Manifest extends UnsignedManifest {
	signature: string;
}

export type UpdateErrorCode =
	| "malformed"
	| "bad-signature"
	| "no-key"
	| "insecure-url"
	| "too-large"
	| "hash-mismatch"
	| "size-mismatch"
	| "network"
	| "http"
	| "installer"
	| "disabled"
	| "no-feed"
	| "busy"
	| "wrong-platform";
export class UpdateError extends Error {
	constructor(
		readonly code: UpdateErrorCode,
		message: string,
	) {
		super(message);
		this.name = "UpdateError";
	}
}

const FIELDS = new Set(["version", "releasedAt", "notes", "url", "sha256", "size", "minVersion", "platform", "signature"]);

// ------------------------------------------------------------------------------------------------------------ canonical bytes

function canon(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
		.join(",")}}`;
}

/** The bytes that are signed: the manifest minus "signature", canonical JSON, UTF-8. */
export function canonicalBytes(m: object): Uint8Array<ArrayBuffer> {
	const { signature: _s, ...rest } = m as Record<string, unknown>;
	return new TextEncoder().encode(canon(rest)) as Uint8Array<ArrayBuffer>;
}

// ------------------------------------------------------------------------------------------------------------ keys

const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const unb64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64"));

export interface PrivateJwk {
	kty: "OKP";
	crv: "Ed25519";
	d: string;
	x: string;
}
export interface KeyPair {
	/** Raw 32-byte public key, base64: this is what the app embeds. */
	publicKey: string;
	/** Private key as JWK: this is what the release script reads (ZN_UPDATE_KEY). */
	privateJwk: PrivateJwk;
}

export async function generateKeyPair(): Promise<KeyPair> {
	const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
	const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
	return { publicKey: b64(raw), privateJwk: { kty: "OKP", crv: "Ed25519", d: jwk.d!, x: jwk.x! } };
}

/** The base64 public key that belongs to a private JWK. */
export function publicKeyOf(jwk: { x: string }): string {
	return b64(Buffer.from(jwk.x, "base64url"));
}

async function importPublic(publicKey: string): Promise<CryptoKey> {
	const raw = unb64(publicKey.trim());
	if (raw.length !== 32) throw new UpdateError("no-key", "the update public key is not a 32-byte Ed25519 key");
	return crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
}

// ------------------------------------------------------------------------------------------------------------ sign / verify

const HEX64 = /^[0-9a-f]{64}$/;

/** https only; plain http only to the machine itself (tests, a local mirror). */
export function assertSecureUrl(u: string): URL {
	let url: URL;
	try {
		url = new URL(u);
	} catch {
		throw new UpdateError("insecure-url", "not a valid URL");
	}
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new UpdateError("insecure-url", `updates need an https URL (got ${url.protocol}//${url.hostname})`);
	return url;
}

/** Check the shape and the values of a manifest (not the signature). Throws UpdateError("malformed"). */
export function validateShape(raw: unknown): Manifest {
	const bad = (why: string): never => {
		throw new UpdateError("malformed", `bad update manifest: ${why}`);
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not an object");
	const m = raw as Record<string, unknown>;
	for (const k of Object.keys(m)) if (!FIELDS.has(k)) bad(`unknown field "${k}"`);
	const str = (k: string): string => (typeof m[k] === "string" && (m[k] as string).length > 0 ? (m[k] as string) : bad(`"${k}" missing`));
	const version = str("version");
	if (!parseVersion(version)) bad("version is not a version number");
	const releasedAt = str("releasedAt");
	if (Number.isNaN(Date.parse(releasedAt))) bad("releasedAt is not a date");
	if (typeof m.notes !== "string") bad('"notes" missing');
	const url = str("url");
	assertSecureUrl(url);
	const sha256 = str("sha256").toLowerCase();
	if (!HEX64.test(sha256)) bad("sha256 is not 64 hex digits");
	const size = m.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) bad('"size" is not a positive integer');
	const minVersion = m.minVersion;
	if (minVersion !== undefined && (typeof minVersion !== "string" || !parseVersion(minVersion)))
		bad("minVersion is not a version number");
	const platform = m.platform;
	if (platform !== undefined && (typeof platform !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(platform)))
		bad("platform is not a platform name");
	const signature = str("signature");
	return {
		version,
		releasedAt,
		notes: m.notes as string,
		url,
		sha256,
		size: size as number,
		...(minVersion ? { minVersion: minVersion as string } : {}),
		...(platform ? { platform: platform as string } : {}),
		signature,
	};
}

/** Sign a manifest with the private JWK. */
export async function signManifest(m: UnsignedManifest, privateJwk: PrivateJwk): Promise<Manifest> {
	const key = await crypto.subtle.importKey("jwk", privateJwk, "Ed25519", false, ["sign"]);
	const body = { ...m, sha256: m.sha256.toLowerCase() };
	const sig = await crypto.subtle.sign("Ed25519", key, canonicalBytes(body));
	return validateShape({ ...body, signature: b64(sig) });
}

/** Parse + check a manifest: shape, then the Ed25519 signature against the embedded public key. Throws UpdateError. */
export async function verifyManifest(raw: unknown, publicKey: string): Promise<Manifest> {
	if (!publicKey) throw new UpdateError("no-key", "this build has no update public key, so updates cannot be verified");
	const m = validateShape(raw);
	const key = await importPublic(publicKey);
	let ok = false;
	try {
		ok = await crypto.subtle.verify("Ed25519", key, unb64(m.signature), canonicalBytes(m));
	} catch {
		ok = false;
	}
	if (!ok) throw new UpdateError("bad-signature", "the update manifest's signature is not valid");
	return m;
}
