// Registry behind the Keyboard Shortcuts help overlay. Other features add their own entries.
import { createSignal } from "solid-js";

export interface ShortcutEntry {
	keys: string; // display text, e.g. "Ctrl+Shift+N"
	description: string;
	group?: string; // heading in the overlay; default "General"
}

const [entries, setEntries] = createSignal<ShortcutEntry[]>([]);
const [helpOpen, setHelpOpen] = createSignal(false);

/** Add shortcuts to the help overlay (an entry with the same keys + description is replaced). */
export function registerShortcutHelp(list: ShortcutEntry[]): void {
	setEntries((cur) => {
		const k = (e: ShortcutEntry) => `${e.group ?? "General"}|${e.keys}|${e.description}`;
		const incoming = new Set(list.map(k));
		return [...cur.filter((e) => !incoming.has(k(e))), ...list];
	});
}

export { entries as shortcutEntries, helpOpen, setHelpOpen };
