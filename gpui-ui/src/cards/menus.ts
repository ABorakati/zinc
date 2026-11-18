// The item context menu (ui/src/cards/shared.tsx ItemMenuItems), shared by the cards and the table: Zotero's order, with the
// entries features registered in registry.ts itemActions slotted into their groups.
import type { ItemDetail } from "../api";
import type { Collection, ItemRow } from "../contracts";
import { itemActions, type ItemAction, type ItemActionContext } from "../registry";
import { store } from "../store";
import { readState } from "../readState";
import { openMenu, type Anchor, type MenuItem } from "../ui";
import { beforePluginMenu } from "../wasmplugins/extend/mount";
import { displayShortcut } from "../shell/shortcuts";
import { collectionStyle, paletteHex } from "../sidebar/collectionStyle";
import { locateFileKey, locateItemFromRow, locateItemOf } from "../locate/item";
import { locateMenu } from "../locate/menu";
import {
	addItemsToCollection,
	copyDoi,
	findFullText,
	getDetail,
	isRegular,
	openItem,
	openUrl,
	revealAttachment,
	setInPublications,
	trashItems,
} from "./actions";

/** The collections of the library on screen (My Library or the selected group). */
const libraryCollections = (): Collection[] =>
	store.libraryId() === 1 ? store.collections() : (store.groupCollections()[store.libraryId()] ?? []);

/** "Parent › Child" path labels for every collection, in tree order. */
export function collectionPaths(): { key: string; path: string; name: string }[] {
	const out: { key: string; path: string; name: string }[] = [];
	const walk = (l: Collection[], prefix: string) => {
		for (const c of l) {
			out.push({ key: c.key, path: prefix + c.name, name: c.name });
			if (c.children) walk(c.children, prefix + c.name + " › ");
		}
	};
	walk(libraryCollections(), "");
	return out;
}

/** A collection's look in the sidebar (its icon and colour), so menus show it the same way. */
function collectionLook(key: string): { icon: string; iconColor?: string } {
	const s = collectionStyle.get().styles[key];
	return { icon: s?.icon ?? "folder", iconColor: paletteHex(s?.color) };
}

const byName = (a: Collection, b: Collection) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * The library's collections as a menu tree, like Zotero's "Add to Collection": a collection with subcollections opens a
 * submenu that starts with the collection itself, so names stay short instead of long "A / B / C" paths. Pinned collections
 * come first, as in the sidebar. Collections in `has` (the item is already in them) are ticked and cannot be picked again.
 */
export function collectionTreeMenu(pick: (c: Collection) => void, has: ReadonlySet<string> = new Set()): MenuItem[] {
	const roots = libraryCollections();
	const self = (c: Collection): MenuItem => ({
		label: c.name,
		...collectionLook(c.key),
		checked: has.has(c.key) || undefined,
		disabled: has.has(c.key),
		onSelect: () => pick(c),
	});
	const entry = (c: Collection): MenuItem => {
		const kids = [...(c.children ?? [])].sort(byName);
		return kids.length
			? { label: c.name, ...collectionLook(c.key), submenu: [self(c), { separator: true }, ...kids.map(entry)] }
			: self(c);
	};
	const byKey = new Map<string, Collection>();
	const walk = (l: Collection[]) => {
		for (const c of l) {
			byKey.set(c.key, c);
			if (c.children) walk(c.children);
		}
	};
	walk(roots);
	const out: MenuItem[] = [];
	const pinned = collectionStyle
		.get()
		.pins.map((k) => byKey.get(k))
		.filter((c): c is Collection => !!c);
	if (pinned.length) out.push({ heading: "Pinned" }, ...pinned.map(self), { separator: true });
	out.push(...[...roots].sort(byName).map(entry));
	return out;
}

