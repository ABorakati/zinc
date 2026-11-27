// The main window's position and size, kept between launches. macOS only; a no-op elsewhere and when the app is driven (ZN_AUTOMATION).
//
// macOS: the window gets a frame autosave name (-[NSWindow setFrameAutosaveName:]). AppKit then writes the frame to the app's user
// defaults (key "NSWindow Frame Zinc Main Window") whenever the window moves or resizes, and setFrameUsingName: puts the window back
// there at the next launch, on a screen that is still connected. GPUIX would show the window centred at platform.window's size first,
// so platform.ts opens it hidden (placesWindow()) and restoreWindowFrame() shows it once its frame is set.
import { automationWanted } from "../automation";
import { hostRenderer } from "./native";
import { nsString, objc, type Id } from "./objc";

const AUTOSAVE_NAME = "Zinc Main Window";

/** True when restoreWindowFrame() places the window: platform.ts then opens it hidden. */
export const placesWindow = (): boolean => process.platform === "darwin" && !automationWanted();

/** GPUI's window, hidden or not: the first of the app's windows that can be a main window (the only one, right after render()). */
function appWindow(): Id {
	const r = objc();
	if (!r) return null;
	const { send: s, sel } = r;
	const list = s.m0(s.m0(r.cls("NSApplication"), sel("sharedApplication")), sel("windows"));
	const n = Number(s.m0(list, sel("count")) ?? 0);
	for (let i = 0; i < n; i++) {
		const w = s.mu(list, sel("objectAtIndex:"), i);
		if (w && s.b0(w, sel("canBecomeMainWindow"))) return w;
	}
	return null;
}

/** Right after render(): move the window to its saved frame, keep saving it, then show the window. */
export function restoreWindowFrame(): void {
	if (!placesWindow()) return;
	const r = objc();
	let w: Id = null;
	try {
		w = appWindow();
		if (r && w != null) {
			const name = nsString(AUTOSAVE_NAME);
			r.send.b1(w, r.sel("setFrameUsingName:"), name); // false on the first launch: the window keeps GPUIX's centred frame
			r.send.b1(w, r.sel("setFrameAutosaveName:"), name);
		}
	} catch (e) {
		console.error("[window] restoring the frame failed:", e instanceof Error ? e.message : e);
	} finally {
		// opened hidden (platform.ts): show it whether or not the frame was restored
		const activate = hostRenderer()?.activateWindow;
		if (activate) activate.call(hostRenderer());
		else if (r && w != null) r.send.m1(w, r.sel("makeKeyAndOrderFront:"), null);
	}
}
