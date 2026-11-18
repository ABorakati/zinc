// Layout kinds: box, grid, scroll, split, tabs, deck, section, group, toolbar, card, spacer, separator, popover.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type JSX } from "solid-js";
import { useGpuix, type EventPayload, type HostElement } from "@gpuix/solid";
import { Icon } from "../../../icons";
import { uiState } from "../../../store";
import { Popover } from "../../../ui";
import { boundsOf, t, tok, tx } from "../../../ui/core";
import { withAlpha } from "../../../theme";
import { P } from "../controller";
import { space } from "../styleMap";
import type { Dim, VNode } from "../types";
import { useRt, type KindComponent, type KindProps } from "./ctx";
import { Children, NodeView } from "./node";
import { UiIcon } from "./icons";

const Box: KindComponent = (p) => (
	<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
		<Children node={p.node} />
	</div>
);

const Card: KindComponent = (p) => (
	<div {...p.handlers} style={{ ...t("flex flex-col rounded-lg border bg-card p-3"), ...p.box() }}>
		<Children node={p.node} />
	</div>
);

const Spacer: KindComponent = (p) => <div {...p.handlers} style={{ flexGrow: 1, flexShrink: 1, ...p.box() }} />;

const Separator: KindComponent = (p) => {
	const horizontal = () => (p.node.kind.val?.orientation ?? "horizontal") === "horizontal";
	return (
		<div
			{...p.handlers}
			style={{
				flexShrink: 0,
				backgroundColor: tok("border"),
				...(horizontal() ? { height: 1, width: "100%", alignSelf: "stretch" } : { width: 1, height: "100%", alignSelf: "stretch" }),
				...p.box(),
			}}
		/>
	);
};

const Group: KindComponent = (p) => {
	const rt = useRt();
	const caption = () => rt.txt(p.node.kind.val?.caption);
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", gap: 6, ...p.box() }}>
			<Show when={caption()}>
				<text style={{ ...tx("text-xs font-semibold text-muted-foreground"), whiteSpace: "nowrap" }}>{caption()}</text>
			</Show>
			<div style={{ ...t("flex flex-col rounded-md border p-3"), gap: 8 }}>
				<Children node={p.node} />
			</div>
		</div>
	);
};

const Toolbar: KindComponent = (p) => {
	const mode = () => p.node.kind.val?.overflow ?? "wrap";
	return (
		<div
			{...p.handlers}
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				gap: 4,
				flexWrap: mode() === "wrap" ? "wrap" : "nowrap",
				...(mode() === "scroll" ? { overflow: "scroll" } : {}),
				...p.box(),
			}}
		>
			<Children node={p.node} />
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- grid
// GPUIX grids have equal columns only, so explicit tracks (px / fill / content) are laid out as rows of flex cells.

const trackStyle = (d: Dim | undefined, span: number): Record<string, unknown> => {
	if (!d || d.tag === "fill") return { flexGrow: span, flexShrink: 1, flexBasis: 0, minWidth: 0 };
	if (d.tag === "px") return { width: d.val * span, flexShrink: 0 };
	if (d.tag === "step") return { width: d.val * 4 * span, flexShrink: 0 };
	if (d.tag === "percent") return { width: `${d.val * span}%`, flexShrink: 0 };
	return { flexShrink: 0 }; // auto / content
};

