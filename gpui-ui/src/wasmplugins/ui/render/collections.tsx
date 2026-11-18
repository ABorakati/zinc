// list-view and table. Inline rows are sorted and tree-folded by the host; virtual rows are pulled with `ui-events.render-range` for
// the window the user sees (plus overscan), and the plugin sorts them (`range-request.sort`). Long lists draw through a windowed
// <virtual-list>; short ones are plain columns so they size to their content.
import { createEffect, createMemo, createSignal, For, on, Show, untrack, type JSX } from "solid-js";
import type { EventPayload, HostElement } from "@gpuix/solid";
import { Icon } from "../../../icons";
import { openMenu } from "../../../ui";
import { boundsOf, t, tok, tx } from "../../../ui/core";
import { withAlpha } from "../../../theme";
import { P } from "../controller";
import { resolveColor } from "../colors";
import type { Cell, Row, SortSpec, VNode } from "../types";
import { useRt, type KindComponent, type KindProps } from "./ctx";
import { UiIcon } from "./icons";
import { modsOf, NodeView, toMenuItems } from "./node";

const INLINE_PLAIN_MAX = 60; // up to this many rows are drawn as plain children
const MAX_DEFAULT_H = 420;
const OVERSCAN_DEFAULT = 20;

interface Source {
	virtual: boolean;
	count: () => number;
	rowAt: (i: number) => Row | undefined;
	/** Row ids for selection ranges (only the rows the host has). */
	idAt: (i: number) => string | undefined;
	rowHeight: () => number;
	overscan: () => number;
}

/** Rows of a list or table node: inline rows (sorted, tree-folded locally) or the pulled window. */
function useSource(p: KindProps, opts: { sort: () => SortSpec | undefined; tree: () => boolean; columns: () => { key: string }[] }) {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const rows = () => spec().rows as { tag: "inline"; val: Row[] } | { tag: "virtual"; val: { count: number; rowHeight: number; overscan: number } };
	const virtual = () => rows().tag === "virtual";
	const [open, setOpen] = createSignal<Record<string, boolean>>({});
	const isOpen = (r: Row) => open()[r.id] ?? r.expanded;
	const toggle = (r: Row) => {
		setOpen({ ...open(), [r.id]: !isOpen(r) });
		rt.ctl.fire(p.node, "toggle", P.row(r.id));
	};
	const sortKeyOf = (r: Row, col: string): string | number => {
		const idx = opts.columns().findIndex((c) => c.key === col);
		const c: Cell | undefined = r.cells[Math.max(0, idx)];
		const v = c?.sortValue;
		if (v) return v.tag === "number" ? v.val : v.tag === "text" ? v.val : v.tag === "flag" ? Number(v.val) : "";
		return rt.txt(c?.text);
	};
	const inline = createMemo<Row[]>(() => {
		const r = rows();
		if (r.tag !== "inline") return [];
		let list = r.val;
		const s = opts.sort();
		if (s && !opts.tree()) {
			const dir = s.direction === "ascending" ? 1 : -1;
			list = [...list].sort((a, b) => {
				const x = sortKeyOf(a, s.column),
					y = sortKeyOf(b, s.column);
				return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
			});
		}
		if (opts.tree()) {
			const out: Row[] = [];
			let hideBelow = Infinity;
			for (const row of list) {
				if (row.depth > hideBelow) continue;
				hideBelow = Infinity;
				out.push(row);
				if (row.expandable && !isOpen(row)) hideBelow = row.depth;
			}
			list = out;
		}
		return list;
	});
	const cache = () => rt.ctl.state.rowCache[p.node.id];
	const src: Source = {
		get virtual() {
			return virtual();
		},
		count: () => (virtual() ? (cache()?.total ?? (rows().val as { count: number }).count) : inline().length),
		rowAt: (i) => (virtual() ? cache()?.rows[i] : inline()[i]),
		idAt: (i) => (virtual() ? cache()?.rows[i]?.id : inline()[i]?.id),
		rowHeight: () => (virtual() ? (rows().val as { rowHeight: number }).rowHeight : 0),
		overscan: () => (virtual() ? ((rows().val as { overscan: number }).overscan ?? OVERSCAN_DEFAULT) : OVERSCAN_DEFAULT),
	};
	return { src, isOpen, toggle };
}

