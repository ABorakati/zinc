import { describe, expect, test } from "bun:test";
import * as nodeZlib from "node:zlib";
import * as shim from "./zlib";

const enc = new TextEncoder();
const eq = (a: Uint8Array, b: Uint8Array) => expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

const samples: [string, Uint8Array][] = [
	["empty", new Uint8Array(0)],
	["short text", enc.encode("hello zotero")],
	["repetitive", enc.encode("abc".repeat(5000))],
	["binary", Uint8Array.from({ length: 70000 }, (_, i) => (i * 2654435761) >>> 24)],
	["utf-8", enc.encode("Zotero: naïve café — 文献 ✓ ".repeat(200))],
];

describe("zlib shim round trips", () => {
	for (const [name, data] of samples) {
		test(`deflateRaw / inflateRaw: ${name}`, () => eq(shim.inflateRawSync(shim.deflateRawSync(data)), data));
		test(`deflate / inflate: ${name}`, () => eq(shim.inflateSync(shim.deflateSync(data)), data));
		test(`gzip / gunzip: ${name}`, () => eq(shim.gunzipSync(shim.gzipSync(data)), data));
	}

	test("returns Uint8Array and accepts Buffer and ArrayBuffer input", () => {
		const out = shim.gzipSync(Buffer.from("abc"));
		expect(out).toBeInstanceOf(Uint8Array);
		eq(shim.gunzipSync(out.buffer as ArrayBuffer), enc.encode("abc"));
	});

	test("level option is accepted", () => {
		const data = enc.encode("level ".repeat(1000));
		eq(shim.inflateRawSync(shim.deflateRawSync(data, { level: 9 })), data);
		eq(shim.inflateSync(shim.deflateSync(data, { level: 1 })), data);
	});
});

describe("interoperates with Bun's node:zlib", () => {
	for (const [name, data] of samples) {
		test(`shim inflates node deflateRawSync: ${name}`, () => {
			eq(shim.inflateRawSync(nodeZlib.deflateRawSync(data)), data);
		});
		test(`shim inflates node deflateSync (zlib wrapper): ${name}`, () => {
			eq(shim.inflateSync(nodeZlib.deflateSync(data)), data);
		});
		test(`shim gunzips node gzipSync: ${name}`, () => {
			eq(shim.gunzipSync(nodeZlib.gzipSync(data)), data);
		});
		test(`node inflates shim deflateRawSync: ${name}`, () => {
			eq(nodeZlib.inflateRawSync(shim.deflateRawSync(data)), data);
		});
		test(`node inflates shim deflateSync: ${name}`, () => {
			eq(nodeZlib.inflateSync(shim.deflateSync(data)), data);
		});
		test(`node gunzips shim gzipSync: ${name}`, () => {
			eq(nodeZlib.gunzipSync(shim.gzipSync(data)), data);
		});
	}

	test("shim gunzips a level-9 gzip stream from node", () => {
		const data = enc.encode("zotero file body");
		eq(shim.gunzipSync(nodeZlib.gzipSync(data, { level: 9 })), data);
	});
});
