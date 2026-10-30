import { createSignal, For, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import { Pencil, Plus, Search, TextCursorInput, Trash2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { api, type SavedSearch } from "~/api";
import { store } from "~/store";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { openAdvancedSearch, refreshSavedSearches, savedSearches } from "./state";

const rowCls = "relative flex h-6 items-center gap-1 pr-2 text-[13px] hover:bg-accent";
const menuItem = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

/** "Saved Searches" under the collection tree in the left pane. */
export const SavedSearchesSection: Component = () => {
	const [menu, setMenu] = createSignal<{ x: number; y: number; s: SavedSearch } | null>(null);
	const [renaming, setRenaming] = createSignal<string | null>(null);
	const [pendingDelete, setPendingDelete] = createSignal<SavedSearch | null>(null);
	const [dlgOpen, setDlgOpen] = createSignal(false);

	const isActive = (k: string) => {
		const v = store.view();
		return v.kind === "search" && v.key === k;
	};

	async function commitRename(s: SavedSearch, name: string) {
		setRenaming(null);
		const n = name.trim();
		if (!n || n === s.name) return;
		try {
			await api.patchSavedSearch(s.key, { name: n });
			refreshSavedSearches();
		} catch (e) { fail("Could not rename search", e); }
	}

	async function remove(s: SavedSearch) {
		setDlgOpen(false);
		try {
			await api.deleteSavedSearch(s.key);
			const v = store.view();
			if (v.kind === "search" && v.key === s.key) store.setView({ kind: "library" });
			refreshSavedSearches();
			toast.success(`Deleted saved search "${s.name}"`);
		} catch (e) { fail("Could not delete search", e); }
	}

	const openMenu = (e: MouseEvent, s: SavedSearch) => {
		e.preventDefault();
		e.stopPropagation(); // the collections tree has its own context menu
		setMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 120), s });
	};

	return (
		<div role="group" aria-label="Saved searches">
			<div class="flex items-center justify-between py-1 pl-2 pr-1 pt-2">
				<span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Saved Searches</span>
				<Tooltip>
					<TooltipTrigger as={Button} variant="ghost" size="icon" class="size-6" aria-label="Advanced search" onClick={() => openAdvancedSearch()}>
						<Plus />
					</TooltipTrigger>
					<TooltipContent>Advanced search (Ctrl+Shift+F)</TooltipContent>
				</Tooltip>
			</div>
			<Show when={(savedSearches() ?? []).length > 0} fallback={
				<div class="px-6 py-1 text-xs text-muted-foreground">No saved searches</div>
			}>
				<For each={savedSearches()}>{(s) => (
					<div role="treeitem" aria-selected={isActive(s.key)} data-skey={s.key}
						class={cn(rowCls, "pl-6", isActive(s.key) && "bg-primary/15 hover:bg-primary/20", menu()?.s.key === s.key && "bg-accent")}
						onClick={() => store.setView({ kind: "search", key: s.key })}
						onDblClick={() => openAdvancedSearch(s.key)}
						on:contextmenu={(e: MouseEvent) => openMenu(e, s)}>
						<Search class="size-4 flex-none text-primary/80" />
						<Show when={renaming() === s.key} fallback={<span class="flex-1 truncate">{s.name}</span>}>
							<Input class="h-5 flex-1 px-1" value={s.name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitRename(s, e.currentTarget.value); if (e.key === "Escape") setRenaming(null); }}
								onBlur={(e) => commitRename(s, e.currentTarget.value)} />
						</Show>
					</div>
				)}</For>
			</Show>

			<Show when={menu()}>{(m) => (
				<Portal>
					<div class="fixed inset-0 z-50" onClick={() => setMenu(null)} on:contextmenu={(e: MouseEvent) => { e.preventDefault(); setMenu(null); }}>
						<div role="menu" class="absolute min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
							style={{ left: m().x + "px", top: m().y + "px" }} onClick={(e) => e.stopPropagation()}>
							<button type="button" role="menuitem" class={menuItem} onClick={() => { const s = m().s; setMenu(null); openAdvancedSearch(s.key); }}>
								<Pencil class="size-4" /> Edit Search…
							</button>
							<button type="button" role="menuitem" class={menuItem} onClick={() => { const s = m().s; setMenu(null); setRenaming(s.key); }}>
								<TextCursorInput class="size-4" /> Rename
							</button>
							<div class="-mx-1 my-1 h-px bg-border" />
							<button type="button" role="menuitem" class={cn(menuItem, "text-destructive")} onClick={() => { const s = m().s; setMenu(null); setPendingDelete(s); setDlgOpen(true); }}>
								<Trash2 class="size-4" /> Delete…
							</button>
						</div>
					</div>
				</Portal>
			)}</Show>

			<AlertDialog open={dlgOpen()} onOpenChange={setDlgOpen}>
				<AlertDialogContent>
					<AlertDialogTitle>Delete saved search "{pendingDelete()?.name}"?</AlertDialogTitle>
					<AlertDialogDescription>Only the search is removed; your items are not affected.</AlertDialogDescription>
					<div class="mt-2 flex justify-end gap-2">
						<Button variant="outline" size="sm" onClick={() => setDlgOpen(false)}>Cancel</Button>
						<Button variant="destructive" size="sm" onClick={() => { const s = pendingDelete(); if (s) remove(s); }}>Delete</Button>
					</div>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
};
