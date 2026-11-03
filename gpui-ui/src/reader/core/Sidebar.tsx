// The reader's left sidebar: a tab strip (core tabs: Thumbnails, Outline, Find results; plus every plugin sidePanel) and the
// active tab's content. Thumbnails and the outline are virtualised (a long document has hundreds of pages / thousands of
// bookmarks); a thumbnail is a tiny bitmap rendered through the same scheduler as the pages, at a lower priority, and freed
// when its row scrolls out of the window.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import type { Mode, Style } from "../../contracts";
import { Icon } from "../../icons";
import { textStyle, tokens, tw, withAlpha } from "../../theme";
import type { Look, OutlineEntry, PdfDoc } from "../pdf";
import { hiddenUntil, type ImgNode, whenMounted } from "./pixels";
import type { Scheduler } from "./scheduler";

export const THUMB_W = 116;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export interface SideTab { id: string; label: string; icon: string; render: () => JSX.Element }

export interface SidebarProps {
	mode: Accessor<Mode>;
	width: number;
	tabs: Accessor<SideTab[]>;
	tab: Accessor<string>;
	onTab(id: string): void;
}

export function Sidebar(p: SidebarProps): JSX.Element {
	const t = (c: string): Style => tw(c, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	const active = createMemo(() => p.tabs().find((x) => x.id === p.tab()) ?? p.tabs()[0]);
	return (
		<div style={{ ...t("flex flex-none flex-col border-r bg-card"), width: p.width, height: "100%", minHeight: 0 }}>
			<div style={{ ...t("flex h-9 flex-none items-center gap-0.5 border-b px-1.5"), width: "100%" }}>
				<For each={p.tabs()}>
					{(x) => (
						<div
							onClick={() => p.onTab(x.id)}
							aria-label={x.label}
							style={{
								...t("flex size-7 flex-none items-center justify-center rounded-md"), cursor: "pointer",
								...(active()?.id === x.id ? { backgroundColor: tok("accent") } : {}),
								hover: t("bg-accent"),
							}}
						>
							<Icon name={x.icon} size={15} color={tok(active()?.id === x.id ? "foreground" : "muted-foreground")} />
						</div>
					)}
				</For>
				<div style={{ flexGrow: 1 }} />
				<text style={{ ...textStyle("text-[11px] text-muted-foreground", p.mode()), whiteSpace: "nowrap" }}>{active()?.label ?? ""}</text>
			</div>
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%" }}>
				<Show when={active()} keyed>{(a) => a.render()}</Show>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ thumbnails

export interface ThumbsProps {
	mode: Accessor<Mode>;
	doc: Accessor<PdfDoc | null>;
	sched: Scheduler;
	dpr: Accessor<number>;
	look: Accessor<Look>;
	rot: (page: number) => number;
	/** bump to re-render every thumbnail (rotation, appearance) */
	epoch: Accessor<number>;
	curPage: Accessor<number>;
	goTo(page: number): void;
	/** page right-click -> rotate etc. */
	onMenu?(page: number, x: number, y: number): void;
}

function Thumb(p: ThumbsProps & { i: number; box: Accessor<[number, number]> }): JSX.Element {
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	let img: ImgNode | undefined;
	let alive = true;
	// the <img> is created hidden and shown by the step that gives it pixels (never GPUIX's "img: no src" box); the previous
	// thumbnail stays until a re-render (rotation, appearance) has produced the new one
	const [ready, setReady] = createSignal(false);
	let handle: { cancel(): void } | undefined;
	let task: { cancel(): void } | undefined;
	onCleanup(() => { alive = false; handle?.cancel(); task?.cancel(); });
	const current = () => p.curPage() === p.i;

	createEffect(on(() => [p.dpr(), p.rot(p.i), p.epoch(), p.doc()] as const, () => {
		const d = p.doc();
		if (!d) return;
		handle?.cancel();
		task?.cancel();
		const rot = p.rot(p.i);
		const [pw, ph] = d.sizes[p.i]!;
		const rw = rot % 180 === 0 ? pw : ph;
		const scale = (THUMB_W * p.dpr()) / rw;
		const look = untrack(p.look);
		handle = p.sched.add({
			pri: () => 3e6 + Math.abs(p.i - untrack(p.curPage)),
			run: async () => {
				if (!alive) return;
				const t = d.render2(p.i, scale, { rot, look });
				task = t;
				const r = await t.promise;
				task = undefined;
				if (!r) return;
				try {
					if (await whenMounted(() => img, () => alive) && img) { img.setImagePixels(r.width, r.height, r.pixels, { format: "bgra" }); setReady(true); }
				} finally { r.release(); }
			},
		});
	}));

	return (
		<div
			onClick={() => p.goTo(p.i)}
			onAuxClick={(e: EventPayload) => p.onMenu?.(p.i, e.x ?? 0, e.y ?? 0)}
			style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6, paddingBottom: 6, width: "100%", cursor: "pointer" }}
		>
			<div
				style={{
					display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: 5, borderRadius: 6,
					...(current() ? { backgroundColor: tok("accent") } : {}),
					hover: { backgroundColor: tok("accent") },
				}}
			>
				<div style={{ position: "relative", width: p.box()[0], height: p.box()[1], backgroundColor: "#ffffff", borderWidth: current() ? 2 : 1, borderColor: current() ? tok("primary") : "rgba(0,0,0,0.12)" }}>
					<img ref={(el) => { img = el as never; }} objectFit="fill" style={{ position: "absolute", left: 0, top: 0, width: p.box()[0], height: p.box()[1], ...hiddenUntil(ready()) }} />
				</div>
				<text style={{ ...textStyle("text-[11px] text-muted-foreground", p.mode()), whiteSpace: "nowrap" }}>{String(p.i + 1)}</text>
			</div>
		</div>
	);
}

export function Thumbnails(p: ThumbsProps): JSX.Element {
	const gpuix = useGpuix();
	const count = () => p.doc()?.pageCount ?? 0;
	const box = (i: number): [number, number] => {
		const d = p.doc();
		if (!d) return [THUMB_W, 150];
		const [pw, ph] = d.sizes[i]!;
		const sw = p.rot(i) % 180 !== 0;
		const w = sw ? ph : pw, h = sw ? pw : ph;
		return [THUMB_W, Math.round((THUMB_W * h) / w)];
	};
	const rowH = (i: number) => box(i)[1] + 6 + 6 + 10 + 4 + 14; // padding, thumb padding, label
	const estimate = createMemo(() => {
		const d = p.doc();
		if (!d) return 170;
		let s = 0;
		const n = Math.min(20, d.pageCount);
		for (let i = 0; i < n; i++) s += rowH(i);
		return Math.round(s / Math.max(1, n));
	});
	const [vis, setVis] = createSignal<[number, number]>([0, 6]);
	const lo = createMemo(() => Math.max(0, Math.floor(vis()[0]) - 4));
	const hi = createMemo(() => Math.min(count(), Math.ceil(vis()[1]) + 4));
	const idx = createMemo(() => Array.from({ length: Math.max(0, hi() - lo()) }, (_, k) => lo() + k));
	let list: { id: number } | undefined;
	// keep the current page's thumbnail in view
	createEffect(on(p.curPage, (c) => {
		const [a, b] = untrack(vis);
		if (c >= Math.floor(a) && c < Math.ceil(b) - 0) return;
		if (list) gpuix?.renderer.scrollToItem?.(list.id, c, -8);
	}));
	return (
		<virtual-list
			ref={(el: { id: number }) => {
				list = el;
				const c = untrack(p.curPage);
				if (c > 0) setTimeout(() => gpuix?.renderer.scrollToItem?.(el.id, c, -8), 0);
			}}
			itemCount={count()}
			windowStart={lo()}
			estimatedItemHeight={estimate()}
			overdraw={200}
			onVisibleRange={(e: EventPayload) => setVis([e.startIndex ?? 0, e.endIndex ?? 6])}
			style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
		>
			<For each={idx()}>{(i) => <Thumb {...p} i={i} box={() => box(i)} />}</For>
		</virtual-list>
	);
}

// ------------------------------------------------------------------------------------------------ outline

export interface OutlineProps {
	mode: Accessor<Mode>;
	outline: Accessor<OutlineEntry[] | null>;
	goTo(page: number, y: number): void;
	curPage: Accessor<number>;
}

const ROW = 26;

export function Outline(p: OutlineProps): JSX.Element {
	const t = (c: string): Style => tw(c, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	// children: entry k has children when the next entry is deeper
	const hasKids = (k: number) => { const o = p.outline(); return !!o && k + 1 < o.length && o[k + 1]!.l > o[k]!.l; };
	const [open, setOpen] = createSignal<Set<number>>(new Set());
	// default: top-level entries are open
	createEffect(on(p.outline, (o) => {
		const s = new Set<number>();
		o?.forEach((e, k) => { if (e.l === 0) s.add(k); });
		setOpen(s);
	}));
	const rows = createMemo(() => {
		const o = p.outline() ?? [], op = open();
		const out: number[] = [];
		let skipBelow = Infinity;
		for (let k = 0; k < o.length; k++) {
			const e = o[k]!;
			if (e.l > skipBelow) continue;
			skipBelow = Infinity;
			out.push(k);
			if (hasKids(k) && !op.has(k)) skipBelow = e.l;
		}
		return out;
	});
	const [vis, setVis] = createSignal<[number, number]>([0, 30]);
	const lo = createMemo(() => Math.max(0, Math.floor(vis()[0]) - 6));
	const hi = createMemo(() => Math.min(rows().length, Math.ceil(vis()[1]) + 6));
	const win = createMemo(() => rows().slice(lo(), hi()));
	const toggle = (k: number) => setOpen((s) => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n; });
	return (
		<Show
			when={p.outline() && p.outline()!.length > 0}
			fallback={
				<div style={{ ...t("flex flex-1 items-center justify-center p-4"), width: "100%" }}>
					<text style={{ ...textStyle("text-xs text-muted-foreground", p.mode()), textAlign: "center" }}>{p.outline() ? "This document has no outline" : "Reading the outline…"}</text>
				</div>
			}
		>
			<virtual-list
				itemCount={rows().length}
				windowStart={lo()}
				estimatedItemHeight={ROW}
				overdraw={120}
				onVisibleRange={(e: EventPayload) => setVis([e.startIndex ?? 0, e.endIndex ?? 30])}
				style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
			>
				<For each={win()}>
					{(k) => {
						const e = () => p.outline()![k]!;
						return (
							<div style={{ display: "flex", flexDirection: "row", alignItems: "center", height: ROW, width: "100%", paddingLeft: 4 + e().l * 12, paddingRight: 8 }}>
								<div
									onClick={() => hasKids(k) && toggle(k)}
									style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, flexShrink: 0, cursor: hasKids(k) ? "pointer" : "default" }}
								>
									<Show when={hasKids(k)}><Icon name={open().has(k) ? "chevron-down" : "chevron-right"} size={13} color={tok("muted-foreground")} /></Show>
								</div>
								<div
									onClick={() => e().p >= 0 && p.goTo(e().p, e().y)}
									style={{ ...t("flex min-w-0 flex-1 items-center rounded-sm px-1"), height: 22, cursor: e().p >= 0 ? "pointer" : "default", hover: t("bg-accent") }}
								>
									<text style={{ ...textStyle("text-[12.5px] text-foreground", p.mode()), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e().t || "(untitled)"}</text>
								</div>
							</div>
						);
					}}
				</For>
			</virtual-list>
		</Show>
	);
}