const Grid: KindComponent = (p) => {
	const spec = () => p.node.kind.val ?? {};
	const cols = () => (spec().columns as Dim[] | undefined) ?? [];
	const n = () => Math.max(1, cols().length);
	const rows = createMemo(() => {
		const out: { node: VNode; col: number; span: number }[][] = [];
		let cur: { node: VNode; col: number; span: number }[] = [];
		let used = 0;
		for (const c of p.node.children) {
			const span = Math.max(1, Math.min(n(), c.props.style.gridColumn?.span ?? 1));
			if (used + span > n()) {
				out.push(cur);
				cur = [];
				used = 0;
			}
			cur.push({ node: c, col: used, span });
			used += span;
		}
		if (cur.length) out.push(cur);
		return out;
	});
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", gap: space(spec().rowGap) ?? 0, ...p.box() }}>
			<For each={rows()}>
				{(row) => (
					<div style={{ display: "flex", flexDirection: "row", gap: space(spec().columnGap) ?? 0, alignItems: "stretch" }}>
						<For each={row}>
							{(cell) => {
								const track = () => {
									const c = cols();
									// one cell spanning several columns takes the fill/size of its first track times the span
									return trackStyle(c[cell.col], cell.span);
								};
								return (
									<div style={{ display: "flex", flexDirection: "column", ...track() }}>
										<NodeView node={cell.node} parentId={p.node.id} />
									</div>
								);
							}}
						</For>
					</div>
				)}
			</For>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- scroll

const Scroll: KindComponent = (p) => {
	const spec = () => p.node.kind.val ?? {};
	const rt = useRt();
	const g = useGpuix();
	let el: HostElement | undefined;
	const axis = () => spec().axis ?? "vertical";
	// a log: keep the end in view when children are added
	createEffect(
		on(
			() => (spec().stickToEnd ? p.node.children.length + ":" + rt.ctl.state.generation : ""),
			(k) => {
				if (!k || !el) return;
				const last = rt.ctl.els.get(p.node.children[p.node.children.length - 1]?.id ?? "");
				if (last) g?.renderer.scrollIntoView?.((last as HostElement).id);
			},
		),
	);
	createEffect(
		on(
			() => JSON.stringify(spec().scrollTo ?? null),
			() => {
				const to = spec().scrollTo as { key: string; align: string } | undefined;
				if (to) queueMicrotask(() => rt.ctl.scrollToKey(to.key, to.align));
			},
		),
	);
	return (
		<div
			{...p.handlers}
			ref={(x: HostElement) => {
				el = x;
				p.reg(x);
			}}
			onScrollChange={(e: EventPayload) => {
				if (!rt.ctl.has(p.node, "scroll")) return;
				const y = -(e.scrollY ?? 0);
				rt.ctl.fire(p.node, "scroll", P.scroll(-(e.scrollX ?? 0), y, 0));
			}}
			style={{
				display: "flex",
				flexDirection: "column",
				...(axis() !== "horizontal" ? { overflowY: "scroll" } : {}),
				...(axis() !== "vertical" ? { overflowX: "scroll" } : {}),
				scrollbarColor: withAlpha(tok("foreground"), 0.25),
				scrollbarWidth: 6,
				...p.box(),
			}}
		>
			<Children node={p.node} />
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- split

const Split: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const horizontal = () => (spec().orientation ?? "row") === "row";
	const n = () => p.node.children.length;
	const persist = () => (spec().persistKey ? `wp:${rt.pluginId}:split:${spec().persistKey}` : undefined);
	const initial = (): number[] => {
		const saved = persist() ? uiState.get<number[] | null>(persist()!, null) : null;
		const base = saved && saved.length === n() ? saved : ((spec().sizes as number[]) ?? []);
		const s = Array.from({ length: n() }, (_, i) => base[i] ?? 1 / Math.max(1, n()));
		const sum = s.reduce((a, b) => a + b, 0) || 1;
		return s.map((v) => v / sum);
	};
	const [sizes, setSizes] = createSignal<number[]>(untrack(initial));
	createEffect(on(() => JSON.stringify(spec().sizes), () => setSizes(initial()), { defer: true }));
	const [drag, setDrag] = createSignal<{ i: number; p0: number; sizes: number[]; total: number } | null>(null);
	const [hot, setHot] = createSignal(-1);
	let root: HostElement | undefined;
	const HANDLE = 5;
	const minPx = (i: number) => (spec().minSizes as number[] | undefined)?.[i] ?? 0;
	const pos = (e: EventPayload) => (horizontal() ? (e.x ?? 0) : (e.y ?? 0));
	function start(i: number, e: EventPayload) {
		const b = boundsOf(root);
		const total = (b ? (horizontal() ? b.width : b.height) : 0) - HANDLE * Math.max(0, n() - 1);
		if (total <= 0) return;
		setDrag({ i, p0: pos(e), sizes: sizes(), total });
	}
	function move(e: EventPayload) {
		const d = drag();
		if (!d) return;
		if (e.pressedButton === undefined || e.pressedButton === null) {
			setDrag(null);
			setHot(-1);
			return;
		}
		let delta = (pos(e) - d.p0) / d.total;
		const a = d.sizes[d.i]!,
			b = d.sizes[d.i + 1]!;
		delta = Math.min(Math.max(delta, minPx(d.i) / d.total - a), b - minPx(d.i + 1) / d.total);
		const next = d.sizes.slice();
		next[d.i] = a + delta;
		next[d.i + 1] = b - delta;
		setSizes(next);
		rt.ctl.fire(p.node, "resize", P.sizes(next));
	}
	function stop() {
		const d = drag();
		setDrag(null);
		setHot(-1);
		if (d && persist()) uiState.set(persist()!, sizes());
	}
	return (
		<div
			{...p.handlers}
			ref={(x: HostElement) => {
				root = x;
				p.reg(x);
			}}
			style={{ display: "flex", flexDirection: horizontal() ? "row" : "column", minWidth: 0, minHeight: 0, ...p.box() }}
		>
			<For each={p.node.children}>
				{(c, i) => (
					<>
						<div style={{ display: "flex", flexDirection: "column", flexGrow: sizes()[i()] ?? 0, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}>
							<NodeView node={c} parentId={p.node.id} />
						</div>
						<Show when={i() < n() - 1}>
							<div
								onMouseDown={(e: EventPayload) => start(i(), e)}
								onMouseEnter={() => setHot(i())}
								onMouseLeave={() => {
									if (!drag()) setHot(-1);
								}}
								style={{
									flexShrink: 0,
									display: "flex",
									justifyContent: "center",
									alignItems: "center",
									cursor: horizontal() ? "col-resize" : "row-resize",
									...(horizontal() ? { width: HANDLE } : { height: HANDLE }),
								}}
							>
								<div
									style={{
										pointerEvents: "none",
										...(horizontal() ? { width: 1, height: "100%" } : { height: 1, width: "100%" }),
										backgroundColor: drag()?.i === i() ? tok("primary") : hot() === i() ? withAlpha(tok("primary"), 0.6) : tok("border"),
									}}
								/>
							</div>
						</Show>
					</>
				)}
			</For>
			<Show when={drag()}>
				<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
					<div onMouseMove={move} onMouseUp={stop} style={{ width: "100%", height: "100%", cursor: horizontal() ? "col-resize" : "row-resize" }} />
				</anchored>
			</Show>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- tabs, deck

const Tabs: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const tabs = () => (spec().tabs as { key: string; label: any; icon?: any; closable: boolean; disabled: boolean; badge?: number }[]) ?? [];
	const [sel, setSel] = createSignal<string | undefined>(untrack(() => spec().selected ?? tabs()[0]?.key));
	createEffect(on(() => spec().selected, (s) => s !== undefined && setSel(s as string), { defer: true }));
	const current = () => (tabs().some((x) => x.key === sel()) ? sel() : tabs()[0]?.key);
	const look = () => spec().look ?? "underline";
	const pick = (key: string) => {
		if (key === current()) return;
		setSel(key);
		rt.ctl.fire(p.node, "change", P.tab(key));
	};
	const index = () => Math.max(0, tabs().findIndex((x) => x.key === current()));
	const strip = (
		<div style={{ display: "flex", flexDirection: look() === "vertical" ? "column" : "row", gap: look() === "pills" ? 4 : 0, flexShrink: 0, ...(look() === "underline" ? { borderBottomWidth: 1, borderColor: tok("border") } : {}), ...(look() === "vertical" ? { borderRightWidth: 1, borderColor: tok("border"), paddingRight: 6, marginRight: 8, minWidth: 120 } : {}) }}>
			<For each={tabs()}>
				{(tab) => {
					const on = () => tab.key === current();
					const [hov, setHov] = createSignal(false);
					return (
						<div
							role="tab"
							aria-selected={on()}
							tabIndex={tab.disabled ? undefined : 0}
							onMouseEnter={() => setHov(true)}
							onMouseLeave={() => setHov(false)}
							onClick={() => !tab.disabled && pick(tab.key)}
							style={{
								display: "flex",
								flexDirection: "row",
								alignItems: "center",
								gap: 6,
								height: 32,
								paddingLeft: 10,
								paddingRight: 10,
								cursor: tab.disabled ? "default" : "pointer",
								opacity: tab.disabled ? 0.45 : 1,
								keyboardFocusDim: false,
								...(look() === "pills"
									? { borderRadius: 6, backgroundColor: on() ? tok("secondary") : hov() ? tok("accent") : "transparent" }
									: look() === "vertical"
										? { borderRadius: 6, backgroundColor: on() ? tok("accent") : hov() ? withAlpha(tok("accent"), 0.5) : "transparent" }
										: { borderBottomWidth: 2, borderColor: on() ? tok("primary") : "transparent", marginBottom: -1 }),
							}}
						>
							<Show when={tab.icon}>
								<UiIcon icon={tab.icon} size={14} color={tok(on() ? "foreground" : "muted-foreground")} />
							</Show>
							<text style={{ ...tx(on() ? "text-[13px] font-medium text-foreground" : "text-[13px] text-muted-foreground"), whiteSpace: "nowrap" }}>{rt.txt(tab.label)}</text>
							<Show when={tab.badge !== undefined}>
								<div style={{ ...t("flex h-[16px] min-w-[18px] items-center justify-center rounded-full bg-border-soft px-1") }}>
									<text style={{ ...tx("text-[10px] font-semibold text-secondary-foreground"), whiteSpace: "nowrap" }}>{String(tab.badge)}</text>
								</div>
							</Show>
							<Show when={tab.closable}>
								<div
									onClick={(e: EventPayload) => {
										(e as unknown as { stopPropagation?: () => void }).stopPropagation?.();
										rt.ctl.fire(p.node, "close", P.tab(tab.key));
									}}
									style={{ cursor: "pointer", display: "flex", alignItems: "center", opacity: 0.7, hover: { opacity: 1 } }}
								>
									<Icon name="x" size={12} color={tok("muted-foreground")} />
								</div>
							</Show>
						</div>
					);
				}}
			</For>
		</div>
	);
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: look() === "vertical" ? "row" : "column", ...p.box() }}>
			{strip}
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, paddingTop: look() === "vertical" ? 0 : 8 }}>
				<For each={p.node.children}>
					{(panel, i) => (
						<Show when={spec().keepAlive || i() === index()}>
							<div style={{ display: i() === index() ? "flex" : "none", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
								<NodeView node={panel} parentId={p.node.id} />
							</div>
						</Show>
					)}
				</For>
			</div>
		</div>
	);
};

const Deck: KindComponent = (p) => {
	const sel = () => p.node.kind.val?.selected ?? 0;
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", ...p.box() }}>
			<For each={p.node.children}>
				{(c, i) => (
					<Show when={i() === sel()}>
						<NodeView node={c} parentId={p.node.id} />
					</Show>
				)}
			</For>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- section

const Section: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const persist = () => (spec().persistKey ? `wp:${rt.pluginId}:section:${spec().persistKey}` : undefined);
	const [open, setOpen] = createSignal<boolean>(untrack(() => (persist() ? uiState.get<boolean | null>(persist()!, null) : null) ?? spec().open ?? true));
	createEffect(on(() => spec().open, (o) => o !== undefined && setOpen(!!o), { defer: true }));
	const [hot, setHot] = createSignal(false);
	const fg = () => tok(hot() ? "foreground" : "muted-foreground");
	const toggle = () => {
		const v = !open();
		setOpen(v);
		if (persist()) uiState.set(persist()!, v);
		rt.ctl.fire(p.node, "toggle", P.toggled(v));
	};
	const title = () => rt.txt(spec().title);
	const buttons = () => ((spec().buttons as { id: string; icon: any; label?: any; disabled: boolean; hidden: boolean }[]) ?? []).filter((b) => !b.hidden);
	return (
		<div {...p.handlers} style={{ display: "flex", flexDirection: "column", flexShrink: 0, ...p.box() }}>
			<div
				onMouseEnter={() => setHot(true)}
				onMouseLeave={() => setHot(false)}
				onClick={toggle}
				style={{ ...t("flex h-9 flex-none items-center gap-1.5 px-3"), cursor: "pointer", backgroundColor: withAlpha(tok("foreground"), 0.03) }}
			>
				<Icon name={open() ? "chevron-down" : "chevron-right"} size={14} color={fg()} />
				<Show when={spec().icon}>
					<UiIcon icon={spec().icon} size={14} color={fg()} />
				</Show>
				<text style={{ ...tx("text-[11px] font-semibold"), color: fg(), whiteSpace: "nowrap" }}>{title().toUpperCase()}</text>
				<Show when={spec().count !== undefined && spec().count > 0}>
					<div style={{ ...t("flex h-[18px] min-w-[22px] flex-none items-center justify-center rounded-full bg-border-soft px-1.5") }}>
						<text style={{ ...tx("text-[11px] font-semibold text-secondary-foreground"), whiteSpace: "nowrap" }}>{String(spec().count)}</text>
					</div>
				</Show>
				<Show when={!open() && spec().summary}>
					<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 }}>{rt.txt(spec().summary)}</text>
				</Show>
				<div style={{ flexGrow: 1 }} />
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 2 }} onClick={(e: EventPayload) => (e as unknown as { stopPropagation?: () => void }).stopPropagation?.()}>
					<For each={buttons()}>
						{(b) => (
							<div
								role="button"
								aria-label={b.label ? rt.txt(b.label) : b.id}
								onClick={() => !b.disabled && rt.ctl.fireRaw(b.id, "press", P.none)}
								style={{ ...t("flex size-5 flex-none items-center justify-center rounded"), cursor: b.disabled ? "default" : "pointer", opacity: b.disabled ? 0.3 : 1, hover: b.disabled ? {} : { backgroundColor: tok("accent") } }}
							>
								<UiIcon icon={b.icon} size={14} color={tok("muted-foreground")} />
							</div>
						)}
					</For>
				</div>
			</div>
			<div style={{ display: open() ? "flex" : "none", flexDirection: "column", paddingLeft: 12, paddingRight: 12, paddingBottom: 12, paddingTop: 2, gap: 8 }}>
				<Children node={p.node} />
			</div>
		</div>
	);
};