/** Entries features registered for the given groups; actions sharing a `submenu` label nest under one submenu. */
function registered(ctx: ItemActionContext, groups: readonly string[]): MenuItem[][] {
	const label = (a: ItemAction) => (typeof a.label === "function" ? a.label(ctx) : a.label);
	// a read-only library offers nothing that changes items
	const readOnly = !store.canEdit();
	const lists = groups
		.map((g) =>
			itemActions().filter(
				(a) => (a.group ?? "edit") === g && !(readOnly && (g === "edit" || g === "maintain")) && (a.visible?.(ctx) ?? true),
			),
		)
		.filter((l) => l.length);
	return lists.map((list) => {
		const out: MenuItem[] = [];
		const subs = new Map<string, MenuItem[]>();
		for (const a of list) {
			const entry: MenuItem = { label: label(a), icon: a.icon, shortcut: displayShortcut(a.shortcut), disabled: a.disabled?.(ctx), onSelect: () => a.run(ctx) };
			if (!a.submenu) {
				out.push(entry);
				continue;
			}
			let s = subs.get(a.submenu);
			if (!s) {
				s = [];
				subs.set(a.submenu, s);
				out.push({ label: a.submenu, icon: "paperclip", submenu: s });
			}
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
	const sep = () => {
		if (out.length && !out[out.length - 1]!.separator) out.push({ separator: true });
	};
	const taken = new Set<string>(); // labels registered actions already provide: the built-in entry is dropped
	for (const l of registered(ctx, ["open", "cite", "export", "edit", "maintain"])) for (const m of l) if (m.label) taken.add(m.label);
	const builtin = (m: MenuItem) => {
		if (!m.label || !taken.has(m.label)) out.push(m);
	};

	out.push({ label: "Open", icon: "book-open", onSelect: () => void openItem(item) });
	const fileKey = detail ? locateFileKey(detail.data, detail.children) : null;
	out.push({
		label: "Locate",
		icon: "globe",
		submenu: locateMenu(detail ? locateItemOf(detail.data) : locateItemFromRow(item), fileKey, {
			openUrl: (url) => void openUrl(url),
			revealFile: (key) => void revealAttachment(key),
		}),
	});
	for (const l of registered(ctx, ["open", "edit"])) {
		sep();
		out.push(...l);
	}

	sep();
	builtin({ label: "Find Full Text", icon: "file-search", onSelect: () => void findFullText(ctx.keys) });
	builtin({
		label: "Find Full Text (open access only)",
		icon: "file-search",
		onSelect: () => void findFullText(ctx.keys, { openAccessOnly: true }),
	});

	sep();
	builtin({ label: "Mark as Read", icon: "check", onSelect: () => readState.markRead(ctx.keys) });
	builtin({ label: "Mark as Unread", icon: "circle-dot", onSelect: () => readState.markUnread(ctx.keys) });

	sep();
	// the item's collections by name; the parent path only when two of them share a name
	const mine = collectionPaths().filter((c) => detail?.collections.includes(c.key));
	const dupName = (n: string) => mine.filter((c) => c.name === n).length > 1;
	out.push({
		label: "Show in collection…",
		icon: "folder-search",
		disabled: !mine.length,
		submenu: mine.map((c) => ({
			label: dupName(c.name) ? c.path : c.name,
			...collectionLook(c.key),
			onSelect: () => store.setView({ kind: "collection", key: c.key }),
		})),
	});
	// a single item shows which collections it is already in (ticked); for several items every collection can be picked
	const already = new Set(ctx.keys.length === 1 ? (detail?.collections ?? []) : []);
	const tree = collectionTreeMenu((c) => void addItemsToCollection(c.key, c.name, ctx.keys), already);
	out.push({
		label: "Add to collection",
		icon: "folder-input",
		disabled: view.kind === "trash" || !store.canEdit(),
		submenu: tree.length ? tree : [{ label: "No collections", disabled: true }],
	});
	builtin({ label: "Copy DOI", icon: "quote", onSelect: () => void copyDoi(item.key) });
	if (view.kind !== "trash" && isRegular(item) && store.libraryId() === 1) {
		// My Publications is My Library's
		// the detail may still be loading: inside the My Publications view the item is known to be in it
		const inPubs = view.kind === "publications" || detail?.data.inPublications === true;
		builtin(
			inPubs
				? { label: "Remove from My Publications", icon: "book-x", onSelect: () => void setInPublications(ctx.keys, false) }
				: { label: "Show in My Publications", icon: "book-marked", onSelect: () => void setInPublications(ctx.keys, true) },
		);
	}
	for (const l of registered(ctx, ["cite", "export", "maintain", "plugins"])) {
		sep();
		out.push(...l);
	}

	sep();
	const n = ctx.keys.length > 1 ? ` (${ctx.keys.length})` : "";
	if (view.kind === "trash") out.push({ label: `Restore${n}`, icon: "rotate-ccw", onSelect: () => void trashItems(ctx.keys, false) });
	else
		out.push({
			label: `Move to Trash${n}`,
			icon: "trash-2",
			danger: true,
			disabled: !store.canEdit(),
			onSelect: () => void trashItems(ctx.keys, true),
		});
	return out;
}

/** Open the context menu of an item at `at`. Selects the item first unless it is part of the selection (like a right-click does). */
export async function openItemMenu(at: Anchor, item: ItemRow, index: number): Promise<void> {
	if (!store.selected().has(item.key)) store.selectOnly(item.key, index);
	const keys = [...store.selected()];
	// the item's collections come with its detail; menus are built synchronously, so wait a moment for it (cached after the first time)
	// plugin menus with an `on-menu-showing` hook answer within 120 ms, in parallel (wasmplugins/extend/mount.ts; a no-op while plugins are off)
	const [detail] = await Promise.all([
		Promise.race([getDetail(item.key).catch(() => null), new Promise<null>((r) => setTimeout(r, 150))]),
		beforePluginMenu("library-item"),
	]);
	openMenu(at, itemMenuItems(item, keys, detail));
}
