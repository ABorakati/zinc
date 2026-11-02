// Global keyboard shortcuts. render()'s window-level onKeyDown (main.tsx passes `handleWindowKeyDown`) sees every key stroke after
// the focused element's own handlers; here it is matched against the `shortcut` strings of the registry's appActions
// ("Ctrl+Shift+A", "Ctrl+,", "Alt+Left") plus any local handler a view registers while it is shown (the Settings tab).
// Light on purpose: imports only the registry.
import type { KeyEvent } from "@gpuix/native/host";
import { appActions } from "../registry";

export interface Chord { ctrl: boolean; shift: boolean; alt: boolean; key: string }

const KEY_ALIASES: Record<string, string> = {
	esc: "escape", return: "enter", del: "delete", ins: "insert", space: " ", spacebar: " ",
	arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", pageup: "pageup", pagedown: "pagedown",
	comma: ",", period: ".", slash: "/", plus: "+", minus: "-",
};

/** "Ctrl+Shift+A" -> {ctrl, shift, alt, key:"a"}; undefined when it has no key. "Ctrl" also means Cmd. */
export function parseChord(s: string): Chord | undefined {
	const parts = s.split("+").map((x) => x.trim());
	// "Ctrl++" / "Ctrl+ +": a trailing empty part means the key is "+"
	let key = parts.pop() ?? "";
	if (key === "" && parts.length) key = "+";
	if (!key) return undefined;
	const c: Chord = { ctrl: false, shift: false, alt: false, key: "" };
	for (const m of parts) {
		const l = m.toLowerCase();
		if (l === "ctrl" || l === "control" || l === "cmd" || l === "meta" || l === "mod") c.ctrl = true;
		else if (l === "shift") c.shift = true;
		else if (l === "alt" || l === "option") c.alt = true;
	}
	const k = key.toLowerCase();
	c.key = KEY_ALIASES[k] ?? k;
	return c;
}

const chordCache = new Map<string, Chord | undefined>();
const chordOf = (s: string): Chord | undefined => {
	if (!chordCache.has(s)) chordCache.set(s, parseChord(s));
	return chordCache.get(s);
};

/** Does the key stroke match the shortcut string? */
export function matchesChord(shortcut: string, e: Pick<KeyEvent, "key" | "modifiers">): boolean {
	const c = chordOf(shortcut);
	if (!c || !e.key) return false;
	const m = e.modifiers;
	const ctrl = !!(m?.ctrl || m?.cmd);
	if (ctrl !== c.ctrl || !!m?.alt !== c.alt) return false;
	const key = KEY_ALIASES[e.key.toLowerCase()] ?? e.key.toLowerCase();
	// a shifted symbol arrives as the symbol itself ("?" for "/"): compare Shift only for letters, digits and named keys
	if (!!m?.shift !== c.shift && (c.key.length > 1 || /^[a-z0-9]$/.test(c.key))) return false;
	return key === c.key;
}

/** Display form on this platform ("Ctrl+Shift+A" as written). */
export const formatShortcut = (s: string): string => s;

type LocalHandler = (e: KeyEvent) => boolean | void;
const locals: LocalHandler[] = [];
/**
 * A key handler for the time a view is shown; return true to mark the stroke handled. The most recently added runs first.
 * Returns the remover.
 */
export function addKeyHandler(fn: LocalHandler): () => void {
	locals.unshift(fn);
	return () => { const i = locals.indexOf(fn); if (i >= 0) locals.splice(i, 1); };
}

/** `onKeyDown` of render(): runs a view's local handlers, then the first registered app action whose shortcut matches. */
export function handleWindowKeyDown(e: KeyEvent): void {
	if (e.defaultPrevented) return;
	for (const h of locals) {
		if (h(e)) { e.preventDefault(); return; }
	}
	for (const a of appActions()) {
		if (a.shortcut && matchesChord(a.shortcut, e)) {
			e.preventDefault();
			try { a.run(); } catch (err) { console.error(`[shortcut] ${a.id} failed:`, err instanceof Error ? err.message : err); }
			return;
		}
	}
}
