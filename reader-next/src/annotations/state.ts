// UI state shared by the annotation overlay, popups and sidebar panel.
import { createSignal } from "solid-js";
import type { SelectionInfo } from "../contract";
import { COLORS, DEFAULT_COLOR } from "./model";

export type Tool = "highlight" | "underline" | "note" | "image" | "ink";

const COLOR_KEY = "rn.ann.color";
function loadColor(): string {
	try {
		const c = localStorage.getItem(COLOR_KEY);
		if (c && COLORS.some((x) => x.value === c)) return c;
	} catch { /* ignore */ }
	return DEFAULT_COLOR;
}

export function createUi() {
	const [tool, setTool] = createSignal<Tool | null>(null);
	const [color, setColorRaw] = createSignal(loadColor());
	const [selectedId, select] = createSignal<string | null>(null);
	/** annotation whose comment box should take focus (after "Add comment") */
	const [focusComment, setFocusComment] = createSignal<string | null>(null);
	const [selection, setSelection] = createSignal<SelectionInfo | null>(null);
	/** true while the pointer is down on the page (the selection popup waits for the release) */
	const [dragging, setDragging] = createSignal(false);
	const [tick, bump] = createSignal(0); // view moved: popups re-anchor
	const [toast, setToast] = createSignal<string | null>(null);
	let toastTimer = 0;
	return {
		tool, setTool, color, selectedId, select, focusComment, setFocusComment, selection, setSelection, dragging, setDragging, tick,
		bump: () => bump((n) => n + 1),
		toast,
		showToast(msg: string) {
			setToast(msg);
			clearTimeout(toastTimer);
			toastTimer = window.setTimeout(() => setToast(null), 3500);
		},
		/** Remember the colour for new annotations. */
		setColor(c: string) {
			setColorRaw(c);
			try { localStorage.setItem(COLOR_KEY, c); } catch { /* ignore */ }
		},
	};
}
export type Ui = ReturnType<typeof createUi>;
