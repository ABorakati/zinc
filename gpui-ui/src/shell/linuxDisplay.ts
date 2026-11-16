// Linux: run the app on X11 (XWayland on a Wayland desktop). Imported FIRST by main.tsx, before GPUIX loads, because GPUI and GTK
// pick their display backend from the environment when they start.
//
// Why: the web view (snapshots, EPUBs, the note editor) is a GTK window kept over a placeholder in the GPUI window (webview/x11.ts).
// On Wayland a client cannot position its own windows, so that only works when both windows are X11 windows. ZN_WAYLAND=1 keeps
// native Wayland instead (sharper with fractional scaling, but no web view).
//
// process.env changes are not guaranteed to reach native code's getenv(), so the C environment is changed through libc as well.
import { dlopen, FFIType } from "bun:ffi";

if (process.platform === "linux" && process.env.ZN_WAYLAND !== "1" && process.env.DISPLAY) {
	try {
		const libc = dlopen("libc.so.6", {
			setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
			unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
		}).symbols;
		const c = (s: string) => Buffer.from(`${s}\0`) as unknown as string;
		if (process.env.WAYLAND_DISPLAY) {
			libc.unsetenv(c("WAYLAND_DISPLAY"));
			delete process.env.WAYLAND_DISPLAY;
		}
		libc.setenv(c("GDK_BACKEND"), c("x11"), 1);
		process.env.GDK_BACKEND = "x11";
		// GTK's print dialog goes through the desktop portal when one is installed, and where the portal cannot show its dialog (no GNOME
		// shell, e.g. WSLg) the call never returns. Outside a sandbox GTK's own dialog does the same job straight with CUPS, so the app
		// uses that; a Flatpak keeps the portal (it has no other way to print).
		if (!process.env.FLATPAK_ID) {
			const debug = [process.env.GDK_DEBUG, "no-portals"].filter(Boolean).join(",");
			libc.setenv(c("GDK_DEBUG"), c(debug), 1);
			process.env.GDK_DEBUG = debug;
		}
	} catch (e) {
		console.warn("[display] could not switch to X11:", e instanceof Error ? e.message : e);
	}
}
