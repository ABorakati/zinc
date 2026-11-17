// The library list. `CardList` picks what fills the list card (ui/src/App.tsx + ItemTable.tsx): the full-text search results, the
// Classic table or the cards (List view). The cards are a windowed GPUIX <virtual-list> of group headers and item cards
// (ui/src/cards/CardList.tsx): the list holds every row logically (itemCount) but only a window of WINDOW rows is mounted; the
// window follows onVisibleRange. Item rows read store.itemAt(i), which fetches the page on demand (a skeleton shows meanwhile).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import { dragSource } from "../dnd";
import { Icon } from "../icons";
import { REVEAL_SETTLE_MS, stats, store } from "../store";
import { TableView } from "../table/Table";
import { loadSchema } from "../table/defs";
import { textStyle, tw } from "../theme";
import { Button } from "../ui";
import { openItem } from "./actions";
import { Card, tok } from "./Card";
import { modsOf, swallowed } from "./click";
import { focusList, listFocused, listKeyHandler, registerListFocus, setListFocused } from "./keys";
import { cardLayout, cardListWidth as cardListWidthNow, setCardListWidth } from "./layout";
import { ListRetry } from "./ListRetry";
import { loadTagColors } from "./logic";
import { openItemMenu } from "./menus";
import { CardChildRow } from "./ChildRow";
import { hasChildren, isOpen, selectedChild } from "./children";
import { createRows, sameRow, type Group, type Rows } from "./rows";
import { createTree, toggleItem } from "./tree";
import { markScroll, throttledCommit } from "./scrolling";
import { SearchResults } from "./SearchResults";

/** Rows mounted at once. */
export const WINDOW = 40;

/** Year header: `flex w-full items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3` + serif label + count pill + chevron. */
export function GroupHeader(p: { group: Group; collapsed: boolean; onToggle: () => void }): JSX.Element {
	const m = () => store.mode();
	return (
		<div
			onClick={() => p.onToggle()}
			style={{
				...tw(
					"flex w-full flex-none items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3 cursor-pointer",
					m(),
				),
			}}
		>
			{/* 16.7px instead of text-base (16px): same serif optical-size compensation as the card titles */}
			<text style={{ ...textStyle("select-none font-title text-base font-semibold text-primary-deep", m()), fontSize: 16.7 }}>
				{p.group.label}
			</text>
			<div style={tw("flex items-center rounded-full bg-primary/10 px-2 py-px", m())}>
				<text style={textStyle("select-none text-[11.5px] font-medium tabular-nums text-primary", m())}>
					{p.group.count.toLocaleString("en-US")}
				</text>
			</div>
			<div style={{ flexGrow: 1 }} />
			<Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={16} color={tok("muted-foreground", m())} />
		</div>
	);
}

/** CardSkeleton: icon block + three bars (bg-primary/10), the paddings of a card. */
function CardSkeleton(): JSX.Element {
	const m = () => store.mode();
	const bar = (cls: string) => tw(`bg-primary/10 rounded ${cls}`, m());
	return (
		<div style={tw("flex gap-3 border-b border-border/60 px-2.5 py-2.5", m())}>
			<div style={{ ...bar("size-[18px] mt-0.5 mx-0.5 flex-none"), borderRadius: 5 }} />
			<div style={tw("flex flex-1 flex-col gap-2 min-w-0", m())}>
				<div style={bar("h-4 w-4/5")} />
				<div style={bar("h-3 w-1/2")} />
				<div style={bar("h-7 w-1/3")} />
			</div>
		</div>
	);
}

