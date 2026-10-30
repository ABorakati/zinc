import { createEffect, createMemo, createSignal, For, on, Show, untrack, type Component } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ChevronDown } from "lucide-solid";
import { toast } from "solid-sonner";
import { store } from "../store";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "~/components/ui/context-menu";
import { loadSchema } from "../columns/defs";
import { createGroupedRows, type Group } from "../groups";
import { SortBar } from "../SortBar";
import type { ItemSummary } from "../api";
import { Card } from "./Card";
import { CustomizeRows } from "./Customize";
import { cardLayout } from "./layout";
import { focusRow, ItemMenuItems, selectClick, startItemDrag, type ItemListHandle } from "./shared";
import { loadTagColors } from "./tags";

const HEADER_H = 40;

export const CardList: Component<{ list: ItemListHandle }> = (props) => {
	let scroller!: HTMLDivElement;
	const list = props.list;
	const [ctx, setCtx] = createSignal<ItemSummary | null>(null);
	const L = cardLayout.layout;
	const rows = createGroupedRows(list.total);
	const listQuery = createMemo(() => ({
		...store.query(),
		fields: cardLayout.fieldsParam() || undefined,
		include: cardLayout.includeParam() || undefined,
	}));
	loadSchema();
	loadTagColors();

	const estimate = () => {
		const compact = L().density === "compact";
		return compact ? 78 : 104 + (L().creators !== "off" ? 0 : -18);
	};

	const v = createVirtualizer({
		get count() { return rows.count(); },
		getScrollElement: () => scroller,
		estimateSize: (i) => (rows.row(i).kind === "header" ? HEADER_H : estimate()),
		overscan: 6,
		gap: 0,
	});

	// A new query (view, filter, sort, tag) or a data change starts over from the top...
	createEffect(on(() => [store.query(), store.itemsRev()], () => {
		list.reset(untrack(listQuery));
		scroller?.scrollTo({ top: 0 });
		store.selectOnly(null);
	}));
	// ...whereas changing what the cards show only refetches the pages in view (selection and scroll stay).
	createEffect(on(() => [cardLayout.fieldsParam(), cardLayout.includeParam()], () => list.reset(untrack(listQuery)), { defer: true }));
	const remeasure = () => {
		v.measure();
		// the mounted rows keep their elements, so measure them again once the new layout has rendered
		requestAnimationFrame(() => scroller?.querySelectorAll<HTMLElement>("[data-index]").forEach((el) => v.measureElement(el)));
	};
	// Row heights depend on the layout: forget the measured ones.
	createEffect(on(() => JSON.stringify(L()), remeasure, { defer: true }));
	// Row -> content mapping changes with the groups (and collapsing): the cached sizes belong to other rows now.
	createEffect(on(() => [rows.grouped(), rows.count(), rows.groups().map((g) => rows.isCollapsed(g)).join()] as const, remeasure, { defer: true }));
	createEffect(() => {
		list.epoch();
		for (const r of v.getVirtualItems()) {
			const row = rows.row(r.index);
			if (row.kind === "item") list.ensure(row.index);
		}
	});
	createEffect(on(list.error, (e) => { if (e) toast.error("Could not load items", { description: e, id: "items-error" }); }));

	/** Move the focus by `delta` items (in item index space), skipping items hidden in collapsed groups. */
	function move(delta: number, extend: boolean) {
		const last = list.total() - 1;
		const dir = delta < 0 ? -1 : 1;
		let next = Math.max(0, Math.min(last, (store.focusIndex() < 0 ? -1 : store.focusIndex()) + delta));
		while (next >= 0 && next <= last && rows.rowOf(next) < 0) next += dir;
		if (next < 0 || next > last) return;
		const row = rows.rowOf(next);
		if (!focusRow(list, next, extend)) { v.scrollToIndex(row); return; }
		v.scrollToIndex(row, { align: "auto" });
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") { e.preventDefault(); move(1, e.shiftKey); }
		else if (e.key === "ArrowUp") { e.preventDefault(); move(-1, e.shiftKey); }
		else if (e.key === "PageDown") { e.preventDefault(); move(5, false); }
		else if (e.key === "PageUp") { e.preventDefault(); move(-5, false); }
		else if (e.key === "Home") { e.preventDefault(); move(-1e9, false); }
		else if (e.key === "End") { e.preventDefault(); move(1e9, false); }
		else if (e.key === " ") {
			e.preventDefault();
			if (store.focusIndex() >= 0) selectClick(list, store.focusIndex(), { shift: false, ctrl: true });
		} else if (e.key === "Enter") {
			const it = list.get(store.focusIndex());
			if (it) store.openSummary(it);
		}
	}

	function onContextMenu(e: MouseEvent) {
		const idx = (e.target as HTMLElement).closest<HTMLElement>("[data-item]")?.dataset.item;
		const it = idx === undefined ? undefined : list.get(+idx);
		if (!it) return e.preventDefault(); // blank area / header / placeholder row: no menu
		if (!store.selected().has(it.key)) store.selectOnly(it.key, +idx!);
		setCtx(it);
	}

	return (
		<div class="flex min-h-0 flex-1 flex-col bg-card">
			<SortBar total={list.total()} loading={list.loading()} trailing={<CustomizeRows />} />
			<ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
				<ContextMenuTrigger as="div" ref={scroller} role="listbox" aria-label="Items" aria-multiselectable="true" tabindex="0"
					onKeyDown={onKey} onContextMenu={onContextMenu}
					class="group/list relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-card outline-none" data-testid="cards-scroller">
					<div role="presentation" style={{ height: v.getTotalSize() + "px", position: "relative", width: "100%" }}>
						<For each={v.getVirtualItems()}>{(r) => {
							const row = () => rows.row(r.index);
							return (
								<Show when={row()} keyed>{(rw) => rw.kind === "header"
									? <GroupHeader index={r.index} start={r.start} group={rw.group} collapsed={rows.isCollapsed(rw.group)} onToggle={() => rows.toggle(rw.group)} measure={(el) => v.measureElement(el)} />
									: <ItemRow index={r.index} start={r.start} item={rw.index} list={list} measure={(el) => v.measureElement(el)} />
								}</Show>
							);
						}}</For>
					</div>
					<Show when={list.total() === 0 && !list.loading()}>
						<div class="p-10 text-center text-muted-foreground">No items</div>
					</Show>
				</ContextMenuTrigger>
				<ContextMenuContent class="max-h-[85vh] w-72 overflow-y-auto">
					<Show when={ctx()}>{(it) => <ItemMenuItems item={it()} />}</Show>
				</ContextMenuContent>
			</ContextMenu>
		</div>
	);
};

