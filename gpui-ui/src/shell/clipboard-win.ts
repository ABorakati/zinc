// The Windows clipboard through Win32 (bun:ffi), so copying never starts a helper process (a PowerShell helper flashed a console
// window from the packaged app). Writes plain text and, optionally, the "HTML Format" (CF_HTML) Word pastes as formatted text,
// in one clipboard transaction; reads plain text. Returns null / false when not on Windows or when the calls fail, so callers
// can fall back.
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";

interface Win32 {
	OpenClipboard(h: number): number;
	CloseClipboard(): number;
	EmptyClipboard(): number;
	SetClipboardData(fmt: number, mem: number | bigint): number | bigint;
	GetClipboardData(fmt: number): number | bigint;
	RegisterClipboardFormatW(name: Buffer): number;
	GlobalAlloc(flags: number, bytes: number): number | bigint;
	GlobalLock(mem: number | bigint): number | bigint;
	GlobalUnlock(mem: number | bigint): number;
	GlobalFree(mem: number | bigint): number | bigint;
	GlobalSize(mem: number | bigint): number | bigint;
}

let w32: Win32 | null | undefined;
function win32(): Win32 | null {
	if (w32 !== undefined) return w32;
	if (process.platform !== "win32") return (w32 = null);
	try {
		const p = FFIType.ptr;
		const u = dlopen("user32.dll", {
			OpenClipboard: { args: [p], returns: FFIType.i32 },
			CloseClipboard: { args: [], returns: FFIType.i32 },
			EmptyClipboard: { args: [], returns: FFIType.i32 },
			SetClipboardData: { args: [FFIType.u32, p], returns: p },
			GetClipboardData: { args: [FFIType.u32], returns: p },
			RegisterClipboardFormatW: { args: [p], returns: FFIType.u32 },
		}).symbols;
		const k = dlopen("kernel32.dll", {
			GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: p },
			GlobalLock: { args: [p], returns: p },
			GlobalUnlock: { args: [p], returns: FFIType.i32 },
			GlobalFree: { args: [p], returns: p },
			GlobalSize: { args: [p], returns: FFIType.u64 },
		}).symbols;
		w32 = { ...u, ...k } as unknown as Win32;
	} catch {
		w32 = null;
	}
	return w32;
}

const CF_UNICODETEXT = 13;
const CF_DIB = 8;
const GMEM_MOVEABLE = 2;

function globalCopy(w: Win32, bytes: Buffer): number | bigint | null {
	const mem = w.GlobalAlloc(GMEM_MOVEABLE, bytes.byteLength);
	if (!mem) return null;
	const dst = w.GlobalLock(mem);
	if (!dst) { w.GlobalFree(mem); return null; }
	new Uint8Array(toArrayBuffer(dst as never, 0, bytes.byteLength)).set(bytes);
	w.GlobalUnlock(mem);
	return mem;
}

/** Put text (and optionally a CF_HTML document, see features/platform.ts cfHtml) on the clipboard. */
export function writeClipboard(text: string, cfHtmlDoc?: string): boolean {
	const w = win32();
	if (!w) return false;
	const parts: [number, Buffer][] = [[CF_UNICODETEXT, Buffer.from(text + "\0", "utf16le")]];
	if (cfHtmlDoc) {
		const fmt = w.RegisterClipboardFormatW(Buffer.from("HTML Format\0", "utf16le"));
		if (fmt) parts.push([fmt, Buffer.from(cfHtmlDoc + "\0", "utf8")]);
	}
	for (let attempt = 0; attempt < 5; attempt++) { // another process may hold the clipboard for a moment
		if (!w.OpenClipboard(0)) { Bun.sleepSync(10); continue; }
		try {
			w.EmptyClipboard();
			let ok = true;
			for (const [fmt, bytes] of parts) {
				const mem = globalCopy(w, bytes);
				if (!mem) { ok = false; continue; }
				if (!w.SetClipboardData(fmt, mem)) { w.GlobalFree(mem); ok = false; } // on success the system owns the memory
			}
			return ok;
		} finally {
			w.CloseClipboard();
		}
	}
	return false;
}

/** The clipboard's text, or null when it cannot be read (not Windows, busy); "" when it holds no text. */
export function readClipboard(): string | null {
	const w = win32();
	if (!w) return null;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!w.OpenClipboard(0)) { Bun.sleepSync(10); continue; }
		try {
			const h = w.GetClipboardData(CF_UNICODETEXT);
			if (!h) return "";
			const src = w.GlobalLock(h);
			if (!src) return "";
			try {
				const size = Number(w.GlobalSize(h));
				const s = Buffer.from(toArrayBuffer(src as never, 0, size)).toString("utf16le");
				const end = s.indexOf("\0");
				return end >= 0 ? s.slice(0, end) : s;
			} finally {
				w.GlobalUnlock(h);
			}
		} finally {
			w.CloseClipboard();
		}
	}
	return null;
}

/** Put an image (PNG buffer and optionally CF_DIB bitmap) on the clipboard. */
export function writeClipboardImage(pngBytes: Buffer, dibBytes?: Buffer): boolean {
	const w = win32();
	if (!w) return false;
	const parts: [number, Buffer][] = [];
	if (dibBytes) {
		parts.push([CF_DIB, dibBytes]);
	}
	const fmt = w.RegisterClipboardFormatW(Buffer.from("PNG\0", "utf16le"));
	if (fmt) {
		parts.push([fmt, pngBytes]);
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!w.OpenClipboard(0)) { Bun.sleepSync(10); continue; }
		try {
			w.EmptyClipboard();
			let ok = true;
			for (const [f, bytes] of parts) {
				const mem = globalCopy(w, bytes);
				if (!mem) { ok = false; continue; }
				if (!w.SetClipboardData(f, mem)) { w.GlobalFree(mem); ok = false; }
			}
			return ok;
		} finally {
			w.CloseClipboard();
		}
	}
	return false;
}

/** Check if the clipboard holds an image (CF_DIB or PNG format). */
export function hasClipboardImage(): boolean {
	const w = win32();
	if (!w) return false;
	const fmt = w.RegisterClipboardFormatW(Buffer.from("PNG\0", "utf16le"));
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!w.OpenClipboard(0)) { Bun.sleepSync(10); continue; }
		try {
			return !!(w.GetClipboardData(CF_DIB) || (fmt && w.GetClipboardData(fmt)));
		} finally {
			w.CloseClipboard();
		}
	}
	return false;
}

/** Read PNG bytes from clipboard if available. */
export function readClipboardImage(): Buffer | null {
	const w = win32();
	if (!w) return null;
	const fmt = w.RegisterClipboardFormatW(Buffer.from("PNG\0", "utf16le"));
	if (!fmt) return null;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!w.OpenClipboard(0)) { Bun.sleepSync(10); continue; }
		try {
			const h = w.GetClipboardData(fmt);
			if (!h) return null;
			const src = w.GlobalLock(h);
			if (!src) return null;
			try {
				const size = Number(w.GlobalSize(h));
				return Buffer.from(toArrayBuffer(src as never, 0, size));
			} finally {
				w.GlobalUnlock(h);
			}
		} finally {
			w.CloseClipboard();
		}
	}
	return null;
}
