// The Windows title bar and window border in the app's colours: dark title bar in dark mode (DWMWA_USE_IMMERSIVE_DARK_MODE) and,
// on Windows 11, the caption, caption text and border painted with the theme's canvas / foreground / border tokens, following the
// colour scheme and light/dark switches. Windows 10 ignores the colour attributes and keeps the light/dark title bar. No-op
// elsewhere and in the headless renderer (no window).
import { dlopen, FFIType } from "bun:ffi";
import { mainWindow } from "../webview/win32";

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_BORDER_COLOR = 34, DWMWA_CAPTION_COLOR = 35, DWMWA_TEXT_COLOR = 36;

let dwm: { DwmSetWindowAttribute(h: unknown, attr: number, value: Uint32Array, size: number): number } | null | undefined;
function api() {
	if (dwm !== undefined) return dwm;
	if (process.platform !== "win32") return (dwm = null);
	try {
		dwm = dlopen("dwmapi.dll", {
			DwmSetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		}).symbols as never;
	} catch {
		dwm = null;
	}
	return dwm;
}

/** "#RRGGBB" -> COLORREF (0x00BBGGRR), or null for anything else. */
function colorref(hex: string | undefined): number | null {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "");
	return m ? (parseInt(m[3]!, 16) << 16) | (parseInt(m[2]!, 16) << 8) | parseInt(m[1]!, 16) : null;
}

const one = new Uint32Array(1);
let retry: ReturnType<typeof setInterval> | undefined;

export function applyFrameTheme(dark: boolean, colors: { caption?: string; text?: string; border?: string }): void {
	const d = api();
	if (!d) return;
	if (retry) clearInterval(retry);
	const set = (): boolean => {
		const w = mainWindow();
		if (w == null) return false;
		const put = (attr: number, v: number | null) => { if (v != null) { one[0] = v >>> 0; d.DwmSetWindowAttribute(w, attr, one, 4); } };
		put(DWMWA_USE_IMMERSIVE_DARK_MODE, dark ? 1 : 0);
		put(DWMWA_CAPTION_COLOR, colorref(colors.caption));
		put(DWMWA_TEXT_COLOR, colorref(colors.text));
		put(DWMWA_BORDER_COLOR, colorref(colors.border));
		return true;
	};
	if (set()) return;
	let tries = 0; // the window may not be visible yet
	retry = setInterval(() => { if (set() || ++tries > 50) clearInterval(retry); }, 100);
	retry.unref?.();
}
