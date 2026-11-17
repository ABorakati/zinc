// The user's keyboard shortcut choices (Settings > Shortcuts), as Zotero's Settings > Advanced > Shortcuts but for every app action:
// action id -> chord ("Ctrl+Shift+K"), or "" for "no shortcut". An action not listed keeps the default its feature registered.
// Stored as "shell.shortcuts" in ui-state.json. Light on purpose: imports only prefs (shortcuts.ts, menus and Settings read it).
import { createSignal } from "solid-js";
import { getPref, setPref } from "./prefs";

const KEY = "shell.shortcuts";
const valid = (v: unknown): Record<string, string> | undefined => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, s] of Object.entries(v)) if (typeof s === "string") out[k] = s;
	return out;
};

const [overrides, setOverrides] = createSignal<Record<string, string>>(getPref(KEY, {}, valid));
export { overrides as shortcutOverrides };

/** The shortcut an action has now: the user's choice, else its default; undefined for none. */
export function effectiveShortcut(id: string, fallback?: string): string | undefined {
	const o = overrides();
	return Object.hasOwn(o, id) ? o[id] || undefined : fallback;
}

/** True when the user changed this action's shortcut (also when they removed it). */
export const isCustomised = (id: string): boolean => Object.hasOwn(overrides(), id);

/** Set an action's shortcut ("" = none). The default itself is stored as "no change". */
export function setShortcut(id: string, chord: string, fallback?: string): void {
	const next = { ...overrides() };
	if (chord === (fallback ?? "")) delete next[id];
	else next[id] = chord;
	save(next);
}

/** Back to the default. */
export function resetShortcut(id: string): void {
	if (!isCustomised(id)) return;
	const next = { ...overrides() };
	delete next[id];
	save(next);
}

export function resetAllShortcuts(): void {
	save({});
}

function save(next: Record<string, string>): void {
	setOverrides(next);
	setPref(KEY, Object.keys(next).length ? next : undefined);
}
