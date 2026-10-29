import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ArrowDown, ArrowUp, BookOpen, FolderInput, FolderSearch, Quote, RotateCcw, Trash2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { createItemList } from "./itemlist";
import { store } from "./store";
import { api, type ItemSummary, type SearchHit } from "./api";
import { sanitizeSnippet } from "./sanitize";
import { addItemsToCollection, copyDoi, errMsg, trashItems } from "~/lib/actions";
import { attachmentIcon, itemTypeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import {
	ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent,
	ContextMenuSubTrigger, ContextMenuTrigger,
} from "~/components/ui/context-menu";

const ROW = 26;
const GRID = "grid grid-cols-[minmax(180px,1fr)_160px_48px_160px_88px_28px]";
const COLS: { id: string; label: string; sort?: string; cls?: string }[] = [
	{ id: "title", label: "Title", sort: "title" },
	{ id: "creator", label: "Creator", sort: "creator" },
	{ id: "year", label: "Year", sort: "year", cls: "justify-end" },
	{ id: "pub", label: "Publication" },
	{ id: "added", label: "Date Added", sort: "dateAdded" },
	{ id: "att", label: "" },
];

export const itemList = createItemList();

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

export const ItemTable: Component = () => {
	let scroller!: HTMLDivElement;
	const list = itemList;
	const [sbw, setSbw] = createSignal(0); // scrollbar width, so the header aligns with the rows
	const [ctx, setCtx] = createSignal<ItemSummary | null>(null);

	const v = createVirtualizer({
		get count() { return list.total(); },
		getScrollElement: () => scroller,
		estimateSize: () => ROW,
		overscan: 12,
	});

	onMount(() => {
		const ro = new ResizeObserver(() => setSbw(scroller.offsetWidth - scroller.clientWidth));
		ro.observe(scroller);
		onCleanup(() => ro.disconnect());
	});

	createEffect(on(() => [store.query(), store.itemsRev()], () => {
		list.reset(store.query());
		scroller?.scrollTo({ top: 0 });
		store.selectOnly(null);
	}));
	createEffect(() => { for (const r of v.getVirtualItems()) list.ensure(r.index); });
	createEffect(on(list.error, (e) => { if (e) toast.error("Could not load items", { description: e, id: "items-error" }); }));

	function click(e: MouseEvent, index: number) {
		const it = list.get(index);
		if (!it) return;
		const sel = new Set(store.selected());
		if (e.shiftKey && store.anchor() >= 0) {
			const [a, b] = [Math.min(store.anchor(), index), Math.max(store.anchor(), index)];
			if (!(e.ctrlKey || e.metaKey)) sel.clear();
			for (let i = a; i <= b; i++) { const x = list.get(i); if (x) sel.add(x.key); }
			store.setFocusIndex(index);
		} else if (e.ctrlKey || e.metaKey) {
			sel.has(it.key) ? sel.delete(it.key) : sel.add(it.key);
			store.setAnchor(index); store.setFocusIndex(index);
		} else {
			store.selectOnly(it.key, index);
			return;
		}
		store.setSelected(sel);
		store.setActiveKey(it.key);
	}

	function move(delta: number, extend: boolean) {
		const next = Math.max(0, Math.min(list.total() - 1, (store.focusIndex() < 0 ? -1 : store.focusIndex()) + delta));
		const it = list.get(next);
		if (!it) { v.scrollToIndex(next); return; }
		if (extend && store.anchor() >= 0) {
			const [a, b] = [Math.min(store.anchor(), next), Math.max(store.anchor(), next)];
			const sel = new Set<string>();
			for (let i = a; i <= b; i++) { const x = list.get(i); if (x) sel.add(x.key); }
			store.setSelected(sel); store.setActiveKey(it.key); store.setFocusIndex(next);
		} else store.selectOnly(it.key, next);
		v.scrollToIndex(next, { align: "auto" });
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") { e.preventDefault(); move(1, e.shiftKey); }
		else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, e.shiftKey); }
		else if (e.key === "PageDown") { e.preventDefault(); move(15, false); }
		else if (e.key === "PageUp") { e.preventDefault(); move(-15, false); }
		else if (e.key === "Home") { e.preventDefault(); move(-1e9, false); }
		else if (e.key === "End") { e.preventDefault(); move(1e9, false); }
		else if (e.key === "Enter") {
			const it = list.get(store.focusIndex());
			if (it) store.openSummary(it);
		}
	}

	function onContextMenu(e: MouseEvent) {
		const idx = (e.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
		const it = idx === undefined ? undefined : list.get(+idx);
		if (!it) return e.preventDefault(); // blank area / placeholder row: no menu
		if (!store.selected().has(it.key)) store.selectOnly(it.key, +idx!);
		setCtx(it);
	}

	function dragStart(e: DragEvent, index: number) {
		const it = list.get(index);
		if (!it) return;
		if (!store.selected().has(it.key)) store.selectOnly(it.key, index);
		const keys = [...store.selected()];
		e.dataTransfer!.setData("application/x-zn-items", JSON.stringify(keys));
		e.dataTransfer!.setData("text/plain", keys.join(","));
		e.dataTransfer!.effectAllowed = "copy";
	}

	function header(c: (typeof COLS)[number]) {
		if (!c.sort) return;
		const s = store.sort();
		store.setSort(s.key === c.sort ? { key: c.sort, dir: s.dir === "asc" ? "desc" : "asc" }
			: { key: c.sort, dir: c.sort === "dateAdded" ? "desc" : "asc" });
	}

	const inTrash = () => store.view().kind === "trash";

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div class={cn(GRID, "h-[26px] flex-none items-center border-b bg-card text-xs font-semibold")} style={{ "padding-right": sbw() + "px" }}>
				<For each={COLS}>{(c) => (
					<div class={cn("flex h-full items-center gap-1 whitespace-nowrap px-2", c.cls, c.sort && "cursor-pointer hover:bg-accent")} onClick={() => header(c)}>
						{c.label}
						<Show when={c.sort && store.sort().key === c.sort}>
							{store.sort().dir === "asc" ? <ArrowUp class="size-3 text-primary" /> : <ArrowDown class="size-3 text-primary" />}
						</Show>
					</div>
				)}</For>
			</div>
			<ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
				<ContextMenuTrigger as="div" ref={scroller} tabindex="0" onKeyDown={onKey} onContextMenu={onContextMenu}
					class="group/list relative min-h-0 flex-1 overflow-y-auto outline-none">
					<div style={{ height: v.getTotalSize() + "px", position: "relative", width: "100%" }}>
						<For each={v.getVirtualItems()}>{(r) => {
							const it = () => list.get(r.index);
							const selected = () => !!it() && store.selected().has(it()!.key);
							return (
								<div data-index={r.index}
									class={cn(GRID, "absolute inset-x-0 top-0 h-[26px] select-none items-center hover:bg-accent",
										r.index % 2 === 1 && "bg-muted/50",
										selected() && "bg-primary/15 hover:bg-primary/20 group-focus-within/list:bg-primary group-focus-within/list:text-primary-foreground group-focus-within/list:hover:bg-primary",
										store.focusIndex() === r.index && "outline-1 -outline-offset-1 outline-ring/60")}
									style={{ transform: `translateY(${r.start}px)` }}
									draggable={!!it()} onDragStart={(e) => dragStart(e, r.index)}
									onClick={(e) => click(e, r.index)}
									onDblClick={() => { const x = it(); if (x) store.openSummary(x); }}>
									<Show when={it()} fallback={<>
										<div class="px-2"><Skeleton class="h-3 w-4/5 rounded-sm" /></div>
										<div class="px-2"><Skeleton class="h-3 w-3/5 rounded-sm" /></div>
										<div class="px-2"><Skeleton class="h-3 w-full rounded-sm" /></div>
									</>}>
										{(x) => (<>
											<div class="flex min-w-0 items-center gap-1.5 px-2" title={x().title}>
												<Dynamic component={itemTypeIcon(x().itemType)} class="size-3.5 flex-none opacity-60" />
												<span class="truncate">{x().title || "(untitled)"}</span>
											</div>
											<div class="truncate px-2">{x().creatorsSummary}</div>
											<div class="px-2 text-right tabular-nums opacity-70">{x().year ?? ""}</div>
											<div class="truncate px-2">{x().publication ?? ""}</div>
											<div class="truncate px-2 tabular-nums opacity-70">{x().dateAdded.slice(0, 10)}</div>
											<div class="flex h-full items-center justify-center" title={x().primaryAttachment?.contentType}
												onClick={(e) => { if (x().primaryAttachment) { e.stopPropagation(); store.openSummary(x()); } }}>
												<Show when={x().primaryAttachment || x().attachmentCount}>
													<Dynamic component={attachmentIcon(x().primaryAttachment?.contentType, x().primaryAttachment ? null : "linked_url")} class="size-3.5 opacity-70" />
												</Show>
											</div>
										</>)}
									</Show>
								</div>
							);
						}}</For>
					</div>
					<Show when={list.total() === 0 && !list.loading()}>
						<div class="p-6 text-center text-muted-foreground">No items</div>
					</Show>
				</ContextMenuTrigger>
				<ContextMenuContent class="w-56">
					<Show when={ctx()}>{(it) => {
						const keys = () => [...store.selected()];
						return (<>
							<ContextMenuItem disabled={!it().primaryAttachment} onSelect={() => store.openSummary(it())}>
								<BookOpen class="mr-2 size-4" /> Open
							</ContextMenuItem>
							<ShowInCollection itemKey={it().key} />
							<AddToCollection keys={keys()} />
							<ContextMenuItem onSelect={() => copyDoi(it().key)}>
								<Quote class="mr-2 size-4" /> Copy DOI
							</ContextMenuItem>
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
					}}</Show>
				</ContextMenuContent>
			</ContextMenu>
			<div class="flex-none border-t bg-card px-2 py-0.5 text-xs text-muted-foreground">
				{list.total().toLocaleString()} items{list.loading() ? " · loading…" : ""}
				<Show when={list.error()}> · <span class="text-destructive">{list.error()}</span></Show>
				<Show when={store.selected().size > 1}> · {store.selected().size} selected</Show>
			</div>
		</div>
	);
};

