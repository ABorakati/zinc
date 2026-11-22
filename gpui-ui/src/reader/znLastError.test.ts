// bun test src/reader/znLastError.test.ts -- the last error is copied out of zn_pdf, and an older zn_pdf.dll still works.
import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { findDll } from "./pdf";
import { lastErrorReader, readCopy } from "./znLastError";

/** A system library that certainly has no zpdf_last_error_copy: stands in for a zn_pdf.dll built before it existed. */
const OLD_LIB = process.platform === "win32" ? "kernel32.dll" : process.platform === "darwin" ? "libSystem.dylib" : "libc.so.6";

function znWithCopy(): string | null {
	try {
		const dll = findDll();
		dlopen(dll, { zpdf_last_error_copy: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 } });
		return dll;
	} catch {
		return null; // no zn_pdf build here, or one without the copy function
	}
}

describe("lastErrorReader", () => {
	test("a zn_pdf without zpdf_last_error_copy reads the message through the old function", () => {
		let calls = 0;
		const read = lastErrorReader(OLD_LIB, () => {
			calls++;
			return "old message";
		});
		expect(read()).toBe("old message");
		expect(calls).toBe(1);
	});

	test("a path that cannot be opened at all also falls back", () => {
		expect(lastErrorReader("no-such-library-anywhere.dll", () => "fallback")()).toBe("fallback");
	});

	const dll = znWithCopy();
	test.skipIf(!dll)("the real zn_pdf: the message of a failed open comes through the copy function", () => {
		const z = dlopen(dll!, { zpdf_open: { args: [FFIType.ptr], returns: FFIType.ptr } }).symbols;
		let legacyUsed = false;
		const read = lastErrorReader(dll!, () => {
			legacyUsed = true;
			return "";
		});
		const path = Buffer.from("Z:/no/such/folder/missing-\u00e9.pdf\0", "utf8");
		expect(z.zpdf_open(ptr(path))).toBeNull();
		const msg = read();
		expect(msg).toContain("missing-\u00e9.pdf"); // UTF-8 survives the copy
		expect(legacyUsed).toBe(false);
	});
});

describe("readCopy", () => {
	/** A stand-in for zpdf_last_error_copy: writes `msg` (cut to fit, NUL-terminated) and returns its full length. */
	const fake = (msg: string) => (p: unknown, cap: number | bigint) => {
		const bytes = Buffer.from(msg, "utf8");
		const out = toBuffer(p as never, 0, Number(cap));
		const n = Math.min(bytes.length, Number(cap) - 1);
		out.set(bytes.subarray(0, n));
		out[n] = 0;
		return bytes.length;
	};

	test("a short message", () => expect(readCopy(fake("boom"))).toBe("boom"));
	test("an empty message", () => expect(readCopy(fake(""))).toBe(""));
	test("a message longer than the first buffer is read whole", () => {
		const long = "x".repeat(5000) + "\u00e9end";
		expect(readCopy(fake(long))).toBe(long);
	});
});
