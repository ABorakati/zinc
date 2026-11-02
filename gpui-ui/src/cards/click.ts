// GPUI delivers one click to the clicked element's handler and to every ancestor's (there is no stopPropagation on mouse events).
// A button inside a row calls swallow() from its handler; the row's own handler checks swallowed() and ignores that click.
let flag = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Mark the click being dispatched as handled by an inner control (cleared after the current dispatch). */
export function swallow(): void {
	flag = true;
	clearTimeout(timer);
	timer = setTimeout(() => { flag = false; }, 0);
}

/** true while the click in flight was handled by an inner control. */
export function swallowed(): boolean {
	return flag;
}

export interface ClickPayload {
	x?: number;
	y?: number;
	button?: number;
	clickCount?: number;
	isRightClick?: boolean;
	modifiers?: { shift?: boolean; ctrl?: boolean; alt?: boolean; cmd?: boolean };
}

/** Shift / Ctrl(Cmd) of a click. */
export const modsOf = (e: ClickPayload) => ({ shift: !!e.modifiers?.shift, ctrl: !!(e.modifiers?.ctrl || e.modifiers?.cmd) });