function ItemRowView(p: { index: number }): JSX.Element {
	const item = createMemo(() => store.itemAt(p.index));
	// no JS hover here: the card's hover wash and buttons use GPUI's native hover (see Card.tsx), which neither flickers over
	// children nor commits anything while the list scrolls
	const src = dragSource(
		() => {
			const it = untrack(item);
			return it ? store.keysFor(it.key) : [];
		},
		() => {
			const it = untrack(item);
			if (it && !store.selected().has(it.key)) store.selectOnly(it.key, p.index);
		},
	);
	return (
		<div
			style={tw("flex flex-col w-full flex-none px-2.5", store.mode())}
			onMouseDown={src.onMouseDown}
			onMouseMove={src.onMouseMove}
			onMouseUp={src.onMouseUp}
			onClick={(e: EventPayload) => {
				if (swallowed() || src.wasDrag()) return;
				const it = untrack(item);
				if (!it) return;
				setListFocused(true);
				focusList(); // the arrow keys now move from this card
				const mods = modsOf(e);
				store.selectClick(p.index, mods);
				if ((e.clickCount ?? 1) >= 2 && !mods.shift && !mods.ctrl) void openItem(it); // double-click opens the PDF in a reader tab
			}}
			onAuxClick={(e: EventPayload) => {
				if (!(e.isRightClick || e.button === 2)) return;
				const it = untrack(item);
				if (it) openItemMenu({ x: e.x ?? 0, y: e.y ?? 0 }, it, p.index);
			}}
		>
			<Show when={item()} fallback={<CardSkeleton />}>
				{(x) => (
					<Card
						item={x()}
						index={p.index}
						hovered={false}
						focused={listFocused() && store.focusIndex() === p.index && !selectedChild()}
						tree={hasChildren(x()) ? { open: isOpen(x().key), toggle: () => toggleItem(x().key, p.index) } : undefined}
						onMore={(r) => openItemMenu({ x: r.x, y: r.y + r.height }, x(), p.index)}
					/>
				)}
			</Show>
		</div>
	);
}

function RowView(p: { row: number; rows: Rows }): JSX.Element {
	const r = createMemo(() => p.rows.row(p.row), undefined, { equals: sameRow });
	return (
		<Show when={r()} keyed>
			{(rw) =>
				rw.kind === "header" ? (
					<GroupHeader group={rw.group} collapsed={p.rows.isCollapsed(rw.group)} onToggle={() => p.rows.toggle(rw.group)} />
				) : rw.kind === "child" ? (
					<CardChildRow row={rw} />
				) : (
					<ItemRowView index={rw.index} />
				)
			}
		</Show>
	);
}

