// The item context menu (ui/src/cards/shared.tsx ItemMenuItems), shared by the cards and the table: Zotero's order, with the
// entries features registered in registry.ts itemActions slotted into their groups.
import type { ItemDetail } from "../api";
import type { Collection, ItemRow } from "../contracts";
import { itemActions, type ItemAction, type ItemActionContext } from "../registry";
import { store } from "../store";
import { readState } from "../readState";
import { openMenu, type Anchor, type MenuItem } from "../ui";
import { locateFileKey, locateItemFromRow, locateItemOf } from "../locate/item";
import { locateMenu } from "../locate/menu";
import {
	addItemsToCollection, copyDoi, findFullText, getDetail, openItem, openUrl, revealAttachment, trashItems,
} from "./actions";

/** "Parent / Child" path labels for every collection, in tree order. */
export function collectionPaths(): { key: string; path: string; name: string }[] {
	const out: { key: string; path: string; name: string }[] = [];
	const walk = (l: Collection[], prefix: string) => {
		for (const c of l) {
			out.push({ key: c.key, path: prefix + c.name, name: c.name });
			if (c.children) walk(c.children, prefix + c.name + " / ");
		}
	};
	walk(store.collections(), "");
	return out;
}

/** Entries features registered for the given groups; actions sharing a `submenu` label nest under one submenu. */
function registered(ctx: ItemActionContext, groups: readonly string[]): MenuItem[][] {
	const label = (a: ItemAction) => (typeof a.label === "function" ? a.label(ctx) : a.label);
	const lists = groups
		.map((g) => itemActions().filter((a) => (a.group ?? "edit") === g && (a.visible?.(ctx) ?? true)))
		.filter((l) => l.length);
	return lists.map((list) => {
		const out: MenuItem[] = [];
		const subs = new Map<string, MenuItem[]>();
		for (const a of list) {
			const entry: MenuItem = { label: label(a), icon: a.icon, shortcut: a.shortcut, onSelect: () => a.run(ctx) };
			if (!a.submenu) { out.push(entry); continue; }
			let s = subs.get(a.submenu);
			if (!s) { s = []; subs.set(a.submenu, s); out.push({ label: a.submenu, icon: "paperclip", submenu: s }); }
			s.push(entry);
		}
		return out;
	});
}

/** Menu entries for a right-clicked item, given the keys acted on. `detail` (item collections) may still be loading. */
export function itemMenuItems(item: ItemRow, keys: string[], detail: ItemDetail | null): MenuItem[] {
	const view = store.view();
	const ctx: ItemActionContext = { keys: keys.length ? keys : [item.key], item, view };
	const out: MenuItem[] = [];
	const sep = () => { if (out.length && !out[out.length - 1]!.separator) out.push({ separator: true }); };
	const taken = new Set<string>(); // labels registered actions already provide: the built-in entry is dropped
	for (const l of registered(ctx, ["open", "cite", "export", "edit", "maintain"])) for (const m of l) if (m.label) taken.add(m.label);
	const builtin = (m: MenuItem) => { if (!m.label || !taken.has(m.label)) out.push(m); };

	out.push({ label: "Open", icon: "book-open", onSelect: () => void openItem(item) });
	const fileKey = detail ? locateFileKey(detail.data, detail.children) : null;
	out.push({
		label: "Locate", icon: "globe",
		submenu: locateMenu(detail ? locateItemOf(detail.data) : locateItemFromRow(item), fileKey, {
			openUrl: (url) => void openUrl(url),
			revealFile: (key) => void revealAttachment(key),
		}),
	});
	for (const l of registered(ctx, ["open", "edit"])) { sep(); out.push(...l); }

	sep();
	builtin({ label: "Find Full Text", icon: "file-search", onSelect: () => void findFullText(ctx.keys) });
	builtin({ label: "Find Full Text (open access only)", icon: "file-search", onSelect: () => void findFullText(ctx.keys, { openAccessOnly: true }) });

	sep();
	builtin({ label: "Mark as Read", icon: "check", onSelect: () => readState.markRead(ctx.keys) });
	builtin({ label: "Mark as Unread", icon: "circle-dot", onSelect: () => readState.markUnread(ctx.keys) });

	sep();
	const mine = collectionPaths().filter((c) => detail?.collections.includes(c.key));
	out.push({
		label: "Show in collection…", icon: "folder-search", disabled: !mine.length,
		submenu: mine.map((c) => ({ label: c.path, onSelect: () => store.setView({ kind: "collection", key: c.key }) })),
	});
	const all = collectionPaths().sort((a, b) => a.path.localeCompare(b.path));
	out.push({
		label: "Add to collection", icon: "folder-input", disabled: view.kind === "trash",
		submenu: all.length ? all.map((c) => ({ label: c.path, onSelect: () => void addItemsToCollection(c.key, c.name, ctx.keys) })) : [{ label: "No collections", disabled: true }],
	});
	builtin({ label: "Copy DOI", icon: "quote", onSelect: () => void copyDoi(item.key) });
	for (const l of registered(ctx, ["cite", "export", "maintain"])) { sep(); out.push(...l); }

	sep();
	const n = ctx.keys.length > 1 ? ` (${ctx.keys.length})` : "";
	if (view.kind === "trash") out.push({ label: `Restore${n}`, icon: "rotate-ccw", onSelect: () => void trashItems(ctx.keys, false) });
	else out.push({ label: `Move to Trash${n}`, icon: "trash-2", danger: true, onSelect: () => void trashItems(ctx.keys, true) });
	return out;
}

/** Open the context menu of an item at `at`. Selects the item first unless it is part of the selection (like a right-click does). */
export async function openItemMenu(at: Anchor, item: ItemRow, index: number): Promise<void> {
	if (!store.selected().has(item.key)) store.selectOnly(item.key, index);
	const keys = [...store.selected()];
	// the item's collections come with its detail; menus are built synchronously, so wait a moment for it (cached after the first time)
	const detail = await Promise.race([getDetail(item.key).catch(() => null), new Promise<null>((r) => setTimeout(r, 150))]);
	openMenu(at, itemMenuItems(item, keys, detail));
}
