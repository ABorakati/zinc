import { createEffect, createMemo, createSignal, For, on, Show, untrack, type Component } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-solid";
import { toast } from "solid-sonner";
import { store } from "../store";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "~/components/ui/context-menu";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
	DropdownMenuSeparator, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { labelOf, loadSchema, moreColumns } from "../columns/defs";
import type { ItemSummary } from "../api";
import { Card } from "./Card";
import { CustomizeRows } from "./Customize";
import { cardLayout } from "./layout";
import { focusRow, ItemMenuItems, selectClick, startItemDrag, type ItemListHandle } from "./shared";
import { loadTagColors } from "./tags";

const SORT_OPTIONS = [
	{ key: "title", label: "Title" },
	{ key: "creator", label: "Author" },
	{ key: "year", label: "Year" },
	{ key: "dateAdded", label: "Date Added" },
	{ key: "dateModified", label: "Date Modified" },
	{ key: "itemType", label: "Item Type" },
	{ key: "publication", label: "Publication" },
	{ key: "noteCount", label: "Notes" },
	{ key: "attachmentCount", label: "Attachments" },
];
const sortLabel = (key: string) => SORT_OPTIONS.find((o) => o.key === key)?.label ?? labelOf(key);
const defaultDir = (key: string) => (/^(dateAdded|dateModified|accessDate)$/.test(key) ? "desc" : "asc");