/** The cards (List view). */
export function CardsView(): JSX.Element {
	const rows = createRows();
	const gpuix = useGpuix();
	let list: { id: number } | undefined;
	const estimate = () => (cardLayout.layout().density === "compact" ? 78 : 104);

	// what the cards show decides which Zotero fields / extras the list requests
	loadSchema();
	loadTagColors();
	createEffect(() => store.setListFields(cardLayout.fieldsParam(), cardLayout.includeParam()));

	const [start, setStart] = createSignal(0);
	const count = () => rows.count();
	const first = createMemo(() => Math.max(0, Math.min(start(), count() - WINDOW)));
	const indices = createMemo(() => {
		const s = first(),
			e = Math.min(count(), s + WINDOW);
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});

	let visA = 0,
		visB = 0;
	/** Item index shown at a row (a header stands for the group's first item). */
	const itemAtRow = (r: number): number => {
		const rw = rows.row(Math.max(0, Math.min(r, count() - 1)));
		return !rw ? 0 : rw.kind === "item" ? rw.index : rw.kind === "child" ? rw.parentIndex : rw.group.start;
	};
	// Keep the mounted window around the visible rows. Moving it is a JS commit (a full, uncached frame), so while scrolling it
	// happens at most every 100 ms, and at once only when the view is about to run off the mounted rows.
	const nearEdge = (rows: number) => {
		const s = untrack(first);
		return (visA < s + rows && s > 0) || visB > s + WINDOW - rows;
	};
	const recentre = throttledCommit(() => {
		if (nearEdge(8)) setStart(Math.max(0, visA - WINDOW / 4));
	}, 100);
	// The group popup: while the list scrolls, a pill beside the scrollbar thumb names the group at the top of the view ("2019").
	// It only commits when its text or (4 px-rounded) position changes, at most every 60 ms, and hides 700 ms after the scroll stops.
	const [bubble, setBubble] = createSignal<{ label: string; top: number } | null>(null);
	let listH = 0,
		quietUntil = 0,
		hideTimer: ReturnType<typeof setTimeout> | undefined;
	let want: { label: string; top: number } | null = null;
	const showBubble = throttledCommit(() => {
		const cur = untrack(bubble);
		if (want && (!cur || cur.label !== want.label || cur.top !== want.top)) setBubble(want);
	}, 60);
	const trackBubble = (a: number, b: number) => {
		const g = rows.groupAt(a);
		if (!g || performance.now() < quietUntil || count() < 40 || listH < 120) return;
		const span = Math.max(1, count() - (b - a)); // rows the top edge can travel over
		const frac = Math.min(1, a / span);
		want = { label: g.label, top: Math.round((14 + frac * (listH - 56)) / 4) * 4 };
		showBubble(false);
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			want = null;
			setBubble(null);
		}, 700);
	};
	onCleanup(() => {
		if (hideTimer) clearTimeout(hideTimer);
	});

	const onVisibleRange = (e: EventPayload) => {
		const t0 = performance.now();
		markScroll();
		const a = Math.floor(e.startIndex ?? 0),
			b = Math.ceil(e.endIndex ?? a + 1);
		if (a !== visA) trackBubble(a, b); // the top row moved: a scroll (not the first layout or a resize)
		visA = a;
		visB = b;
		store.setVisible(itemAtRow(a), itemAtRow(b));
		if (nearEdge(3)) recentre(true);
		else if (nearEdge(8)) recentre(false);
		const d = performance.now() - t0;
		stats.visCalls++;
		stats.visMs += d;
		stats.visMaxMs = Math.max(stats.visMaxMs, d);
	};

	// a new list (view / filter / sort) starts at the top
	createEffect(
		on(
			() => store.listVersion(),
			() => {
				quietUntil = performance.now() + 400; // the jump back to the top is not a scroll: no popup for it
				want = null;
				setBubble(null);
				setStart(0);
				if (list) gpuix?.renderer.scrollToItem?.(list.id, 0);
			},
			{ defer: true },
		),
	);
	// "Open in Zinc" (store.revealItem): scroll the item it selected into view. The list it switched to is still arriving (its row
	// count, then the group headers that move every row down), so follow the count for a moment after the request.
	let revealUntil = 0;
	createEffect(
		on(
			[() => store.scrollRequest(), () => rows.count()],
			([req], prev) => {
				if (!req) return;
				if (req !== prev?.[0]) revealUntil = performance.now() + REVEAL_SETTLE_MS;
				else if (performance.now() > revealUntil) return;
				const r = rows.rowOf(req.index);
				// after this effect: its writes (the window move in reveal) are batched until it ends, and the scroll must follow them
				if (r >= 0 && r < rows.count()) queueMicrotask(() => reveal(r, true));
			},
			{ defer: true },
		),
	);

	/** Scroll so row `r` is on screen (only when it is outside the visible range, unless `always`: the range is the previous list's). */
	function reveal(r: number, always = false) {
		if (r < 0 || !list) return;
		if (!always && r >= visA + 1 && r < visB - 1) return;
		setStart(Math.max(0, r - WINDOW / 2));
		gpuix?.renderer.scrollToItem?.(list.id, r, always || r >= visA ? -300 : 0);
	}
	/** Move the focus by `delta` items, skipping items hidden in collapsed groups. */
	function move(delta: number, extend: boolean) {
		const last = store.total() - 1;
		if (last < 0) return;
		const dir = delta < 0 ? -1 : 1;
		let next = Math.max(0, Math.min(last, (store.focusIndex() < 0 ? (delta > 0 ? -1 : 1) : store.focusIndex()) + delta));
		while (next >= 0 && next <= last && rows.rowOf(next) < 0) next += dir;
		if (next < 0 || next > last) return;
		store.focusRow(next, extend);
		reveal(rows.rowOf(next));
	}
	const tree = createTree({ rows, reveal, visible: () => [visA, visB], moveItems: move });
	const keys = listKeyHandler({
		move: tree.move,
		page: () => Math.max(1, Math.floor((visB - visA) * 0.9)),
		open: () =>
			tree.open(() => {
				const it = store.peek(store.focusIndex());
				if (it) void openItem(it);
			}),
		extra: tree.extra,
		toggle: () => {
			if (store.focusIndex() >= 0) store.selectClick(store.focusIndex(), { shift: false, ctrl: true });
		},
	});
	onMount(() => onCleanup(() => setListFocused(false)));
	let box: { id: number } | undefined;
	onCleanup(registerListFocus(() => box && gpuix?.renderer.focusElement?.(box.id)));

	return (
		<div
			ref={(el: { id: number }) => {
				box = el;
			}}
			tabIndex={0}
			testId="card-list-container"
			onKeyDown={keys}
			onFocus={() => setListFocused(true)}
			onBlur={() => setListFocused(false)}
			onScroll={markScroll}
			onLayout={(e: EventPayload) => {
				listH = e.height ?? listH;
				const w = Math.round(e.width ?? 0);
				if (w !== untrack(cardListWidthNow)) setCardListWidth(w);
			}}
			style={{ ...tw("flex flex-col flex-1 min-h-0 w-full h-full bg-card", store.mode()), keyboardFocusDim: false }}
		>
			<virtual-list
				ref={(el: { id: number }) => {
					list = el;
				}}
				testId="card-list"
				itemCount={count()}
				windowStart={first()}
				estimatedItemHeight={estimate()}
				overdraw={400}
				onVisibleRange={onVisibleRange}
				// the overlaid thumb at the list's right edge (as the sidebar's list); the rows' px-2.5 keeps cards clear of it
				style={{ width: "100%", height: "100%", scrollbarColor: tok("input", store.mode()), scrollbarWidth: 6 }}
			>
				<For each={indices()}>{(i) => <RowView row={i} rows={rows} />}</For>
			</virtual-list>
			<Show when={bubble()}>
				{(bb) => (
					<div
						style={{
							...tw("flex items-center rounded-full bg-primary px-3 py-1 shadow-raised", store.mode()),
							position: "absolute",
							right: 18,
							top: bb().top,
							pointerEvents: "none",
						}}
					>
						<text
							style={{
								...textStyle("select-none font-title text-sm font-semibold", store.mode()),
								color: tok("primary-foreground", store.mode()),
							}}
						>
							{bb().label}
						</text>
					</div>
				)}
			</Show>
			<ListRetry />
			<Show when={count() === 0 && !store.loading()}>
				<div style={tw("flex flex-col absolute top-10 inset-x-0 items-center gap-1", store.mode())}>
					<text style={textStyle("text-muted-foreground", store.mode())}>
						{store.view().kind === "publications" ? "No items in My Publications" : "No items"}
					</text>
					<Show when={store.error()}>
						<text style={textStyle("text-xs text-destructive", store.mode())}>{store.error() ?? ""}</text>
						<Button size="sm" variant="outline" onClick={() => store.retryFailed()}>
							Retry
						</Button>
					</Show>
				</div>
			</Show>
		</div>
	);
}

/**
 * The list card's content: search results with snippets in "Full text" mode, else the Classic table or the cards, per the
 * List / Classic toggle. (ItemTable in ui/src/ItemTable.tsx.)
 */
export function CardList(): JSX.Element {
	return (
		<Show when={!store.fulltext()} fallback={<SearchResults />}>
			<Show when={store.viewMode() === "cards"} fallback={<TableView />}>
				<CardsView />
			</Show>
		</Show>
	);
}
export { CardList as ItemList };
