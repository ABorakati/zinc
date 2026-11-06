// Dragging text OUT of the window into other apps (Windows). GPUI has no OLE drag source, so native/pdf's zn_pdf.dll runs
// DoDragDrop (zn_drag_run, src/drag.rs) with an IDataObject offering Unicode text + "HTML Format"; this file is the bun:ffi side
// plus the Win32 probes the drag controller needs (is the button still down, where is the pointer relative to our window, Shift).
//
// OLE only sees the pointer on the thread that owns the window the button went down in, and GPUI's window lives on a thread of its
// own (not the JS thread). zn_drag_begin(hwnd, ...) therefore subclasses that window and runs DoDragDrop on ITS thread (see
// drag.rs); it returns a job that this file polls, so JS is never blocked while the pointer is dragged around.
import { dlopen, FFIType, JSCallback, ptr, toBuffer } from "bun:ffi";
import { findDll } from "../reader/pdf";
import { cfHtml } from "../features/cfhtml";

export interface Rect { left: number; top: number; right: number; bottom: number }

/** Is the point outside the rect, with `inset` px of slack on every side (so a pointer on the very edge still counts as inside)? */
export function pointOutside(r: Rect, x: number, y: number, inset = 1): boolean {
	return x < r.left + inset || y < r.top + inset || x >= r.right - inset || y >= r.bottom - inset;
}

const VK_LBUTTON = 0x01, VK_SHIFT = 0x10, VK_MENU = 0x12;
const GW_OWNER = 4;

interface Native {
	user: {
		GetAsyncKeyState(vk: number): number;
		GetCursorPos(p: ArrayBufferView): number;
		GetWindowRect(h: number | bigint, r: ArrayBufferView): number;
		GetWindowThreadProcessId(h: number | bigint, pid: ArrayBufferView): number;
		IsWindowVisible(h: number | bigint): number;
		GetWindow(h: number | bigint, cmd: number): number | bigint;
		EnumWindows(cb: unknown, lparam: number): number;
	};
	kernel: { GetCurrentThreadId(): number; GetCurrentProcessId(): number };
	zn: {
		zn_drag_begin(hwnd: bigint, text: unknown, tl: number | bigint, html: unknown, hl: number | bigint): unknown;
		zpdf_job_poll(job: unknown): number;
		zpdf_job_data(job: unknown): unknown;
		zpdf_job_len(job: unknown): number | bigint;
		zpdf_job_free(job: unknown): void;
		zpdf_last_error(): unknown;
	} | null;
}

let native: Native | null | undefined;
function load(): Native | null {
	if (native !== undefined) return native;
	if (process.platform !== "win32") return (native = null);
	try {
		const P = FFIType.ptr;
		const user = dlopen("user32.dll", {
			GetAsyncKeyState: { args: [FFIType.i32], returns: FFIType.i16 },
			GetCursorPos: { args: [P], returns: FFIType.i32 },
			GetWindowRect: { args: [P, P], returns: FFIType.i32 },
			GetWindowThreadProcessId: { args: [P, P], returns: FFIType.u32 },
			IsWindowVisible: { args: [P], returns: FFIType.i32 },
			GetWindow: { args: [P, FFIType.u32], returns: P },
			EnumWindows: { args: [P, FFIType.i64], returns: FFIType.i32 },
		}).symbols;
		const kernel = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: FFIType.u32 }, GetCurrentProcessId: { args: [], returns: FFIType.u32 } }).symbols;
		let zn: Native["zn"] = null;
		try {
			zn = dlopen(findDll(), {
				zn_drag_begin: { args: [FFIType.i64, P, FFIType.u64, P, FFIType.u64], returns: P },
				zpdf_job_poll: { args: [P], returns: FFIType.i32 },
				zpdf_job_data: { args: [P], returns: P },
				zpdf_job_len: { args: [P], returns: FFIType.u64 },
				zpdf_job_free: { args: [P], returns: FFIType.void },
				zpdf_last_error: { args: [], returns: FFIType.cstring },
			}).symbols as unknown as Native["zn"];
		} catch { zn = null; } // no zn_pdf.dll, or one built before the drag source: no OS drag, the caller falls back
		native = { user: user as unknown as Native["user"], kernel, zn };
	} catch {
		native = null;
	}
	return native;
}

/** Can this process start an OS drag (Windows, and a zn_pdf.dll that has zn_drag_begin)? */
export const osDragSupported = (): boolean => !!load()?.zn;

