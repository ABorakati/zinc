// Side panels: "Figures & Tables" (thumbnails, jump), "References" (the resolved bibliography with filter, cards, add to library)
// and "Supplementary" (the item's other attachments). reader-next/src/academic/index.ts addSidebarTab(...).
import { createMemo, createResource, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import type { ReaderContext } from "../plugins";
import { clampTx, Field, kit, RegionImage, type Kit } from "../structure/kit";
import { RefCard, SuppRow, useCrop } from "./Cards";
import type { FigItem } from "./figures";
import { academicFor, type AcademicSession } from "./session";
import { supplementaryItems } from "./supp";
import type { Reference } from "./types";

const emptyNote = (s: AcademicSession, text: string): JSX.Element => (
	<div style={{ padding: 16 }}><text style={kit(s.ctx.mode).tx("text-[12px] text-muted-foreground")}>{text}</text></div>
);

// ---------------------------------------------------------------------------------------------------- figures & tables

function FigRow(p: { s: AcademicSession; it: FigItem }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const cap = () => (p.it.caption ?? "").replace(/^\s*(?:Supplementary\s+)?(?:Figure|Fig\.?|Table)\s*S?\d+\s*[.:|]?\s*/i, "");
	return (
		<div
			onClick={() => p.s.jump(p.it.page, p.it.rect)}
			style={{ ...k.t("flex flex-row border-b"), width: "100%", padding: 8, gap: 8, cursor: "pointer", hover: k.t("bg-accent/60"), alignItems: "flex-start" }}
		>
			<div style={{ width: 76, flexShrink: 0 }}>
				<RegionThumb k={k} s={p.s} it={p.it} />
			</div>
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, gap: 3 }}>
				<div style={{ display: "flex", flexDirection: "row", alignItems: "baseline", gap: 8 }}>
					<text style={{ ...k.tx("text-[12.5px] font-medium text-foreground"), whiteSpace: "nowrap" }}>{p.it.label}</text>
					<text style={{ ...k.tx("text-[10.5px] text-muted-foreground"), whiteSpace: "nowrap" }}>{`p. ${p.it.page + 1}`}</text>
				</div>
				<Show when={cap()}><text style={{ ...k.tx("text-[11.5px] text-muted-foreground"), ...clampTx(4) }}>{cap()}</text></Show>
			</div>
		</div>
	);
}

function RegionThumb(p: { k: Kit; s: AcademicSession; it: FigItem }): JSX.Element {
	const crop = useCrop(p.s, p.it, 76);
	return <RegionImage k={p.k} crop={crop} width={76} maxHeight={90} fallbackHeight={56} />;
}