/** Selection with the plugin's `selected` applied when it changes, and click / keyboard handling. */
function useSelection(p: KindProps, src: Source) {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const mode = () => (spec().selection ?? "none") as "none" | "single" | "multiple";
	const [sel, setSel] = createSignal<string[]>(untrack(() => (spec().selected as string[]) ?? []));
	createEffect(on(() => JSON.stringify(spec().selected), () => setSel((spec().selected as string[]) ?? []), { defer: true }));
	const [anchor, setAnchor] = createSignal<number>(-1);
	const set = (ids: string[]) => {
		setSel(ids);
		rt.ctl.fire(p.node, "select", P.selection(ids));
	};
	const click = (i: number, r: Row, e: EventPayload | undefined, column?: string) => {
		if (r.disabled) return;
		const m = modsOf(e);
		if (mode() === "multiple" && m.shift && anchor() >= 0) {
			const [a, b] = [Math.min(anchor(), i), Math.max(anchor(), i)];
			const ids: string[] = [];
			for (let k = a; k <= b; k++) {
				const id = src.idAt(k);
				if (id) ids.push(id);
			}
			set(ids);
		} else if (mode() === "multiple" && (m.ctrl || m.meta)) {
			set(sel().includes(r.id) ? sel().filter((x) => x !== r.id) : [...sel(), r.id]);
			setAnchor(i);
		} else if (mode() !== "none") {
			setAnchor(i);
			if (!(sel().length === 1 && sel()[0] === r.id)) set([r.id]);
		}
		const b = boundsOf(rt.ctl.els.get(p.node.id) as HostElement | undefined);
		const n = p.node;
		rt.ctl.fire(n, "press", P.pointer((e?.x ?? 0) - (b?.x ?? 0), (e?.y ?? 0) - (b?.y ?? 0), { row: r.id, column }), m);
		if ((e?.clickCount ?? 1) >= 2) rt.ctl.fire(n, "activate", P.row(r.id, column), m);
	};
	const context = (r: Row, e: EventPayload, column?: string) => {
		if (mode() !== "none" && !sel().includes(r.id)) set([r.id]);
		const b = boundsOf(rt.ctl.els.get(p.node.id) as HostElement | undefined);
		rt.ctl.fire(p.node, "context-menu", P.pointer((e.x ?? 0) - (b?.x ?? 0), (e.y ?? 0) - (b?.y ?? 0), { button: 2, row: r.id, column }), modsOf(e));
		const menu = p.node.props.contextMenu;
		if (menu) openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, toMenuItems(menu, rt.txt, (id) => void rt.ctl.fireRaw(id, "press", P.none, p.node.props.key)));
	};
	const key = (e: EventPayload) => {
		const k = (e.key ?? "").toLowerCase();
		const cur = Math.max(0, ...sel().map((id) => [...Array(src.count()).keys()].findIndex((i) => src.idAt(i) === id)));
		const go = (i: number) => {
			const n = Math.min(src.count() - 1, Math.max(0, i));
			const r = src.rowAt(n);
			if (r && mode() !== "none") click(n, r, undefined);
		};
		if (k === "down") go(cur + 1);
		else if (k === "up") go(cur - 1);
		else if (k === "home") go(0);
		else if (k === "end") go(src.count() - 1);
		else if (k === "enter" && sel().length) rt.ctl.fire(p.node, "activate", P.row(sel()[0]!));
		else return;
		(e as unknown as { preventDefault?: () => void }).preventDefault?.();
	};
	return { sel, click, context, key, mode };
}

