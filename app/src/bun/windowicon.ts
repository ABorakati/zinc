import { dlopen, FFIType, ptr } from "bun:ffi";

// Electrobun 2.0.5 registers its window class without an icon, so title bars show Windows' generic one. The class icon
// is set here, which also covers windows opened later (sign-in). Taskbar and shortcuts use the exe's own icon.
const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, GCLP_HICON = -14, GCLP_HICONSM = -34, WM_SETICON = 0x80, ICON_SMALL = 0, ICON_BIG = 1;
const wide = (s: string) => ptr(Buffer.from(s + "\0", "utf16le"));

export function applyWindowIcon(icoPath: string): void {
	if (process.platform !== "win32") return;
	try {
		const { symbols: u } = dlopen("user32.dll", {
			LoadImageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			FindWindowExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
			SetClassLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
			SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.ptr },
		});
		const load = (size: number) => u.LoadImageW(null, wide(icoPath), IMAGE_ICON, size, size, LR_LOADFROMFILE);
		const small = load(16), big = load(32);
		if (!small || !big) return void console.warn("[icon] could not load", icoPath);
		const className = Buffer.from("BasicWindowClass\0", "utf16le");
		const pid = new Uint32Array(1);
		const set = () => {
			let found = false;
			for (let w = u.FindWindowExW(null, null, ptr(className), null); w; w = u.FindWindowExW(null, w, ptr(className), null)) {
				u.GetWindowThreadProcessId(w, ptr(pid));
				if (pid[0] !== process.pid) continue;
				if (!found) {
					u.SetClassLongPtrW(w, GCLP_HICON, big);
					u.SetClassLongPtrW(w, GCLP_HICONSM, small);
				}
				u.SendMessageW(w, WM_SETICON, ICON_SMALL, small);
				u.SendMessageW(w, WM_SETICON, ICON_BIG, big);
				found = true;
			}
			return found;
		};
		// the native window can appear a moment after new BrowserWindow() returns
		if (set()) return;
		let tries = 0;
		const t = setInterval(() => { if (set() || ++tries > 40) clearInterval(t); }, 100);
		t.unref();
	} catch (e) {
		console.warn("[icon] not set:", e);
	}
}
