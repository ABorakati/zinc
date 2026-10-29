import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { ChevronRight, Folder, FolderOpen, FolderPlus, Inbox, Library, Pencil, Plus, Trash2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { api, type Collection } from "./api";
import { store } from "./store";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import {
	AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
	ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "~/components/ui/context-menu";

interface Node { c: Collection; children: Node[] }

function buildTree(list: Collection[]): Node[] {
	const nodes = new Map(list.map((c) => [c.key, { c, children: [] as Node[] }]));
	const roots: Node[] = [];
	for (const n of nodes.values()) {
		const p = n.c.parentKey ? nodes.get(n.c.parentKey) : undefined;
		(p ? p.children : roots).push(n);
	}
	const sort = (a: Node[]) => { a.sort((x, y) => x.c.name.localeCompare(y.c.name)); a.forEach((n) => sort(n.children)); };
	sort(roots);
	return roots;
}

const rowCls = "relative flex h-6 items-center gap-1 pr-2 text-[13px] hover:bg-accent";

export const CollectionsPane: Component = () => {
	const tree = createMemo(() => buildTree(store.collections() ?? []));
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
	const [editing, setEditing] = createSignal<string | null>(null);
	const [creating, setCreating] = createSignal<string | "root" | null>(null);
	const [dropKey, setDropKey] = createSignal<string | null>(null);
	const [ctx, setCtx] = createSignal<Collection | null>(null);
	const [pendingDelete, setPendingDelete] = createSignal<Collection | null>(null);
	const [dlgOpen, setDlgOpen] = createSignal(false); // separate from pendingDelete so the title survives the close animation
	const askDelete = (c: Collection | null) => { if (c) { setPendingDelete(c); setDlgOpen(true); } };

	const isView = (k: string) => {
		const v = store.view();
		return v.kind === k || (v.kind === "collection" && v.key === k);
	};
	const toggle = (key: string) => {
		const s = new Set(expanded());
		s.has(key) ? s.delete(key) : s.add(key);
		setExpanded(s);
	};
	const byKey = (k: string | undefined) => store.collections()?.find((c) => c.key === k) ?? null;

	async function commitCreate(parent: string | "root", name: string) {
		setCreating(null);
		if (!name.trim()) return;
		try {
			await api.createCollection(name.trim(), parent === "root" ? null : parent);
			if (parent !== "root") setExpanded(new Set(expanded()).add(parent));
			store.refetchCollections();
			toast.success(`Created collection "${name.trim()}"`);
		} catch (e) { fail("Could not create collection", e); }
	}
	async function commitRename(key: string, name: string, old: string) {
		setEditing(null);
		if (!name.trim() || name === old) return;
		try { await api.patchCollection(key, { name: name.trim() }); store.refetchCollections(); } catch (e) { fail("Could not rename collection", e); }
	}
	async function remove(c: Collection) {
		setDlgOpen(false);
		try {
			await api.deleteCollection(c.key);
			const v = store.view();
			if (v.kind === "collection" && v.key === c.key) store.setView({ kind: "library" });
			store.refetchCollections();
			toast.success(`Deleted collection "${c.name}"`);
		} catch (e) { fail("Could not delete collection", e); }
	}
	async function drop(e: DragEvent, c: Collection) {
		e.preventDefault();
		setDropKey(null);
		const raw = e.dataTransfer?.getData("application/x-zn-items");
		if (!raw) return;
		try {
			const keys: string[] = JSON.parse(raw);
			await api.addToCollection(c.key, keys);
			store.refetchCollections();
			toast.success(`Added ${keys.length} item${keys.length === 1 ? "" : "s"} to "${c.name}"`);
		} catch (x) { fail("Could not add to collection", x); }
	}

	const NameInput: Component<{ value: string; onDone: (v: string) => void; onCancel: () => void }> = (p) => (
		<Input class="h-5 flex-1 px-1" value={p.value} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
			onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") p.onDone(e.currentTarget.value); if (e.key === "Escape") p.onCancel(); }}
			onBlur={(e) => p.onDone(e.currentTarget.value)} onClick={(e) => e.stopPropagation()} />
	);

	const Row: Component<{ n: Node; depth: number }> = (p) => {
		const open = () => expanded().has(p.n.c.key);
		return (
			<>
				<div role="treeitem" aria-selected={isView(p.n.c.key)} data-ckey={p.n.c.key}
					class={cn(rowCls, isView(p.n.c.key) && "bg-primary/15 text-foreground hover:bg-primary/20",
						ctx()?.key === p.n.c.key && "bg-accent", dropKey() === p.n.c.key && "outline-2 -outline-offset-2 outline-primary")}
					style={{ "padding-left": 4 + p.depth * 14 + "px" }}
					onClick={() => store.setView({ kind: "collection", key: p.n.c.key })}
					onDblClick={() => setEditing(p.n.c.key)}
					onDragOver={(e) => { e.preventDefault(); setDropKey(p.n.c.key); }}
					onDragLeave={() => setDropKey(null)}
					onDrop={(e) => drop(e, p.n.c)}>
					<span class="flex size-4 flex-none items-center justify-center text-muted-foreground"
						onClick={(e) => { e.stopPropagation(); toggle(p.n.c.key); }}>
						<Show when={p.n.children.length}>
							<ChevronRight class={cn("size-3.5 transition-transform", open() && "rotate-90")} />
						</Show>
					</span>
					<Show when={open() || isView(p.n.c.key)} fallback={<Folder class="size-4 flex-none text-primary/80" />}>
						<FolderOpen class="size-4 flex-none text-primary" />
					</Show>
					<Show when={editing() === p.n.c.key} fallback={<span class="flex-1 truncate">{p.n.c.name}</span>}>
						<NameInput value={p.n.c.name} onDone={(v) => commitRename(p.n.c.key, v, p.n.c.name)} onCancel={() => setEditing(null)} />
					</Show>
					<span class="ml-1 text-[11px] tabular-nums text-muted-foreground">{p.n.c.itemCount}</span>
				</div>
				<Show when={creating() === p.n.c.key}>
					<div class={rowCls} style={{ "padding-left": 4 + (p.depth + 1) * 14 + 20 + "px" }}>
						<Folder class="size-4 flex-none text-muted-foreground" />
						<NameInput value="" onDone={(v) => commitCreate(p.n.c.key, v)} onCancel={() => setCreating(null)} />
					</div>
				</Show>
				<Show when={open()}>
					<For each={p.n.children}>{(c) => <Row n={c} depth={p.depth + 1} />}</For>
				</Show>
			</>
		);
	};

	const special = (kind: "library" | "unfiled" | "trash", label: string, Icon: typeof Library) => (
		<div role="treeitem" aria-selected={isView(kind)} class={cn(rowCls, "pl-6", isView(kind) && "bg-primary/15 hover:bg-primary/20")}
			onClick={() => store.setView({ kind })}>
			<Icon class="size-4 flex-none text-muted-foreground" />
			<span class="flex-1 truncate">{label}</span>
		</div>
	);

	return (
		<div class="flex h-full min-h-0 flex-col">
			<div class="flex flex-none items-center justify-between py-1 pl-2 pr-1">
				<span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Collections</span>
				<Tooltip>
					<TooltipTrigger as={Button} variant="ghost" size="icon" class="size-6" aria-label="New collection" onClick={() => setCreating("root")}>
						<Plus />
					</TooltipTrigger>
					<TooltipContent>New collection</TooltipContent>
				</Tooltip>
			</div>
			<ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
				<ContextMenuTrigger as="div" role="tree" class="min-h-0 flex-1 overflow-y-auto pb-1.5"
					onContextMenu={(e: MouseEvent) => {
						const c = byKey((e.target as HTMLElement).closest<HTMLElement>("[data-ckey]")?.dataset.ckey);
						if (c) setCtx(c); else e.preventDefault();
					}}>
					{special("library", "My Library", Library)}
					<Show when={!store.collections.loading || store.collections()} fallback={
						<div class="space-y-2 px-3 py-2"><Skeleton class="h-3.5 w-3/4" /><Skeleton class="h-3.5 w-1/2" /><Skeleton class="h-3.5 w-2/3" /></div>
					}>
						<For each={tree()}>{(n) => <Row n={n} depth={0} />}</For>
					</Show>
					<Show when={creating() === "root"}>
						<div class={rowCls} style={{ "padding-left": "24px" }}>
							<Folder class="size-4 flex-none text-muted-foreground" />
							<NameInput value="" onDone={(v) => commitCreate("root", v)} onCancel={() => setCreating(null)} />
						</div>
					</Show>
					{special("unfiled", "Unfiled", Inbox)}
					{special("trash", "Trash", Trash2)}
				</ContextMenuTrigger>
				<ContextMenuContent class="w-52" onCloseAutoFocus={(e: Event) => e.preventDefault()}>
					<ContextMenuItem onSelect={() => { const c = ctx(); if (c) setCreating(c.key); }}>
						<FolderPlus class="mr-2 size-4" /> New subcollection
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => { const c = ctx(); if (c) setEditing(c.key); }}>
						<Pencil class="mr-2 size-4" /> Rename
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem class="text-destructive focus:text-destructive" onSelect={() => askDelete(ctx())}>
						<Trash2 class="mr-2 size-4" /> Delete…
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>

			<AlertDialog open={dlgOpen()} onOpenChange={setDlgOpen}>
				<AlertDialogContent>
					<AlertDialogTitle>Delete collection "{pendingDelete()?.name}"?</AlertDialogTitle>
					<AlertDialogDescription>The items inside are kept in your library; only the collection is removed.</AlertDialogDescription>
					<div class="mt-2 flex justify-end gap-2">
						<Button variant="outline" size="sm" onClick={() => setDlgOpen(false)}>Cancel</Button>
						<Button variant="destructive" size="sm" onClick={() => { const c = pendingDelete(); if (c) remove(c); }}>Delete</Button>
					</div>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
};
