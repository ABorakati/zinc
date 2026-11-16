import { describe, expect, test } from "bun:test";
import { createHash as nodeCreateHash, randomBytes } from "node:crypto";
import { createHash } from "./small";

const hex = (alg: string, data: string | Uint8Array) => createHash(alg).update(data).digest("hex");
const nodeHex = (alg: string, data: Uint8Array) => nodeCreateHash(alg).update(data).digest("hex");

const RFC1321: [string, string][] = [
	["", "d41d8cd98f00b204e9800998ecf8427e"],
	["a", "0cc175b9c0f1b6a831c399e269772661"],
	["abc", "900150983cd24fb0d6963f7d28e17f72"],
	["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
	["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
	["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
	["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
];

describe("md5 (RFC 1321 test suite)", () => {
	for (const [input, digest] of RFC1321) {
		test(`md5(${input.length > 20 ? `${input.length} chars` : JSON.stringify(input)})`, () => {
			expect(hex("md5", input)).toBe(digest);
		});
	}

	test("digest without an encoding returns 16 bytes", () => {
		const out = createHash("md5").update("abc").digest();
		expect(out).toBeInstanceOf(Uint8Array);
		expect(out.length).toBe(16);
		expect(Buffer.from(out).toString("hex")).toBe("900150983cd24fb0d6963f7d28e17f72");
	});

	test("base64 encoding", () => {
		expect(createHash("md5").update("abc").digest("base64")).toBe(
			Buffer.from("900150983cd24fb0d6963f7d28e17f72", "hex").toString("base64"),
		);
	});

	test("update accepts several chunks, strings, ArrayBuffers and views, and equals the concatenation", () => {
		const a = new TextEncoder().encode("hello, ");
		const b = new TextEncoder().encode("world, this is a longer chunk of text for md5");
		const h = createHash("md5")
			.update("zotero ")
			.update(a)
			.update(b.buffer.slice(0))
			.update(new DataView(new Uint8Array([33]).buffer));
		const whole = new Uint8Array([...new TextEncoder().encode("zotero "), ...a, ...b, 33]);
		expect(h.digest("hex")).toBe(nodeHex("md5", whole));
	});

	test("50 random buffers match node:crypto md5, including padding boundaries", () => {
		const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128];
		for (let i = 0; i < 50; i++) {
			const size = i < sizes.length ? sizes[i]! : Math.floor(Math.random() * 3000);
			const data = new Uint8Array(randomBytes(size));
			expect(hex("md5", data)).toBe(nodeHex("md5", data));
		}
	});
});

const SHA1_VECTORS: [string, string][] = [
	["", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
	["abc", "a9993e364706816aba3e25717850c26c9cd0d89d"],
	["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "84983e441c3bd26ebaae4aa1f95129e5e54670f1"],
];

const SHA256_VECTORS: [string, string][] = [
	["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
	["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
];

describe("sha1 (FIPS 180-4)", () => {
	for (const [input, digest] of SHA1_VECTORS) {
		test(`sha1(${input.length} chars)`, () => expect(hex("sha1", input)).toBe(digest));
	}
	test("sha-1 spelling is accepted", () => expect(hex("SHA-1", "abc")).toBe(SHA1_VECTORS[1]![1]));
	test("50 random buffers match node:crypto sha1", () => {
		for (let i = 0; i < 50; i++) {
			const data = new Uint8Array(randomBytes(Math.floor(Math.random() * 2000)));
			expect(hex("sha1", data)).toBe(nodeHex("sha1", data));
		}
	});
});

describe("sha256 (FIPS 180-4)", () => {
	for (const [input, digest] of SHA256_VECTORS) {
		test(`sha256(${input.length} chars)`, () => expect(hex("sha256", input)).toBe(digest));
	}
	test("50 random buffers match node:crypto sha256", () => {
		for (let i = 0; i < 50; i++) {
			const data = new Uint8Array(randomBytes(Math.floor(Math.random() * 2000)));
			expect(hex("sha256", data)).toBe(nodeHex("sha256", data));
		}
	});
});

describe("unsupported algorithms", () => {
	test("throw a clear error that names the algorithm", () => {
		expect(() => createHash("sha512")).toThrow(/sha512/);
		expect(() => createHash("blake2b512")).toThrow(/blake2b512/);
	});
	test("digest twice throws", () => {
		const h = createHash("md5").update("x");
		h.digest("hex");
		expect(() => h.digest("hex")).toThrow();
	});
});
