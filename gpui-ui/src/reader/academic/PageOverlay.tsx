// Mentions on a page: in-text citations (the PDF's citation links, else "[3, 5-7]" groups found in the text), figure / table
// mentions, supplementary-material mentions and author-year citations. Each becomes a soft highlight with hover / click popovers
// (reader-next/src/academic/index.ts onPageOverlay). The overlay is sized to the page box; hot areas are the only things that take
// pointer input.
import { createResource, createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import { withAlpha } from "../../theme";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import { windowSize } from "../../ui/core";
import type { ReaderContext } from "../plugins";
import { kit, type Kit } from "../structure/kit";
import { fromNRect, toNRect } from "../structure/pagetext";
import type { PdfRect } from "../structure/types";
import { CitedByCard, CiteGroup, FigureCard, RefCard, SuppCard } from "./Cards";
import {
	expandCitationGroup, isInReferences, markerOf, parseCitationNumbers, resolveAuthorYear, resolveCitation, type Resolution,
} from "./citations";
import { findByKey } from "./figures";
import { captionStart, findAuthorYear, findFigureMentions, findSupplementaryMentions } from "./mentions";
import { academicFor, type AcademicSession } from "./session";
import { charsInRect, computeLines, lineAt, lineRect, rangeRects, type Line } from "./textlines";

type HotKind = "cite" | "figure" | "supp" | "author-year" | "bib";
/** go: what a click on the mention does besides pinning its card (bibliography entries jump to their first citation). */
interface Hot { kind: HotKind; rects: PdfRect[]; key: string; content: () => JSX.Element; go?: () => void }

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const BRACKET_GROUP = /\[\s*\d{1,3}(?:\s*[,;–—−\-]\s*\d{1,3})*\s*\]/g;

// ---------------------------------------------------------------------------------------------------- citation content

export interface CiteSpec {
	nums: number[];
	groupText: string;
	/** the citation link's destination (page index, y of the target's top in PDF points) */
	dest?: { page: number; top?: number };
}

export function CiteContent(p: { s: AcademicSession; k: Kit; spec: CiteSpec; jump?: (page: number, rect: PdfRect) => void }): JSX.Element {
	const jump = (page: number, rect: PdfRect) => (p.jump ?? p.s.jump)(page, rect);
	const [data] = createResource(async () => {
		const s = p.s;
		await s.start();
		const refs = await s.api.refs();
		const rs = s.refStart();
		const out: { n: number; res: Resolution }[] = [];
		for (const n of p.spec.nums) {
			const single = p.spec.nums.length === 1;
			const dpage = p.spec.dest?.page;
			const res = resolveCitation({
				refs, page: dpage ?? rs?.page ?? 0, top: single ? p.spec.dest?.top : undefined,
				pageText: dpage !== undefined ? await s.pageText(dpage) : null, structure: s.structure(), number: n,
				maxY: rs && dpage === rs.page ? rs.y : undefined,
			});
			out.push({ n, res });
		}
		return out;
	});
	return (
		<Show when={data()} fallback={<text style={p.k.tx("text-[12px] text-muted-foreground")}>Looking up the reference...</text>}>
			{(d) => (
				<Show
					when={d().length > 1}
					fallback={
						<RefCard
							s={p.s}
							opts={{
								ref: d()[0]?.res.ref ?? null, rawText: d()[0]?.res.entry?.text,
								onJump: d()[0]?.res.entry ? () => jump(d()[0]!.res.entry!.page, d()[0]!.res.entry!.rect) : undefined,
							}}
						/>
					}
				>
					<CiteGroup s={p.s} k={p.k} text={p.spec.groupText} entries={d().map((x) => ({ n: x.n, ref: x.res.ref }))} />
				</Show>
			)}
		</Show>
	);
}

// ---------------------------------------------------------------------------------------------------- finding the hot areas

/** A line's rect minus the horizontal spans of the links on it (the hot zones sit above the PDF's own link zones, so a DOI link inside a
 *  bibliography entry must stay uncovered to remain clickable). */
function minusLinks(line: PdfRect, links: PdfRect[]): PdfRect[] {
	const spans = links
		.filter((l) => l[1] < line[3] && l[3] > line[1] && l[0] < line[2] && l[2] > line[0])
		.map((l) => [Math.max(l[0], line[0]), Math.min(l[2], line[2])] as const)
		.sort((a, b) => a[0] - b[0]);
	const out: PdfRect[] = [];
	let x = line[0];
	for (const [a, b] of spans) {
		if (a > x + 1) out.push([x, line[1], a, line[3]]);
		x = Math.max(x, b);
	}
	if (line[2] > x + 1) out.push([x, line[1], line[2], line[3]]);
	return out;
}

async function computeHots(s: AcademicSession, ctx: ReaderContext, page: number): Promise<Hot[]> {
	const [pt] = await Promise.all([s.pageText(page), s.start()]);
	if (!pt.text) return [];
	const k = kit(ctx.mode);
	const lines = computeLines(pt.text, pt.rects);
	const hots: Hot[] = [];
	const covered: [number, number][] = [];
	const overlaps = (a: number, b: number) => covered.some(([x, y]) => a < y && b > x);
	const startsCaption = (i: number): Line | null => {
		const line = lines[lineAt(lines, i)];
		return !!line && i - line.start <= 2 && !!captionStart(line.text) ? line : null;
	};
	const rs = s.refStart();
	const inRefList = (idx: number) => {
		if (!rs) return false;
		if (page > rs.page) return true;
		if (page < rs.page) return false;
		const y = lines[lineAt(lines, idx)]?.y2;
		return y !== undefined && y <= rs.y + 2;
	};
	const figs = s.figItems();

	// figures & tables
	for (const m of findFigureMentions(pt.text)) {
		const it = figs.length ? findByKey(figs, m.key) : undefined;
		if (!it) continue;
		const capLine = startsCaption(m.start);
		if (capLine && it.page === page && it.caption && norm(it.caption).startsWith(norm(capLine.text).slice(0, 15))) continue; // the caption's own label
		covered.push([m.start, m.end]);
		hots.push({ kind: "figure", rects: rangeRects(pt.rects, m.start, m.end), key: `fig:${page}:${m.start}`, content: () => <FigureCard s={s} item={it} /> });
	}
	// supplementary material
	for (const m of findSupplementaryMentions(pt.text)) {
		if (overlaps(m.start, m.end) || startsCaption(m.start)) continue;
		covered.push([m.start, m.end]);
		hots.push({ kind: "supp", rects: rangeRects(pt.rects, m.start, m.end), key: `supp:${page}:${m.start}`, content: () => <SuppCard s={s} mention={m} /> });
	}

	// in-text citation links of the PDF
	const links = (await ctx.pageLinks?.(page).catch(() => [])) ?? [];
	for (const l of links) {
		if (l.target.kind !== "page") continue;
		const rect = fromNRect(l.rect, ctx.pageSize(page).w, ctx.pageSize(page).h);
		const idx = charsInRect(pt.rects, rect, 0.5);
		const text = idx ? pt.text.slice(idx[0], idx[1]) : "";
		const destSize = ctx.pageSize(l.target.page);
		const top = l.target.y >= 0 ? (1 - l.target.y) * destSize.h : undefined;
		const refLike = isInReferences(rs, l.target.page, top) || (!!rs && l.target.page === rs.page && parseCitationNumbers(text).length > 0);
		if (!refLike) continue;
		let nums = parseCitationNumbers(text);
		let groupText = text;
		if (idx) {
			const g = expandCitationGroup(pt.text, idx);
			const gn = parseCitationNumbers(g);
			if (gn.length >= nums.length) { nums = gn; groupText = g; }
		}
		if (idx) covered.push([idx[0], idx[1]]);
		const spec: CiteSpec = { nums: nums.length ? nums : [], groupText: groupText || text, dest: { page: l.target.page, top } };
		// the zone sits above the PDF's own link, so it does the link's job on a click: go to the reference (the card has the details)
		const dest = l.target;
		hots.push({
			kind: "cite", rects: [rect], key: `link:${page}:${rect.map((n) => Math.round(n)).join(",")}`, content: () => <CiteContent s={s} k={k} spec={spec} />,
			go: () => s.jump(dest.page, top !== undefined ? [0, top - 10, 0, top] : null),
		});
	}

	// "[3, 5-7]" groups with no link (PDFs without link annotations)
	if (!rs || page <= rs.page) {
		BRACKET_GROUP.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = BRACKET_GROUP.exec(pt.text))) {
			const a = m.index, b = m.index + m[0].length;
			if (overlaps(a, b) || inRefList(a)) continue;
			const nums = parseCitationNumbers(m[0]);
			if (!nums.length) continue;
			covered.push([a, b]);
			const spec: CiteSpec = { nums, groupText: m[0] };
			hots.push({ kind: "cite", rects: rangeRects(pt.rects, a, b), key: `br:${page}:${a}`, content: () => <CiteContent s={s} k={k} spec={spec} /> });
		}
	}

	// author-year citations that resolve to a unique bibliography entry
	if (!rs || page <= rs.page) {
		const refs = await s.api.refs();
		if (refs.some((r) => r.authors?.length && r.year)) {
			for (const ay of findAuthorYear(pt.text)) {
				if (overlaps(ay.start, ay.end) || inRefList(ay.start)) continue;
				const ref = resolveAuthorYear(refs, ay);
				if (!ref) continue;
				hots.push({ kind: "author-year", rects: rangeRects(pt.rects, ay.start, ay.end), key: `ay:${page}:${ay.start}`, content: () => <RefCard s={s} opts={{ ref }} /> });
			}
		}
	}

	const uriRects = links.filter((l) => l.target.kind === "uri").map((l) => fromNRect(l.rect, ctx.pageSize(page).w, ctx.pageSize(page).h));
	// bibliography entries: hover shows where the paper cites them (with the sentences), a click jumps to the first citation
	if (rs && page >= rs.page) {
		const cites = await s.citeIndex();
		for (const line of lines) {
			const n = markerOf(line.text);
			if (n === undefined || (page === rs.page && line.y2 > rs.y + 2)) continue;
			const sites = cites.get(n) ?? [];
			hots.push({
				kind: "bib", rects: minusLinks(lineRect(line), uriRects), key: `bib:${page}:${n}`,
				content: () => <CitedByCard s={s} k={k} n={n} sites={sites} onJump={(site) => s.jump(site.page, site.rect)} />,
				go: sites[0] ? () => s.jump(sites[0]!.page, sites[0]!.rect) : undefined,
			});
		}
	}
	return hots.filter((h) => h.rects.length > 0);
}

