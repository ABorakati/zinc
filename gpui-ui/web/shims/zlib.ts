// node:zlib's synchronous functions for the browser demo, on fflate (pure JavaScript). Node's zlib-wrapped deflateSync/inflateSync
// are fflate's zlibSync/unzlibSync; deflateRawSync/inflateRawSync are fflate's deflateSync/inflateSync; gzip and gunzip map one to
// one. Each takes a Uint8Array, an ArrayBuffer or another typed array and returns a Uint8Array (not a Buffer).
// Mapped from node:zlib and zlib by web/build.ts.
import {
	deflateSync as fDeflateRaw,
	gunzipSync as fGunzip,
	gzipSync as fGzip,
	inflateSync as fInflateRaw,
	unzlibSync as fUnzlib,
	zlibSync as fZlib,
} from "fflate";

export type ZlibInput = Uint8Array | ArrayBufferLike | ArrayBufferView;
export type ZlibOptions = { level?: number };
type FflateOptions = { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 };

function bytes(data: ZlibInput): Uint8Array {
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(data);
}

function fflateOptions(opts?: ZlibOptions): FflateOptions {
	return opts?.level === undefined ? {} : { level: opts.level as FflateOptions["level"] };
}

export function deflateSync(data: ZlibInput, opts?: ZlibOptions): Uint8Array {
	return fZlib(bytes(data), fflateOptions(opts));
}

export function inflateSync(data: ZlibInput): Uint8Array {
	return fUnzlib(bytes(data));
}

export function deflateRawSync(data: ZlibInput, opts?: ZlibOptions): Uint8Array {
	return fDeflateRaw(bytes(data), fflateOptions(opts));
}

export function inflateRawSync(data: ZlibInput): Uint8Array {
	return fInflateRaw(bytes(data));
}

export function gzipSync(data: ZlibInput, opts?: ZlibOptions): Uint8Array {
	return fGzip(bytes(data), fflateOptions(opts));
}

export function gunzipSync(data: ZlibInput): Uint8Array {
	return fGunzip(bytes(data));
}

export default { deflateSync, inflateSync, deflateRawSync, inflateRawSync, gzipSync, gunzipSync };
