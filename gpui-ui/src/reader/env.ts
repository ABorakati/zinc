// What the reader needs to know about the window it lives in: the device pixel ratio and the light/dark mode.
//
// DPR: GPUIX (0.11) reports logical sizes only (getWindowSize, onLayout), no scale factor. On Windows the window's DPI comes from
// user32 (GetDpiForWindow on this process's top-level window, found with EnumWindows), through bun:ffi; elsewhere, and in the
// headless test renderer (no window of this process), it is 1. `setReaderDpr(n)` / ZN_DPR force a value (scripts).
//
// Mode: the app's theme mode is store.mode(); importing the store runs it (it starts loading the library), so the reader
// follows it through a dynamic import the first time a reader mounts, and until then (or when the store is not wanted, as in
// the headless scripts that call setReaderMode) uses "dark", the store's own default.
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import { createEffect, createRoot, createSignal, type Accessor } from "solid-js";
import type { Mode } from "../contracts";

// ------------------------------------------------------------------------------------------------ DPR

let forcedDpr: number | undefined = Number(process.env.ZN_DPR) > 0 ? Number(process.env.ZN_DPR) : undefined;
export function setReaderDpr(dpr: number | undefined): void { forcedDpr = dpr; }

interface User32 {
	EnumWindows(cb: unknown, lparam: number): number;
	GetWindowThreadProcessId(hwnd: number | bigint, pid: number | bigint): number;
	IsWindowVisible(hwnd: number | bigint): number;
	IsWindow(hwnd: number | bigint): number;
	GetWindow(hwnd: number | bigint, cmd: number): number | bigint;
	GetDpiForWindow(hwnd: number | bigint): number;
}
let u32: User32 | null | undefined;
let enumCb: JSCallback | undefined;
let hwnd: number | bigint | null = null;
const pidBuf = new Uint32Array(1);
let found: (number | bigint)[] = [];

function user32(): User32 | null {
	if (u32 !== undefined) return u32;
	if (process.platform !== "win32") return (u32 = null);
	try {
		const p = FFIType.ptr;
		u32 = dlopen("user32.dll", {
			EnumWindows: { args: [FFIType.function, p], returns: FFIType.i32 },
			GetWindowThreadProcessId: { args: [p, p], returns: FFIType.u32 },
			IsWindowVisible: { args: [p], returns: FFIType.i32 },
			IsWindow: { args: [p], returns: FFIType.i32 },
			GetWindow: { args: [p, FFIType.u32], returns: p },
			GetDpiForWindow: { args: [p], returns: FFIType.u32 },
		}).symbols as unknown as User32;
		enumCb = new JSCallback(
			(h: number | bigint) => {
				const s = u32!;
				s.GetWindowThreadProcessId(h, pidBuf as never);
				// this process's visible top-level windows that have no owner (not a tool window / popup)
				if (pidBuf[0] === process.pid && s.IsWindowVisible(h) && !s.GetWindow(h, 4)) found.push(h);
				return 1;
			},
			{ args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		);
	} catch {
		u32 = null;
	}
	return u32;
}

/** Scale factor of the window this process shows (1 when there is none, e.g. the headless renderer). */
export function windowDpr(): number {
	if (forcedDpr) return forcedDpr;
	const s = user32();
	if (!s || !enumCb) return 1;
	try {
		if (hwnd == null || !s.IsWindow(hwnd)) {
			found = [];
			s.EnumWindows(enumCb.ptr, 0);
			hwnd = found[0] ?? null;
		}
		if (hwnd == null) return 1;
		const dpi = s.GetDpiForWindow(hwnd);
		return dpi > 0 ? Math.round((dpi / 96) * 100) / 100 : 1;
	} catch {
		return 1;
	}
}

// ------------------------------------------------------------------------------------------------ mode

const [mode, setMode] = createSignal<Mode>("dark");
let bound = false;

/** Force the mode (scripts); stops the reader from following the store. */
export function setReaderMode(m: Mode): void { bound = true; setMode(m); }

/** The reader's current mode accessor; the first call starts following store.mode(). */
export function readerMode(): Accessor<Mode> {
	if (!bound) {
		bound = true;
		void import("../store").then(({ store }) => createRoot(() => createEffect(() => setMode(store.mode())))).catch(() => {});
	}
	return mode;
}
