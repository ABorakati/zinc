// The library list: a windowed GPUIX <virtual-list> of year-group headers and item cards (ui/src/cards/CardList.tsx).
// The list holds every row logically (itemCount) but only a window of WINDOW rows is mounted; the window follows
// onVisibleRange. Item rows read store.itemAt(i), which fetches the page on demand; until it arrives a skeleton shows.
import { createEffect, createMemo, createSignal, For, on, Show, untrack, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tw } from "../theme";
import { Card, tok } from "./Card";
import { createRows, type Group, type Rows } from "./rows";

/** Rows mounted at once, and the logical row height used until a row has been measured. */
export const WINDOW = 40;
const ITEM_ESTIMATE = 104;

/** Year header: `flex w-full items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3` + serif label + count pill + chevron. */
function GroupHeader(p: { group: Group; collapsed: boolean; onToggle: () => void }): JSX.Element {
	const m = () => store.mode();
	return (
		<div onClick={() => p.onToggle()} style={{ ...tw("flex w-full flex-none items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3 cursor-pointer", m()) }}>
			{/* 16.7px instead of text-base (16px): same serif optical-size compensation as the card titles */}
			<text style={{ ...textStyle("font-title text-base font-semibold text-primary-deep", m()), fontSize: 16.7 }}>{p.group.label}</text>
			<div style={tw("flex items-center rounded-full bg-primary/10 px-2 py-px", m())}>
				<text style={textStyle("text-[11.5px] font-medium tabular-nums text-primary", m())}>{p.group.count.toLocaleString("en-US")}</text>
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
	return (
		<div style={tw("flex flex-col w-full flex-none px-2.5", store.mode())}
			onClick={() => { const it = untrack(item); if (it) store.selectItem(it.key); }}>
			<Show when={item()} fallback={<CardSkeleton />}>{(x) => <Card item={x()} index={p.index} />}</Show>
		</div>
	);
}

function RowView(p: { row: number; rows: Rows }): JSX.Element {
	const r = createMemo(() => p.rows.row(p.row));
	return (
		<Show when={r()} keyed>
			{(rw) => rw.kind === "header"
				? <GroupHeader group={rw.group} collapsed={p.rows.isCollapsed(rw.group)} onToggle={() => p.rows.toggle(rw.group)} />
				: <ItemRowView index={rw.index} />}
		</Show>
	);
}

export function CardList(): JSX.Element {
	const rows = createRows();
	const gpuix = useGpuix();
	let list: { id: number } | undefined;

	const [start, setStart] = createSignal(0);
	const count = () => rows.count();
	const first = createMemo(() => Math.max(0, Math.min(start(), count() - WINDOW)));
	const indices = createMemo(() => {
		const s = first(), e = Math.min(count(), s + WINDOW);
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});

	// keep the mounted window around the visible rows (recentre only when the view nears an edge)
	const onVisibleRange = (e: EventPayload) => {
		const a = Math.floor(e.startIndex ?? 0), b = Math.ceil(e.endIndex ?? a + 1);
		const s = untrack(first);
		if ((a < s + 6 && s > 0) || b > s + WINDOW - 6) setStart(Math.max(0, a - WINDOW / 4));
	};

	// a new list (collection / filter) starts at the top
	createEffect(on(() => store.listVersion(), () => {
		setStart(0);
		if (list) gpuix?.renderer.scrollToItem?.(list.id, 0);
	}, { defer: true }));

	return (
		<div style={{ ...tw("flex flex-col flex-1 min-h-0 w-full h-full bg-card", store.mode()) }}>
			<virtual-list
				ref={(el: { id: number }) => { list = el; }}
				testId="card-list"
				itemCount={count()}
				windowStart={first()}
				estimatedItemHeight={ITEM_ESTIMATE}
				overdraw={400}
				onVisibleRange={onVisibleRange}
				style={{ width: "100%", height: "100%" }}>
				<For each={indices()}>{(i) => <RowView row={i} rows={rows} />}</For>
			</virtual-list>
			<Show when={count() === 0 && !store.loading()}>
				<div style={tw("flex absolute top-10 inset-x-0 justify-center", store.mode())}>
					<text style={textStyle("text-muted-foreground", store.mode())}>No items</text>
				</div>
			</Show>
		</div>
	);
}

