// Pieces shared by the table and the card list: selection rules, drag payload and the item context menu body.
import { createResource, For, Show, type Component } from "solid-js";
import { BookOpen, FileSearch, FolderInput, FolderSearch, Quote, RotateCcw, Trash2 } from "lucide-solid";
import { api, type ItemSummary } from "../api";
import { store } from "../store";
import type { createItemList } from "../itemlist";
import { addItemsToCollection, copyDoi, trashItems } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { ITEM_GROUPS, itemActions, type ItemActionContext } from "~/lib/registry";
import {
	ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from "~/components/ui/context-menu";

export type ItemListHandle = ReturnType<typeof createItemList>;

/** Click / checkbox selection: plain = select only, ctrl = toggle, shift = range from the anchor. */
export function selectClick(list: ItemListHandle, index: number, mods: { shift: boolean; ctrl: boolean }) {
	const it = list.get(index);
	if (!it) return;
	const sel = new Set(store.selected());
	if (mods.shift && store.anchor() >= 0) {
		const [a, b] = [Math.min(store.anchor(), index), Math.max(store.anchor(), index)];
		if (!mods.ctrl) sel.clear();
		for (let i = a; i <= b; i++) { const x = list.get(i); if (x) sel.add(x.key); }
		store.setFocusIndex(index);
	} else if (mods.ctrl) {
		sel.has(it.key) ? sel.delete(it.key) : sel.add(it.key);
		store.setAnchor(index); store.setFocusIndex(index);
	} else {
		store.selectOnly(it.key, index);
		return;
	}
	store.setSelected(sel);
	store.setActiveKey(it.key);
}

/** Arrow-key navigation: moves the focus row (extending the selection with shift). Returns false if row `next` is not loaded yet. */
export function focusRow(list: ItemListHandle, next: number, extend: boolean): boolean {
	const it = list.get(next);
	if (!it) return false;
	if (extend && store.anchor() >= 0) {
		const [a, b] = [Math.min(store.anchor(), next), Math.max(store.anchor(), next)];
		const sel = new Set<string>();
		for (let i = a; i <= b; i++) { const x = list.get(i); if (x) sel.add(x.key); }
		store.setSelected(sel); store.setActiveKey(it.key); store.setFocusIndex(next);
	} else store.selectOnly(it.key, next);
	return true;
}

/** Drag payload: the dragged row joins the selection if it is not in it already. */
export function startItemDrag(list: ItemListHandle, e: DragEvent, index: number) {
	const it = list.get(index);
	if (!it) return;
	if (!store.selected().has(it.key)) store.selectOnly(it.key, index);
	const keys = [...store.selected()];
	e.dataTransfer!.setData("application/x-zn-items", JSON.stringify(keys));
	e.dataTransfer!.setData("text/plain", keys.join(","));
	e.dataTransfer!.effectAllowed = "copy";
}

/** Submenu body: collections the right-clicked item already belongs to (fetched lazily). */
const ShowInCollection: Component<{ itemKey: string }> = (p) => {
	const [d] = createResource(() => p.itemKey, (k) => api.item(k));
	const mine = () => (store.collections() ?? []).filter((c) => d()?.collections.includes(c.key));
	return (
		<ContextMenuSub overlap>
			<ContextMenuSubTrigger disabled={!mine().length}>
				<FolderSearch class="mr-2 size-4" /> Show in collection…
			</ContextMenuSubTrigger>
			<ContextMenuSubContent class="max-h-72 min-w-44 overflow-y-auto">
				<For each={mine()}>{(c) => <ContextMenuItem onSelect={() => store.setView({ kind: "collection", key: c.key })}>{c.name}</ContextMenuItem>}</For>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
};

const AddToCollection: Component<{ keys: string[] }> = (p) => {
	const sorted = () => [...(store.collections() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
	const path = (k: string | null): string => {
		const c = store.collections()?.find((x) => x.key === k);
		return c ? (c.parentKey ? path(c.parentKey) + " / " : "") + c.name : "";
	};
	return (
		<ContextMenuSub overlap>
			<ContextMenuSubTrigger disabled={store.view().kind === "trash"}>
				<FolderInput class="mr-2 size-4" /> Add to collection
			</ContextMenuSubTrigger>
			<ContextMenuSubContent class="max-h-72 min-w-52 overflow-y-auto">
				<For each={sorted()} fallback={<div class="px-2 py-1.5 text-muted-foreground">No collections</div>}>
					{(c) => <ContextMenuItem onSelect={() => addItemsToCollection(c.key, c.name, p.keys)}>{path(c.key)}</ContextMenuItem>}
				</For>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
};

/** Menu entries features registered (lib/registry.ts), grouped with a separator per group. */
const RegisteredItemActions: Component<{ item: ItemSummary; keys: string[] }> = (p) => {
	const ctx = (): ItemActionContext => ({ keys: p.keys.length ? p.keys : [p.item.key], item: p.item, view: store.view() as ItemActionContext["view"] });
	const groups = () =>
		ITEM_GROUPS.map((g) => itemActions().filter((a) => (a.group ?? "edit") === g && (a.visible?.(ctx()) ?? true))).filter((l) => l.length);
	return (
		<For each={groups()}>{(list) => (<>
			<ContextMenuSeparator />
			<For each={list}>{(a) => (
				<ContextMenuItem onSelect={() => a.run(ctx())}>
					<Show when={a.icon}>{(I) => { const C = I(); return <C class="mr-2 size-4" />; }}</Show>
					{typeof a.label === "function" ? a.label(ctx()) : a.label}
				</ContextMenuItem>
			)}</For>
		</>)}</For>
	);
};

/** Body of the item context menu (inside a ContextMenuContent), shared by the table and the cards. */
export const ItemMenuItems: Component<{ item: ItemSummary }> = (p) => {
	const keys = () => [...store.selected()];
	const inTrash = () => store.view().kind === "trash";
	return (<>
		<ContextMenuItem disabled={!p.item.primaryAttachment} onSelect={() => store.openSummary(p.item)}>
			<BookOpen class="mr-2 size-4" /> Open
		</ContextMenuItem>
		<ContextMenuItem onSelect={() => findFullText(keys())}>
			<FileSearch class="mr-2 size-4" /> Find Full Text
		</ContextMenuItem>
		<ContextMenuItem onSelect={() => findFullText(keys(), { openAccessOnly: true })}>
			<FileSearch class="mr-2 size-4" /> Find Full Text (open access only)
		</ContextMenuItem>
		<ShowInCollection itemKey={p.item.key} />
		<AddToCollection keys={keys()} />
		<ContextMenuItem onSelect={() => copyDoi(p.item.key)}>
			<Quote class="mr-2 size-4" /> Copy DOI
		</ContextMenuItem>
		<RegisteredItemActions item={p.item} keys={keys()} />
		<ContextMenuSeparator />
		<Show when={inTrash()} fallback={
			<ContextMenuItem class="text-destructive focus:text-destructive" onSelect={() => trashItems(keys(), true)}>
				<Trash2 class="mr-2 size-4" /> Move to Trash{keys().length > 1 ? ` (${keys().length})` : ""}
			</ContextMenuItem>
		}>
			<ContextMenuItem onSelect={() => trashItems(keys(), false)}>
				<RotateCcw class="mr-2 size-4" /> Restore{keys().length > 1 ? ` (${keys().length})` : ""}
			</ContextMenuItem>
		</Show>
	</>);
};
