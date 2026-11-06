// The reflowed reading view: DocStructure as a clean article with the user's typography (reader-next/src/reflow/ReflowView.tsx).
// Text is drawn with GPUIX: paragraphs and lists through <markdown> (inline emphasis, links, sup/subscripts), headings through
// <text>; figures, tables and equations are crops of the PDF page. Citation, figure and table links are blue and open the same
// cards as the page view, on hover (after a short delay) or on a click. Annotations live in the reflowed text too: the document's
// highlights and underlines are drawn over the words they cover, notes sit in the margin of their paragraph, and a selection here
// can be highlighted, underlined or noted. Those are saved exactly like the page view's (PDF rects, see anchor.ts), so the page
// view and Zotero show them as well.
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { withAlpha } from "../../theme";
import { Tooltip } from "../../ui";
import { boundsOf, placeAt } from "../../ui/core";
import { CiteContent, EscapeCloses } from "../academic/PageOverlay";
import { CitedByCard, FigureCard } from "../academic/Cards";
import { markerOf, parseCitationNumbers } from "../academic/citations";
import { findByKey } from "../academic/figures";
import { findFigureMentions } from "../academic/mentions";
import { academicFor } from "../academic/session";
import { selectionToPosition } from "../annotations/geometry";
import { COLORS, NOTE_SIZE, notePosition, textPosition, type Annotation } from "../annotations/model";
import { sessionFor as annotationsFor } from "../annotations/session";
import type { ReaderContext } from "../plugins";
import { clampTx, kit, RegionImage, Swatches } from "../structure/kit";
import { renderRegion, type Crop } from "../structure/regions";
import type { Block, DocStructure, PdfRect } from "../structure/types";
import { buildUnit, byPage, glyphsOfRunRange, locateRun, rangesFor, touches, type Glyph, type PageRects, type Unit } from "./anchor";
import { bestTarget, buildItems, firstItemOnPage, tocEntries, type ReflowItem } from "./build";
import { htmlText, htmlToMarkdown, htmlToMarkedMarkdown, htmlToPlain } from "./html";
import { FONTS, fontFamilyOf, LIMITS, palette, type Palette, type ReadingSettings, type ThemeKind } from "./settings";

export type LoadState =
	| { phase: "loading"; pct: number }
	| { phase: "error"; message: string }
	| { phase: "ready"; doc: DocStructure };

export interface ReflowProps {
	ctx: ReaderContext;
	state: Accessor<LoadState>;
	retry(): void;
	settings: Accessor<ReadingSettings>;
	setSettings(patch: Partial<ReadingSettings>): void;
	resetSettings(): void;
}

const MONO = "Cascadia Mono";
const CARD_W = 380;
const HOVER_OPEN_MS = 350, HOVER_HIDE_MS = 450;

/** One <markdown> of the view and the structure blocks its text came from (the unit annotations are mapped through). */
interface UnitSpec { key: string; html: string; blockIds: string[] }
/** GPUIX's getSelectionSpans() entry (the local fork's renderer method). */
interface SelSpan { elementId: number; sub: number; text: string; start: number; end: number }
/** A card over the text: a citation's reference, a figure, where a bibliography entry is cited. */
interface Card { key: string; rect: { x: number; y: number; width: number; height: number }; content: () => JSX.Element; pinned: boolean }

/** Where an annotation is: its page's rects, and the next page's for a highlight that runs on. */
function whereOf(a: Annotation): PageRects[] {
	const p = a.position;
	const out: PageRects[] = [{ page: p.pageIndex, rects: p.rects ?? [] }];
	if (p.nextPageRects?.length) out.push({ page: p.pageIndex + 1, rects: p.nextPageRects });
	return out;
}
const textual = (a: Annotation) => a.type === "highlight" || a.type === "underline";
const pad = (r: PdfRect, d: number): PdfRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

/** The <markdown> theme for a reading palette + settings; `scale` shrinks it for captions and notes. */
function mdTheme(st: ReadingSettings, pal: Palette, scale = 1) {
	const size = st.size * scale;
	return {
		appearance: (pal.dark ? "dark" : "light") as "dark" | "light", bg: pal.bg, border: pal.rule, text: pal.fg, textMuted: pal.muted, textFaint: pal.muted, textDim: pal.muted,
		accent: pal.cite, link: pal.cite, fontSans: fontFamilyOf(st), fontMono: MONO, codeText: pal.fg, codeWash: pal.panel,
		metrics: {
			mdTextSize: size, mdLineHeight: Math.round(size * st.lineHeight * 10) / 10, mdBlockGap: Math.round(size * 0.55),
			mdHeadingSizes: [size * 1.5, size * 1.3, size * 1.15, size * 1.05], mdHeadingLineHeights: [size * 1.9, size * 1.7, size * 1.55, size * 1.45],
		},
	};
}

