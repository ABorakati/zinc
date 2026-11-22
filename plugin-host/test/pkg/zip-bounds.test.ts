// readZip confines every central directory entry to the directory the end record declares.
import { describe, expect, test } from "bun:test";
import { readZip, writeZip, ZipError } from "../../src/package/zip";

const sample = () =>
	writeZip([
		{ name: "manifest.json", data: new TextEncoder().encode("{}") },
		{ name: "locale/en-US/main.ftl", data: new TextEncoder().encode("hello = hi\n") },
	]);
const eocdAt = (z: Uint8Array) => {
	for (let i = z.length - 22; i >= 0; i--) if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 5 && z[i + 3] === 6) return i;
	throw new Error("no end record");
};
const view = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);

describe("central directory bounds", () => {
	test("a well-formed archive reads", () => {
		expect(readZip(sample()).map((f) => f.name)).toEqual(["manifest.json", "locale/en-US/main.ftl"]);
	});
	test("a declared directory too small for its entries is refused", () => {
		const z = sample();
		const e = eocdAt(z);
		const size = view(z).getUint32(e + 12, true);
		for (const smaller of [0, 10, 46, size - 1]) {
			const copy = z.slice();
			view(copy).setUint32(e + 12, smaller, true);
			let refused = false;
			try {
				readZip(copy);
			} catch (e) {
				refused = e instanceof ZipError;
			}
			expect([smaller, refused]).toEqual([smaller, true]);
		}
	});
	test("a directory that runs into the end record is refused", () => {
		const z = sample();
		const e = eocdAt(z);
		const copy = z.slice();
		view(copy).setUint32(e + 12, view(z).getUint32(e + 12, true) + 8, true); // 8 bytes of the end record count as directory
		expect(() => readZip(copy)).toThrow(ZipError);
	});
	test("a name or extra field that runs past the directory is refused", () => {
		const z = sample();
		const e = eocdAt(z);
		const first = view(z).getUint32(e + 16, true);
		const copy = z.slice();
		view(copy).setUint16(first + 30, 4000, true); // extra-field length of the first entry
		expect(() => readZip(copy)).toThrow(ZipError);
	});
});