// ---------------------------------------------------------------------------------------------------- the overlay

const TINT: Record<HotKind, string> = { cite: "#3b82f6", figure: "#14b8a6", supp: "#f59e0b", "author-year": "#3b82f6", bib: "#8b5cf6" };
const CARD_W = 380;

export function AcademicPage(p: { ctx: ReaderContext; page: number; box: Accessor<{ width: number; height: number }> }): JSX.Element {
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	const size = () => p.ctx.pageSize(p.page);
	const sc = () => p.box().width / size().w; // px per PDF point
	const [hots] = createResource(() => computeHots(s, p.ctx, p.page).catch((e) => { console.warn("[academic] page scan failed:", (e as Error).message); return [] as Hot[]; }));
	const [hover, setHover] = createSignal<string | null>(null);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const open = (h: Hot, pinned: boolean) => s.showPopup({ key: h.key, page: p.page, rect: h.rects[0]!, content: h.content, pinned });

	function HotRect(q: { h: Hot; r: PdfRect }): JSX.Element {
		const on = () => hover() === q.h.key;
		return (
			<div
				onMouseEnter={() => {
					setHover(q.h.key);
					s.cancelHide();
					if (s.popup()?.key === q.h.key) return;
					clearTimeout(timers.get(q.h.key));
					timers.set(q.h.key, setTimeout(() => open(q.h, false), 350));
				}}
				onMouseLeave={() => {
					setHover(null);
					clearTimeout(timers.get(q.h.key));
					s.scheduleHide(450);
				}}
				// a click pins the card (it then stays until closed)
				onClick={() => {
					clearTimeout(timers.get(q.h.key));
					if (q.h.go) { s.hidePopup(); q.h.go(); } else open(q.h, true);
				}}
				style={{
					position: "absolute", left: q.r[0] * sc() - 1, top: (size().h - q.r[3]) * sc() - 1, width: (q.r[2] - q.r[0]) * sc() + 2, height: (q.r[3] - q.r[1]) * sc() + 2,
					backgroundColor: withAlpha(TINT[q.h.kind], on() ? (q.h.kind === "bib" ? 0.12 : 0.28) : q.h.kind === "bib" ? 0 : 0.1), borderRadius: 2, cursor: "pointer", pointerEvents: "auto",
					...(q.h.kind === "bib" ? {} : { borderBottomWidth: 1, borderColor: withAlpha(TINT[q.h.kind], on() ? 0.9 : 0.5) }),
				}}
			/>
		);
	}

	/** The card of the open popup, placed under (or above) its mention inside the page box. */
	const card = (): JSX.Element => {
		const pp = s.popup();
		if (!pp || pp.page !== p.page) return undefined;
		const r = pp.rect;
		const left = Math.max(4, Math.min((r[0] * sc()), p.box().width - CARD_W - 4));
		const rectTop = (size().h - r[3]) * sc(), rectBottom = (size().h - r[1]) * sc();
		// below the mention when the window has room there (a card is up to ~430 px tall), else above it; the page box is taller than the window
		p.ctx.viewTick?.();
		const w = p.ctx.rectToWindow?.(p.page, toNRect(r, size().w, size().h));
		const room = w ? windowSize().height - (w.y + w.height) : 0;
		const below = w ? room >= 440 || room >= w.y : rectBottom + 8 + 260 < p.box().height || rectTop < 270;
		return (
			<div
				onMouseEnter={() => s.cancelHide()}
				onMouseLeave={() => s.scheduleHide(600)}
				onMouseDownOutside={() => { if (s.popup()?.pinned) s.hidePopup(); }}
				style={{
					...k.t("flex flex-col rounded-lg border bg-popover"), position: "absolute", left, width: CARD_W, padding: 12,
					...(below ? { top: Math.min(rectBottom + 6, p.box().height - 80) } : { bottom: p.box().height - rectTop + 6 }),
					borderColor: k.tok("border"), pointerEvents: "auto", boxShadow: [{ offsetX: 0, offsetY: 8, blurRadius: 18, spreadRadius: -2, color: "rgba(0, 0, 0, 0.32)" }],
				}}
			>
				<Show when={pp.pinned}>
					<div onClick={() => s.hidePopup()} style={{ position: "absolute", right: 6, top: 6, display: "flex", cursor: "pointer" }}>
						<Icon name="x" size={14} color={k.tok("muted-foreground")} />
					</div>
				</Show>
				{pp.content()}
			</div>
		);
	};

	return (
		<div style={{ position: "absolute", left: 0, top: 0, width: p.box().width, height: p.box().height, pointerEvents: "none" }}>
			<Show when={hots()}>
				<For each={hots()}>{(h) => <For each={h.rects}>{(r) => <HotRect h={h} r={r} />}</For>}</For>
			</Show>
			{card()}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- back button

/** Mounted once (in the toolbar): the "Back to page N" button that follows a jump from a popup or the panels. */
export function AcademicHost(p: { ctx: ReaderContext }): JSX.Element {
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	return (
		<>
		<Show when={s.struct().phase === "error"}>
			{/* the layout analysis failed (the worker is missing or crashed): citations found in the text still work, the reading view shows the error */}
			<text style={{ ...k.tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>Layout analysis unavailable</text>
		</Show>
		<Show when={s.backStack().length > 0}>
			<Button size="sm" variant="outline" icon="arrow-left" onClick={() => s.goBack()}>
				{`Back to page ${(s.backStack()[s.backStack().length - 1] ?? 0) + 1}`}
			</Button>
		</Show>
		</>
	);
}
