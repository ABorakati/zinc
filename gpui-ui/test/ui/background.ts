// Keeps the tests' windows off the screen. GPUI's test renderer opens a real window for each renderer, "offscreen" or not. On Windows
// the process's main thread moves to a desktop of its own before the first window exists: what it opens there is drawn and takes input
// from the test as usual, and can neither be seen nor take the focus from whoever is working on the machine.
//
// It fails closed: a test that cannot get that desktop does not run. `bun run test:ui --show` puts the windows on screen, to watch one.
import { dlopen, FFIType, JSCallback } from "bun:ffi";

/** One desktop for all test processes: each desktop costs desktop heap, of which a session has little. It goes with its last process. */
const DESKTOP = "zinc-ui-tests";
const GENERIC_ALL = 0x10000000;

let moved = false;

/** Call before the first window (so before the first TestRenderer) of this process. */
export function moveToBackgroundDesktop(): void {
	if (moved || process.platform !== "win32" || process.env.ZN_UI_TEST_SHOW === "1") return;
	const P = FFIType.ptr,
		HANDLE = FFIType.u64,
		U32 = FFIType.u32;
	const user32 = dlopen("user32.dll", {
		CreateDesktopW: { args: [P, P, P, U32, U32, P], returns: HANDLE },
		SetThreadDesktop: { args: [HANDLE], returns: FFIType.i32 },
	}).symbols;
	const desktop = user32.CreateDesktopW(Buffer.from(`${DESKTOP}\0`, "utf16le"), null, null, 0, GENERIC_ALL, null);
	if (!Number(desktop)) throw new Error("UI test: Windows gave no background desktop, so no window is opened (--show runs on screen)");
	if (!user32.SetThreadDesktop(desktop))
		throw new Error("UI test: could not move to the background desktop (a window already existed), so no window is opened");
	moved = true;
}

/**
 * The visible top-level windows on the desktop this thread is on (the user's screen, for the harness itself) that belong to a process
 * running `exe`. The real-app harness calls it while the app runs: anything but 0 means a window of the test app is on the user's screen.
 * Windows only; elsewhere 0.
 */
export function windowsOnScreen(exe: string): number {
	if (process.platform !== "win32") return 0;
	const H = FFIType.u64,
		I = FFIType.i32,
		U32 = FFIType.u32,
		P = FFIType.ptr;
	const user32 = dlopen("user32.dll", {
		EnumWindows: { args: [FFIType.function, H], returns: I },
		IsWindowVisible: { args: [H], returns: I },
		GetWindowThreadProcessId: { args: [H, P], returns: U32 },
	}).symbols;
	const kernel32 = dlopen("kernel32.dll", {
		OpenProcess: { args: [U32, I, U32], returns: H },
		QueryFullProcessImageNameW: { args: [H, U32, P, P], returns: I },
		CloseHandle: { args: [H], returns: I },
	}).symbols;
	const pids = new Set<number>();
	const each = new JSCallback(
		(hwnd: bigint) => {
			if (user32.IsWindowVisible(hwnd)) {
				const pid = new Uint32Array(1);
				user32.GetWindowThreadProcessId(hwnd, pid);
				pids.add(pid[0]!);
			}
			return 1;
		},
		{ args: [H, H], returns: I },
	);
	try {
		user32.EnumWindows(each.ptr!, 0n);
	} finally {
		each.close();
	}
	const want = exe.replaceAll("/", "\\").toLowerCase();
	let n = 0;
	for (const pid of pids) {
		const h = kernel32.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
		if (!Number(h)) continue;
		const buf = new Uint16Array(1024),
			len = new Uint32Array([buf.length]);
		if (kernel32.QueryFullProcessImageNameW(h, 0, buf, len) && String.fromCharCode(...buf.subarray(0, len[0])).toLowerCase() === want) n++;
		kernel32.CloseHandle(h);
	}
	return n;
}

/**
 * Gives the window this thread opened an inside of exactly `width` x `height` (logical pixels). GPUI's visual test window takes its size
 * from the display, whatever it is asked for, and every scenario's coordinates assume one size. Windows only; elsewhere false.
 */
export function fitWindow(width: number, height: number): boolean {
	if (process.platform !== "win32") return false;
	const H = FFIType.u64,
		I = FFIType.i32,
		U32 = FFIType.u32,
		P = FFIType.ptr;
	const user32 = dlopen("user32.dll", {
		EnumThreadWindows: { args: [U32, FFIType.function, H], returns: I },
		GetWindowRect: { args: [H, P], returns: I },
		GetClientRect: { args: [H, P], returns: I },
		GetDpiForWindow: { args: [H], returns: U32 },
		SetWindowPos: { args: [H, H, I, I, I, I, U32], returns: I },
	}).symbols;
	const kernel32 = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: U32 } }).symbols;
	const windows: bigint[] = [];
	const each = new JSCallback(
		(hwnd: bigint) => {
			windows.push(hwnd);
			return 1;
		},
		{ args: [H, H], returns: I },
	);
	try {
		user32.EnumThreadWindows(kernel32.GetCurrentThreadId(), each.ptr!, 0n);
	} finally {
		each.close();
	}
	const rect = (get: (h: bigint, r: Int32Array) => number, h: bigint) => {
		const r = new Int32Array(4);
		get(h, r);
		return { w: r[2]! - r[0]!, h: r[3]! - r[1]! };
	};
	// the app's window is the largest this thread has (GPUI may keep small helper windows)
	const hwnd = windows
		.map((h) => ({ h, area: rect(user32.GetClientRect, h).w * rect(user32.GetClientRect, h).h }))
		.sort((a, b) => b.area - a.area)[0]?.h;
	if (!hwnd) return false;
	const scale = (user32.GetDpiForWindow(hwnd) || 96) / 96;
	const outer = rect(user32.GetWindowRect, hwnd),
		inner = rect(user32.GetClientRect, hwnd);
	const SWP_NOMOVE = 0x2,
		SWP_NOZORDER = 0x4,
		SWP_NOACTIVATE = 0x10;
	return !!user32.SetWindowPos(
		hwnd,
		0n,
		0,
		0,
		Math.round(width * scale) + outer.w - inner.w,
		Math.round(height * scale) + outer.h - inner.h,
		SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
	);
}