// ---------------------------------------------------------------------------------------------------- popover

/** Anchored to the PARENT node: the content opens beside the parent's painted box; the node itself takes no room. */
const PopoverK: KindComponent = (p) => {
	const rt = useRt();
	const spec = () => p.node.kind.val ?? {};
	const [open, setOpen] = createSignal(!!spec().open);
	createEffect(on(() => spec().open, (o) => setOpen(!!o), { defer: true }));
	const anchor = () => {
		const el = p.parentId ? (rt.ctl.els.get(p.parentId) as HostElement | undefined) : undefined;
		const b = boundsOf(el);
		const place = spec().placement as string | undefined;
		const end = place?.endsWith("end");
		if (b) return { rect: b, align: end ? ("end" as const) : ("start" as const) };
		return { x: 40, y: 40 };
	};
	// Contents are built here so they keep this view's contexts (the Popover draws them in the OverlayHost).
	const content = <Children node={p.node} />;
	return (
		<div style={{ width: 0, height: 0, flexShrink: 0 }}>
			<Popover
				open={open()}
				onClose={() => {
					if (spec().dismissOnOutside === false) return;
					setOpen(false);
					rt.ctl.fire(p.node, "close");
					rt.ctl.fire(p.node, "toggle", P.toggled(false));
				}}
				anchor={anchor()}
				width={spec().width ?? 288}
			>
				{content}
			</Popover>
		</div>
	);
};

export const layout: Record<string, KindComponent> = {
	box: Box,
	grid: Grid,
	scroll: Scroll,
	split: Split,
	tabs: Tabs,
	deck: Deck,
	section: Section,
	group: Group,
	toolbar: Toolbar,
	card: Card,
	spacer: Spacer,
	separator: Separator,
	popover: PopoverK,
};