const GroupHeader: Component<{
	index: number; start: number; group: Group; collapsed: boolean; onToggle: () => void; measure: (el: HTMLElement) => void;
}> = (p) => (
	<div data-index={p.index} role="presentation" ref={(el) => queueMicrotask(() => p.measure(el))}
		class="absolute inset-x-0 top-0 z-[1] select-none" style={{ transform: `translateY(${p.start}px)` }}>
		<button type="button" tabindex="-1" aria-expanded={!p.collapsed} aria-label={`${p.group.label}, ${p.group.count} items`}
			class="flex w-full items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3 text-left"
			onClick={p.onToggle} onDblClick={(e) => e.stopPropagation()}>
			<span class="font-title text-base font-semibold text-primary-deep">{p.group.label}</span>
			<span class="rounded-full bg-primary/10 px-2 py-px text-[11.5px] font-medium tabular-nums text-primary">{p.group.count.toLocaleString()}</span>
			<ChevronDown class={cn("ml-auto size-4 text-muted-foreground transition-transform", p.collapsed && "-rotate-90")} aria-hidden="true" />
		</button>
	</div>
);

const ItemRow: Component<{ index: number; start: number; item: number; list: ItemListHandle; measure: (el: HTMLElement) => void }> = (p) => {
	const it = () => p.list.get(p.item);
	const selected = () => !!it() && store.selected().has(it()!.key);
	return (
		<div data-index={p.index} data-item={p.item} role="option" aria-selected={selected()} ref={(el) => queueMicrotask(() => p.measure(el))}
			class="absolute inset-x-0 top-0 select-none px-2.5"
			style={{ transform: `translateY(${p.start}px)` }}
			draggable={!!it()} onDragStart={(e) => startItemDrag(p.list, e, p.item)}
			onClick={(e) => selectClick(p.list, p.item, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
			onDblClick={() => { const x = it(); if (x) store.openSummary(x); }}>
			<Show when={it()} fallback={<CardSkeleton />}>
				{(x) => <Card item={x()} index={p.item} list={p.list} selected={selected()} focused={store.focusIndex() === p.item} />}
			</Show>
		</div>
	);
};

const CardSkeleton: Component = () => (
	<div class={cn("flex gap-3 border-b border-border/60 px-2.5 py-2.5", cardLayout.layout().density === "compact" && "py-1.5")}>
		<Skeleton class="mt-0.5 size-[18px] rounded-[5px]" />
		<div class="flex-1 space-y-2">
			<Skeleton class="h-4 w-4/5" />
			<Skeleton class="h-3 w-1/2" />
			<Skeleton class="h-7 w-1/3" />
		</div>
	</div>
);