export function ReflowView(p: ReflowProps): JSX.Element {
	const gpuix = useGpuix();
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	const st = p.settings;
	const pal = createMemo(() => palette(st()));
	const items = createMemo<ReflowItem[]>(() => { const x = p.state(); return x.phase === "ready" ? buildItems(x.doc) : []; });
	const blockById = createMemo(() => { const x = p.state(); return new Map<string, Block>(x.phase === "ready" ? x.doc.blocks.map((b) => [b.id, b]) : []); });
	const toc = createMemo(() => tocEntries(items()));
	const indexOf = createMemo(() => new Map(items().map((it, i) => [it.id, i])));

	const [settingsOpen, setSettingsOpen] = createSignal(false);
	const [tocOpen, setTocOpen] = createSignal(false);
	const [top, setTop] = createSignal(0);
	const [flash, setFlash] = createSignal<string | null>(null);
	const [back, setBack] = createSignal<number[]>([]);
	let list: { id: number } | undefined;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	const pointer = { x: 0, y: 0 };

	// ---- scrolling / position
	const scrollToIndex = (i: number, offset = 0) => { if (list) gpuix?.renderer.scrollToItem?.(list.id, i, offset); };
	function goToIndex(i: number, remember = true) {
		if (remember) setBack((b) => [...b.slice(-29), top()]);
		scrollToIndex(i);
		const it = items()[i];
		if (it) {
			setFlash(it.id);
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => setFlash(null), 1800);
		}
	}
	/** Scroll to the item (or bibliography entry) holding PDF location (page, top). */
	function targetIndex(page: number, y?: number): number {
		const map = blockById();
		const its = items();
		const i = bestTarget(its.map((it) => ({ blocks: it.blockIds.flatMap((id) => map.get(id) ?? []) })), page, y);
		return its.length ? (i >= 0 ? i : firstItemOnPage(its, page)) : -1;
	}
	function goTo(page: number, y?: number): boolean {
		const idx = targetIndex(page, y);
		if (idx < 0) return false;
		goToIndex(idx);
		return true;
	}
	const goBack = () => {
		const b = back();
		const i = b[b.length - 1];
		if (i === undefined) return;
		setBack(b.slice(0, -1));
		scrollToIndex(i);
	};

	let entered = false;
	function onListRef(el: { id: number }) {
		list = el;
		if (entered || !items().length) return;
		entered = true;
		setTimeout(() => scrollToIndex(firstItemOnPage(items(), p.ctx.currentPage())), 30);
	}
	const topPage = () => items()[Math.min(top(), items().length - 1)]?.page;
	onCleanup(() => {
		clearTimeout(flashTimer);
		const page = topPage();
		if (page !== undefined) setTimeout(() => p.ctx.scrollTo(page, 0), 40);
	});

	// the sidebar's figure / table / reference rows, the cards' "Go to" buttons and the page-view style links all call the session's
	// jump(page, rect), which scrolls the PDF pages: while this view is shown it scrolls the reading list to the block there instead
	onCleanup(s.setJumpOverride((page, rect) => goTo(page, rect ? rect[3] : undefined)));

	// ---- cards for citation, figure and table links: hover opens one after a short delay, moving into it keeps it, leaving closes it;
	// a click opens it pinned (it then stays until a press elsewhere, Escape or its X). The page view's AcademicPage does the same.
	const [card, setCard] = createSignal<Card | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let inCard = false;
	const cancelHide = () => { clearTimeout(hideTimer); hideTimer = undefined; };
	const closeCard = () => { clearTimeout(openTimer); cancelHide(); inCard = false; setCard(null); };
	const scheduleHide = (ms: number) => { cancelHide(); hideTimer = setTimeout(() => { if (!card()?.pinned && !inCard) setCard(null); }, ms); };
	onCleanup(() => { clearTimeout(openTimer); cancelHide(); });

	interface CiteLink { kind: string; page: number; top?: number; text: string }
	const parseCite = (url: string): CiteLink | null => {
		if (!url.startsWith("zn-cite:")) return null;
		const [, kind, pageS, topS, textS] = url.split(":");
		return { kind: kind ?? "other", page: Number(pageS), top: topS ? Number(topS) : undefined, text: decodeURIComponent(textS ?? "") };
	};
	/** The card a link opens, or null (a link with nothing to show only jumps). */
	function cardContent(l: CiteLink): (() => JSX.Element) | null {
		// (the link text keeps the PDF's superscript digits: "⁷³–⁷⁶")
		const nums = l.kind === "ref" ? parseCitationNumbers(l.text.normalize("NFKC")) : [];
		if (nums.length) {
			return () => <CiteContent s={s} k={k} spec={{ nums, groupText: l.text.normalize("NFKC"), dest: { page: l.page, top: l.top } }} jump={(pg, r) => { closeCard(); goTo(pg, r[3]); }} />;
		}
		if (l.kind === "fig" || l.kind === "other") {
			const key = findFigureMentions(l.text)[0]?.key;
			const items = s.figItems();
			const it = (key ? findByKey(items, key) : undefined)
				?? (l.kind === "fig" && l.top !== undefined ? items.find((f) => f.page === l.page && l.top! <= f.rect[3] + 12 && l.top! >= f.rect[1] - 12) : undefined);
			if (it) return () => <FigureCard s={s} item={it} />;
		}
		return null;
	}
	const rectOf = (e: EventPayload) => ({ x: e.x ?? pointer.x, y: e.y ?? pointer.y, width: e.width ?? 0, height: e.height ?? 0 });
	function onLinkEnter(e: EventPayload) {
		const url = e.value;
		if (!url) return; // the element's own enter (no link)
		if (probe) probe.lastLink = { url, x: e.x ?? 0, y: e.y ?? 0, width: e.width ?? 0, height: e.height ?? 0 };
		const l = parseCite(url);
		const content = l && cardContent(l);
		if (!content || inCard) return;
		const key = `${url}@${Math.round(e.x ?? 0)},${Math.round(e.y ?? 0)}`;
		cancelHide();
		if (card()?.key === key) return;
		clearTimeout(openTimer);
		const rect = rectOf(e);
		openTimer = setTimeout(() => { if (!inCard) setCard({ key, rect, content, pinned: false }); }, HOVER_OPEN_MS);
	}
	function onLinkLeave(e: EventPayload) {
		if (!e.value) return;
		clearTimeout(openTimer);
		if (card() && !card()!.pinned) scheduleHide(HOVER_HIDE_MS);
	}
	function onLink(url: string) {
		const l = parseCite(url);
		if (l) {
			clearTimeout(openTimer);
			const content = cardContent(l);
			if (content) {
				const at = card()?.rect ?? { x: pointer.x, y: pointer.y, width: 0, height: 0 };
				setCard({ key: `${url}@pinned`, rect: card() ? at : { x: pointer.x - 4, y: pointer.y - 10, width: 8, height: 16 }, content, pinned: true });
			} else if (Number.isFinite(l.page)) goTo(l.page, l.top);
			return;
		}
		if (/^https?:/i.test(url)) { if (!p.ctx.openUrl?.(url)) void s.api.openUrl(url).catch(() => {}); }
	}

	/** Click on a bibliography entry: where the paper cites it (the reading-view counterpart of hovering an entry in the PDF). */
	function showCitedBy(blockId: string, position: number) {
		const n = markerOf(blockById().get(blockId)?.text ?? "") ?? position;
		setCard({
			key: `bib:${blockId}`, rect: { x: pointer.x - 4, y: pointer.y - 10, width: 8, height: 16 }, pinned: true,
			content: () => {
				const [sites] = createResource(() => s.citeIndex().then((m) => m.get(n) ?? []));
				return (
					<Show when={sites()} fallback={<text style={k.tx("text-[12px] text-muted-foreground")}>Looking for the citations...</text>}>
						{(ss) => <CitedByCard s={s} k={k} n={n} sites={ss()} onJump={(site) => { closeCard(); goTo(site.page, site.rect[3]); }} />}
					</Show>
				);
			},
		});
	}

	const cardView = (c: Card): JSX.Element => {
		const pos = () => placeAt({ rect: c.rect }, 320);
		return (
			<anchored position={{ x: pos().x, y: pos().y }} anchor={pos().anchor} fit="snap" priority={4000}>
				<div
					onMouseEnter={() => { inCard = true; cancelHide(); }}
					onMouseLeave={() => { inCard = false; if (!card()?.pinned) scheduleHide(600); }}
					onMouseDownOutside={closeCard}
					style={{
						...k.t("flex flex-col rounded-lg border bg-popover"), width: CARD_W, padding: 12, borderColor: k.tok("border"),
						boxShadow: [{ offsetX: 0, offsetY: 8, blurRadius: 18, spreadRadius: -2, color: "rgba(0, 0, 0, 0.32)" }],
					}}
				>
					<EscapeCloses close={closeCard} />
					<Show when={c.pinned}>
						<div onClick={closeCard} style={{ position: "absolute", right: 6, top: 6, display: "flex", cursor: "pointer", padding: 2, backgroundColor: "rgba(128, 128, 128, 0.02)" }}>
							<Icon name="x" size={14} color={k.tok("muted-foreground")} />
						</div>
					</Show>
					{c.content()}
				</div>
			</anchored>
		);
	};

	/** ZN_REFLOW_PROBE=1: state for the headless probe (scripts/shot-reflow-annot.tsx) */
	const probe = process.env.ZN_REFLOW_PROBE === "1"
		? ((globalThis as Record<string, unknown>).__znReflow = {
			card, lastLink: null as null | { url: string; x: number; y: number; width: number; height: number }, selPop: () => selPop(),
			top, flash, backLength: () => back().length, targetIndex, itemCount: () => items().length, goBack, goToIndex,
			family: () => family(), size: () => st().size, theme: () => st().theme, items, toc,
		}) as { lastLink: unknown; card: typeof card; selPop: () => unknown }
		: null;

	// ---- annotations: the document's, drawn in the text; new ones from a selection here (see anchor.ts)
	const ann = annotationsFor(p.ctx);
	const units = new Map<string, Promise<Unit | null>>();
	/** The unit's text aligned with its blocks' glyphs (once per unit; the page texts are the academic session's cache). */
	function unitOf(u: UnitSpec): Promise<Unit | null> {
		let pr = units.get(u.key);
		if (!pr) {
			pr = (async () => {
				const blocks = u.blockIds.flatMap((id) => blockById().get(id) ?? []);
				if (!blocks.length) return null;
				const pages = new Map<number, Awaited<ReturnType<typeof s.pageText>>>();
				for (const pg of new Set(blocks.map((b) => b.page))) pages.set(pg, await s.pageText(pg));
				return buildUnit(htmlText(u.html), blocks, pages);
			})().catch((e) => { console.warn("[reflow] text mapping failed:", (e as Error).message); return null; });
			units.set(u.key, pr);
		}
		return pr;
	}
	/** painted <markdown> element id -> its unit, for the selection */
	// (the host element, not its id: a ref runs before the element is mounted, when its id is still 0)
	const mdEls = new Set<{ el: { id: number }; u: UnitSpec }>();
	const unitByEl = { get: (id: number) => [...mdEls].find((x) => x.el.id === id)?.u, has: (id: number) => [...mdEls].some((x) => x.el.id === id) };
	const blocksOf = (ids: string[]) => ids.flatMap((id) => blockById().get(id) ?? []);
	const markColor = (a: Annotation) => (a.type === "underline" ? withAlpha(a.color, 0.95) : withAlpha(a.color, ann.ui.selectedId() === a.id ? 0.6 : 0.4));

	/** Sticky notes, each in the margin of the item nearest to it (same page, overlapping its lines, else the closest one there). */
	const notesByItem = createMemo(() => {
		const out = new Map<string, Annotation[]>();
		const its = items(), map = blockById();
		for (const a of ann.store.list()) {
			if (a.type !== "note") continue;
			const r = a.position.rects?.[0];
			if (!r) continue;
			let best: string | null = null, bestD = Infinity;
			for (const it of its) {
				for (const id of it.blockIds) {
					const b = map.get(id);
					if (!b || b.page !== a.position.pageIndex) continue;
					for (const br of b.rects) {
						const dy = r[3] < br[1] ? br[1] - r[3] : r[1] > br[3] ? r[1] - br[3] : 0;
						const dx = r[2] < br[0] ? br[0] - r[2] : r[0] > br[2] ? r[0] - br[2] : 0;
						const d = dy * 3 + dx;
						if (d < bestD) { bestD = d; best = it.id; }
					}
				}
			}
			if (best && bestD < 400) out.set(best, [...(out.get(best) ?? []), a]);
		}
		return out;
	});
	const openAnnotations = (id?: string) => {
		if (id) ann.ui.select(id);
		p.ctx.setSidebar?.(true, "annotations");
	};
	// the annotations panel's "jump" scrolls this view while it is shown
	onCleanup(ann.act.setJumpOverride((a) => {
		const r = a.position.rects?.[0];
		return goTo(a.position.pageIndex, r ? r[3] : undefined);
	}));

	// ---- a selection in the text: the popup with the annotation actions
	/** the popup and the selection it acts on (kept: pressing one of its buttons may already clear the native selection) */
	const [selPop, setSelPop] = createSignal<{ x: number; y: number; spans: SelSpan[] } | null>(null);
	let inPop = false, popPressed = false;
	const [selMsg, setSelMsg] = createSignal<string | null>(null);
	type SelHost = { getSelectionSpans?(): SelSpan[]; clearSelection?(): void };
	const renderer = () => gpuix?.renderer as unknown as (SelHost & { native?: SelHost }) | undefined;
	// (the headless test renderer wraps the native one and does not forward this method)
	const spansNow = (): SelSpan[] => { const r = renderer(); return r?.getSelectionSpans?.() ?? r?.native?.getSelectionSpans?.() ?? []; };
	const selSpans = (): SelSpan[] => spansNow().filter((sp) => unitByEl.has(sp.elementId) && sp.end > sp.start);
	// The popup opens when a selection in the text settles: on the mouse-up that ends the drag, or (should that release land on
	// something that keeps it) once the selection has stopped changing with no button held. It closes when the selection goes.
	let pressed = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const showSelPop = (at: { x: number; y: number }) => {
		const spans = selSpans();
		if (!pressed && spans.length) { setSelMsg(null); inPop = false; popPressed = false; setSelPop({ ...at, spans }); }
	};
	function onRootMouseUp(e: EventPayload) {
		pressed = false;
		const at = { x: e.x ?? pointer.x, y: e.y ?? pointer.y };
		// the selection is resolved during the drag's paints; read it once this event is through
		setTimeout(() => showSelPop(at), 0);
	}
	const unsubscribe = gpuix?.subscribeSelection?.((text) => {
		clearTimeout(settleTimer);
		// (a press on the popup's own buttons clears the native selection too: the popup keeps its snapshot then)
		if (!text) { settleTimer = setTimeout(() => { if (!inPop && !popPressed) setSelPop(null); }, 120); return; }
		settleTimer = setTimeout(() => { if (!selPop()) showSelPop({ x: pointer.x, y: pointer.y }); }, 350);
	});
	onCleanup(() => { clearTimeout(settleTimer); unsubscribe?.(); });
	/** The selected glyphs, in text order, with the selected text. */
	async function selectedGlyphs(): Promise<{ glyphs: Glyph[]; text: string; missed: boolean }> {
		const glyphs: Glyph[] = [];
		const texts: string[] = [];
		let missed = false;
		const from = new Map<string, number>(); // per unit: where the previous run matched, so a repeated paragraph text maps in order
		for (const sp of selPop()?.spans ?? selSpans()) {
			const spec = unitByEl.get(sp.elementId)!;
			const u = await unitOf(spec);
			const at = u ? locateRun(u, sp.text, from.get(spec.key) ?? 0) : -1;
			if (!u || at < 0) { missed = true; continue; }
			from.set(spec.key, at);
			const g = glyphsOfRunRange(u, sp.text, at, sp.start, sp.end);
			if (!g.length) { missed = true; continue; }
			glyphs.push(...g);
			texts.push(sp.text.slice(sp.start, sp.end));
		}
		return { glyphs, text: texts.join(" ").replace(/\s+/g, " ").trim(), missed };
	}
	async function annotateSelection(type: "highlight" | "underline" | "note", color: string, comment = false) {
		ann.ui.setColor(color);
		const { glyphs, text, missed } = await selectedGlyphs();
		if (!glyphs.length) { setSelMsg("This text could not be found on the PDF page, so it cannot be annotated here."); return; }
		setSelPop(null);
		renderer()?.clearSelection?.();
		const pages = byPage(glyphs);
		if (type === "note") {
			// a sticky note in the page margin beside the line the selection starts on (left of a left-hand column, right of a
			// right-hand one, so it covers no text), its top level with that line
			const first = pages[0]!, r = first.rects[0]!, size = p.ctx.pageSize(first.page);
			const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
			const col = [...blockById().values()].find((b) => b.page === first.page && b.rects.some((br) => cx >= br[0] && cx <= br[2] && cy >= br[1] && cy <= br[3]))
				?.rects.find((br) => cy >= br[1] - 2 && cy <= br[3] + 2);
			const left = col ? col[0] : r[0], right = col ? col[2] : r[2];
			const x = (left + right) / 2 < size.w / 2 ? left - NOTE_SIZE / 2 - 3 : right + NOTE_SIZE / 2 + 3;
			await ann.act.create("note", color, notePosition(first.page, x, r[3] - NOTE_SIZE / 2, size.w, size.h), { focusComment: true });
			openAnnotations();
		} else {
			const pos = selectionToPosition(pages);
			if (!pos) return;
			await ann.act.create(type, color, textPosition(pos.pageIndex, pos.rects, pos.nextPageRects), { text, focusComment: comment });
			if (comment) openAnnotations();
		}
		if (missed) ann.ui.notify("Part of the selection could not be found on the PDF page and was left out.");
	}
	const selectionPopup = (at: { x: number; y: number }): JSX.Element => {
		const action = (label: string, icon: string, run: () => void): JSX.Element => (
			<div onClick={run} style={{ ...k.t("flex flex-row items-center rounded-md px-2"), height: 28, gap: 5, cursor: "pointer", hover: k.t("bg-accent") }}>
				<Icon name={icon} size={14} color={k.tok("foreground")} />
				<text style={{ ...k.tx("text-xs text-foreground"), whiteSpace: "nowrap" }}>{label}</text>
			</div>
		);
		return (
			<anchored position={{ x: at.x, y: at.y + 14 }} anchor="topLeft" fit="snap" priority={3900}>
				<div
					onMouseDownOutside={() => setSelPop(null)}
					onMouseEnter={() => { inPop = true; }}
					onMouseDown={() => { popPressed = true; }}
					onMouseLeave={() => { inPop = false; }}
					style={{ ...k.t("flex flex-col rounded-lg border bg-popover p-1"), gap: 4, borderColor: k.tok("border"), boxShadow: [{ offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: "rgba(0,0,0,0.25)" }] }}
				>
					<EscapeCloses close={() => setSelPop(null)} />
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, userSelect: "none" }}>
						<div style={{ marginLeft: 4, marginRight: 4 }}>
							<Swatches k={k} colors={COLORS} value={ann.ui.color()} size={16} onPick={(c) => void annotateSelection("highlight", c)} />
						</div>
						<div style={{ width: 1, height: 18, backgroundColor: k.tok("border") }} />
						{action("Highlight", "highlighter", () => void annotateSelection("highlight", ann.ui.color()))}
						{action("Underline", "underline", () => void annotateSelection("underline", ann.ui.color()))}
						{action("Comment", "message-square-plus", () => void annotateSelection("highlight", ann.ui.color(), true))}
						{action("Note", "message-square-text", () => void annotateSelection("note", ann.ui.color()))}
					</div>
					<Show when={selMsg()}>
						<div style={{ maxWidth: 420, paddingLeft: 6, paddingRight: 6, paddingBottom: 4 }}>
							<text style={k.tx("text-[11.5px] text-muted-foreground")}>{selMsg() ?? ""}</text>
						</div>
					</Show>
				</div>
			</anchored>
		);
	};

	// ---- rendering of the items
	const family = () => fontFamilyOf(st());
	const base = () => ({ color: pal().fg, fontFamily: family(), fontSize: st().size, lineHeight: Math.round(st().size * st().lineHeight * 10) / 10 });

	function Row(r: { id: string; gap?: number; children: JSX.Element }): JSX.Element {
		const notes = () => notesByItem().get(r.id) ?? [];
		return (
			<div
				style={{
					display: "flex", flexDirection: "row", justifyContent: "center", width: "100%", paddingBottom: Math.round(st().size * (r.gap ?? 0.8)),
					backgroundColor: flash() === r.id ? pal().panel : "transparent",
				}}
			>
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: st().width, minWidth: 0, paddingLeft: 28, paddingRight: 28, position: "relative" }}>
					{r.children}
					{/* the item's sticky notes, in its right margin: hover shows the comment, a click selects it in the annotations panel */}
					<Show when={notes().length > 0}>
						<div style={{ position: "absolute", right: 2, top: 2, display: "flex", flexDirection: "column", gap: 4 }}>
							<For each={notes()}>
								{(a) => (
									<Tooltip label={(a.comment || "Note").slice(0, 120)}>
										<div onClick={() => openAnnotations(a.id)} testId={`reflow-note-${a.id}`} style={{ display: "flex", cursor: "pointer", padding: 2, borderRadius: 4, backgroundColor: withAlpha(a.color, ann.ui.selectedId() === a.id ? 0.45 : 0.25) }}>
											<Icon name="message-square-text" size={14} color={pal().fg} />
										</div>
									</Tooltip>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>
		);
	}

	/** A paragraph's <markdown>: blue links with hover cards, and the annotations that cover its text drawn as marks. */
	function Md(q: { u: UnitSpec; scale?: number }): JSX.Element {
		const blocks = createMemo(() => blocksOf(q.u.blockIds));
		const relevant = createMemo(() => ann.store.list().filter((a) => textual(a) && touches(blocks(), whereOf(a))));
		const [unit] = createResource(() => (relevant().length ? q.u : false), (u) => unitOf(u));
		const plain = htmlToMarkdown(q.u.html);
		const marked = createMemo(() => {
			const u = unit(), rel = relevant();
			if (!u || !rel.length) return { source: plain, marks: [] as { start: number; end: number; color: string; kind: "highlight" | "underline" }[] };
			const ranges: [number, number][] = [];
			const specs: { color: string; kind: "highlight" | "underline" }[] = [];
			for (const a of rel) {
				for (const r of rangesFor(u, whereOf(a))) {
					ranges.push(r);
					specs.push({ color: markColor(a), kind: a.type === "underline" ? "underline" : "highlight" });
				}
			}
			const m = htmlToMarkedMarkdown(q.u.html, ranges);
			return { source: m.source, marks: m.marks.map(([start, end], i) => ({ start, end, ...specs[i]! })).filter((x) => x.end > x.start) };
		});
		let entry: { el: { id: number }; u: UnitSpec } | undefined;
		onCleanup(() => { if (entry) mdEls.delete(entry); });
		return (
			<markdown
				ref={(el: { id: number }) => { if (entry) mdEls.delete(entry); entry = { el, u: q.u }; mdEls.add(entry); }}
				source={marked().source}
				marks={marked().marks}
				linkHover
				theme={mdTheme(st(), pal(), q.scale ?? 1)}
				onLinkClick={(e) => onLink((e as { value?: string }).value ?? "")}
				onMouseEnter={onLinkEnter}
				onMouseLeave={onLinkLeave}
			/>
		);
	}
	const md = (key: string, html: string, blockIds: string[], scale = 1) => <Md u={{ key, html, blockIds }} scale={scale} />;

	function Region(r: { page: number; rect: PdfRect; maxW?: number; maxH?: number; zoom?: number }): JSX.Element {
		const [crop, setCrop] = createSignal<Crop | null>(null);
		const w = () => Math.min(st().width - 56, r.maxW ?? 9999, Math.round((r.rect[2] - r.rect[0]) * (r.zoom ?? 1.4)));
		onMount(() => void renderRegion(p.ctx, r.page, pad(r.rect, 3), 1100, true).then(setCrop));
		return <RegionImage k={k} crop={crop} width={Math.max(60, w())} maxHeight={r.maxH ?? 520} fallbackHeight={Math.round(w() * 0.5)} />;
	}

	function ItemView(q: { it: ReflowItem }): JSX.Element {
		const it = q.it;
		return (
			<Switch>
				<Match when={it.kind === "title"}>
					<Row id={it.id} gap={1.2}>
						<text style={{ ...base(), fontSize: Math.round(st().size * 1.75), lineHeight: Math.round(st().size * 2.2), fontWeight: 700 }}>{htmlToPlain((it as { html: string }).html)}</text>
					</Row>
				</Match>
				<Match when={it.kind === "heading"}>
					<Row id={it.id} gap={0.5}>
						<div style={{ height: Math.round(st().size * 0.9) }} />
						<text
							style={{
								...base(), fontWeight: 650,
								fontSize: Math.round(st().size * ([1.45, 1.3, 1.15, 1.05, 1][(it as { level: number }).level - 1] ?? 1)),
								lineHeight: Math.round(st().size * ([1.9, 1.7, 1.55, 1.45, 1.4][(it as { level: number }).level - 1] ?? 1.4)),
							}}
						>
							{htmlToPlain((it as { html: string }).html)}
						</text>
					</Row>
				</Match>
				<Match when={it.kind === "para" || it.kind === "list"}>
					<Row id={it.id}>{md(it.id, (it as { html: string }).html, it.blockIds)}</Row>
				</Match>
				<Match when={it.kind === "code"}>
					<Row id={it.id}>
						<div style={{ display: "flex", flexDirection: "column", padding: 10, borderRadius: 6, backgroundColor: pal().panel }}>
							<text style={{ ...base(), fontFamily: MONO, fontSize: Math.round(st().size * 0.82), lineHeight: Math.round(st().size * 1.25) }}>{(it as { text: string }).text}</text>
						</div>
					</Row>
				</Match>
				<Match when={it.kind === "equation"}>
					<Row id={it.id}><Region page={it.page} rect={(it as { rect: PdfRect }).rect} zoom={1.7} maxH={160} /></Row>
				</Match>
				<Match when={it.kind === "figure"}>
					<Row id={it.id} gap={1}>
						<Region page={it.page} rect={(it as { rect: PdfRect }).rect} zoom={(it as { wide: boolean }).wide ? 2 : 1.5} />
						<Show when={(it as { captionHtml: string }).captionHtml}>
							<div style={{ height: Math.round(st().size * 0.4) }} />
							{md(it.id + ":cap", (it as { captionHtml: string }).captionHtml, it.blockIds.slice(1), 0.86)}
						</Show>
					</Row>
				</Match>
				<Match when={it.kind === "notes"}>
					<Row id={it.id} gap={1}>
						<div style={{ height: 1, backgroundColor: pal().rule, marginBottom: 8 }} />
						<For each={(it as { html: string[] }).html}>{(h, i) => <div style={{ paddingBottom: 4 }}>{md(`${it.id}:n${i()}`, h, it.blockIds.slice(i(), i() + 1), 0.82)}</div>}</For>
					</Row>
				</Match>
				<Match when={it.kind === "refs"}>
					<Row id={it.id} gap={1.2}>
						<For each={(it as { entries: { id: string; html: string }[] }).entries}>
							{(e, i) => (
								<div onClick={() => { if (!selSpans().length) showCitedBy(e.id, i() + 1); }} style={{ paddingBottom: Math.round(st().size * 0.35), cursor: "pointer", backgroundColor: hitFill() }}>{md(e.id, e.html, [e.id], 0.84)}</div>
							)}
						</For>
					</Row>
				</Match>
			</Switch>
		);
	}

	// ---- chrome
	/** GPUIX only hit-tests a box that paints something: a "transparent" (or unfilled) clickable never gets its click. A fill of
	 *  almost no alpha is invisible and still counts. */
	const hitFill = () => withAlpha(pal().bg, 0.02);
	function Chip(c: { label?: string; icon?: string; on?: boolean; onClick: () => void; w?: number; disabled?: boolean; refEl?: (el: { id: number }) => void }): JSX.Element {
		return (
			<div
				ref={(el: { id: number }) => c.refEl?.(el)}
				onClick={() => { if (!c.disabled) c.onClick(); }}
				style={{
					display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 6, flexShrink: 0,
					borderWidth: 1, borderColor: c.on ? pal().fg : pal().rule, backgroundColor: c.on ? pal().panel : hitFill(), cursor: c.disabled ? "default" : "pointer",
					opacity: c.disabled ? 0.45 : 1, ...(c.w ? { width: c.w } : {}),
				}}
			>
				<Show when={c.icon}><Icon name={c.icon!} size={13} color={pal().fg} /></Show>
				<Show when={c.label}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12, whiteSpace: "nowrap" }}>{c.label!}</text></Show>
			</div>
		);
	}
	const label = (t: string): JSX.Element => <text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11, width: 74, flexShrink: 0 }}>{t}</text>;
	function Stepper(c: { name: string; value: string; dec(): void; inc(): void }): JSX.Element {
		return (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				{label(c.name)}
				<Chip icon="minus" onClick={c.dec} />
				<div style={{ width: 52, display: "flex", justifyContent: "center" }}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12 }}>{c.value}</text></div>
				<Chip icon="plus" onClick={c.inc} />
			</div>
		);
	}
	const step = (v: number, d: number, [lo, hi]: readonly [number, number], dp = 0) => Math.min(hi, Math.max(lo, Math.round((v + d) * 10 ** dp) / 10 ** dp));
	const THEMES: { id: ThemeKind; label: string }[] = [{ id: "light", label: "Light" }, { id: "sepia", label: "Sepia" }, { id: "dark", label: "Dark" }];

	const settingsPanel = (): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderBottomWidth: 1, borderColor: pal().rule, backgroundColor: pal().panel, flexShrink: 0 }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
				{label("Font")}
				<For each={FONTS}>{(f) => <Chip label={f.label} on={st().font === f.id} onClick={() => p.setSettings({ font: f.id })} />}</For>
			</div>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
				<Stepper name="Size" value={`${st().size}px`} dec={() => p.setSettings({ size: step(st().size, -1, LIMITS.size) })} inc={() => p.setSettings({ size: step(st().size, 1, LIMITS.size) })} />
				<Stepper name="Line spacing" value={st().lineHeight.toFixed(2)} dec={() => p.setSettings({ lineHeight: step(st().lineHeight, -0.05, LIMITS.lineHeight, 2) })} inc={() => p.setSettings({ lineHeight: step(st().lineHeight, 0.05, LIMITS.lineHeight, 2) })} />
				<Stepper name="Text width" value={`${st().width}px`} dec={() => p.setSettings({ width: step(st().width, -40, LIMITS.width) })} inc={() => p.setSettings({ width: step(st().width, 40, LIMITS.width) })} />
			</div>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				{label("Theme")}
				<For each={THEMES}>{(th) => <Chip label={th.label} on={st().theme === th.id} onClick={() => p.setSettings({ theme: th.id })} />}</For>
				<div style={{ flexGrow: 1 }} />
				<Chip label="Reset" onClick={p.resetSettings} />
			</div>
		</div>
	);

	let rootEl: { id: number } | undefined;
	let tocBtn: { id: number } | undefined;
	let tocClosedAt = 0;
	const closeToc = () => { if (tocOpen()) { tocClosedAt = Date.now(); setTocOpen(false); } };
	/** the Contents dropdown (reader-next: a floating contents panel): anchored under the toolbar chip, scrolls, closes on pick / outside / Escape */
	const tocPanel = (): JSX.Element => {
		const rb = boundsOf(rootEl as never), bb = boundsOf(tocBtn as never);
		const left = rb && bb ? Math.max(6, bb.x - rb.x) : 76;
		const cur = createMemo(() => {
			let c: string | null = null;
			for (const e of toc()) { if ((indexOf().get(e.id) ?? 0) <= top()) c = e.id; else break; }
			return c;
		});
		return (
			<div
				tabIndex={0}
				autoFocus
				onKeyDown={(e) => { if (e.key === "escape") closeToc(); }}
				onMouseDownOutside={closeToc}
				style={{
					position: "absolute", left, top: 40, width: 300, maxHeight: 440, display: "flex", flexDirection: "column", borderRadius: 8, borderWidth: 1,
					borderColor: pal().rule, backgroundColor: pal().bg, overflow: "hidden", keyboardFocusDim: false,
					boxShadow: [{ offsetX: 0, offsetY: 10, blurRadius: 30, spreadRadius: 0, color: "rgba(0, 0, 0, 0.28)" }],
				}}
			>
				<div style={{ display: "flex", alignItems: "center", height: 30, paddingLeft: 14, flexShrink: 0 }}>
					<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11, fontWeight: 600 }}>CONTENTS</text>
				</div>
				<div style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: 400, overflowY: "scroll", scrollbarColor: "rgba(128, 128, 128, 0.4)", scrollbarWidth: 5, paddingBottom: 8 }}>
					<For each={toc()}>
						{(e) => (
							<div
								onClick={() => { const i = indexOf().get(e.id); closeToc(); if (i !== undefined) goToIndex(i); }}
								style={{
									display: "flex", paddingTop: 4, paddingBottom: 4, paddingRight: 10, paddingLeft: 14 + (e.level - 1) * 12, cursor: "pointer",
									backgroundColor: cur() === e.id ? pal().panel : hitFill(), borderLeftWidth: 2, borderColor: cur() === e.id ? pal().cite : "transparent", hover: { backgroundColor: pal().panel },
								}}
							>
								<text style={{ color: cur() === e.id ? pal().fg : pal().muted, fontFamily: "Inter", fontSize: 12, fontWeight: cur() === e.id ? 600 : 400, ...clampTx(2) }}>{e.text}</text>
							</div>
						)}
					</For>
				</div>
			</div>
		);
	};

	const bar = (): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, height: 42, paddingLeft: 10, paddingRight: 10, flexShrink: 0, borderBottomWidth: 1, borderColor: pal().rule }}>
			<Chip icon="arrow-left" label="PDF" onClick={() => p.ctx.setAltView(null)} />
			<Chip icon="list" label="Contents" on={tocOpen()} refEl={(el) => { tocBtn = el; }} onClick={() => { if (tocOpen()) closeToc(); else if (Date.now() - tocClosedAt > 250) setTocOpen(true); }} disabled={toc().length === 0} />
			<Show when={back().length > 0}><Chip icon="undo-2" label="Back" onClick={goBack} /></Show>
			<div style={{ flexGrow: 1 }} />
			<Show when={p.ctx.setSidebar}>
				<Chip
					icon="highlighter" label={ann.store.list().length ? `Annotations ${ann.store.list().length}` : "Annotations"} on={p.ctx.sidebarTab?.() === "annotations"}
					onClick={() => { if (p.ctx.sidebarTab?.() === "annotations") p.ctx.setSidebar!(false); else openAnnotations(); }}
				/>
			</Show>
			<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11.5, whiteSpace: "nowrap" }}>Reading view</text>
			<Chip icon="a-large-small" label="Aa" on={settingsOpen()} onClick={() => setSettingsOpen(!settingsOpen())} />
		</div>
	);

	const message = (icon: string, text: string, retry?: boolean, pct?: number): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
			<Icon name={icon} size={26} color={pal().muted} />
			<div style={{ maxWidth: 440, display: "flex", justifyContent: "center" }}>
				<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 13, textAlign: "center" }}>{text}</text>
			</div>
			<Show when={pct !== undefined}>
				<div style={{ width: 240, height: 4, borderRadius: 2, backgroundColor: pal().rule }}>
					<div style={{ width: Math.round((240 * (pct ?? 0)) / 100), height: 4, borderRadius: 2, backgroundColor: pal().fg }} />
				</div>
			</Show>
			<Show when={retry}><Chip label="Retry" onClick={p.retry} /></Show>
		</div>
	);

	return (
		<div
			ref={(el: { id: number }) => { rootEl = el; }}
			onMouseMove={(e) => { pointer.x = e.x ?? pointer.x; pointer.y = e.y ?? pointer.y; if (e.pressedButton === undefined) pressed = false; }}
			onMouseDown={() => { pressed = true; }}
			onMouseUp={onRootMouseUp}
			style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, minWidth: 0, backgroundColor: pal().bg, position: "relative" }}
		>
			{bar()}
			<Show when={settingsOpen()}>{settingsPanel()}</Show>
			<Switch>
				<Match when={p.state().phase === "loading"}>
					{message("loader-circle", "Analysing the document layout...", false, (p.state() as { pct: number }).pct)}
				</Match>
				<Match when={p.state().phase === "error"}>
					{message("file-warning", (p.state() as { message: string }).message, true)}
				</Match>
				<Match when={p.state().phase === "ready"}>
					<div style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
						<Show when={items().length > 0} fallback={message("file-text", "No readable text was found in this PDF.")}>
							<virtual-list
								ref={onListRef}
								estimatedItemHeight={Math.round(st().size * 5)}
								overdraw={600}
								onVisibleRange={(e) => { setTop(Math.max(0, Math.floor(e.startIndex ?? 0))); if (card() && !card()!.pinned) closeCard(); }}
								style={{ flexGrow: 1, minWidth: 0, height: "100%", paddingTop: 28, paddingBottom: 80 }}
							>
								<For each={items()}>{(it) => <ItemView it={it} />}</For>
							</virtual-list>
						</Show>
					</div>
				</Match>
			</Switch>
			<Show when={tocOpen() && toc().length > 0}>{tocPanel()}</Show>
			<Show when={card()} keyed>{(c) => cardView(c)}</Show>
			<Show when={selPop()} keyed>{(at) => selectionPopup(at)}</Show>
		</div>
	);
}
