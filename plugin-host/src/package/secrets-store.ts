// Per-plugin secrets (lifecycle.wit, interface secrets): API keys and tokens, 64 names and 8 KiB per value per plugin.
//
// HOW THEY ARE STORED, and how that differs from the WIT's wording ("the operating system's credential store"): Windows Credential
// Manager limits one credential to 2560 bytes and a native store per OS would need a keychain/libsecret binding each. What is built
// here is an encrypted file store keyed to the OS user:
//   - one 32-byte master key per user; on Windows it is wrapped with DPAPI (CryptProtectData, the primitive under Credential
//     Manager) and stored in secrets/master.key.dpapi, so only this Windows user can unwrap it;
//   - on other systems (or if DPAPI fails) the key is a file with mode 0600 (secrets/master.key): a plain-file fallback, marked in
//     `protection`;
//   - each plugin's secrets are in secrets/<id>.json, every value AES-256-GCM encrypted under a per-plugin key derived with HKDF, with
//     the plugin id and secret name as authenticated data, so moving a value to another plugin or name makes it fail to decrypt.
// TODO: macOS Keychain (`security`) and Secret Service (`secret-tool`) key providers, and Credential Manager chunking, if the
// "visible in the OS credential UI" property is wanted. Values are never logged.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-file";
import type { Layout } from "./layout";

export const MAX_SECRETS = 64;
export const MAX_SECRET_BYTES = 8 * 1024;
const NAME = /^[A-Za-z0-9._:-]{1,128}$/;

export class SecretError extends Error {
	constructor(
		readonly tag: "invalid-argument" | "limit-exceeded" | "internal",
		message: string,
	) {
		super(message);
	}
}

export interface KeyProvider {
	/** How the master key is protected: "dpapi" or "file" (plain file, mode 0600). */
	readonly protection: string;
	/** The 32-byte master key. Created on first use. */
	key(): Uint8Array;
}

// ---- Windows DPAPI through bun:ffi -------------------------------------------------------------------------------------------

const ENTROPY = new TextEncoder().encode("zinc-plugin-secrets-v1");

function dpapi(): { protect(data: Uint8Array): Uint8Array; unprotect(data: Uint8Array): Uint8Array } {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { dlopen, FFIType, ptr, read, toArrayBuffer } = require("bun:ffi") as typeof import("bun:ffi");
	const crypt32 = dlopen("crypt32.dll", {
		CryptProtectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		CryptUnprotectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	});
	const kernel32 = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } });
	const CRYPTPROTECT_UI_FORBIDDEN = 1;
	// DATA_BLOB on x64: { DWORD cbData; (4 bytes padding); BYTE *pbData }
	const blob = (bytes: Uint8Array) => {
		const b = Buffer.alloc(16);
		b.writeUInt32LE(bytes.length, 0);
		b.writeBigUInt64LE(BigInt(ptr(bytes)), 8);
		return b;
	};
	const run = (fn: "CryptProtectData" | "CryptUnprotectData", data: Uint8Array) => {
		const input = data.length ? data : new Uint8Array(1);
		const inBlob = blob(input);
		inBlob.writeUInt32LE(data.length, 0);
		const entropy = new Uint8Array(ENTROPY);
		const entBlob = blob(entropy);
		const out = Buffer.alloc(16);
		const ok =
			fn === "CryptProtectData"
				? crypt32.symbols.CryptProtectData(ptr(inBlob), null, ptr(entBlob), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out))
				: crypt32.symbols.CryptUnprotectData(ptr(inBlob), null, ptr(entBlob), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out));
		if (!ok) throw new SecretError("internal", `${fn} failed`);
		const len = read.u32(ptr(out), 0);
		const p = read.ptr(ptr(out), 8);
		const copy = new Uint8Array(toArrayBuffer(p as never, 0, len)).slice();
		kernel32.symbols.LocalFree(p as never);
		return copy;
	};
	return { protect: (d) => run("CryptProtectData", d), unprotect: (d) => run("CryptUnprotectData", d) };
}

export function windowsKeyProvider(dir: string): KeyProvider {
	const file = join(dir, "master.key.dpapi");
	let cached: Uint8Array | undefined;
	return {
		protection: "dpapi",
		key() {
			if (cached) return cached;
			const d = dpapi();
			if (existsSync(file)) cached = d.unprotect(new Uint8Array(readFileSync(file)));
			else {
				mkdirSync(dir, { recursive: true });
				const k = new Uint8Array(randomBytes(32));
				writeFileSync(file, d.protect(k));
				cached = k;
			}
			return cached;
		},
	};
}

