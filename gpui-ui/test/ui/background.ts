// Keeps the tests' windows off the screen. GPUI's test renderer opens a real window for each renderer, "offscreen" or not. On Windows
// the process's main thread moves to a desktop of its own before the first window exists: what it opens there is drawn and takes input
// from the test as usual, and can neither be seen nor take the focus from whoever is working on the machine.
//
// It fails closed: a test that cannot get that desktop does not run. `bun run test:ui --show` puts the windows on screen, to watch one.
import { dlopen, FFIType } from "bun:ffi";

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
