// Global keyboard shortcuts. render()'s window-level onKeyDown (main.tsx passes `handleWindowKeyDown`) sees every key stroke after
// the focused element's own handlers; here it is matched against the `shortcut` strings of the registry's appActions
// ("Ctrl+Shift+A", "Ctrl+,", "Alt+Left") plus any local handler a view registers while it is shown (the Settings tab).
// An action's shortcut is the user's choice from Settings > Shortcuts when there is one (./bindings.ts), else its default.
// Light on purpose: imports only the registry and the bindings.
import type { KeyEvent } from "@gpuix/native/host";
import { appActions, type AppAction } from "../registry";
import { effectiveShortcut } from "./bindings";

export interface Chord {
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	key: string;
}

const KEY_ALIASES: Record<string, string> = {
	esc: "escape",
	return: "enter",
	del: "delete",
	ins: "insert",
	space: " ",
	spacebar: " ",
	arrowleft: "left",
	arrowright: "right",
	arrowup: "up",
	arrowdown: "down",
	pageup: "pageup",
	pagedown: "pagedown",
	comma: ",",
	period: ".",
	slash: "/",
	plus: "+",
	minus: "-",
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

const KEY_LABELS: Record<string, string> = {
	escape: "Esc",
	" ": "Space",
	pageup: "PageUp",
	pagedown: "PageDown",
	backspace: "Backspace",
};
const keyLabel = (k: string): string =>
	KEY_LABELS[k] ?? (/^f\d{1,2}$/.test(k) || k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));

/** A chord written the one way Settings stores and shows it: Ctrl, Alt, Shift, then the key ("Ctrl+Shift+K", "Alt+F2"). */
export function formatChord(c: Chord): string {
	return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", keyLabel(c.key)].filter(Boolean).join("+");
}
/** "ctrl+shift+k" / "Shift+Ctrl+K" -> "Ctrl+Shift+K"; undefined when it names no key. */
export const canonicalChord = (s: string): string | undefined => {
	const c = chordOf(s);
	return c ? formatChord(c) : undefined;
};

const MODIFIER_KEYS = new Set(["control", "ctrl", "shift", "alt", "altgraph", "meta", "cmd", "command", "os", "super", "capslock", "fn"]);
/** The chord a key stroke makes, for recording a new shortcut; undefined while only modifiers are held. */
export function chordFromEvent(e: Pick<KeyEvent, "key" | "modifiers">): string | undefined {
	const raw = (e.key ?? "").toLowerCase();
	if (!raw || MODIFIER_KEYS.has(raw)) return undefined;
	const m = e.modifiers;
	return formatChord({ ctrl: !!(m?.ctrl || m?.cmd), alt: !!m?.alt, shift: !!m?.shift, key: KEY_ALIASES[raw] ?? raw });
}
/**
 * Can this chord be a global shortcut? It needs Ctrl or Alt, or must be a function key: a plain letter, digit, arrow, Enter, Tab or
 * Delete belongs to text fields and lists (typing, moving, deleting).
 */
export function isBindable(chord: string): boolean {
	const c = chordOf(chord);
	return !!c && (c.ctrl || c.alt || /^f\d{1,2}$/.test(c.key));
}

/** The shortcut an app action has now (the user's choice in Settings, else the feature's default). */
export const actionShortcut = (a: { id: string; shortcut?: string }): string | undefined => effectiveShortcut(a.id, a.shortcut);

/** App actions (other than `exceptId`) bound to the same chord. */
export function shortcutUsers(chord: string, exceptId?: string): AppAction[] {
	const want = canonicalChord(chord);
	if (!want) return [];
	return appActions().filter((a) => a.id !== exceptId && canonicalChord(actionShortcut(a) ?? "") === want);
}

/**
 * The shortcut to show beside a menu entry whose feature wrote down a default (an item action's `shortcut` is display only; the app
 * action bound to that default runs it): follows the user's rebinding, undefined once they removed it.
 */
export function displayShortcut(fallback: string | undefined): string | undefined {
	if (!fallback) return undefined;
	const a = appActions().find((x) => x.shortcut === fallback);
	return a ? actionShortcut(a) : fallback;
}

type LocalHandler = (e: KeyEvent) => boolean | void;
const locals: LocalHandler[] = [];
/**
 * A key handler for the time a view is shown; return true to mark the stroke handled. The most recently added runs first.
 * Returns the remover.
 */
export function addKeyHandler(fn: LocalHandler): () => void {
	locals.unshift(fn);
	return () => {
		const i = locals.indexOf(fn);
		if (i >= 0) locals.splice(i, 1);
	};
}

/** `onKeyDown` of render(): runs a view's local handlers, then the first registered app action whose shortcut matches. */
export function handleWindowKeyDown(e: KeyEvent): void {
	if (e.defaultPrevented) return;
	for (const h of locals) {
		if (h(e)) {
			e.preventDefault();
			return;
		}
	}
	for (const a of appActions()) {
		const s = actionShortcut(a);
		if (s && matchesChord(s, e)) {
			e.preventDefault();
			if (a.when && !a.when()) return;
			try {
				a.run();
			} catch (err) {
				console.error(`[shortcut] ${a.id} failed:`, err instanceof Error ? err.message : err);
			}
			return;
		}
	}
}
