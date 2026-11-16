// OS services the reader needs and GPUIX 0.11 does not expose: the clipboard (copy selected PDF text) and opening a URL in the
// browser (external links). Win32 through bun:ffi; elsewhere a best-effort fallback (pbcopy / xclip, open / xdg-open).
//
// GPUIX has a native clipboard in its source tree (packages/native/src/clipboard.rs) but the published 0.11.0 binding does not
// export it, so copyText() first looks for `writeToClipboard` / `copyText` on the renderer at run time (a newer binding gets
// used automatically) and only then falls back to Win32.
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

interface Win32 {
	OpenClipboard(h: number): number;
	CloseClipboard(): number;
	EmptyClipboard(): number;
	SetClipboardData(fmt: number, mem: number | bigint): number | bigint;
	GetClipboardData(fmt: number): number | bigint;
	GlobalAlloc(flags: number, bytes: number): number | bigint;
	GlobalLock(mem: number | bigint): number | bigint;
	GlobalUnlock(mem: number | bigint): number;
	GlobalFree(mem: number | bigint): number | bigint;
	ShellExecuteW(h: number, op: Buffer, file: Buffer, params: number, dir: number, show: number): number | bigint;
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
		}).symbols;
		const k = dlopen("kernel32.dll", {
			GlobalAlloc: { args: [FFIType.u32, FFIType.u64], returns: p },
			GlobalLock: { args: [p], returns: p },
			GlobalUnlock: { args: [p], returns: FFIType.i32 },
			GlobalFree: { args: [p], returns: p },
		}).symbols;
		const s = dlopen("shell32.dll", { ShellExecuteW: { args: [p, p, p, p, p, FFIType.i32], returns: p } }).symbols;
		w32 = { ...u, ...k, ...s } as unknown as Win32;
	} catch {
		w32 = null;
	}
	return w32;
}

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 2;

/** Anything with a native clipboard (a newer GPUIX binding). */
type MaybeClipboard = { writeToClipboard?(t: string): void; copyText?(t: string): void } | null | undefined;

/** Put text on the system clipboard. Returns whether it worked. */
export function copyText(text: string, renderer?: MaybeClipboard): boolean {
	try {
		if (renderer?.writeToClipboard) {
			renderer.writeToClipboard(text);
			return true;
		}
		if (renderer?.copyText) {
			renderer.copyText(text);
			return true;
		}
	} catch {
		/* fall through */
	}
	const w = win32();
	if (w) {
		const bytes = Buffer.from(text + "\0", "utf16le");
		const mem = w.GlobalAlloc(GMEM_MOVEABLE, bytes.byteLength);
		if (!mem) return false;
		const dst = w.GlobalLock(mem);
		if (!dst) {
			w.GlobalFree(mem);
			return false;
		}
		new Uint8Array(toArrayBuffer(dst as never, 0, bytes.byteLength)).set(bytes);
		w.GlobalUnlock(mem);
		let ok = false;
		for (let i = 0; i < 5 && !ok; i++) {
			// another process may hold the clipboard for a moment
			if (w.OpenClipboard(0)) {
				w.EmptyClipboard();
				ok = !!w.SetClipboardData(CF_UNICODETEXT, mem);
				w.CloseClipboard();
			} else Bun.sleepSync(10);
		}
		if (!ok) w.GlobalFree(mem); // on success the system owns the memory
		return ok;
	}
	try {
		const cmd = process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
		const r = Bun.spawnSync(cmd, { stdin: Buffer.from(text) });
		return r.exitCode === 0;
	} catch {
		return false;
	}
}

/** Text from the system clipboard (used by tests); null when there is none. */
export function pasteText(): string | null {
	const w = win32();
	if (!w || !w.OpenClipboard(0)) return null;
	try {
		const h = w.GetClipboardData(CF_UNICODETEXT);
		if (!h) return null;
		const src = w.GlobalLock(h);
		if (!src) return null;
		try {
			const u16 = new Uint16Array(toArrayBuffer(src as never, 0, 1 << 24));
			let n = 0;
			while (u16[n] !== 0 && n < u16.length - 1) n++;
			return Buffer.from(u16.buffer, 0, n * 2).toString("utf16le");
		} finally {
			w.GlobalUnlock(h);
		}
	} finally {
		w.CloseClipboard();
	}
}

/** http(s) only: a PDF is attacker-authored, so file:, smb:, javascript: and app-registered schemes never reach the OS. */
export const isSafeUrl = (u: string): boolean => /^https?:\/\//i.test(u) && !/[\s\u0000-\u001f]/.test(u);

/** Open a URL in the default browser. Returns false for anything that is not a plain http(s) URL. */
export function openUrl(url: string): boolean {
	if (!isSafeUrl(url)) return false;
	const w = win32();
	try {
		if (w) {
			const r = w.ShellExecuteW(0, Buffer.from("open\0", "utf16le"), Buffer.from(url + "\0", "utf16le"), 0, 0, 1);
			return Number(r) > 32;
		}
		Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
		return true;
	} catch {
		return false;
	}
}