/** Is the left mouse button down right now (system wide)? */
export function leftButtonDown(): boolean {
	const n = load();
	return !!n && (n.user.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
}
export function shiftDown(): boolean {
	const n = load();
	return !!n && (n.user.GetAsyncKeyState(VK_SHIFT) & 0x8000) !== 0;
}
export function altDown(): boolean {
	const n = load();
	return !!n && (n.user.GetAsyncKeyState(VK_MENU) & 0x8000) !== 0;
}

/** The pointer's screen position, or null. */
export function cursorPos(): { x: number; y: number } | null {
	const n = load();
	if (!n) return null;
	const p = new Int32Array(2);
	return n.user.GetCursorPos(p) ? { x: p[0]!, y: p[1]! } : null;
}

let own: { hwnd: number | bigint; threadId: number } | null = null;
/** This process's main window: the largest visible, unowned top-level window of the process (cached). */
export function ownWindow(): { hwnd: number | bigint; threadId: number } | null {
	const n = load();
	if (!n) return null;
	if (own && n.user.IsWindowVisible(own.hwnd)) return own;
	const pid = n.kernel.GetCurrentProcessId();
	let best: { hwnd: number | bigint; threadId: number; area: number } | null = null;
	const cb = new JSCallback((hwnd: number | bigint) => {
		const owner = new Uint32Array(1);
		const tid = n.user.GetWindowThreadProcessId(hwnd, owner);
		if (owner[0] !== pid || !n.user.IsWindowVisible(hwnd) || n.user.GetWindow(hwnd, GW_OWNER)) return 1;
		const r = new Int32Array(4);
		if (!n.user.GetWindowRect(hwnd, r)) return 1;
		const area = Math.max(0, r[2]! - r[0]!) * Math.max(0, r[3]! - r[1]!);
		if (area > 0 && (!best || area > best.area)) best = { hwnd, threadId: tid, area };
		return 1;
	}, { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 });
	try { n.user.EnumWindows(cb.ptr, 0); } finally { cb.close(); }
	const found = best as { hwnd: number | bigint; threadId: number } | null;
	own = found ? { hwnd: found.hwnd, threadId: found.threadId } : null;
	return own;
}

/** The main window's screen rectangle, or null. */
export function ownWindowRect(): Rect | null {
	const n = load(), w = ownWindow();
	if (!n || !w) return null;
	const r = new Int32Array(4);
	return n.user.GetWindowRect(w.hwnd, r) ? { left: r[0]!, top: r[1]!, right: r[2]!, bottom: r[3]! } : null;
}

/** Is the pointer outside the main window right now? false when unknown. */
export function pointerOutsideWindow(): boolean {
	const r = ownWindowRect(), c = cursorPos();
	return !!r && !!c && pointOutside(r, c.x, c.y);
}

/** Is there a window to subclass and a zn_pdf.dll that can drag? (The drag runs on the window's own thread, whichever it is.) */
export function dragReady(): boolean {
	return !!load()?.zn && !!ownWindow();
}

export type OsDragResult = "dropped" | "cancelled" | "failed";

/**
 * Start the OS drag with this text (and HTML fragment, offered as "HTML Format") on the main window's thread and resolve when it ends
 * (the left button released). The button must be down when this is called.
 * "failed": the drag could not run (the caller should fall back to the clipboard); `lastDragError` says why.
 */
export async function runOsDrag(p: { text: string; html?: string }): Promise<OsDragResult> {
	const n = load(), w = ownWindow();
	if (!n?.zn) { lastError = "zn_pdf.dll has no drag source"; return "failed"; }
	if (!w) { lastError = "no window"; return "failed"; }
	const text = Buffer.from(p.text, "utf8");
	const html = p.html ? Buffer.from(cfHtml(p.html), "utf8") : null;
	const job = n.zn.zn_drag_begin(BigInt(w.hwnd), text.length ? ptr(text) : null, text.length, html ? ptr(html) : null, html ? html.length : 0);
	if (!job) { lastError = String(n.zn.zpdf_last_error()); return "failed"; }
	try {
		let st: number;
		const t0 = Date.now();
		while ((st = n.zn.zpdf_job_poll(job)) === 0) {
			if (Date.now() - t0 > 120_000) { lastError = "the drag did not finish"; return "failed"; } // the job is left to finish by itself (freeing a pending job is safe)
			await Bun.sleep(10);
		}
		if (st !== 1) { lastError = String(n.zn.zpdf_last_error()); return "failed"; }
		const len = Number(n.zn.zpdf_job_len(job));
		const json = JSON.parse(Buffer.from(toBuffer(n.zn.zpdf_job_data(job) as never, 0, len)).toString("utf8")) as { result: string };
		return json.result === "dropped" ? "dropped" : "cancelled";
	} finally {
		n.zn.zpdf_job_free(job);
	}
}

let lastError = "";
export const lastDragError = (): string => lastError;
