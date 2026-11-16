// The list as a tree (Zotero's item tree): twisty toggles, child rows (select / open) and the tree keys, for the cards and the
// table alike. The views keep their own item-based move (page / home / end / Shift ranges); Up / Down step through child rows here.
import { store } from "../store";
import type { ChildSummary } from "../api";
import { fail, openChild } from "./actions";
import { closeAll, hasChildren, isOpen, openAll, selectChild, selectedChild, setOpen } from "./children";
import { treeKeyAction, type TreeFocus } from "./flatten";
import type { Rows } from "./rows";

export interface TreeView {
	rows: Rows;
	/** Scroll so row `r` is on screen. */
	reveal(r: number): void;
	/** Rows on screen, [first, last). */
	visible(): [number, number];
	/** The view's item-based move (pages, Home / End, Shift ranges). */
	moveItems(delta: number, extend: boolean): void;
}

/** Open or close an item's children; closing the item of the selected child selects the item. */
export function toggleItem(key: string, index: number) {
	const open = !isOpen(key);
	if (!open && selectedChild()?.parentKey === key) store.selectOnly(key, index);
	setOpen(key, open);
}

/** Open a child row (double-click / Enter): as the item pane's entries do. */
export function openChildRow(parentIndex: number, c: ChildSummary) {
	const parent = store.peek(parentIndex);
	void openChild({ key: parent?.key ?? "", title: parent?.title ?? "" }, c).catch((e) => fail("Could not open", e));
}

export function createTree(v: TreeView) {
	const { rows } = v;
	/** Row of the focused child or item, or -1. */
	const focusedRow = (): number => {
		const c = selectedChild();
		if (c) return rows.childRowByKey(c.parentKey, c.key);
		return store.focusIndex() < 0 ? -1 : rows.rowOf(store.focusIndex());
	};
	const focus = (): TreeFocus => {
		const c = selectedChild();
		if (c) return { kind: "child", parentKey: c.parentKey };
		const it = store.peek(store.focusIndex());
		return it ? { kind: "item", key: it.key, hasKids: hasChildren(it), open: isOpen(it.key) } : null;
	};
	/** Put the focus on row `r` (an item or a loaded child); false when that row cannot take it. */
	const focusAt = (r: number): boolean => {
		const rw = rows.row(r);
		if (rw?.kind === "child") {
			if (!rw.child) return false;
			selectChild(rw.parentKey, rw.parentIndex, rw.child.key);
		} else if (rw?.kind === "item") {
			if (!store.focusRow(rw.index, false)) return false;
		} else return false;
		v.reveal(r);
		return true;
	};

	return {
		/** Up / Down step row by row while children are open; everything else is the view's item move. */
		move(delta: number, extend: boolean) {
			const cur = focusedRow();
			if (extend || Math.abs(delta) !== 1 || cur < 0) return v.moveItems(delta, extend);
			for (let r = cur + delta; r >= 0 && r < rows.count(); r += delta) {
				const rw = rows.row(r);
				if (rw?.kind === "header") continue;
				if (focusAt(r)) return;
				if (rw?.kind === "child") continue; // a child still loading: step over it
				return;
			}
		},
		/** Enter: open the selected child, else the item. */
		open(openFocusedItem: () => void) {
			const c = selectedChild();
			const r = c ? rows.row(rows.childRowByKey(c.parentKey, c.key)) : undefined;
			if (r?.kind === "child" && r.child) return openChildRow(r.parentIndex, r.child);
			openFocusedItem();
		},
		/** Right / Left / + / - (listKeyHandler's extra keys). */
		extra(key: string, e: { keyChar?: string }): boolean {
			const a = treeKeyAction(key, e.keyChar, focus());
			if (!a) return false;
			switch (a.kind) {
				case "open":
					setOpen(a.key, true);
					break;
				case "close":
					toggleItem(a.key, store.focusIndex());
					break;
				case "firstChild":
					focusAt(rows.childRow(a.key, 0));
					break;
				case "parent": {
					const c = selectedChild();
					const r = c ? rows.childRowByKey(c.parentKey, c.key) : -1;
					const rw = rows.row(r);
					if (rw?.kind === "child") focusAt(rows.rowOf(rw.parentIndex));
					break;
				}
				case "openAll": {
					const [a0, b0] = v.visible();
					const keys: string[] = [];
					for (let r = a0; r < b0; r++) {
						const rw = rows.row(r);
						const it = rw?.kind === "item" ? store.peek(rw.index) : undefined;
						if (it && hasChildren(it)) keys.push(it.key);
					}
					openAll(keys);
					break;
				}
				case "closeAll": {
					const c = selectedChild();
					if (c) {
						const rw = rows.row(rows.childRowByKey(c.parentKey, c.key));
						if (rw?.kind === "child") store.selectOnly(c.parentKey, rw.parentIndex);
					}
					closeAll();
					break;
				}
			}
			return true;
		},
	};
}
