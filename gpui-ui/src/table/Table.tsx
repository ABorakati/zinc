// The Classic table (ItemTable.tsx TableView): a header with sortable, resizable, re-orderable columns (right-click: column picker)
// over a windowed GPUIX <virtual-list> of 30 px rows. Column state is the headless TanStack table (headless.ts); the rows are the
// store's page cache, grouped like the cards (group header rows).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import { childMenu } from "../cards/Card";
import { modsOf, swallow, swallowed } from "../cards/click";
import { openItem } from "../cards/actions";
import { listFocused, listKeyHandler, setListFocused } from "../cards/keys";
import { openItemMenu } from "../cards/menus";
import { createRows, type Group, type Rows } from "../cards/rows";
import { mix } from "../cards/logic";
import { gatedHover, markScroll, throttledCommit } from "../cards/scrolling";
import { clipText } from "../clip";
import { dragSource } from "../dnd";
import type { ItemRow } from "../contracts";
import { attachmentIconName, Icon, itemTypeIconName } from "../icons";
import { defaultDir, stats, store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { readState } from "../readState";
import { DropdownMenu, openMenu, type MenuItem } from "../ui";
import { getColumn, labelOf, loadSchema, MENU_COLUMNS, moreColumns, type Column } from "./defs";
import { createColumnTable } from "./headless";
import { columnLayout as layout } from "./layout";

const ROW = 30;
const HEADER = 32;
const WINDOW = 60;

const mode = () => store.mode();
const tok = (name: string) => tokens[mode()][name]!;

type ColInfo = { id: string; def: Column; width: number };

/** Sort by a column header (ItemTable.tsx HeaderRow.sortBy): click sorts (flips when already the level), Shift+click edits the level list. */
function sortByColumn(c: Column, shift: boolean) {
	const flip = (d: "asc" | "desc") => (d === "asc" ? "desc" : "asc");
	const levels = store.sortLevels();
	const idx = levels.findIndex((l) => l.key === c.sort);
	if (shift) {
		if (idx < 0) store.setSortLevels([...levels, { key: c.sort, dir: defaultDir(c.sort) }]);
		else if (idx === 0 || levels[idx]!.dir === defaultDir(c.sort)) store.setSortLevels(levels.map((l, i) => (i === idx ? { ...l, dir: flip(l.dir) } : l)));
		else store.setSortLevels(levels.filter((_, i) => i !== idx)); // default -> flipped -> removed
		return;
	}
	// while grouped, level 1 is the group field: a plain click on another column edits the level after it
	const at = store.groupBy() !== "none" && c.sort !== store.groupBy() ? 1 : 0;
	const cur = levels[at];
	store.sortBy(cur?.key === c.sort ? { key: c.sort, dir: flip(cur.dir) } : { key: c.sort, dir: defaultDir(c.sort) });
}

/** Header context menu: the column picker. Re-opens after a toggle (the web menu stays open on check). */
function openColumnMenu(at: { x: number; y: number }) {
	const toggle = (id: string) => () => { layout.toggle(id); queueMicrotask(() => openColumnMenu(at)); };
	const entry = (id: string, label: string): MenuItem => ({ label, checked: layout.has(id), disabled: id === "title", onSelect: toggle(id) });
	const more = moreColumns().map((f) => entry(f.id, f.label));
	openMenu(at, [
		...MENU_COLUMNS.map((id) => entry(id, labelOf(id))),
		{ separator: true },
		{ label: "More Columns", submenu: more.length ? more : [{ label: "No other fields", disabled: true }] },
		{ separator: true },
		{ label: "Restore Column Order", onSelect: () => layout.restoreOrder() },
	]);
}

function GroupRow(p: { group: Group; collapsed: boolean; onToggle: () => void }): JSX.Element {
	return (
		<div onClick={p.onToggle} style={{ ...tw("flex flex-none items-center gap-2 px-3 border-b border-border/60 bg-muted/60 cursor-pointer", mode()), height: ROW, width: "100%" }}>
			<Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={14} color={tok("muted-foreground")} />
			<text style={textStyle("select-none text-sm font-semibold text-foreground", mode())}>{p.group.label}</text>
			<text style={textStyle("select-none text-sm tabular-nums text-muted-foreground", mode())}>{p.group.count.toLocaleString("en-US")}</text>
		</div>
	);
}

function Cell(p: { col: ColInfo; item: ItemRow }): JSX.Element {
	const c = () => p.col.def;
	const base = (): Record<string, unknown> => ({
		...tw("flex items-center px-2 min-w-0", mode()), width: p.col.width, flexShrink: 0, flexGrow: 0, height: "100%", overflow: "hidden",
		...(c().align === "right" ? { justifyContent: "flex-end" } : c().align === "center" ? { justifyContent: "center" } : {}),
	});
	// one-line cell text, cut to the column in JS (clip.ts) instead of textOverflow: ellipsis; the cell's overflow:hidden catches the rest
	const text = () => clipText(c().get(p.item), p.col.width - 16, 13);
	const attach = () => (p.item.attachmentCount ?? 0) > 0;
	const unread = () => readState.isUnread(p.item);
	return (
		<Show
			when={c().id === "title"}
			fallback={
				<Show
					when={c().id === "attachments"}
					fallback={
						<div style={base()}>
							<text style={{ ...textStyle("select-none text-[13px] text-foreground/80", mode()), whiteSpace: "nowrap", flexShrink: 0 }}>{text()}</text>
						</div>
					}
				>
					<div style={base()}>
						<Show when={attach()}>
							<DropdownMenu
								items={childMenu(p.item, false)}
								trigger={
									<div onClick={() => swallow()} style={tw("flex size-6 items-center justify-center rounded hover:bg-foreground/15", mode())}>
										<Icon name={attachmentIconName(p.item.primaryAttachment?.contentType, p.item.primaryAttachment ? null : "linked_url")} size={14} color={tok("muted-foreground")} />
									</div>
								}
							/>
						</Show>
					</div>
				</Show>
			}
		>
			<div style={{ ...base(), gap: 6 }}>
				<div style={{ position: "relative", width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
					<Icon name={itemTypeIconName(p.item.itemType)} size={14} color={tok("muted-foreground")} />
					<Show when={unread()}>
						<div
							data-testid="table-unread-dot"
							style={{
								position: "absolute",
								top: -2,
								right: -2,
								width: 6,
								height: 6,
								borderRadius: 9999,
								backgroundColor: tok("primary"),
							}}
						/>
					</Show>
				</div>
				<text style={{ ...textStyle("select-none text-[13px] text-foreground", mode()), whiteSpace: "nowrap", flexShrink: 0 }}>{clipText(p.item.title || "(untitled)", p.col.width - 16 - 20, 13)}</text>
			</div>
		</Show>
	);
}

function RowSkeleton(p: { cols: ColInfo[] }): JSX.Element {
	return (
		<For each={p.cols}>{(c) => (
			<div style={{ ...tw("flex items-center px-2", mode()), width: c.width, flexShrink: 0 }}>
				<div style={{ ...tw("bg-primary/10 rounded-sm", mode()), height: 10, width: c.id === "title" ? "80%" : "60%" }} />
			</div>
		)}</For>
	);
}

function ItemRowView(p: { index: number; cols: () => ColInfo[]; total: () => number }): JSX.Element {
	const item = createMemo(() => store.itemAt(p.index));
	const [hovered, setHovered] = createSignal(false);
	const hover = gatedHover(setHovered); // no hover commits while the list scrolls (cards/scrolling.ts)
	const selected = () => { const it = item(); return !!it && store.selected().has(it.key); };
	const focused = () => listFocused() && store.focusIndex() === p.index;
	const src = dragSource(
		() => { const it = untrack(item); return it ? store.keysFor(it.key) : []; },
		() => { const it = untrack(item); if (it && !store.selected().has(it.key)) store.selectOnly(it.key, p.index); },
	);
	return (
		<div
			onMouseEnter={hover.enter}
			onMouseLeave={hover.leave}
			onMouseDown={src.onMouseDown}
			onMouseMove={src.onMouseMove}
			onMouseUp={src.onMouseUp}
			onClick={(e: EventPayload) => {
				if (swallowed() || src.wasDrag()) return;
				const it = untrack(item);
				if (!it) return;
				setListFocused(true);
				const mods = modsOf(e);
				store.selectClick(p.index, mods);
				if ((e.clickCount ?? 1) >= 2 && !mods.shift && !mods.ctrl) void openItem(it);
			}}
			onAuxClick={(e: EventPayload) => {
				if (!(e.isRightClick || e.button === 2)) return;
				const it = untrack(item);
				if (it) openItemMenu({ x: e.x ?? 0, y: e.y ?? 0 }, it, p.index);
			}}
			style={{
				display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: ROW, width: Math.max(p.total(), 0),
				borderBottomWidth: 1, borderColor: mix(tok("border"), 40, "transparent"),
				backgroundColor: selected() ? mix(tok("primary"), 10, tok("card")) : hovered() ? mix(tok("accent"), 50, "transparent") : "transparent",
				...(focused() ? { outlineWidth: 1, outlineColor: mix(tok("ring"), 60, "transparent"), outlineOffset: -1 } : {}),
			}}
		>
			<Show when={item()} fallback={<RowSkeleton cols={p.cols()} />}>
				{(x) => <For each={p.cols()}>{(c) => <Cell col={c} item={x()} />}</For>}
			</Show>
		</div>
	);
}

function RowView(p: { row: number; rows: Rows; cols: () => ColInfo[]; total: () => number }): JSX.Element {
	const r = createMemo(() => p.rows.row(p.row));
	return (
		<Show when={r()} keyed>
			{(rw) => rw.kind === "header"
				? <GroupRow group={rw.group} collapsed={p.rows.isCollapsed(rw.group)} onToggle={() => p.rows.toggle(rw.group)} />
				: <ItemRowView index={rw.index} cols={p.cols} total={p.total} />}
		</Show>
	);
}

type Gesture = { kind: "resize"; id: string; x0: number; w0: number } | { kind: "reorder"; id: string; x0: number; at: number | null };

export function TableView(): JSX.Element {
	const rows = createRows();
	const gpuix = useGpuix();
	const engine = createColumnTable();
	let list: { id: number } | undefined;

	loadSchema();
	// the table needs the visible columns' fields, not tags / creators
	createEffect(() => store.setListFields(layout.fieldsParam(), ""));

	const [vw, setVw] = createSignal(0); // viewport width of the table (window px)
	const [panX, setPanX] = createSignal(0); // horizontal pan, px (content moves left by this much)
	/** Visible columns; when they are wider than the viewport the title column gives way first (down to 80 px). */
	const cols = createMemo<ColInfo[]>(() => {
		const list = engine.columns().map((c) => ({ id: c.id, def: c.def, width: c.width }));
		const over = list.reduce((n, c) => n + c.width, 0) - vw();
		const title = list.find((c) => c.id === "title");
		if (vw() > 0 && over > 0 && title) title.width = Math.max(80, title.width - over);
		return list;
	});
	const total = createMemo(() => cols().reduce((n, c) => n + c.width, 0));
	const maxPan = () => Math.max(0, total() - vw());

	// ---- window over the rows ----
	const [start, setStart] = createSignal(0);
	const count = () => rows.count();
	const first = createMemo(() => Math.max(0, Math.min(start(), count() - WINDOW)));
	const indices = createMemo(() => {
		const s = first(), e = Math.min(count(), s + WINDOW);
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});
	let visA = 0, visB = 0;
	const itemAtRow = (r: number): number => {
		const rw = rows.row(Math.max(0, Math.min(r, count() - 1)));
		return !rw ? 0 : rw.kind === "item" ? rw.index : rw.group.start;
	};
	// moving the mounted window is a JS commit (a full, uncached frame): at most every 100 ms while scrolling, at once only at the edge
	const nearEdge = (rows: number) => { const s = untrack(first); return (visA < s + rows && s > 0) || visB > s + WINDOW - rows; };
	const recentre = throttledCommit(() => { if (nearEdge(14)) setStart(Math.max(0, visA - WINDOW / 4)); }, 100);
	// The scroll popup (as the cards' one in CardList.tsx): while the table scrolls, a pill beside the scrollbar thumb names where
	// the view is — the group at the top when the list is grouped, else the top row's value in the main sort column ("2019",
	// "Smith", "T"). It commits only when its text or 4 px-rounded position changes, at most every 60 ms, and hides 700 ms after
	// the scroll stops.
	const [bubble, setBubble] = createSignal<{ label: string; top: number } | null>(null);
	let bodyH = 0, quietUntil = 0, hideTimer: ReturnType<typeof setTimeout> | undefined;
	let want: { label: string; top: number } | null = null;
	const showBubble = throttledCommit(() => {
		const cur = untrack(bubble);
		if (want && (!cur || cur.label !== want.label || cur.top !== want.top)) setBubble(want);
	}, 60);
	const pillLabel = (r: number): string | null => {
		const g = rows.groupAt(r);
		if (g) return g.label;
		const it = store.peek(itemAtRow(r));
		const key = store.sortLevels()[0]?.key;
		if (!it || !key) return null;
		const def = untrack(cols).find((c) => c.def.sort === key)?.def ?? getColumn(key);
		const v = (def?.get(it) ?? "").trim();
		if (!v) return null;
		if (/date|year|added|modified/i.test(key)) return v.match(/\d{4}/)?.[0] ?? v.slice(0, 12);
		if (key === "title") return v[0]!.toUpperCase();
		return v.length > 28 ? `${v.slice(0, 27)}…` : v;
	};
	const trackBubble = (a: number, b: number) => {
		if (performance.now() < quietUntil || count() < 40 || bodyH < 120) return;
		const label = pillLabel(a);
		if (!label) return;
		const span = Math.max(1, count() - (b - a)); // rows the top edge can travel over
		const frac = Math.min(1, a / span);
		want = { label, top: HEADER + Math.round((14 + frac * (bodyH - 56)) / 4) * 4 };
		showBubble(false);
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => { want = null; setBubble(null); }, 700);
	};
	onCleanup(() => { if (hideTimer) clearTimeout(hideTimer); });
	const onVisibleRange = (e: EventPayload) => {
		const t0 = performance.now();
		markScroll();
		const a = Math.floor(e.startIndex ?? 0), b = Math.ceil(e.endIndex ?? a + 1);
		if (a !== visA) trackBubble(a, b); // the top row moved: a scroll (not the first layout or a resize)
		visA = a; visB = b;
		store.setVisible(itemAtRow(a), itemAtRow(b));
		if (nearEdge(4)) recentre(true);
		else if (nearEdge(14)) recentre(false);
		const d = performance.now() - t0;
		stats.visCalls++; stats.visMs += d; stats.visMaxMs = Math.max(stats.visMaxMs, d);
	};
	createEffect(on(() => store.listVersion(), () => {
		quietUntil = performance.now() + 400; // the jump back to the top is not a scroll: no popup for it
		want = null;
		setBubble(null);
		setStart(0);
		if (list) gpuix?.renderer.scrollToItem?.(list.id, 0);
	}, { defer: true }));

	function reveal(r: number) {
		if (r < 0 || !list) return;
		if (r >= visA + 1 && r < visB - 1) return;
		setStart(Math.max(0, r - WINDOW / 2));
		gpuix?.renderer.scrollToItem?.(list.id, r, r < visA ? 0 : -300);
	}
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
	const keys = listKeyHandler({
		move,
		page: () => Math.max(1, visB - visA - 2),
		open: () => { const it = store.peek(store.focusIndex()); if (it) void openItem(it); },
		toggle: () => { if (store.focusIndex() >= 0) store.selectClick(store.focusIndex(), { shift: false, ctrl: true }); },
	});
	onMount(() => onCleanup(() => setListFocused(false)));

	// ---- header gestures: resize + reorder, tracked through a full-window overlay while active ----
	const [gesture, setGesture] = createSignal<Gesture | null>(null);
	const [pending, setPending] = createSignal<{ id: string; x0: number } | null>(null);
	const [hx, setHx] = createSignal(0); // header's left edge (window px)
	/** Drop slot (0..n) under window x. */
	const slotAt = (x: number): number => {
		let edge = hx(), i = 0;
		for (const c of cols()) { if (x < edge + c.width / 2) return i; edge += c.width; i++; }
		return cols().length;
	};
	const slotLeft = (slot: number) => cols().slice(0, slot).reduce((n, c) => n + c.width, 0);
	function onOverlayMove(e: EventPayload) {
		const g = gesture();
		if (!g) return;
		if (g.kind === "resize") engine.setWidth(g.id, g.w0 + (e.x ?? 0) - g.x0);
		else setGesture({ ...g, at: slotAt(e.x ?? 0) });
	}
	function onOverlayUp() {
		const g = gesture();
		if (g?.kind === "reorder" && g.at !== null) {
			const from = cols().findIndex((c) => c.id === g.id);
			engine.moveTo(g.id, g.at > from ? g.at - 1 : g.at);
		}
		setGesture(null);
		setPending(null);
	}

	const sortMark = (id: string) => {
		const c = engine.columns().find((x) => x.id === id);
		if (!c || !c.sorted) return null;
		const lvl = store.sortLevels().findIndex((l) => l.key === c.def.sort);
		return { arrow: c.sorted === "asc" ? "↑" : "↓", n: lvl + 1 };
	};

	return (
		<div style={{ ...tw("flex flex-col flex-1 min-h-0 w-full bg-card", mode()), height: "100%" }}>
			<div
				tabIndex={0}
				testId="table-container"
				onKeyDown={keys}
				onFocus={() => setListFocused(true)}
				onBlur={() => setListFocused(false)}
				onLayout={(e: EventPayload) => setVw(e.width ?? 0)}
				onScroll={(e: EventPayload) => { markScroll(); if (e.deltaX) setPanX(Math.max(0, Math.min(maxPan(), panX() - e.deltaX))); }}
				style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0, width: "100%", overflow: "hidden", keyboardFocusDim: false }}
			>
				<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0, width: Math.max(total(), vw(), 1), marginLeft: -Math.min(panX(), maxPan()) }}>
					{/* header */}
					<div
						onLayout={(e: EventPayload) => setHx(e.x ?? 0)}
						style={{ ...tw("relative flex flex-none flex-row items-center border-b border-border/70 bg-muted/50", mode()), height: HEADER, width: "100%", overflow: "hidden" }}
						onAuxClick={(e: EventPayload) => { if (e.isRightClick || e.button === 2) openColumnMenu({ x: e.x ?? 0, y: e.y ?? 0 }); }}
					>
						<For each={cols()}>{(c) => {
							const mark = () => sortMark(c.id);
							const dragging = () => { const g = gesture(); return g?.kind === "reorder" && g.id === c.id; };
							return (
								<div
									onMouseDown={(e: EventPayload) => { if ((e.button ?? 0) === 0) setPending({ id: c.id, x0: e.x ?? 0 }); }}
									onMouseMove={(e: EventPayload) => {
										const pd = pending();
										if (!pd || pd.id !== c.id || e.pressedButton !== 0 || Math.abs((e.x ?? 0) - pd.x0) < 5) return;
										setGesture({ kind: "reorder", id: c.id, x0: pd.x0, at: slotAt(e.x ?? 0) });
									}}
									onMouseUp={() => setPending(null)}
									onClick={(e: EventPayload) => { if (swallowed()) return; sortByColumn(c.def, modsOf(e).shift); }}
									style={{
										...tw("relative flex flex-row items-center gap-1 px-2 cursor-pointer hover:bg-accent/60", mode()),
										width: c.width, height: "100%", flexShrink: 0, overflow: "hidden", opacity: dragging() ? 0.4 : 1,
										...(c.def.align === "right" ? { justifyContent: "flex-end" } : c.def.align === "center" ? { justifyContent: "center" } : {}),
									}}
								>
									<Show when={c.def.icon} fallback={<text style={{ ...textStyle("select-none text-xs font-medium text-muted-foreground", mode()), whiteSpace: "nowrap", flexShrink: 0 }}>{clipText(c.def.label, c.width - 16 - (mark() ? 24 : 0), 12, 500)}</text>}>
										<Icon name={c.def.icon === "attachments" ? "paperclip" : "sticky-note"} size={14} color={tok("muted-foreground")} />
									</Show>
									<Show when={mark()}>
										{(mk) => <text style={{ ...textStyle("select-none text-xs text-primary", mode()), whiteSpace: "nowrap" }}>{`${mk().arrow}${mk().n}`}</text>}
									</Show>
									{/* resize handle: the cell's right edge */}
									<div
										onMouseDown={(e: EventPayload) => { if ((e.button ?? 0) === 0) { swallow(); setPending(null); setGesture({ kind: "resize", id: c.id, x0: e.x ?? 0, w0: c.width }); } }}
										onClick={() => swallow()}
										style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", borderRightWidth: 1, borderColor: mix(tok("border"), 40, "transparent"), hover: { backgroundColor: mix(tok("primary"), 20, "transparent") } }}
									/>
								</div>
							);
						}}</For>
						<Show when={(() => { const g = gesture(); return g?.kind === "reorder" && g.at !== null; })()}>
							<div style={{ position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: tok("primary"), left: Math.max(0, slotLeft((gesture() as { at: number }).at) - 1) }} />
						</Show>
					</div>
					{/* body */}
					<div onLayout={(e: EventPayload) => { bodyH = e.height ?? bodyH; }} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, width: "100%", display: "flex", flexDirection: "column" }}>
						<virtual-list
							ref={(el: { id: number }) => { list = el; }}
							testId="table-list"
							itemCount={count()}
							windowStart={first()}
							estimatedItemHeight={ROW}
							overdraw={300}
							onVisibleRange={onVisibleRange}
							style={{ width: "100%", flexGrow: 1, minHeight: 0, scrollbarColor: tok("input"), scrollbarWidth: 6 }}
						>
							<For each={indices()}>{(i) => <RowView row={i} rows={rows} cols={cols} total={total} />}</For>
						</virtual-list>
						<Show when={count() === 0 && !store.loading()}>
							<div style={tw("flex absolute top-12 inset-x-0 justify-center", mode())}>
								<text style={textStyle("text-muted-foreground", mode())}>{store.view().kind === "publications" ? "No items in My Publications" : "No items"}</text>
							</div>
						</Show>
					</div>
				</div>
			</div>
			{/* outside the panned content, so the pill stays beside the scrollbar when the columns scroll sideways */}
			<Show when={bubble()}>
				{(bb) => (
					<div style={{ ...tw("flex items-center rounded-full bg-primary px-3 py-1 shadow-raised", mode()), position: "absolute", right: 18, top: bb().top, pointerEvents: "none" }}>
						<text style={{ ...textStyle("select-none font-title text-sm font-semibold", mode()), color: tok("primary-foreground") }}>{bb().label}</text>
					</div>
				)}
			</Show>
			{/* status strip, tinted like the column header. It reaches down over the list card's 10 px bottom padding (App.tsx) and
			    carries the card's bottom radii itself, so the tint fills the card's foot instead of leaving a pale band under it. */}
			<div style={{ ...tw("flex flex-none flex-row items-center gap-1 border-t border-border/70 bg-muted/50", mode()), height: 38, paddingLeft: 10, paddingRight: 10, paddingBottom: 3, marginBottom: -10, borderBottomLeftRadius: 14, borderBottomRightRadius: 14 }}>
				<text style={textStyle("text-xs text-muted-foreground", mode())}>
					{`${store.total().toLocaleString("en-GB")} items${store.loading() ? " · loading…" : ""}${store.selected().size > 1 ? ` · ${store.selected().size} selected` : ""}${store.error() ? ` · ${store.error()}` : ""}`}
				</text>
			</div>
			<Show when={gesture()}>
				<anchored fill="window" priority={1} style={{ cursor: gesture()?.kind === "resize" ? "col-resize" : "grabbing" }} onMouseMove={onOverlayMove} onMouseUp={onOverlayUp} />
			</Show>
		</div>
	);
}

export { getColumn };