/** The visible window of a windowed list, and the render-range requests that follow it. */
function useWindow(p: KindProps, src: Source, sort: () => SortSpec | undefined) {
	const rt = useRt();
	const [win, setWin] = createSignal<[number, number]>([0, 30]);
	const request = (a: number, b: number) => {
		if (!src.virtual) return;
		const o = src.overscan();
		const start = Math.max(0, a - o);
		rt.ctl.requestRange(p.node, start, Math.min(src.count(), b + o) - start, sort());
	};
	const onRange = (e: EventPayload) => {
		const a = Math.floor(e.startIndex ?? 0),
			b = Math.ceil(e.endIndex ?? a + 1);
		setWin([a, b]);
		request(a, b);
	};
	// a new count or sort invalidates what was pulled; pull the visible window again (only when the key really changed)
	let lastKey: string | undefined;
	createEffect(() => {
		if (!src.virtual) return;
		const k = `${JSON.stringify(sort() ?? null)}|${(p.node.kind.val?.rows as { val: { count: number } }).val.count}`;
		const [a, b] = win();
		if (k === lastKey) return;
		const prev = lastKey;
		lastKey = k;
		if (prev !== undefined) rt.ctl.invalidateRows(p.node.id);
		request(a, b);
	});
	const indices = createMemo(() => {
		const [a, b] = win();
		const o = Math.max(8, src.overscan() / 2);
		const from = Math.max(0, a - o),
			to = Math.min(src.count(), b + o);
		return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
	});
	return { win, onRange, indices };
}

const Skeleton = (p: { h: number }) => (
	<div style={{ height: p.h, display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 8 }}>
		<div style={{ height: 10, width: "55%", borderRadius: 4, backgroundColor: withAlpha(tok("foreground"), 0.07) }} />
	</div>
);