export function fileKeyProvider(dir: string): KeyProvider {
	const file = join(dir, "master.key");
	let cached: Uint8Array | undefined;
	return {
		protection: "file",
		key() {
			if (cached) return cached;
			if (existsSync(file)) cached = new Uint8Array(Buffer.from(readFileSync(file, "utf8").trim(), "hex"));
			else {
				mkdirSync(dir, { recursive: true });
				cached = new Uint8Array(randomBytes(32));
				writeFileSync(file, Buffer.from(cached).toString("hex") + "\n", { mode: 0o600 });
				try {
					chmodSync(file, 0o600);
				} catch {
					/* best effort */
				}
			}
			if (cached.length !== 32) throw new SecretError("internal", "master key file is damaged");
			return cached;
		},
	};
}

/** DPAPI on Windows (falling back to the file when DPAPI is unusable), the 0600 key file elsewhere. */
export function defaultKeyProvider(dir: string): KeyProvider {
	if (process.platform !== "win32") return fileKeyProvider(dir);
	const w = windowsKeyProvider(dir);
	const f = fileKeyProvider(dir);
	let chosen: KeyProvider | undefined;
	const pick = () => {
		if (chosen) return chosen;
		try {
			w.key();
			chosen = w;
		} catch {
			chosen = f;
		}
		return chosen;
	};
	return {
		get protection() {
			return pick().protection;
		},
		key: () => pick().key(),
	};
}

// ---- the store ---------------------------------------------------------------------------------------------------------------------

interface Sealed {
	iv: string;
	tag: string;
	ct: string;
}
interface SecretFile {
	v: 1;
	items: Record<string, Sealed>;
}

export class SecretStore {
	private keys: KeyProvider;

	constructor(
		private layout: Layout,
		keys?: KeyProvider,
	) {
		this.keys = keys ?? defaultKeyProvider(layout.secretsDir);
	}

	get protection(): string {
		return this.keys.protection;
	}

	private pluginKey(plugin: string): Buffer {
		return Buffer.from(hkdfSync("sha256", this.keys.key(), "zinc-plugin-secrets", plugin, 32));
	}

	private read(plugin: string): SecretFile {
		const f = readJson<SecretFile>(this.layout.secretsFile(plugin), { v: 1, items: {} });
		return f.v === 1 && f.items ? f : { v: 1, items: {} };
	}

	private checkName(name: string) {
		if (!NAME.test(name)) throw new SecretError("invalid-argument", `bad secret name "${name}" (1 to 128 of A-Z a-z 0-9 . _ : -)`);
	}

	get(plugin: string, name: string): string | undefined {
		this.checkName(name);
		const s = this.read(plugin).items[name];
		if (!s) return undefined;
		try {
			const d = createDecipheriv("aes-256-gcm", this.pluginKey(plugin), Buffer.from(s.iv, "base64"));
			d.setAAD(Buffer.from(`${plugin}\0${name}`));
			d.setAuthTag(Buffer.from(s.tag, "base64"));
			return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
		} catch {
			throw new SecretError("internal", `secret "${name}" cannot be decrypted (the store was copied from another user or changed)`);
		}
	}

	set(plugin: string, name: string, value: string): void {
		this.checkName(name);
		if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new SecretError("limit-exceeded", `a secret is at most ${MAX_SECRET_BYTES} bytes`);
		const f = this.read(plugin);
		if (!(name in f.items) && Object.keys(f.items).length >= MAX_SECRETS) throw new SecretError("limit-exceeded", `at most ${MAX_SECRETS} secrets per plugin`);
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", this.pluginKey(plugin), iv);
		c.setAAD(Buffer.from(`${plugin}\0${name}`));
		const ct = Buffer.concat([c.update(Buffer.from(value, "utf8")), c.final()]);
		f.items[name] = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
		writeJsonAtomic(this.layout.secretsFile(plugin), f, 0o600);
	}

	delete(plugin: string, name: string): void {
		this.checkName(name);
		const f = this.read(plugin);
		if (!(name in f.items)) return;
		delete f.items[name];
		writeJsonAtomic(this.layout.secretsFile(plugin), f, 0o600);
	}

	listNames(plugin: string): string[] {
		return Object.keys(this.read(plugin).items).sort();
	}

	/** Uninstall: delete every secret of the plugin. */
	deleteAll(plugin: string): void {
		rmSync(this.layout.secretsFile(plugin), { force: true });
	}
}
