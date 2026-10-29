import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ArrowDown, ArrowUp, BookOpen, FileSearch, FolderInput, FolderSearch, Paperclip, Quote, RotateCcw, StickyNote, Trash2 } from "lucide-solid";
import { toast } from "solid-sonner";
import { createItemList } from "./itemlist";
import { store } from "./store";
import { api, type ItemSummary, type SearchHit } from "./api";
import { sanitizeSnippet } from "./sanitize";
import { addItemsToCollection, copyDoi, errMsg, trashItems } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { attachmentIcon, itemTypeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import {
	ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
	ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { columnLayout as layout } from "./columns/layout";
import { loadSchema, labelOf, moreColumns, MENU_COLUMNS, type Column } from "./columns/defs";

const ROW = 26;
const gridCols = () => layout.ids().map((id) => layout.widthOf(id) + "px").join(" ") + " 1fr";
const alignCls = (c: Column) => (c.align === "right" ? "justify-end text-right" : c.align === "center" ? "justify-center text-center" : "");

export const itemList = createItemList();

/** Header row: sort on click, drag to reorder, drag the right edge to resize, right-click for the column picker. */
const HeaderRow: Component<{ sbw: number; left: number }> = (p) => {
	let outer!: HTMLDivElement;
	let inner!: HTMLDivElement;
	const [dragId, setDragId] = createSignal<string | null>(null);
	const [dropAt, setDropAt] = createSignal<{ index: number; left: number } | null>(null);
	let suppressClick = false;
	// keep the header horizontally in step with the body
	createEffect(() => { layout.total(); p.sbw; outer.scrollLeft = p.left; });

	function sortBy(c: Column) {
		if (suppressClick) return;
		const s = store.sort();
		store.setSort(s.key === c.sort ? { key: c.sort, dir: s.dir === "asc" ? "desc" : "asc" }
			: { key: c.sort, dir: /^(dateAdded|dateModified|accessDate)$/.test(c.sort) ? "desc" : "asc" });
	}

	/** Follow the pointer until release; `onEnd` returns true when the gesture was a drag (so the trailing click must not sort). */
	function track(e: PointerEvent, onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent) => boolean) {
		const up = (ev: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			if (onEnd(ev)) {
				suppressClick = true;
				setTimeout(() => (suppressClick = false), 0);
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
		e.preventDefault();
	}

	function startResize(e: PointerEvent, id: string) {
		if (e.button !== 0) return;
		e.stopPropagation();
		const x0 = e.clientX, w0 = layout.widthOf(id);
		track(e, (ev) => layout.setWidth(id, w0 + ev.clientX - x0), () => true);
	}

	function startDrag(e: PointerEvent, id: string) {
		if (e.button !== 0) return;
		const x0 = e.clientX;
		let moved = false;
		const cells = () => [...inner.querySelectorAll<HTMLElement>("[data-col]")];
		const target = (x: number) => {
			const cs = cells();
			const base = inner.getBoundingClientRect().left;
			let i = cs.findIndex((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2; });
			if (i < 0) i = cs.length;
			const edge = i < cs.length ? cs[i].getBoundingClientRect().left : cs[cs.length - 1].getBoundingClientRect().right;
			return { index: i, left: edge - base };
		};
		track(e, (ev) => {
			if (!moved && Math.abs(ev.clientX - x0) < 5) return;
			moved = true;
			setDragId(id);
			setDropAt(target(ev.clientX));
		}, () => {
			const t = dropAt();
			if (moved && t) {
				const from = layout.ids().indexOf(id);
				layout.move(id, t.index > from ? t.index - 1 : t.index);
			}
			setDragId(null); setDropAt(null);
			return moved;
		});
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger as="div" ref={outer} class="flex-none overflow-hidden border-b bg-card text-xs font-semibold" role="presentation">
				<div ref={inner} role="row" aria-rowindex={1} class="relative grid h-[26px] items-center"
					style={{ "grid-template-columns": gridCols(), width: layout.total() + p.sbw + "px", "min-width": "100%", "padding-right": p.sbw + "px" }}>
					<For each={layout.columns()}>{(c) => (
						<div role="columnheader" data-col={c.id}
							aria-sort={store.sort().key === c.sort ? (store.sort().dir === "asc" ? "ascending" : "descending") : "none"}
							aria-label={c.icon ? c.label : undefined}
							title={c.icon ? c.label : undefined}
							class={cn("relative flex h-full min-w-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap px-2 hover:bg-accent", alignCls(c), dragId() === c.id && "opacity-40")}
							onPointerDown={(e) => startDrag(e, c.id)} onClick={() => sortBy(c)}>
							<Show when={c.icon} fallback={<span class="truncate">{c.label}</span>}>
								{c.icon === "attachments" ? <Paperclip class="size-3.5" /> : <StickyNote class="size-3.5" />}
							</Show>
							<Show when={store.sort().key === c.sort}>
								{store.sort().dir === "asc" ? <ArrowUp class="size-3 flex-none text-primary" /> : <ArrowDown class="size-3 flex-none text-primary" />}
							</Show>
							<div data-resize={c.id} class="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize border-r border-border/60 hover:border-primary hover:bg-primary/20"
								onPointerDown={(e) => startResize(e, c.id)} onClick={(e) => e.stopPropagation()} />
						</div>
					)}</For>
					<Show when={dropAt()}>{(d) => <div class="pointer-events-none absolute top-0 z-20 h-full w-0.5 bg-primary" style={{ left: Math.max(0, d().left - 1) + "px" }} />}</Show>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent class="max-h-[80vh] w-56 overflow-y-auto">
				<For each={MENU_COLUMNS}>{(id) => (
					<ContextMenuCheckboxItem checked={layout.has(id)} disabled={id === "title"} closeOnSelect={false}
						onChange={(on) => layout.toggle(id, on)}>{labelOf(id)}</ContextMenuCheckboxItem>
				)}</For>
				<ContextMenuSeparator />
				<ContextMenuSub>
					<ContextMenuSubTrigger>More Columns</ContextMenuSubTrigger>
					<ContextMenuSubContent class="max-h-[70vh] min-w-48 overflow-y-auto">
						<For each={moreColumns()} fallback={<div class="px-2 py-1.5 text-muted-foreground">No other fields</div>}>{(f) => (
							<ContextMenuCheckboxItem checked={layout.has(f.id)} closeOnSelect={false}
								onChange={(on) => layout.toggle(f.id, on)}>{f.label}</ContextMenuCheckboxItem>
						)}</For>
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={() => layout.restoreOrder()}>Restore Column Order</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
};

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
	const [left, setLeft] = createSignal(0); // horizontal scroll offset, mirrored into the header
	const listQuery = createMemo(() => ({ ...store.query(), fields: layout.fieldsParam() || undefined }));
	loadSchema();

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

	// A new query (view, filter, sort, tag) or a data change starts over from the top...
	createEffect(on(() => [store.query(), store.itemsRev()], () => {
		list.reset(untrack(listQuery));
		scroller?.scrollTo({ top: 0 });
		store.selectOnly(null);
	}));
	// ...whereas changing the visible columns only refetches the pages in view (selection and scroll stay).
	createEffect(on(() => layout.fieldsParam(), () => list.reset(untrack(listQuery)), { defer: true }));
	createEffect(() => { list.epoch(); for (const r of v.getVirtualItems()) list.ensure(r.index); });
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

	const inTrash = () => store.view().kind === "trash";
	const rowWidth = () => layout.total() + "px";

	/** One body cell; text columns truncate and show their full value as a tooltip. */
	const Cell: Component<{ col: Column; item: ItemSummary }> = (cp) => {
		const text = () => cp.col.get(cp.item);
		return (
			<Switch fallback={
				<div role="gridcell" class={cn("min-w-0 truncate px-2", alignCls(cp.col), (cp.col.id === "dateAdded" || cp.col.id === "year") && "tabular-nums opacity-70")} title={text() || undefined}>{text()}</div>
			}>
				<Match when={cp.col.id === "title"}>
					<div role="gridcell" class="flex min-w-0 items-center gap-1.5 px-2" title={cp.item.title}>
						<Dynamic component={itemTypeIcon(cp.item.itemType)} class="size-3.5 flex-none opacity-60" />
						<span class="truncate">{cp.item.title || "(untitled)"}</span>
					</div>
				</Match>
				<Match when={cp.col.id === "attachments"}>
					<div role="gridcell" class="flex h-full items-center justify-center" title={cp.item.primaryAttachment?.contentType}
						onClick={(e) => { if (cp.item.primaryAttachment) { e.stopPropagation(); store.openSummary(cp.item); } }}>
						<Show when={cp.item.primaryAttachment || cp.item.attachmentCount}>
							<Dynamic component={attachmentIcon(cp.item.primaryAttachment?.contentType, cp.item.primaryAttachment ? null : "linked_url")} class="size-3.5 opacity-70" />
						</Show>
					</div>
				</Match>
			</Switch>
		);
	};

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div role="grid" aria-label="Items" aria-multiselectable="true" aria-rowcount={list.total() + 1} aria-colcount={layout.ids().length}
				class="flex min-h-0 flex-1 flex-col">
			<HeaderRow sbw={sbw()} left={left()} />
			<ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
				<ContextMenuTrigger as="div" ref={scroller} role="rowgroup" tabindex="0" onKeyDown={onKey} onContextMenu={onContextMenu}
					onScroll={() => setLeft(scroller.scrollLeft)}
					class="group/list relative min-h-0 flex-1 overflow-auto outline-none">
					<div role="presentation" style={{ height: v.getTotalSize() + "px", position: "relative", width: rowWidth(), "min-width": "100%" }}>
						<For each={v.getVirtualItems()}>{(r) => {
							const it = () => list.get(r.index);
							const selected = () => !!it() && store.selected().has(it()!.key);
							return (
								<div data-index={r.index} role="row" aria-rowindex={r.index + 2} aria-selected={selected()}
									class={cn("absolute inset-x-0 top-0 grid h-[26px] select-none items-center hover:bg-accent",
										r.index % 2 === 1 && "bg-muted/50",
										selected() && "bg-primary/15 hover:bg-primary/20 group-focus-within/list:bg-primary group-focus-within/list:text-primary-foreground group-focus-within/list:hover:bg-primary",
										store.focusIndex() === r.index && "outline-1 -outline-offset-1 outline-ring/60")}
									style={{ transform: `translateY(${r.start}px)`, "grid-template-columns": gridCols() }}
									draggable={!!it()} onDragStart={(e) => dragStart(e, r.index)}
									onClick={(e) => click(e, r.index)}
									onDblClick={() => { const x = it(); if (x) store.openSummary(x); }}>
									<Show when={it()} fallback={
										<For each={layout.columns()}>{(c) => (
											<div role="gridcell" class="px-2"><Skeleton class={cn("h-3 rounded-sm", c.id === "title" ? "w-4/5" : "w-3/5")} /></div>
										)}</For>
									}>
										{(x) => <For each={layout.columns()}>{(c) => <Cell col={c} item={x()} />}</For>}
									</Show>
								</div>
							);
						}}</For>
					</div>
					<Show when={list.total() === 0 && !list.loading()}>
						<div class="sticky left-0 p-6 text-center text-muted-foreground">No items</div>
					</Show>
				</ContextMenuTrigger>
				<ContextMenuContent class="w-56">
					<Show when={ctx()}>{(it) => {
						const keys = () => [...store.selected()];
						return (<>
							<ContextMenuItem disabled={!it().primaryAttachment} onSelect={() => store.openSummary(it())}>
								<BookOpen class="mr-2 size-4" /> Open
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => findFullText(keys())}>
								<FileSearch class="mr-2 size-4" /> Find Full Text
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => findFullText(keys(), { openAccessOnly: true })}>
								<FileSearch class="mr-2 size-4" /> Find Full Text (open access only)
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
			</div>
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
