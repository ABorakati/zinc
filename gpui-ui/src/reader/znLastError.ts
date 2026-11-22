// Reading zn_pdf's last error message from bun:ffi.
//
// zpdf_last_error() returns a pointer into a string that any worker thread frees the moment it records another error, so reading it
// races with them. Newer zn_pdf builds also export zpdf_last_error_copy(buf, cap), which copies the message into our own buffer while
// it is locked. zn_pdf.dll is built separately and shipped beside the app, so the one in use can be older than this code: the copy
// function is bound on its own, and without it the old pointer function is used.
import { dlopen, FFIType, ptr } from "bun:ffi";

type CopyFn = (buf: unknown, cap: number | bigint) => number | bigint;

/** The first `cap` bytes the buffer can hold; a longer message is read again into a buffer that fits. */
const FIRST_CAP = 1024;

/**
 * A function that returns the library's last error message. `dll` is the zn_pdf library's path; `legacy` reads the message through the
 * old zpdf_last_error symbol and is used when this build of the library has no zpdf_last_error_copy.
 */
export function lastErrorReader(dll: string, legacy: () => unknown): () => string {
	let copy: CopyFn | null;
	try {
		copy = dlopen(dll, { zpdf_last_error_copy: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 } }).symbols
			.zpdf_last_error_copy as unknown as CopyFn;
	} catch {
		copy = null; // an older zn_pdf without the symbol
	}
	return copy ? () => readCopy(copy) : () => String(legacy());
}

/** Read the message through `copy`; exported for the test, which hands it a function of its own. */
export function readCopy(copy: CopyFn): string {
	let buf = Buffer.alloc(FIRST_CAP);
	let n = Number(copy(ptr(buf), buf.length));
	if (n >= buf.length) {
		buf = Buffer.alloc(n + 1);
		n = Math.min(n, Number(copy(ptr(buf), buf.length))); // the message may have changed in between: never read past what was written
	}
	return buf.toString("utf8", 0, Math.min(n, buf.length - 1));
}
