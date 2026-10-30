// Pieces shared by the table and the card list: selection rules, drag payload and the item context menu body.
import { createResource, For, Show, type Component } from "solid-js";
import { BookOpen, ExternalLink, FileSearch, FolderInput, FolderOpen, FolderSearch, Globe, Paperclip, Quote, RotateCcw, Trash2 } from "lucide-solid";
import { api, type ChildSummary, type ItemSummary } from "../api";
import { store } from "../store";
import { childKind, doiUrl, getDetail, openChild, openExternal, openUrl, revealAttachment, webUrl } from "../itemopen";
import type { createItemList } from "../itemlist";
import { addItemsToCollection, copyDoi, trashItems } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { itemActions, type ItemAction, type ItemActionContext } from "~/lib/registry";
import {
	ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
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

// beside the parent menu, as wide as the screen side allows (popper flips / shifts and reports the room it has)
const SUB_CLS = "max-h-[60vh] min-w-64 max-w-[min(28rem,max(16rem,var(--kb-popper-content-available-width,28rem)))] overflow-y-auto";
const LABEL = "min-w-0 flex-1 truncate whitespace-nowrap";

const collPath = (k: string | null): string => {
	const c = store.collections()?.find((x) => x.key === k);
	return c ? (c.parentKey ? collPath(c.parentKey) + " / " : "") + c.name : "";
};

/** Submenu body: collections the right-clicked item already belongs to (fetched lazily). */
const ShowInCollection: Component<{ itemKey: string }> = (p) => {
	const [d] = createResource(() => p.itemKey, (k) => api.item(k));
	const mine = () => (store.collections() ?? []).filter((c) => d()?.collections.includes(c.key));
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger disabled={!mine().length}>
				<FolderSearch class="mr-2 size-4 flex-none" /> <span class={LABEL}>Show in collection…</span>
			</ContextMenuSubTrigger>
			<ContextMenuSubContent class={SUB_CLS}>
				<For each={mine()}>{(c) => (
					<ContextMenuItem onSelect={() => store.setView({ kind: "collection", key: c.key })} title={collPath(c.key)}>
						<span class={LABEL}>{collPath(c.key)}</span>
					</ContextMenuItem>
				)}</For>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
};

const AddToCollection: Component<{ keys: string[] }> = (p) => {
	const sorted = () => [...(store.collections() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger disabled={store.view().kind === "trash"}>
				<FolderInput class="mr-2 size-4 flex-none" /> <span class={LABEL}>Add to collection</span>
			</ContextMenuSubTrigger>
			<ContextMenuSubContent class={SUB_CLS}>
				<For each={sorted()} fallback={<div class="px-2 py-1.5 text-muted-foreground">No collections</div>}>
					{(c) => (
						<ContextMenuItem onSelect={() => addItemsToCollection(c.key, c.name, p.keys)} title={collPath(c.key)}>
							<span class={LABEL}>{collPath(c.key)}</span>
						</ContextMenuItem>
					)}
				</For>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
};

/** Menu entries features registered (lib/registry.ts) for the given groups; actions sharing a `submenu` label nest under one submenu. */
const RegisteredItemActions: Component<{ item: ItemSummary; keys: string[]; groups: readonly string[] }> = (p) => {
	const ctx = (): ItemActionContext => ({ keys: p.keys.length ? p.keys : [p.item.key], item: p.item, view: store.view() as ItemActionContext["view"] });
	const lists = () =>
		p.groups.map((g) => itemActions().filter((a) => (a.group ?? "edit") === g && (a.visible?.(ctx()) ?? true))).filter((l) => l.length);
	/** Plain actions and submenu groups in registration order (a submenu sits where its first action is). */
	const entries = (list: ItemAction[]) => {
		const out: ({ action: ItemAction } | { submenu: string; actions: ItemAction[] })[] = [];
		const seen = new Map<string, ItemAction[]>();
		for (const a of list) {
			if (!a.submenu) { out.push({ action: a }); continue; }
			let s = seen.get(a.submenu);
			if (!s) { s = []; seen.set(a.submenu, s); out.push({ submenu: a.submenu, actions: s }); }
			s.push(a);
		}
		return out;
	};
	const label = (a: ItemAction) => (typeof a.label === "function" ? a.label(ctx()) : a.label);
	const actionItem = (a: ItemAction) => (
		<ContextMenuItem onSelect={() => a.run(ctx())}>
			<Show when={a.icon}>{(I) => { const C = I(); return <C class="mr-2 size-4 flex-none" />; }}</Show>
			<span class={LABEL}>{label(a)}</span>
			<Show when={a.shortcut}><ContextMenuShortcut class="pl-4">{a.shortcut}</ContextMenuShortcut></Show>
		</ContextMenuItem>
	);
	return (
		<For each={lists()}>{(list) => (<>
			<ContextMenuSeparator />
			<For each={entries(list)}>{(e) => "action" in e ? actionItem(e.action) : (
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<Paperclip class="mr-2 size-4 flex-none" /> <span class={LABEL}>{e.submenu}</span>
					</ContextMenuSubTrigger>
					<ContextMenuSubContent class={SUB_CLS}>
						<For each={e.actions}>{actionItem}</For>
					</ContextMenuSubContent>
				</ContextMenuSub>
			)}</For>
		</>)}</For>
	);
};

/** Body of the context menu for an expanded child row (attachment or note) in the table. */
export const ChildMenuItems: Component<{ parent: { key: string; title: string }; child: ChildSummary }> = (p) => {
	const kind = () => childKind(p.child);
	const isFile = () => p.child.hasFile && p.child.linkMode !== "linked_url";
	return (<>
		<ContextMenuItem onSelect={() => openChild(p.parent, p.child)}>
			<BookOpen class="mr-2 size-4" /> Open
		</ContextMenuItem>
		<Show when={isFile()}>
			<ContextMenuItem onSelect={() => revealAttachment(p.child.key)}>
				<FolderOpen class="mr-2 size-4" /> Show File
			</ContextMenuItem>
			<Show when={kind() !== "file"}>
				<ContextMenuItem onSelect={() => openExternal(p.child.key)}>
					<ExternalLink class="mr-2 size-4" /> Open in Default App
				</ContextMenuItem>
			</Show>
		</Show>
		<ContextMenuSeparator />
		<ContextMenuItem class="text-destructive focus:text-destructive" onSelect={() => trashItems([p.child.key], true)}>
			<Trash2 class="mr-2 size-4" /> Move {p.child.itemType === "note" ? "Note" : "Attachment"} to Trash
		</ContextMenuItem>
	</>);
};

/** Body of the item context menu (inside a ContextMenuContent), in Zotero's order; shared by the table and the cards. */
export const ItemMenuItems: Component<{ item: ItemSummary }> = (p) => {
	const keys = () => [...store.selected()];
	const inTrash = () => store.view().kind === "trash";
	// the item's URL / DOI (for View Online) comes with the detail, fetched when the menu opens
	const [d] = createResource(() => p.item.key, getDetail);
	const online = () => webUrl(d()?.data.url) ?? doiUrl(d()?.data.DOI);
	return (<>
		<ContextMenuItem onSelect={() => store.openSummary(p.item)}>
			<BookOpen class="mr-2 size-4 flex-none" /> <span class={LABEL}>Open</span>
		</ContextMenuItem>
		<Show when={online()}>{(u) => (
			<ContextMenuItem onSelect={() => openUrl(u())}>
				<Globe class="mr-2 size-4 flex-none" /> <span class={LABEL}>View Online</span>
			</ContextMenuItem>
		)}</Show>
		<Show when={p.item.primaryAttachment}>{(a) => (
			<ContextMenuItem onSelect={() => revealAttachment(a().key)}>
				<FolderOpen class="mr-2 size-4 flex-none" /> <span class={LABEL}>Show File</span>
			</ContextMenuItem>
		)}</Show>
		<RegisteredItemActions item={p.item} keys={keys()} groups={["open", "edit"]} />
		<ContextMenuSeparator />
		<ContextMenuItem onSelect={() => findFullText(keys())}>
			<FileSearch class="mr-2 size-4 flex-none" /> <span class={LABEL}>Find Full Text</span>
		</ContextMenuItem>
		<ContextMenuItem onSelect={() => findFullText(keys(), { openAccessOnly: true })}>
			<FileSearch class="mr-2 size-4 flex-none" /> <span class={LABEL}>Find Full Text (open access only)</span>
		</ContextMenuItem>
		<ContextMenuSeparator />
		<ShowInCollection itemKey={p.item.key} />
		<AddToCollection keys={keys()} />
		<ContextMenuItem onSelect={() => copyDoi(p.item.key)}>
			<Quote class="mr-2 size-4 flex-none" /> <span class={LABEL}>Copy DOI</span>
		</ContextMenuItem>
		<RegisteredItemActions item={p.item} keys={keys()} groups={["cite", "export", "maintain"]} />
		<ContextMenuSeparator />
		<Show when={inTrash()} fallback={
			<ContextMenuItem class="text-destructive focus:text-destructive" onSelect={() => trashItems(keys(), true)}>
				<Trash2 class="mr-2 size-4 flex-none" /> <span class={LABEL}>Move to Trash{keys().length > 1 ? ` (${keys().length})` : ""}</span>
			</ContextMenuItem>
		}>
			<ContextMenuItem onSelect={() => trashItems(keys(), false)}>
				<RotateCcw class="mr-2 size-4 flex-none" /> <span class={LABEL}>Restore{keys().length > 1 ? ` (${keys().length})` : ""}</span>
			</ContextMenuItem>
		</Show>
	</>);
};