export function FiguresPanel(p: { ctx: ReaderContext }): JSX.Element {
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	onMount(() => void s.start());
	const figures = createMemo(() => s.figItems().filter((i) => i.kind === "figure"));
	const tables = createMemo(() => s.figItems().filter((i) => i.kind === "table"));
	const section = (title: string, n: number): JSX.Element => (
		<div style={{ ...k.t("flex flex-none px-2 border-b bg-muted/50"), height: 24, alignItems: "center" }}>
			<text style={{ ...k.tx("text-[11px] font-medium text-muted-foreground"), whiteSpace: "nowrap" }}>{`${title} (${n})`}</text>
		</div>
	);
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
			<Show when={s.analysed()} fallback={emptyNote(s, s.struct().phase === "loading" ? `Analysing document... ${Math.round((s.struct() as { pct?: number }).pct ?? 0)}%` : "Analysing document...")}>
				<Show when={s.figItems().length > 0} fallback={emptyNote(s, "No figures or tables were detected in this PDF.")}>
					<virtual-list estimatedItemHeight={84} overdraw={300} style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
						<Show when={figures().length}>{section("Figures", figures().length)}</Show>
						<For each={figures()}>{(it) => <FigRow s={s} it={it} />}</For>
						<Show when={tables().length}>{section("Tables", tables().length)}</Show>
						<For each={tables()}>{(it) => <FigRow s={s} it={it} />}</For>
					</virtual-list>
				</Show>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- references

function RefRow(p: { s: AcademicSession; r: Reference; onJump: (r: Reference) => void }): JSX.Element {
	const k = kit(p.s.ctx.mode);
	const [open, setOpen] = createSignal(false);
	const [inLib, setInLib] = createSignal(p.r.inLibraryKey);
	const meta = () => [p.r.authors?.[0] && (p.r.authors.length > 1 ? `${p.r.authors[0]} et al.` : p.r.authors[0]), p.r.year, p.r.venue].filter(Boolean).join(" · ");
	return (
		<div style={{ ...k.t("flex flex-col border-b"), width: "100%", padding: 8, gap: 6 }}>
			<div onClick={() => setOpen(!open())} style={{ display: "flex", flexDirection: "row", gap: 8, cursor: "pointer", alignItems: "flex-start" }}>
				<div style={{ width: 30, flexShrink: 0 }}>
					<text style={{ ...k.tx("text-[11px] font-medium text-muted-foreground"), whiteSpace: "nowrap" }}>{`[${p.r.index}]`}</text>
				</div>
				<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, gap: 2 }}>
					<div style={{ display: "flex", flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
						<div style={{ display: "flex", flexGrow: 1, minWidth: 0 }}>
							<text style={{ ...k.tx("text-[12.5px] font-medium text-foreground"), ...clampTx(3) }}>{p.r.title ?? p.r.raw ?? ""}</text>
						</div>
						<Show when={inLib()}>
							<Icon name="library" size={13} color={k.tok("primary")} />
						</Show>
					</div>
					<Show when={meta()}><text style={{ ...k.tx("text-[11px] text-muted-foreground"), ...clampTx(1) }}>{meta()}</text></Show>
				</div>
			</div>
			<Show when={open()}>
				<div style={{ paddingLeft: 38, width: "100%", minWidth: 0 }}>
					<RefCard s={p.s} opts={{ ref: p.r, compact: true, bare: true, onJump: () => p.onJump(p.r), onChange: () => setInLib(p.r.inLibraryKey) }} />
				</div>
			</Show>
		</div>
	);
}

export function ReferencesPanel(p: { ctx: ReaderContext }): JSX.Element {
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	const [query, setQuery] = createSignal("");
	const [refs, { refetch }] = createResource(() => s.api.refs());
	const [refreshing, setRefreshing] = createSignal(false);
	onMount(() => void s.start());
	const shown = createMemo(() => {
		const q = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
		const all = refs() ?? [];
		return all.filter((r) => !q.length || q.every((t) => [r.index, r.title, r.raw, r.authors?.join(" "), r.year, r.venue, r.doi].filter((x) => x != null).join(" ").toLowerCase().includes(t)));
	});
	async function refresh() {
		setRefreshing(true);
		try { await s.api.refList(true); await refetch(); } catch (e) { console.warn("[academic] refresh failed:", (e as Error).message); }
		setRefreshing(false);
	}
	function jumpToEntry(r: Reference) {
		const se = s.structure().references.find((e) => e.index === r.index);
		if (se?.rects[0]) s.jump(se.page, se.rects[0]);
	}
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
			<div style={{ ...k.t("flex flex-none flex-row items-center border-b"), padding: 8, gap: 6 }}>
				<Field k={k} icon="search" value={query()} placeholder="Filter references" onInput={setQuery} style={{ flexGrow: 1 }} />
				<Button size="sm" disabled={refreshing()} onClick={() => void refresh()}>{refreshing() ? "..." : "Refresh"}</Button>
			</div>
			<Show when={!refs.loading} fallback={emptyNote(s, "Loading...")}>
				<Show when={(refs() ?? []).length > 0} fallback={emptyNote(s, "No bibliography could be resolved for this paper.")}>
					<Show when={shown().length > 0} fallback={emptyNote(s, "No matches.")}>
						<virtual-list estimatedItemHeight={70} overdraw={300} style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
							<For each={shown()}>{(r) => <RefRow s={s} r={r} onJump={jumpToEntry} />}</For>
						</virtual-list>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- supplementary

export function SupplementaryPanel(p: { ctx: ReaderContext }): JSX.Element {
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	const [items] = createResource(() => s.api.children().then((c) => supplementaryItems(c, p.ctx.attachmentKey)).catch(() => []));
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, padding: 8, gap: 6 }}>
			<Show when={!items.loading} fallback={<text style={k.tx("text-[12px] text-muted-foreground")}>Loading...</text>}>
				<Show when={(items() ?? []).length > 0} fallback={<text style={k.tx("text-[12px] text-muted-foreground")}>This item has no other attachments.</text>}>
					<For each={items()}>{(it) => <SuppRow s={s} item={it} />}</For>
				</Show>
			</Show>
		</div>
	);
}