function Frame(p: {
	kp: KindProps;
	src: Source;
	header?: JSX.Element;
	headerH?: number;
	body: (indices: () => number[], rowH: () => number) => JSX.Element;
	rowH: () => number;
	empty?: string;
	sel: ReturnType<typeof useSelection>;
	win: ReturnType<typeof useWindow>;
	plain: boolean;
}): JSX.Element {
	const sized = () => p.kp.box().height !== undefined || p.kp.box().flexGrow !== undefined;
	const defaultH = () => Math.min(MAX_DEFAULT_H, p.src.count() * p.rowH() + (p.headerH ?? 0) + 2);
	return (
		<div
			{...p.kp.handlers}
			tabIndex={0}
			onKeyDown={p.sel.key}
			style={{
				display: "flex",
				flexDirection: "column",
				...t("rounded-md border"),
				keyboardFocusDim: false,
				overflow: "hidden",
				...(!p.plain && !sized() ? { height: defaultH() } : {}),
				...p.kp.box(),
			}}
		>
			{p.header}
			<Show
				when={p.src.count() > 0}
				fallback={
					<div style={{ padding: 16, display: "flex", justifyContent: "center" }}>
						<text style={tx("text-[13px] text-muted-foreground")}>{p.empty ?? ""}</text>
					</div>
				}
			>
				<Show
					when={p.plain}
					fallback={
						<virtual-list
							itemCount={p.src.count()}
							windowStart={p.win.indices()[0] ?? 0}
							estimatedItemHeight={p.rowH()}
							overdraw={200}
							onVisibleRange={p.win.onRange}
							style={{ width: "100%", flexGrow: 1, minHeight: 0, scrollbarColor: withAlpha(tok("foreground"), 0.25), scrollbarWidth: 6 }}
						>
							{p.body(p.win.indices, p.rowH)}
						</virtual-list>
					}
				>
					<div style={{ display: "flex", flexDirection: "column" }}>{p.body(() => Array.from({ length: p.src.count() }, (_, i) => i), p.rowH)}</div>
				</Show>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- list-view

const ListViewK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const { src } = useSource(p, { sort: () => undefined, tree: () => false, columns: () => [] });
	const sel = useSelection(p, src);
	const win = useWindow(p, src, () => undefined);
	const rowH = () => (src.virtual ? src.rowHeight() : 32);
	const plain = () => !src.virtual && src.count() <= INLINE_PLAIN_MAX;
	const [hot, setHot] = createSignal(-1);
	return (
		<Frame
			kp={p}
			src={src}
			sel={sel}
			win={win}
			plain={plain()}
			rowH={rowH}
			empty={rt.txt(spec().empty)}
			body={(indices) => (
				<For each={indices()}>
					{(i) => {
						const row = () => src.rowAt(i);
						return (
							<Show when={row()} fallback={<Skeleton h={rowH()} />}>
								{(r) => (
									<div
										role="listitem"
										onClick={(e: EventPayload) => sel.click(i, r(), e)}
										onAuxClick={(e: EventPayload) => (e.isRightClick || e.button === 2) && sel.context(r(), e)}
										onMouseEnter={() => setHot(i)}
										onMouseLeave={() => hot() === i && setHot(-1)}
										style={{
											display: "flex",
											flexDirection: "row",
											alignItems: "center",
											minHeight: r().height ?? rowH(),
											paddingLeft: 8,
											paddingRight: 8,
											cursor: "pointer",
											opacity: r().disabled ? 0.5 : 1,
											backgroundColor: sel.sel().includes(r().id) ? tok("primary-tint") : hot() === i ? tok("accent") : "transparent",
										}}
									>
										<Show when={r().contentNode} fallback={<CellView cell={r().cells[0]} />}>
											<NodeView node={r().contentNode!} parentId={p.node.id} />
										</Show>
									</div>
								)}
							</Show>
						);
					}}
				</For>
			)}
		/>
	);
};

function CellView(p: { cell: Cell | undefined; node?: VNode }): JSX.Element {
	const rt = useRt();
	const c = () => p.cell;
	return (
		<Show when={c()}>
			<Show
				when={c()!.contentNode}
				fallback={
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
						<Show when={c()!.icon}>
							<UiIcon icon={c()!.icon} size={14} color={tok("muted-foreground")} />
						</Show>
						<text
							style={{
								...tx(c()!.bold ? "text-[13px] font-semibold text-foreground" : "text-[13px] text-foreground"),
								...(c()!.color ? { color: resolveColor(c()!.color, rt.mode()) } : {}),
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
								minWidth: 0,
							}}
						>
							{rt.txt(c()!.text)}
						</text>
					</div>
				}
			>
				<NodeView node={c()!.contentNode!} parentId={p.node?.id} />
			</Show>
		</Show>
	);
}

// ---------------------------------------------------------------------------------------------------- table

const TableK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const columns = createMemo(() => ((spec().columns as any[]) ?? []).filter((c) => !c.hidden));
	const [sort, setSort] = createSignal<SortSpec | undefined>(untrack(() => spec().sort as SortSpec | undefined));
	createEffect(on(() => JSON.stringify(spec().sort ?? null), () => setSort(spec().sort as SortSpec | undefined), { defer: true }));
	const tree = () => !!spec().tree;
	const { src, isOpen, toggle } = useSource(p, { sort, tree, columns });
	const sel = useSelection(p, src);
	const win = useWindow(p, src, sort);
	const ROW = 30;
	const rowH = () => (src.virtual ? src.rowHeight() || ROW : ROW);
	const plain = () => !src.virtual && src.count() <= INLINE_PLAIN_MAX;
	const [hot, setHot] = createSignal(-1);
	const colStyle = (c: any): Record<string, unknown> => ({
		...(c.width !== undefined ? { width: c.width, flexShrink: 0 } : { flexGrow: c.flex ?? 1, flexShrink: 1, flexBasis: 0 }),
		minWidth: c.minWidth ?? 40,
		justifyContent: c.align === "center" ? "center" : c.align === "end" ? "flex-end" : "flex-start",
	});
	const clickSort = (c: any) => {
		if (!c.sortable) return;
		const cur = sort();
		const next: SortSpec = { column: c.key, direction: cur?.column === c.key && cur?.direction === "ascending" ? "descending" : "ascending" };
		setSort(next);
		rt.ctl.fire(p.node, "sort", P.sort(next));
	};
	const header = (
		<Show when={spec().header !== false}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", height: 28, flexShrink: 0, paddingLeft: 8, paddingRight: 8, gap: 8, backgroundColor: tok("muted"), borderBottomWidth: 1, borderColor: tok("border") }}>
				<For each={columns()}>
					{(c) => (
						<div
							onClick={() => clickSort(c)}
							style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, cursor: c.sortable ? "pointer" : "default", overflow: "hidden", ...colStyle(c) }}
						>
							<Show when={c.icon}>
								<UiIcon icon={c.icon} size={12} color={tok("muted-foreground")} />
							</Show>
							<text style={{ ...tx("text-[11px] font-semibold text-muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rt.txt(c.label)}</text>
							<Show when={sort()?.column === c.key}>
								<Icon name={sort()!.direction === "ascending" ? "arrow-up" : "arrow-down"} size={12} color={tok("muted-foreground")} />
							</Show>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
	return (
		<Frame
			kp={p}
			src={src}
			sel={sel}
			win={win}
			plain={plain()}
			rowH={rowH}
			header={header}
			headerH={spec().header !== false ? 28 : 0}
			empty={rt.txt(spec().empty)}
			body={(indices) => (
				<For each={indices()}>
					{(i) => {
						const row = () => src.rowAt(i);
						return (
							<Show when={row()} fallback={<Skeleton h={rowH()} />}>
								{(r) => (
									<div
										role="listitem"
										onClick={(e: EventPayload) => sel.click(i, r(), e)}
										onAuxClick={(e: EventPayload) => (e.isRightClick || e.button === 2) && sel.context(r(), e)}
										onMouseEnter={() => setHot(i)}
										onMouseLeave={() => hot() === i && setHot(-1)}
										style={{
											display: "flex",
											flexDirection: "row",
											alignItems: "center",
											gap: 8,
											height: r().height ?? rowH(),
											paddingLeft: 8,
											paddingRight: 8,
											cursor: "pointer",
											opacity: r().disabled ? 0.5 : 1,
											backgroundColor: sel.sel().includes(r().id)
												? tok("primary-tint")
												: hot() === i
													? tok("accent")
													: spec().striped && i % 2 === 1
														? withAlpha(tok("foreground"), 0.03)
														: "transparent",
											...(r().style ? {} : {}),
										}}
									>
										<Show
											when={r().contentNode}
											fallback={
												<For each={columns()}>
													{(c, ci) => (
														<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, overflow: "hidden", ...colStyle(c) }}>
															<Show when={tree() && ci() === 0}>
																<div style={{ width: r().depth * 14, flexShrink: 0 }} />
																<div
																	onClick={(e: EventPayload) => {
																		(e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
																		if (r().expandable) toggle(r());
																	}}
																	style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
																>
																	<Show when={r().expandable}>
																		<Icon name={isOpen(r()) ? "chevron-down" : "chevron-right"} size={12} color={tok("muted-foreground")} />
																	</Show>
																</div>
															</Show>
															<CellView cell={r().cells[spec().columns.findIndex((x: any) => x.key === c.key)]} />
														</div>
													)}
												</For>
											}
										>
											<NodeView node={r().contentNode!} parentId={p.node.id} />
										</Show>
									</div>
								)}
							</Show>
						);
					}}
				</For>
			)}
		/>
	);
};

export const collections: Record<string, KindComponent> = { "list-view": ListViewK, table: TableK };
