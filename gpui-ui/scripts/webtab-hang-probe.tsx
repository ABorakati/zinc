// Reproduces "the app hangs when a web snapshot opens / when closing": runs the real window on a COPY of a library, opens a web
// snapshot tab, then closes the window (WM_CLOSE), logging every 500 ms whether the JS thread runs (heartbeat) and whether Windows
// considers the window hung (IsHungAppWindow). Never touches the mouse or keyboard. Use a scratch APPDATA so settings stay apart:
//   APPDATA=<scratch> ZN_DB=<library copy> ZN_PORT=23182 ZN_SYNC=0 ZN_ZPORT=0 bun scripts/webtab-hang-probe.tsx <attachmentKey> [close-open]
import { dlopen, FFIType } from "bun:ffi";
import { mainWindow } from "../src/webview/win32";
const [key = "", mode = "close-after"] = process.argv.slice(2);
const u = dlopen("user32.dll", {
	IsHungAppWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
	PostMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
	GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
	GetWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
	GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	SetWindowPos: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
	SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
});
const k32 = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 } });
const t0 = performance.now();
const log = (m: string) => console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${m}`);
await import("../src/main");
const { store } = await import("../src/store");
const { hostState, hostError, webTabHandle } = await import("../src/webview/host");
/** Is the web tab's popup visible, and is it above the main window in the z-order (what the user sees)? */
function popupReport(label: string): void {
	const p = webTabHandle(), w = mainWindow();
	if (p == null || w == null) { log(`[popup] ${label}: no popup`); return; }
	let above = false;
	let cur: unknown = p;
	for (let i = 0; i < 200; i++) { cur = u.symbols.GetWindow(cur as never, 2); if (!cur) break; if (BigInt(cur as never) === BigInt(w as never)) { above = true; break; } }
	const r = new Int32Array(4); u.symbols.GetWindowRect(p as never, r as never);
	log(`[popup] ${label}: visible=${u.symbols.IsWindowVisible(p as never)} aboveMain=${above} rect=${r.join(",")}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let last = performance.now();
setInterval(() => {
	const now = performance.now(), gap = now - last; last = now;
	const w = mainWindow();
	log(`beat${gap > 900 ? ` LATE by ${(gap - 500).toFixed(0)} ms` : ""}  hung=${w != null ? u.symbols.IsHungAppWindow(w as never) : "-"}  web=${hostState()} ${hostError()}`);
}, 500);
while (store.pagesLoaded() === 0) await sleep(100);
{ const w = mainWindow(); log(`threads: JS ${k32.symbols.GetCurrentThreadId()}, app window ${w != null ? u.symbols.GetWindowThreadProcessId(w as never, null as never) : "-"}`); }
await sleep(1500);
log(`opening snapshot ${key}`);
store.openAttachment(key, "Probe snapshot", "");
await sleep(6000);
log(`tabs ${store.tabs().map((t) => t.id).join(",")} active ${store.activeTab()}`);
if (mode === "minimize") {
	// minimise and restore, then resize, as a user does: is the snapshot still shown over its tab?
	const m = mainWindow();
	popupReport("after opening");
	if (m != null) {
		u.symbols.ShowWindow(m as never, 6); log("minimised"); await sleep(2000); popupReport("while minimised");
		u.symbols.ShowWindow(m as never, 9); u.symbols.SetForegroundWindow(m as never); log("restored"); await sleep(2000); popupReport("after restore");
		const r = new Int32Array(4); u.symbols.GetWindowRect(m as never, r as never);
		u.symbols.SetWindowPos(m as never, null as never, r[0]! + 40, r[1]! + 30, r[2]! - r[0]! - 200, r[3]! - r[1]! - 120, 0x4 | 0x10);
		log("resized"); await sleep(2000); popupReport("after resize");
		u.symbols.SetForegroundWindow(m as never); await sleep(1500); popupReport("after bringing the app forward again");
	}
}
if (mode !== "close-open") { store.closeTab(key); log("closed the web tab"); await sleep(3000); }
const w = mainWindow();
log("posting WM_CLOSE to the main window");
if (w != null) u.symbols.PostMessageW(w as never, 0x10, 0n, 0n);
await sleep(15000);
log("still running 15 s after WM_CLOSE");
process.exit(3);