const SortControl: Component = () => {
	const s = store.sort;
	const known = new Set(SORT_OPTIONS.map((o) => o.key));
	return (
		<div class="inline-flex items-center rounded-md hover:bg-accent/60">
			<Button variant="ghost" size="sm" class="h-7 w-7 px-0" title={s().dir === "asc" ? "Ascending - click to reverse" : "Descending - click to reverse"}
				aria-label="Reverse sort order" onClick={() => store.setSort({ key: s().key, dir: s().dir === "asc" ? "desc" : "asc" })}>
				{s().dir === "asc" ? <ArrowUp /> : <ArrowDown />}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger as={Button} variant="ghost" size="sm" class="-ml-1 h-7 gap-1 px-1.5 text-xs font-medium" aria-label="Sort by">
					{sortLabel(s().key)} <ChevronDown class="!size-3 opacity-60" />
				</DropdownMenuTrigger>
				<DropdownMenuContent class="max-h-[70vh] w-52 overflow-y-auto">
					<DropdownMenuLabel>Sort by</DropdownMenuLabel>
					<DropdownMenuRadioGroup value={s().key} onChange={(key) => store.setSort({ key, dir: defaultDir(key) })}>
						<For each={SORT_OPTIONS}>{(o) => <DropdownMenuRadioItem value={o.key}>{o.label}</DropdownMenuRadioItem>}</For>
						<Show when={moreColumns().length}>
							<DropdownMenuSeparator />
							<DropdownMenuLabel class="text-xs text-muted-foreground">More fields</DropdownMenuLabel>
							<For each={moreColumns().filter((c) => !known.has(c.id))}>{(c) => <DropdownMenuRadioItem value={c.id}>{c.label}</DropdownMenuRadioItem>}</For>
						</Show>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
};

export const CardList: Component<{ list: ItemListHandle }> = (props) => {
	let scroller!: HTMLDivElement;
	const list = props.list;
	const [ctx, setCtx] = createSignal<ItemSummary | null>(null);
	const L = cardLayout.layout;
	const listQuery = createMemo(() => ({
		...store.query(),
		fields: cardLayout.fieldsParam() || undefined,
		include: cardLayout.includeParam() || undefined,
	}));
	loadSchema();
	loadTagColors();

	const estimate = () => {
		const l = L();
		const compact = l.density === "compact";
		return (compact ? 14 : 30) + (compact ? 20 : 24) + (l.creators !== "off" ? (compact ? 18 : 22) : 0) + (compact ? 20 : 24) + (l.icons && !compact ? 30 : 0) + 8;
	};

	const v = createVirtualizer({
		get count() { return list.total(); },
		getScrollElement: () => scroller,
		estimateSize: estimate,
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
	// Row heights depend on the layout: forget the measured ones.
	createEffect(on(() => JSON.stringify(L()), () => {
		v.measure();
		// the mounted rows keep their elements, so measure them again once the new layout has rendered
		requestAnimationFrame(() => scroller?.querySelectorAll<HTMLElement>("[data-index]").forEach((el) => v.measureElement(el)));
	}, { defer: true }));
	createEffect(() => { list.epoch(); for (const r of v.getVirtualItems()) list.ensure(r.index); });
	createEffect(on(list.error, (e) => { if (e) toast.error("Could not load items", { description: e, id: "items-error" }); }));

	function move(delta: number, extend: boolean) {
		const next = Math.max(0, Math.min(list.total() - 1, (store.focusIndex() < 0 ? -1 : store.focusIndex()) + delta));
		if (!focusRow(list, next, extend)) { v.scrollToIndex(next); return; }
		v.scrollToIndex(next, { align: "auto" });
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
		const idx = (e.target as HTMLElement).closest<HTMLElement>("[data-index]")?.dataset.index;
		const it = idx === undefined ? undefined : list.get(+idx);
		if (!it) return e.preventDefault(); // blank area / placeholder row: no menu
		if (!store.selected().has(it.key)) store.selectOnly(it.key, +idx!);
		setCtx(it);
	}

	const selCount = () => store.selected().size;

	return (
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="flex flex-none items-center justify-end gap-2 border-b bg-card px-3 py-1" data-testid="cards-header">
				<SortControl />
				<span class="text-xs tabular-nums text-muted-foreground" data-testid="cards-count">
					{list.total().toLocaleString()} {list.total() === 1 ? "reference" : "references"}
					<Show when={selCount() > 0}> · {selCount().toLocaleString()} selected</Show>
					<Show when={list.loading()}> · loading…</Show>
				</span>
				<CustomizeRows />
			</div>
			<ContextMenu onOpenChange={(o) => !o && setCtx(null)}>
				<ContextMenuTrigger as="div" ref={scroller} role="listbox" aria-label="Items" aria-multiselectable="true" tabindex="0"
					onKeyDown={onKey} onContextMenu={onContextMenu}
					class="group/list relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-background outline-none" data-testid="cards-scroller">
					<div role="presentation" style={{ height: v.getTotalSize() + "px", position: "relative", width: "100%" }}>
						<For each={v.getVirtualItems()}>{(r) => {
							const it = () => list.get(r.index);
							const selected = () => !!it() && store.selected().has(it()!.key);
							return (
								<div data-index={r.index} role="option" aria-selected={selected()} ref={(el) => queueMicrotask(() => v.measureElement(el))}
									class="absolute inset-x-0 top-0 select-none px-3 py-[3px]"
									style={{ transform: `translateY(${r.start}px)` }}
									draggable={!!it()} onDragStart={(e) => startItemDrag(list, e, r.index)}
									onClick={(e) => selectClick(list, r.index, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })}
									onDblClick={() => { const x = it(); if (x) store.openSummary(x); }}>
									<Show when={it()} fallback={<CardSkeleton />}>
										{(x) => <Card item={x()} index={r.index} list={list} selected={selected()} focused={store.focusIndex() === r.index} />}
									</Show>
								</div>
							);
						}}</For>
					</div>
					<Show when={list.total() === 0 && !list.loading()}>
						<div class="p-10 text-center text-muted-foreground">No items</div>
					</Show>
				</ContextMenuTrigger>
				<ContextMenuContent class="w-56">
					<Show when={ctx()}>{(it) => <ItemMenuItems item={it()} />}</Show>
				</ContextMenuContent>
			</ContextMenu>
		</div>
	);
};

const CardSkeleton: Component = () => (
	<div class={cn("flex gap-3 rounded-lg border bg-card px-3.5 py-3", cardLayout.layout().density === "compact" && "py-2")}>
		<Skeleton class="mt-0.5 size-[18px] rounded-[5px]" />
		<div class="flex-1 space-y-2">
			<Skeleton class="h-4 w-4/5" />
			<Skeleton class="h-3 w-1/2" />
			<Skeleton class="h-3 w-1/3" />
		</div>
	</div>
);