export const SearchResults: Component = () => {
	const [hits, setHits] = createSignal<SearchHit[]>([]);
	const [total, setTotal] = createSignal(0);
	const [busy, setBusy] = createSignal(false);
	const [err, setErr] = createSignal<string | null>(null);
	let n = 0;
	createEffect(() => {
		const q = store.filter().trim();
		const id = ++n;
		if (!q) { setHits([]); setTotal(0); return; }
		setBusy(true);
		const t = setTimeout(async () => {
			try {
				const r = await api.search(q, 200);
				if (id !== n) return;
				setHits(r.hits); setTotal(r.total); setErr(null);
			} catch (e) { if (id === n) { setErr(errMsg(e)); toast.error("Search failed", { description: errMsg(e), id: "search-error" }); } }
			finally { if (id === n) setBusy(false); }
		}, 250);
		return () => clearTimeout(t);
	});
	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="relative min-h-0 flex-1 overflow-y-auto">
				<For each={hits()}>{(h) => (
					<div class={cn("cursor-default border-b px-3 py-1.5 hover:bg-accent", store.selected().has(h.key) && "bg-primary/15 hover:bg-primary/20")}
						onClick={() => store.selectOnly(h.key)}
						onDblClick={() => store.openItem(h.key, h.title).catch((e) => toast.error("Could not open item", { description: errMsg(e) }))}>
						<div class="font-semibold">{h.title || "(untitled)"}</div>
						<div class="text-xs text-muted-foreground">{h.creatorsSummary}{h.year ? ` (${h.year})` : ""} · {h.matchedIn.join(", ")}</div>
						<div class="mt-0.5 text-xs" innerHTML={sanitizeSnippet(h.snippet)} />
					</div>
				)}</For>
				<Show when={busy() && !hits().length}>
					<div class="space-y-3 p-3"><Skeleton class="h-4 w-3/4" /><Skeleton class="h-3 w-1/2" /><Skeleton class="h-4 w-2/3" /></div>
				</Show>
				<Show when={!busy() && !hits().length}>
					<div class="p-6 text-center text-muted-foreground">{store.filter().trim() ? "No matches" : "Type to search titles, notes and full text"}</div>
				</Show>
			</div>
			<div class="flex-none border-t bg-card px-2 py-0.5 text-xs text-muted-foreground">
				{total().toLocaleString()} hits{busy() ? " · searching…" : ""}<Show when={err()}> · <span class="text-destructive">{err()}</span></Show>
			</div>
		</div>
	);
};