// ------------------------------------------------------------------------------------------------ find results

export interface HitRow { page: number; snippet: string }
export interface HitsProps {
	mode: Accessor<Mode>;
	query: Accessor<string>;
	hits: Accessor<HitRow[]>;
	cur: Accessor<number>;
	done: Accessor<boolean>;
	show(i: number): void;
}
const HIT_ROW = 50;

export function FindResults(p: HitsProps): JSX.Element {
	const t = (c: string): Style => tw(c, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	const [vis, setVis] = createSignal<[number, number]>([0, 14]);
	const lo = createMemo(() => Math.max(0, Math.floor(vis()[0]) - 4));
	const hi = createMemo(() => Math.min(p.hits().length, Math.ceil(vis()[1]) + 4));
	const idx = createMemo(() => Array.from({ length: Math.max(0, hi() - lo()) }, (_, k) => lo() + k));
	return (
		<Show
			when={p.hits().length > 0}
			fallback={
				<div style={{ ...t("flex flex-1 items-center justify-center p-4"), width: "100%" }}>
					<text style={{ ...textStyle("text-xs text-muted-foreground", p.mode()), textAlign: "center" }}>
						{!p.query().trim() ? "Type in the search box to find text" : p.done() ? "No results" : "Searching…"}
					</text>
				</div>
			}
		>
			<virtual-list
				itemCount={p.hits().length}
				windowStart={lo()}
				estimatedItemHeight={HIT_ROW}
				overdraw={120}
				onVisibleRange={(e: EventPayload) => setVis([e.startIndex ?? 0, e.endIndex ?? 14])}
				style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
			>
				<For each={idx()}>
					{(i) => (
						<div
							onClick={() => p.show(i)}
							style={{
								display: "flex", flexDirection: "column", gap: 2, height: HIT_ROW, width: "100%", paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5,
								cursor: "pointer", ...(p.cur() === i ? { backgroundColor: withAlpha(tok("primary"), 0.16) } : {}), hover: t("bg-accent"),
							}}
						>
							<text style={{ ...textStyle("text-[10.5px] text-muted-foreground", p.mode()), whiteSpace: "nowrap" }}>{`Page ${p.hits()[i]!.page + 1}`}</text>
							<text style={{ ...textStyle("text-[12px] text-foreground", p.mode()), lineClamp: 2 }}>{p.hits()[i]!.snippet}</text>
						</div>
					)}
				</For>
			</virtual-list>
		</Show>
	);
}
