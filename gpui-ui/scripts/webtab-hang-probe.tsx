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
});
const k32 = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 } });
const t0 = performance.now();
const log = (m: string) => console.log(`${(performance.now() - t0).toFixed(0).padStart(6)} ms  ${m}`);
await import("../src/main");
const { store } = await import("../src/store");
const { hostState, hostError } = await import("../src/webview/host");
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
if (mode !== "close-open") { store.closeTab(key); log("closed the web tab"); await sleep(3000); }
const w = mainWindow();
log("posting WM_CLOSE to the main window");
if (w != null) u.symbols.PostMessageW(w as never, 0x10, 0n, 0n);
await sleep(15000);
log("still running 15 s after WM_CLOSE");
process.exit(3);
