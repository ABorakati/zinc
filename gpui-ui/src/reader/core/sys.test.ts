// bun test src/reader/core/sys.test.ts -- text read from another program's global memory stays inside the block. (Windows only; own memory, not the clipboard.)
import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { globalUtf16 } from "./sys";

const k =
	process.platform === "win32"
		? dlopen("kernel32.dll", {
				GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: FFIType.ptr },
				GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
				GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.i32 },
				GlobalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
				GlobalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
			}).symbols
		: null;

/** A moveable global block holding `bytes` exactly (no room for a terminator unless the bytes have one). */
function block(bytes: Buffer) {
	const h = k!.GlobalAlloc(2, bytes.byteLength)!;
	const p = k!.GlobalLock(h)!;
	new Uint8Array(toArrayBuffer(p as never, 0, bytes.byteLength)).set(bytes);
	k!.GlobalUnlock(h);
	return h;
}

const w = k as unknown as Parameters<typeof globalUtf16>[0];

describe.skipIf(!k)("globalUtf16", () => {
	test("reads a terminated string", () => {
		const h = block(Buffer.from("Smith J (2020) \u201cT\u201d\0", "utf16le"));
		expect(globalUtf16(w, h)).toBe("Smith J (2020) \u201cT\u201d");
		k!.GlobalFree(h);
	});

	test("an unterminated string ends with the block, not 16 MB later", () => {
		const h = block(Buffer.from("abcd", "utf16le")); // 8 bytes, no NUL
		expect(globalUtf16(w, h)).toBe("abcd");
		k!.GlobalFree(h);
	});

	test("an odd block size, an empty block and a null handle", () => {
		const h = block(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63]));
		expect(globalUtf16(w, h)).toBe("ab");
		k!.GlobalFree(h);
		expect(globalUtf16(w, 0)).toBeNull();
		const e = block(Buffer.from("\0\0", "utf16le"));
		expect(globalUtf16(w, e)).toBe("");
		k!.GlobalFree(e);
	});
});
