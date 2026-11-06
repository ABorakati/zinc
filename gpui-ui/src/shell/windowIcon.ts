// The window's own icon (title bar, taskbar button, Alt-Tab). GPUI registers its window class without one, so Windows showed its
// generic icon there; the exe's embedded icon only covers Explorer and shortcuts. Load the app icon (gpui-ui/assets/icon.ico, all sizes
// 16-256 px, made by scripts/make-icon.ts) at the sizes the window's DPI asks for and set it on the window and its class.
// Windows only; a no-op elsewhere and in the headless renderer (no window).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { packaged } from "../packaged";
import { mainWindow } from "../webview/win32";

const IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10, GCLP_HICON = -14, GCLP_HICONSM = -34, WM_SETICON = 0x80, ICON_SMALL = 0, ICON_BIG = 1;
const SM_CXICON = 11, SM_CXSMICON = 49;

function iconPath(): string | null {
	const candidates = packaged
		? [join(dirname(process.execPath), "icon.ico")]
		: [join(import.meta.dir, "..", "..", "assets", "icon.ico")];
	return candidates.find((p) => existsSync(p)) ?? null;
}

export function applyWindowIcon(): void {
	if (process.platform !== "win32") return;
	const file = iconPath();
	if (!file) return void console.warn("[icon] icon.ico not found");
	try {
		const p = FFIType.ptr;
		const { symbols: u } = dlopen("user32.dll", {
			LoadImageW: { args: [p, p, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: p },
			SetClassLongPtrW: { args: [p, FFIType.i32, p], returns: p },
			SendMessageW: { args: [p, FFIType.u32, FFIType.u64, p], returns: p },
			GetDpiForWindow: { args: [p], returns: FFIType.u32 },
			GetSystemMetricsForDpi: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
		});
		const wide = Buffer.from(file + "\0", "utf16le");
		const set = (): boolean => {
			const w = mainWindow();
			if (w == null) return false;
			const dpi = u.GetDpiForWindow(w as never) || 96;
			// LoadImageW picks the closest image in the .ico for each size, so the title bar gets a sharp 20/24 px icon at 125/150 %
			const small = u.LoadImageW(null, ptr(wide), IMAGE_ICON, u.GetSystemMetricsForDpi(SM_CXSMICON, dpi) || 16, u.GetSystemMetricsForDpi(SM_CXSMICON, dpi) || 16, LR_LOADFROMFILE);
			const big = u.LoadImageW(null, ptr(wide), IMAGE_ICON, u.GetSystemMetricsForDpi(SM_CXICON, dpi) || 32, u.GetSystemMetricsForDpi(SM_CXICON, dpi) || 32, LR_LOADFROMFILE);
			if (!small || !big) return void console.warn("[icon] could not load", file), true;
			u.SetClassLongPtrW(w as never, GCLP_HICON, big);
			u.SetClassLongPtrW(w as never, GCLP_HICONSM, small);
			u.SendMessageW(w as never, WM_SETICON, ICON_SMALL, small);
			u.SendMessageW(w as never, WM_SETICON, ICON_BIG, big);
			return true;
		};
		if (set()) return;
		// the window may not be visible yet when this runs
		let tries = 0;
		const t = setInterval(() => { if (set() || ++tries > 50) clearInterval(t); }, 100);
		t.unref?.();
	} catch (e) {
		console.warn("[icon] not set:", e instanceof Error ? e.message : e);
	}
}
