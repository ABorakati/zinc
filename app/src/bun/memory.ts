import { dlopen, FFIType } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserWindow } from "electrobun/main";

// Background-memory saver (Windows). Electrobun 2.0.5 has no minimise/restore event, no WebView2 memory-target or
// suspend API, and its webview pointer is a private C++ object (not an ICoreWebView2), so the one lever it does
// expose is the native webviewSetHidden call (the same one the <electrobun-webview> tag uses). While the window is
// minimised we hide the webview with it: WebView2 then reports document.visibilityState "hidden", throttles the
// page and trims physical memory: measured with a PDF open, hidden vs visible 20 s+ later, WebView2 working set
// ~790 MB vs ~865 MB (about -9%), private bytes about equal (~530 MB). Restore: visible again and painting in
// 140-200 ms, layout unchanged. Minimised state is polled (cheap FFI call) because there is no event for it.
// A real memory-target-level (COM) call was not reachable without forking the native wrapper.
const POLL_MS = 250;

const core = (() => {
	if (process.platform !== "win32") return null;
	try {
		const dll = join(dirname(process.execPath), "ElectrobunCore.dll");
		if (!existsSync(dll)) return null;
		return dlopen(dll, { webviewSetHidden: { args: [FFIType.u32, FFIType.bool], returns: FFIType.void } }).symbols;
	} catch (e) {
		console.warn("[memory] native hook unavailable:", e);
		return null;
	}
})();

export function watchWindowMemory(win: BrowserWindow): void {
	if (!core) return;
	let hidden = false;
	const apply = (h: boolean) => {
		if (h === hidden) return;
		const view = win.webview;
		if (!view) return;
		hidden = h;
		try {
			core.webviewSetHidden(view.id, h);
		} catch (e) {
			hidden = !h;
			console.warn("[memory] webviewSetHidden failed:", e);
		}
	};
	// Test hook: ZN_LOWMEM_TRIGGER=<file>; the webview is hidden while the file contains "1" (nothing is minimised on screen).
	const trigger = process.env.ZN_LOWMEM_TRIGGER;
	setInterval(() => {
		try {
			apply(trigger ? existsSync(trigger) && readFileSync(trigger, "utf8").trim() === "1" : win.isMinimized());
		} catch {
			// window already closed
		}
	}, POLL_MS).unref();
}
