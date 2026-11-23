// Opt-in automation of the running app, for the UI harness (gpui-ui/test/ui): the packaged app, with the renderer that ships, driven
// over its standard input and output with GPUIX's automation protocol (@gpuix/native/automation). Off unless ZN_AUTOMATION=stdio is set
// by whoever starts the process; a normal start never reads stdin or exposes anything.
//
//   ZN_AUTOMATION=stdio          serve the protocol on stdin/stdout (the app's own console output goes to stderr instead)
//   ZN_AUTOMATION_DESKTOP=<name> Windows: open the window on that background desktop, where it is drawn and takes input but cannot be seen
//                                or take the focus (the harness uses one desktop for all its processes)

export const automationWanted = (): boolean => typeof process !== "undefined" && process.env?.ZN_AUTOMATION === "stdio";

let prepared = false;
let served = false;

/** Before the first window: move to the background desktop when asked, and keep stdout for the protocol. */
export function prepareAutomation(): void {
	if (prepared || !automationWanted()) return;
	prepared = true;
	// stdout carries the protocol: anything else written there would be read as part of it
	const toErr = (...a: unknown[]) => process.stderr.write(`${a.map((x) => (typeof x === "string" ? x : Bun.inspect(x))).join(" ")}\n`);
	console.log = toErr;
	console.info = toErr;
	console.debug = toErr;
	const desktop = process.env.ZN_AUTOMATION_DESKTOP;
	if (desktop && process.platform === "win32") moveToDesktop(desktop);
}

/** Once the renderer exists: answer the harness. */
export async function serveAutomation(renderer: unknown): Promise<void> {
	if (served || !automationWanted() || !renderer) return;
	served = true;
	const m = await import("@gpuix/native/automation");
	m.serveAutomationStdio(new m.InProcessBackend(m.liveRendererAsTest(renderer as never)));
}

function moveToDesktop(name: string): void {
	// bun:ffi is loaded only here: the app does not need it otherwise
	const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
	const user32 = dlopen("user32.dll", {
		CreateDesktopW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		SetThreadDesktop: { args: [FFIType.u64], returns: FFIType.i32 },
	}).symbols;
	const GENERIC_ALL = 0x10000000;
	const handle = user32.CreateDesktopW(Buffer.from(`${name}\0`, "utf16le"), null, null, 0, GENERIC_ALL, null);
	// fails closed: a window that could not be hidden is not opened on the user's screen
	if (!Number(handle) || !user32.SetThreadDesktop(handle)) {
		process.stderr.write(`automation: could not move to the background desktop "${name}"; not opening a window\n`);
		process.exit(3);
	}
}
