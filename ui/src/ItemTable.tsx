import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createVirtualizer, type VirtualItem } from "@tanstack/solid-virtual";
import { ArrowDown, ArrowUp, ChevronRight, Paperclip, StickyNote } from "lucide-solid";
import { toast } from "solid-sonner";
import { createItemList } from "./itemlist";
import { store } from "./store";
import { api, type ChildSummary, type ItemSummary, type SearchHit } from "./api";
import { childIcon, childLabel, getDetail, openChild } from "./itemopen";
import { AttachmentMenu } from "./cards/AttachmentMenu";
import { sanitizeSnippet } from "./sanitize";
import { errMsg } from "~/lib/actions";
import { attachmentIcon, itemTypeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import {
	ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
	ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { columnLayout as layout } from "./columns/layout";
import { selectClick, focusRow, startItemDrag, ItemMenuItems, ChildMenuItems } from "./cards/shared";
import { CardList } from "./cards/CardList";
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

interface Ins { itemIndex: number; key: string; count: number; start: number; endCum: number }
type ChildRef = { kind: "child"; e: Ins; ci: number; c: ChildSummary };
type RowRef = { kind: "item"; i: number } | ChildRef;
const hasKids = (it: ItemSummary) => it.attachmentCount + it.noteCount > 0;

interface TableOps { expandAll(): void; collapseAll(): void; has(t: EventTarget | null): boolean }
let tableOps: TableOps | null = null;
// "+" / "-" expand / collapse all rows while the item list has focus. Registered at import time, i.e. before the
// global shortcut handler (maintenance/shortcuts.ts), so the collections shortcut only fires elsewhere.
if (typeof window !== "undefined") {
	window.addEventListener("keydown", (e) => {
		if (!tableOps || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
		const plus = e.key === "+" || e.key === "=", minus = e.key === "-" || e.key === "_";
		if (!(plus || minus) || !tableOps.has(e.target)) return;
		e.preventDefault(); e.stopImmediatePropagation();
		plus ? tableOps.expandAll() : tableOps.collapseAll();
	}, true);
}

const TableView: Component = () => {
	let scroller!: HTMLDivElement;
	const list = itemList;
	const [sbw, setSbw] = createSignal(0); // scrollbar width, so the header aligns with the rows
	const [ctx, setCtx] = createSignal<ItemSummary | null>(null);
	const [ctxChild, setCtxChild] = createSignal<{ parent: { key: string; title: string }; child: ChildSummary } | null>(null);
	const [left, setLeft] = createSignal(0); // horizontal scroll offset, mirrored into the header
	const listQuery = createMemo(() => ({ ...store.query(), fields: layout.fieldsParam() || undefined }));
	loadSchema();

	// ---- expanded children -------------------------------------------------------------------------
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
	const kidsMap = new Map<string, ChildSummary[]>(); // parent key -> children (plain map + version signal: cheap bulk loads)
	const [kidsV, setKidsV] = createSignal(0);
	const [focusChild, setFocusChild] = createSignal<{ parentKey: string; key: string } | null>(null);

	/** Expanded parents that are loaded and have children, in list order, with the virtual index where each starts. */
	const ins = createMemo<Ins[]>(() => {
		const ex = expanded();
		kidsV();
		if (!ex.size) return [];
		const km = list.keyMap();
		const arr: Ins[] = [];
		for (const key of ex) {
			const c = kidsMap.get(key), i = km.get(key);
			if (c?.length && i !== undefined) arr.push({ itemIndex: i, key, count: c.length, start: 0, endCum: 0 });
		}
		arr.sort((a, b) => a.itemIndex - b.itemIndex);
		let cum = 0;
		for (const e of arr) { e.start = e.itemIndex + cum; cum += e.count; e.endCum = cum; }
		return arr;
	});
	const totalRows = () => list.total() + (ins().at(-1)?.endCum ?? 0);

	/** Virtual row index -> item row or child row. */
	function rowAt(v: number): RowRef {
		const a = ins();
		let lo = 0, hi = a.length - 1, j = -1;
		while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].start <= v) { j = m; lo = m + 1; } else hi = m - 1; }
		if (j < 0) return { kind: "item", i: v };
		const e = a[j];
		if (v === e.start) return { kind: "item", i: e.itemIndex };
		if (v <= e.start + e.count) { const ci = v - e.start - 1; return { kind: "child", e, ci, c: kidsMap.get(e.key)![ci] }; }
		return { kind: "item", i: v - e.endCum };
	}
	/** Item index -> virtual row index. */
	function vOfItem(i: number): number {
		const a = ins();
		let lo = 0, hi = a.length;
		while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].itemIndex < i) lo = m + 1; else hi = m; }
		return i + (lo ? a[lo - 1].endCum : 0);
	}

	let active = 0;
	const queue: string[] = [];
	const pending = new Set<string>();
	function pump() {
		while (active < 8 && queue.length) {
			const key = queue.shift()!;
			const rev = store.itemsRev();
			active++;
			getDetail(key)
				.then((d) => { if (rev === store.itemsRev() && expanded().has(key)) { kidsMap.set(key, d.children); setKidsV((n) => n + 1); } })
				.catch((e) => toast.error("Could not load attachments", { description: errMsg(e), id: "children-error" }))
				.finally(() => { active--; pending.delete(key); pump(); });
		}
	}
	function loadKids(key: string) {
		if (kidsMap.has(key) || pending.has(key)) return;
		pending.add(key); queue.push(key); pump();
	}

	const parentIndex = (key: string) => list.keyMap().get(key) ?? -1;
	function selectParent(key: string) {
		setFocusChild(null);
		const i = parentIndex(key);
		store.selectOnly(key, i);
		if (i >= 0) v.scrollToIndex(vOfItem(i), { align: "auto" });
	}
	function expand(key: string) {
		if (expanded().has(key)) return;
		setExpanded((s) => new Set(s).add(key));
		loadKids(key);
	}
	function collapse(key: string) {
		if (!expanded().has(key)) return;
		setExpanded((s) => { const n = new Set(s); n.delete(key); return n; });
		if (focusChild()?.parentKey === key) selectParent(key);
	}
	function expandAll() {
		const keys: string[] = [];
		for (const [key, i] of list.keyMap()) { const it = list.get(i); if (it && hasKids(it)) keys.push(key); }
		setExpanded(new Set(keys));
		keys.forEach(loadKids);
	}
	function collapseAll() {
		const fc = focusChild();
		setExpanded(new Set<string>());
		if (fc) selectParent(fc.parentKey);
	}

	const v = createVirtualizer({
		get count() { return totalRows(); },
		getScrollElement: () => scroller,
		estimateSize: () => ROW,
		overscan: 12,
	});

	onMount(() => {
		const ro = new ResizeObserver(() => setSbw(scroller.offsetWidth - scroller.clientWidth));
		ro.observe(scroller);
		tableOps = { expandAll, collapseAll, has: (t) => t instanceof Node && scroller.contains(t) };
		// fallback when another handler consumed the key first: the global shortcut dispatches these for collections
		const onExpand = () => { if (scroller.contains(document.activeElement)) expandAll(); };
		const onCollapse = () => { if (scroller.contains(document.activeElement)) collapseAll(); };
		window.addEventListener("zn:collections-expand-all", onExpand);
		window.addEventListener("zn:collections-collapse-all", onCollapse);
		onCleanup(() => {
			ro.disconnect();
			tableOps = null;
			window.removeEventListener("zn:collections-expand-all", onExpand);
			window.removeEventListener("zn:collections-collapse-all", onCollapse);
		});
	});

	// A new query (view, filter, sort, tag) or a data change starts over from the top...
	createEffect(on(() => [store.query(), store.itemsRev()], () => {
		list.reset(untrack(listQuery));
		scroller?.scrollTo({ top: 0 });
		store.selectOnly(null);
		setFocusChild(null);
	}));
	// ...a different query also collapses everything; a data change reloads the children of the expanded rows.
	createEffect(on(() => store.query(), () => {
		setExpanded(new Set<string>()); kidsMap.clear(); queue.length = 0; pending.clear(); setKidsV((n) => n + 1);
	}, { defer: true }));
	createEffect(on(() => store.itemsRev(), () => {
		kidsMap.clear(); queue.length = 0; pending.clear(); setKidsV((n) => n + 1);
		for (const k of untrack(expanded)) loadKids(k);
	}, { defer: true }));
	// ...whereas changing the visible columns only refetches the pages in view (selection and scroll stay).
	createEffect(on(() => layout.fieldsParam(), () => list.reset(untrack(listQuery)), { defer: true }));
	createEffect(() => {
		list.epoch();
		for (const r of v.getVirtualItems()) { const x = rowAt(r.index); if (x.kind === "item") list.ensure(x.i); }
	});
	createEffect(on(list.error, (e) => { if (e) toast.error("Could not load items", { description: e, id: "items-error" }); }));

	const parentOf = (key: string) => ({ key, title: list.get(parentIndex(key))?.title ?? "" });

	function selectChild(cr: ChildRef) {
		setFocusChild({ parentKey: cr.e.key, key: cr.c.key });
		store.setSelected(new Set([cr.c.key]));
		store.setActiveKey(cr.e.key);
		store.setAnchor(cr.e.itemIndex);
		store.setFocusIndex(cr.e.itemIndex);
	}
	const click = (e: MouseEvent, index: number) => {
		const had = focusChild();
		setFocusChild(null);
		selectClick(list, index, had ? { shift: false, ctrl: false } : { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
	};

	function currentV(): number {
		const fc = focusChild();
		if (fc) {
			const e = ins().find((x) => x.key === fc.parentKey);
			const ci = kidsMap.get(fc.parentKey)?.findIndex((c) => c.key === fc.key) ?? -1;
			if (e && ci >= 0) return e.start + 1 + ci;
		}
		const fi = store.focusIndex();
		return fi < 0 ? -1 : vOfItem(fi);
	}

	function move(delta: number, extend: boolean) {
		const hadChild = !!focusChild();
		const next = Math.max(0, Math.min(totalRows() - 1, currentV() + delta));
		const row = rowAt(next);
		if (row.kind === "child") { selectChild(row); v.scrollToIndex(next, { align: "auto" }); return; }
		setFocusChild(null);
		if (!focusRow(list, row.i, extend && !hadChild)) { v.scrollToIndex(next); return; }
		v.scrollToIndex(next, { align: "auto" });
	}

	function openFocused() {
		const fc = focusChild();
		if (fc) {
			const c = kidsMap.get(fc.parentKey)?.find((x) => x.key === fc.key);
			if (c) void openChild(parentOf(fc.parentKey), c);
			return;
		}
		const it = list.get(store.focusIndex());
		if (it) store.openSummary(it);
	}

	function onKey(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === "ArrowDown") { e.preventDefault(); move(1, e.shiftKey); }
		else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, e.shiftKey); }
		else if (e.key === "PageDown") { e.preventDefault(); move(15, false); }
		else if (e.key === "PageUp") { e.preventDefault(); move(-15, false); }
		else if (e.key === "Home") { e.preventDefault(); move(-1e9, false); }
		else if (e.key === "End") { e.preventDefault(); move(1e9, false); }
		else if (e.key === "ArrowRight") {
			e.preventDefault();
			const it = focusChild() ? undefined : list.get(store.focusIndex());
			if (it && hasKids(it)) { if (!expanded().has(it.key)) expand(it.key); else move(1, false); }
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			const fc = focusChild();
			if (fc) return selectParent(fc.parentKey);
			const it = list.get(store.focusIndex());
			if (it && expanded().has(it.key)) collapse(it.key);
		} else if (e.key === "Enter") { e.preventDefault(); openFocused(); }
	}

	function onContextMenu(e: MouseEvent) {
		const idx = (e.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
		if (idx === undefined) return e.preventDefault();
		const row = rowAt(+idx);
		if (row.kind === "child") {
			if (!store.selected().has(row.c.key)) selectChild(row);
			setCtx(null);
			setCtxChild({ parent: parentOf(row.e.key), child: row.c });
			return;
		}
		const it = list.get(row.i);
		if (!it) return e.preventDefault(); // blank area / placeholder row: no menu
		if (!store.selected().has(it.key)) { setFocusChild(null); store.selectOnly(it.key, row.i); }
		setCtxChild(null);
		setCtx(it);
	}

	const dragStart = (e: DragEvent, index: number) => startItemDrag(list, e, index);

	const rowWidth = () => layout.total() + "px";

	/** One body cell; text columns truncate and show their full value as a tooltip. */
	const Cell: Component<{ col: Column; item: ItemSummary }> = (cp) => {
		const text = () => cp.col.get(cp.item);
		const open = () => expanded().has(cp.item.key);
		return (
			<Switch fallback={
				<div role="gridcell" class={cn("min-w-0 truncate px-2", alignCls(cp.col), (cp.col.id === "dateAdded" || cp.col.id === "year") && "tabular-nums opacity-70")} title={text() || undefined}>{text()}</div>
			}>
				<Match when={cp.col.id === "title"}>
					<div role="gridcell" class="flex min-w-0 items-center gap-1.5 px-2" title={cp.item.title}>
						<Show when={hasKids(cp.item)} fallback={<span class="size-4 flex-none" />}>
							<button type="button" tabindex="-1" aria-label={open() ? "Collapse" : "Expand"} aria-expanded={open()} data-twisty
								class="inline-flex size-4 flex-none items-center justify-center rounded-sm hover:bg-foreground/15"
								onClick={(e) => { e.stopPropagation(); open() ? collapse(cp.item.key) : expand(cp.item.key); }}
								onDblClick={(e) => e.stopPropagation()}>
								<ChevronRight class={cn("size-3.5 transition-transform", open() && "rotate-90")} />
							</button>
						</Show>
						<Dynamic component={itemTypeIcon(cp.item.itemType)} class="size-3.5 flex-none opacity-60" />
						<span class="truncate">{cp.item.title || "(untitled)"}</span>
					</div>
				</Match>
				<Match when={cp.col.id === "attachments"}>
					<div role="gridcell" class="flex h-full items-center justify-center">
						<Show when={cp.item.attachmentCount}>
							<AttachmentMenu item={cp.item} title={cp.item.primaryAttachment?.contentType ?? "Attachments"}
								class="inline-flex size-6 items-center justify-center rounded hover:bg-foreground/15 data-[expanded]:bg-foreground/15">
								<Dynamic component={attachmentIcon(cp.item.primaryAttachment?.contentType, cp.item.primaryAttachment ? null : "linked_url")} class="size-3.5 opacity-70" />
							</AttachmentMenu>
						</Show>
					</div>
				</Match>
			</Switch>
		);
	};

	const rowCls = (index: number, selected: boolean, focused: boolean) =>
		cn("absolute inset-x-0 top-0 grid h-[26px] select-none items-center hover:bg-accent",
			index % 2 === 1 && "bg-muted/50",
			selected && "bg-primary/15 hover:bg-primary/20 group-focus-within/list:bg-primary group-focus-within/list:text-primary-foreground group-focus-within/list:hover:bg-primary",
			focused && "outline-1 -outline-offset-1 outline-ring/60");

	const ItemRow: Component<{ r: VirtualItem; i: number }> = (rp) => {
		const it = () => list.get(rp.i);
		const selected = () => !!it() && store.selected().has(it()!.key);
		return (
			<div data-index={rp.r.index} role="row" aria-rowindex={rp.r.index + 2} aria-selected={selected()}
				aria-expanded={it() && hasKids(it()!) ? expanded().has(it()!.key) : undefined}
				class={rowCls(rp.r.index, selected(), store.focusIndex() === rp.i && !focusChild())}
				style={{ transform: `translateY(${rp.r.start}px)`, "grid-template-columns": gridCols() }}
				draggable={!!it()} onDragStart={(e) => dragStart(e, rp.i)}
				onClick={(e) => click(e, rp.i)}
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
	};

	const ChildRow: Component<{ r: VirtualItem; cr: ChildRef }> = (rp) => {
		const selected = () => store.selected().has(rp.cr.c.key);
		return (
			<div data-index={rp.r.index} data-child={rp.cr.c.key} role="row" aria-level={2} aria-rowindex={rp.r.index + 2} aria-selected={selected()}
				class={rowCls(rp.r.index, selected(), focusChild()?.key === rp.cr.c.key)}
				style={{ transform: `translateY(${rp.r.start}px)`, "grid-template-columns": gridCols() }}
				draggable={false} onDragStart={(e) => e.preventDefault()}
				onClick={() => selectChild(rp.cr)}
				onDblClick={() => void openChild(parentOf(rp.cr.e.key), rp.cr.c)}>
				<For each={layout.columns()}>{(col) => col.id === "title" ? (
					<div role="gridcell" class="flex min-w-0 items-center gap-1.5 px-2" title={childLabel(rp.cr.c)}>
						<span class="w-4 flex-none" /><span class="w-4 flex-none" />
						<Dynamic component={childIcon(rp.cr.c)} class="size-3.5 flex-none opacity-60" />
						<span class="truncate">{childLabel(rp.cr.c)}</span>
					</div>
				) : <div role="gridcell" />}</For>
			</div>
		);
	};

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div role="grid" aria-label="Items" aria-multiselectable="true" aria-rowcount={totalRows() + 1} aria-colcount={layout.ids().length}
				class="flex min-h-0 flex-1 flex-col">
			<HeaderRow sbw={sbw()} left={left()} />
			<ContextMenu onOpenChange={(o) => { if (!o) { setCtx(null); setCtxChild(null); } }}>
				<ContextMenuTrigger as="div" ref={scroller} role="rowgroup" tabindex="0" onKeyDown={onKey} onContextMenu={onContextMenu}
					onScroll={() => setLeft(scroller.scrollLeft)} data-itemlist
					class="group/list relative min-h-0 flex-1 overflow-auto outline-none">
					<div role="presentation" style={{ height: v.getTotalSize() + "px", position: "relative", width: rowWidth(), "min-width": "100%" }}>
						<For each={v.getVirtualItems()}>{(r) => {
							const ref = createMemo(() => rowAt(r.index));
							const itemIdx = createMemo(() => { const x = ref(); return x.kind === "item" ? x.i : -1; });
							const child = createMemo(() => { const x = ref(); return x.kind === "child" ? x : null; });
							return (
								<Show when={child()} fallback={<ItemRow r={r} i={itemIdx()} />}>
									{(cr) => <ChildRow r={r} cr={cr()} />}
								</Show>
							);
						}}</For>
					</div>
					<Show when={list.total() === 0 && !list.loading()}>
						<div class="sticky left-0 p-6 text-center text-muted-foreground">No items</div>
					</Show>
				</ContextMenuTrigger>
				<ContextMenuContent class="max-h-[85vh] w-72 overflow-y-auto">
					<Show when={ctxChild()}>{(c) => <ChildMenuItems parent={c().parent} child={c().child} />}</Show>
					<Show when={ctx()}>{(it) => <ItemMenuItems item={it()} />}</Show>
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

/** The item list in the chosen view mode (table or cards); both read the shared itemList cache. */
export const ItemTable: Component = () => (
	<Show when={store.viewMode() === "cards"} fallback={<TableView />}>
		<CardList list={itemList} />
	</Show>
);

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
