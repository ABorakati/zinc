// Keyboard handling shared by the cards and the table: up/down (Shift extends), page, home/end, space (toggle), enter (open), Ctrl+A,
// Delete / Shift+Delete and 1–9 (coloured tags), as Zotero's item tree.
import { createSignal } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { deleteSelected } from "../features/maintenance/ops";
import { selectedKeys } from "../features/shared";
import { toggleColoredTag } from "../tags/state";
import { addByIdentifier } from "../features/additems/client";
import { looksLikeIdentifiers } from "../features/text";
import { readClipboard } from "../shell/clipboard-win";
import { clipboard } from "../ui";
import { store } from "../store";

const [listFocused, setListFocused] = createSignal(false);
/** true while the item list (cards or table) holds keyboard focus: the focused row draws its ring only then. */
export { listFocused, setListFocused };

type KeyLike = EventPayload & { preventDefault?(): void; stopPropagation?(): void };

let searchFocuser: (() => void) | undefined;
/** The toolbar's search box registers how to focus itself (Ctrl+F in the list). */
export const registerSearchFocus = (f: (() => void) | undefined) => {
	searchFocuser = f;
};
export const focusSearch = () => searchFocuser?.();

let listFocuser: (() => void) | undefined;
/**
 * The list view on screen (table or cards) registers how its focusable container takes keyboard focus. A click on a row calls
 * focusList(): GPUIX does not move focus to a focusable ancestor on a click, and the <virtual-list> keeps the click from reaching
 * the container, so without this the arrow keys did nothing after clicking an item. Returns the remover.
 */
export function registerListFocus(f: () => void): () => void {
	listFocuser = f;
	return () => {
		if (listFocuser === f) listFocuser = undefined;
	};
}
export const focusList = () => listFocuser?.();

export interface ListKeyOps {
	/** Move the focus row by `delta` items. */
	move(delta: number, extend: boolean): void;
	/** Items per page for page up / down. */
	page(): number;
	open(): void;
	toggle(): void;
	/** Extra keys (the table's left / right expand); return true when handled. */
	extra?(key: string, e: KeyLike): boolean;
}
function tryPasteIdentifiers(): boolean {
	const clip = readClipboard();
	if (clip === null) {
		void clipboard.readText().then((text) => {
			const t = (text ?? "").trim();
			if (looksLikeIdentifiers(t)) void addByIdentifier(t);
		});
		return false;
	}
	const text = clip.trim();
	if (looksLikeIdentifiers(text)) {
		void addByIdentifier(text);
		return true;
	}
	return false;
}

export function listKeyHandler(ops: ListKeyOps) {
	return (ev: EventPayload) => {
		const e = ev as KeyLike;
		const k = (e.key ?? "").toLowerCase();
		const m: { shift?: boolean; ctrl?: boolean; alt?: boolean; cmd?: boolean } = e.modifiers ?? {};
		const ctrl = !!(m.ctrl || m.cmd);
		let handled = true;
		if (ctrl && k === "a") store.selectAll();
		else if (ctrl && k === "f") focusSearch();
		else if (ctrl && k === "v")
			handled = store.canEdit() && tryPasteIdentifiers(); // a read-only library takes no new items
		else if (ctrl || m.alt) handled = false;
		else if (k === "down") ops.move(1, !!m.shift);
		else if (k === "up") ops.move(-1, !!m.shift);
		else if (k === "pagedown") ops.move(ops.page(), !!m.shift);
		else if (k === "pageup") ops.move(-ops.page(), !!m.shift);
		else if (k === "home") ops.move(-1e9, !!m.shift);
		else if (k === "end") ops.move(1e9, !!m.shift);
		else if (k === "space" || k === " ") ops.toggle();
		else if (k === "enter") ops.open();
		else if (k === "escape") store.selectOnly(null);
		else if (k === "delete") {
			if (store.canEdit()) void deleteSelected(!!m.shift);
		} // Zotero's keys: Delete removes from the open collection / moves to the Trash; Shift+Delete moves to the Trash (deleteSelected)
		else if (/^[1-9]$/.test(k) && !m.shift) {
			// Zotero's coloured-tag keys: toggle the tag coloured at that position on the selection
			if (store.canEdit()) void toggleColoredTag(Number(k), selectedKeys());
		} else handled = ops.extra?.(k, e) ?? false;
		if (handled) {
			e.preventDefault?.();
			e.stopPropagation?.();
		}
	};
}
