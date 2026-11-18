// Drag items OUT of the window to drop a Quick Copy citation / bibliography into another app (Word, a browser text box, an email…).
//
// The in-app drag (dnd.ts: a mouse gesture, for dropping onto collections) tells this controller when it starts and ends. While it
// runs, a 16 ms timer watches the pointer; when it leaves the main window (or Alt was held at the start) the in-app drag is dropped
// and the OS takes over: shell/dragout.ts runs OLE DoDragDrop with the formatted text (Unicode text + "HTML Format"). Shift, read at
// that moment, flips bibliography <-> citation as in Zotero; the format itself (style or export format, locale, HTML or plain)
// is the Quick Copy setting.
//
// The text is formatted in the background from the moment the drag starts, so it is ready when the pointer crosses the border. If it
// is not (a big selection) the wait happens first; if the button was released meanwhile, or the OS drag cannot run (no zn_pdf.dll
// drag source, or the window is not on the JS thread), the text goes on the clipboard instead and a toast says so (the fallback).
import { endDrag, setDragHook, type DragPayload } from "../../dnd";
import {
	altDown,
	dragReady,
	lastDragError,
	leftButtonDown,
	osDragSupported,
	pointerOutsideWindow,
	runOsDrag,
	shiftDown,
	type OsDragResult,
} from "../../shell/dragout";
import { toast } from "../../ui";
import { copyRich } from "../platform";
import { errMsg } from "../text";
import { copiedMessage } from "./logic";
import { quickCopyContent, type QuickCopyContent } from "./quickcopy";

export interface OutDragDeps {
	supported(): boolean;
	leftDown(): boolean;
	shiftDown(): boolean;
	altDown(): boolean;
	outside(): boolean;
	/** can the OS drag run at all (a window to subclass, zn_pdf.dll with the drag source)? */
	ready(): boolean;
	content(keys: string[], shift: boolean): Promise<QuickCopyContent>;
	run(c: { text: string; html?: string }): Promise<OsDragResult>;
	/** the in-app drag is over (clears its ghost / highlight) */
	endInApp(): void;
	copy(c: QuickCopyContent): Promise<void>;
	notify(message: string, kind: "success" | "error", description?: string): void;
	every(fn: () => void, ms: number): () => void;
}

export interface OutDrag {
	start(payload: DragPayload): void;
	end(): void;
	/** true while a drag is being watched */
	active(): boolean;
}

export function createOutDrag(d: OutDragDeps): OutDrag {
	let stop: (() => void) | null = null;
	let handing = false;
	let memo = new Map<string, Promise<QuickCopyContent>>();
	let session = 0;

	const clear = () => {
		stop?.();
		stop = null;
	};

	/** Both results are requested up front (the plan is the same for both when an export format is chosen, so that is one request). */
	function prefetch(keys: string[]): (shift: boolean) => Promise<QuickCopyContent> {
		const get = (shift: boolean) => {
			// the plan key is only known after the settings are read, so memoise on the Shift flag
			const k = shift ? "shift" : "plain";
			let p = memo.get(k);
			if (!p) {
				p = d.content(keys, shift);
				memo.set(k, p);
				p.catch(() => { });
			}
			return p;
		};
		void get(false);
		if (keys.length <= 200) void get(true);
		return get;
	}

	async function handoff(get: (shift: boolean) => Promise<QuickCopyContent>, mySession: number): Promise<void> {
		if (handing) return;
		handing = true;
		clear();
		const shift = d.shiftDown(); // read now: the pointer has just crossed the border
		try {
			if (!d.ready()) throw new Error("no window to drag from, or zn_pdf.dll has no drag source");
			const c = await get(shift);
			if (mySession !== session) return; // cancelled meanwhile
			if (!d.leftDown()) {
				// released while formatting: nothing to drag any more
				await d.copy(c);
				d.notify(`${copiedMessage(c.plan, c.count)} — paste it`, "success");
				d.endInApp();
				return;
			}
			d.endInApp();
			const r = await d.run({ text: c.text, html: c.html });
			if (r === "failed") {
				await d.copy(c);
				d.notify(`${copiedMessage(c.plan, c.count)} — paste it`, "success", `The drag could not start: ${lastDragError()}`);
			}
		} catch (e) {
			d.endInApp();
			d.notify("Could not drag the citation", "error", errMsg(e));
		} finally {
			handing = false;
		}
	}

	return {
		start(payload) {
			clear();
			session++;
			memo = new Map();
			if (!d.supported() || payload.kind !== "items") return;
			const get = prefetch(payload.keys);
			const mine = session;
			const tick = () => {
				if (!d.leftDown()) {
					clear();
					return;
				} // an ordinary release inside the window: the in-app drag ends itself
				if (d.outside()) void handoff(get, mine);
			};
			stop = d.every(tick, 16);
			if (d.altDown()) void handoff(get, mine); // Alt held at the start: straight to the OS drag (dropping on a window next to this one)
		},
		end() {
			if (handing) return; // our own endInApp()
			clear();
		},
		active: () => stop !== null || handing,
	};
}

/** The real thing, wired to the Win32 probes and the clipboard. */
export function installOutDrag(): void {
	const dbg = process.env.ZN_DRAG_DEBUG ? (m: string) => console.error(`[dragout] ${m}`) : () => { };
	const out = createOutDrag({
		supported: osDragSupported,
		leftDown: leftButtonDown,
		shiftDown,
		altDown,
		outside: () => {
			const o = pointerOutsideWindow();
			if (o) dbg("outside");
			return o;
		},
		ready: () => {
			const ok = dragReady();
			dbg(`ready=${ok}`);
			return ok;
		},
		content: (keys, shift) => quickCopyContent(keys, { shift }),
		run: async (c) => {
			dbg(`DoDragDrop text=${c.text.length} html=${c.html?.length ?? 0}`);
			const r = await runOsDrag(c);
			dbg(`result ${r} ${lastDragError()}`);
			return r;
		},
		endInApp: endDrag,
		copy: (c) => copyRich(c.html ?? "", c.text),
		notify: (message, kind, description) => toast(message, { kind, description }),
		every: (fn, ms) => {
			const t = setInterval(fn, ms);
			return () => clearInterval(t);
		},
	});
	setDragHook({
		start: (p) => {
			if (p.kind !== "items") return;
			dbg(`start ${p.keys.length}`);
			out.start(p);
		},
		end: () => out.end(),
	});
}
