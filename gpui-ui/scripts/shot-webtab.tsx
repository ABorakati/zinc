// Drives the real window through the web-tab life cycle and measures it (visible window; never touches the mouse or keyboard):
//   ZN_DB=<copy of the library> ZN_PORT=23182 ZN_SYNC=0 ZN_ZPORT=0 bun scripts/shot-webtab.tsx <attachmentKey> <outDir> <capproc.ps1> <mem.ps1>
// 1 baseline memory (no web tab)  2 open the snapshot (web tab)  3 shot  4 resize the window, shot (the view follows)  5 Library tab, shot
// (the view is hidden)  6 back, open a dialog, shot (the view is hidden under overlays)  7 close the tab, memory (the WebView2 is gone).
// capproc.ps1 screen-copies only the app window's rect; mem.ps1 sums this process and its descendants (WebView2 processes).
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync } from "node:fs";
import { Show } from "solid-js";
import { mainWindow } from "../src/webview/win32";

const [key = "", outDir = ".", cap = "", mem = ""] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
await import("../src/main");
const { store } = await import("../src/store");
const { openDialog } = await import("../src/ui");
const { hostState, evalInPage } = await import("../src/webview/host");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u = dlopen("user32.dll", { SetWindowPos: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.i32 }, GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } }).symbols;

async function ps(file: string, args: string[]): Promise<string> {
	const p = Bun.spawn(["pwsh", "-NoProfile", "-File", file, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim();
}
const shot = async (name: string) => console.log(`[shot] ${name}:`, await ps(cap, ["-ProcId", String(process.pid), "-Out", `${outDir}/${name}.png`]));
const memory = async (label: string) => console.log(`[mem] ${label}:\n${await ps(mem, ["-ProcId", String(process.pid)])}`);

while (store.pagesLoaded() === 0) await sleep(100);
await sleep(3000);
await memory("baseline, no web tab");
const cpu = async (label: string) => { const a = process.cpuUsage(); await sleep(5000); const b = process.cpuUsage(a); console.log(`[cpu] ${label}: ${((b.user + b.system) / 5000 / 10).toFixed(2)} % of one core over 5 s`); };
await cpu("idle, no web tab");

store.openAttachment(key, "Snapshot test", "");
await sleep(7000);
console.log("[webview] state", hostState(), "tabs", store.tabs().map((t) => `${t.id}:${"kind" in t ? t.kind : "-"}`).join(","), "active", store.activeTab());
await memory("web tab open");
await cpu("web tab open and shown (10 ms message pump)");
// the page's bridge: reader-host posts to window.parent; the stub forwards it to the app (open-item -> Library tab + selection)
evalInPage("window.parent.postMessage({ type: 'open-item', key: 'ABCD1234' }, '*')");
await sleep(1000);
console.log("[bridge] after open-item: active tab", store.activeTab(), "selected", store.selectedItem());
store.setActiveTab(key);
await sleep(1000);
await shot("1-open");

const w = mainWindow();
if (w != null) {
	const r = new Int32Array(4);
	u.GetWindowRect(w as never, r as never);
	u.SetWindowPos(w as never, null as never, r[0]! + 60, r[1]! + 40, 1500, 1000, 0x4 | 0x10);
	await sleep(2500);
	await shot("2-moved-resized");
}

store.setActiveTab("library");
await sleep(1200);
await shot("3-library");

store.setActiveTab(key);
await sleep(1200);
let closeDialog = () => {};
void openDialog((close) => (
	<div ref={() => { closeDialog = () => close(); }} onClick={() => close()} style={{ padding: 24 }}><text style={{ color: "#e2e2e2" }}>A dialog open above the web tab (click to close)</text></div>
), { title: "Overlay test", width: 420 });
await sleep(1500);
await shot("4-dialog-over-web");
closeDialog();
await sleep(1500);
await shot("5-dialog-closed");

store.closeTab(key);
await sleep(2500);
console.log("[webview] after close: state", hostState());
await memory("web tab closed");
await shot("6-closed");
process.exit(0);
