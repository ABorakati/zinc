// academic/ plugin entry (see ../contract.ts): citation popups, figures & tables navigator, references tab,
// supplementary files tab. Uses only ViewerHandle + structure/load.ts; vanilla DOM so it needs no UI framework.
import type { DocStructure, LinkClick, PdfRect, ReaderPlugin } from "../contract";
import { loadStructure } from "../structure/load";
import { createApi, type Reference } from "./api";
import { buildRefCard } from "./card";
import {
	expandCitationGroup, findRefStartInPages, isInReferences, markerOf, parseCitationNumbers,
	refStartFromStructure, resolveAuthorYear, resolveCitation, sentenceAround, type RefStart,
} from "./citations";
import { button, h, PopupManager, useStyles } from "./dom";
import { findByKey, indexFromStructure, mergeIndex, scanCaptionsInPage, type FigItem } from "./figures";
import { captionStart, findAuthorYear, findFigureMentions, findSupplementaryMentions } from "./mentions";
import { createSupplement } from "./supplement";
import { charsInRect, computeLines, lineAt, lineRect, rangeRects, unionRects } from "./textlines";

type PT = { text: string; rects: PdfRect[] };
const EMPTY: DocStructure = { blocks: [], figures: [], tables: [], references: [], outline: [] };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export const academicPlugin: ReaderPlugin = (viewer) => {
	const disposers: (() => void)[] = [];
	const own = (d: () => void) => { disposers.push(d); };
	own(useStyles());
	const popups = new PopupManager();
	own(() => popups.dispose());
	const api = createApi(viewer.attachmentKey, viewer.itemKey);
	const supp = createSupplement(viewer, api);

	// ---------------------------------------------------------------- shared data
	const ptCache = new Map<number, Promise<PT>>();
	const pageText = (i: number) => {
		let p = ptCache.get(i);
		if (!p) {
			p = viewer.pageText(i).catch(() => ({ text: "", rects: [] }) as PT);
			ptCache.set(i, p);
		}
		return p;
	};

	let structure: DocStructure = EMPTY;
	let refStart: RefStart | null = null;
	let figItems: FigItem[] = [];
	let isReady = false;
	const figListeners = new Set<() => void>();

	const ready = (async () => {
		try {
			const res = await fetch(`/api/attachments/${encodeURIComponent(viewer.attachmentKey)}/file`);
			if (res.ok) structure = await loadStructure(viewer.attachmentKey, await res.arrayBuffer());
		}
		catch (e) { console.warn("[academic] structure unavailable:", e); }
		refStart = refStartFromStructure(structure);
		try {
			const all: PT[] = [];
			for (let i = 0; i < viewer.pages.length; i++) all.push(await pageText(i));
			refStart ??= findRefStartInPages(all);
			const scanned = all.flatMap((pt, i) => scanCaptionsInPage(i, pt));
			figItems = mergeIndex(indexFromStructure(structure), scanned);
		}
		catch (e) { console.warn("[academic] text scan failed:", e); }
		isReady = true;
		for (const f of figListeners) f();
	})();
	// fetch every reference's details (abstract, citation counts) in the background, so hover cards are instant
	const prefetchTimer = setTimeout(() => void api.refs().then((r) => api.prefetch(r)), 1500);
	own(() => clearTimeout(prefetchTimer));

	// ---------------------------------------------------------------- navigation + back stack
	const back: { page: number }[] = [];
	let pill: HTMLElement | null = null;
	let pillTimer: ReturnType<typeof setTimeout> | undefined;
	function hidePill() { pill?.remove(); pill = null; clearTimeout(pillTimer); }
	function showPill() {
		hidePill();
		const top = back[back.length - 1];
		if (!top) return;
		pill = h("button", {
			type: "button", class: "rn-btn rn-primary", "data-testid": "rn-back",
			style: { position: "fixed", left: "16px", bottom: "16px", zIndex: "9000", boxShadow: "0 4px 14px rgba(0,0,0,.25)", padding: "6px 12px", fontSize: "12px" },
		}, `← Back to page ${top.page + 1} (Esc)`);
		pill.addEventListener("click", goBack);
		document.body.appendChild(pill);
		pillTimer = setTimeout(hidePill, 10000);
	}
	function goBack(): boolean {
		const t = back.pop();
		if (!t) return false;
		viewer.goToPage(t.page, { smooth: true });
		if (back.length) showPill(); else hidePill();
		return true;
	}
	/** Jump somewhere remembering where we were (leaving the reading view first if it is open). */
	function jump(page: number, rect: PdfRect, cite?: number) {
		if (viewer.alternateActive()) {
			// the reading view scrolls to the target itself when it can (it cancels the event); cite: mark that citation
			const ev = new CustomEvent("reader-next:reading-goto", { detail: { page, rect, cite }, cancelable: true });
			if (!window.dispatchEvent(ev)) { popups.hide(); return; }
			// otherwise leave it: it returns to its own position as it closes; reveal the target after that
			viewer.setAlternateView(null);
			setTimeout(() => jump(page, rect, cite), 120);
			return;
		}
		const here = viewer.page();
		if (!back.length || back[back.length - 1]!.page !== here) back.push({ page: here });
		if (back.length > 30) back.shift();
		viewer.reveal(page, rect);
		showPill();
	}
	own(hidePill);

	const onKey = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
		if (e.key === "Escape") {
			if (popups.isOpen) { popups.hide(); e.stopPropagation(); return; }
			if (viewer.alternateActive()) return; // the reading view keeps its own history
			if (back.length && goBack()) e.preventDefault();
		}
		else if (e.key === "ArrowLeft" && e.altKey && back.length && !viewer.alternateActive()) {
			if (goBack()) e.preventDefault();
		}
	};
	window.addEventListener("keydown", onKey, true);
	own(() => window.removeEventListener("keydown", onKey, true));

	// ---------------------------------------------------------------- citation popups
	let refsFocus: ((index: number) => void) | null = null;
	let pendingRefFocus: number | null = null;
	/** Open the References tab and highlight entry `index` (once the tab has loaded its list). */
	function showInRefs(index: number) {
		popups.hide();
		pendingRefFocus = index;
		viewer.showSidebarTab("references");
		if (refsFocus) refsFocus(index);
	}
	let linkToken = 0;

	const keyOf = (e: LinkClick) => `link:${e.page}:${e.rect.map((n) => Math.round(n)).join(",")}`;

	function isRefLink(e: LinkClick): boolean {
		if (e.target.kind !== "internal" || e.target.page === undefined || !isReady) return false;
		if (isInReferences(refStart, e.target.page, e.target.top)) return true;
		// some producers give odd destination heights: a numeric link landing on the page where the list starts still counts
		return !!refStart && e.target.page === refStart.page && parseCitationNumbers(e.text ?? "").length > 0;
	}

	async function citationContent(e: LinkClick): Promise<HTMLElement> {
		const dest = e.target.page!;
		const [refs, destText, srcText] = await Promise.all([api.refs(), pageText(dest), pageText(e.page)]);

		// text of the whole bracket group around the link ("[3, 5, 9]")
		let groupText = e.text ?? "";
		let nums = parseCitationNumbers(groupText);
		const ownNums = nums;
		const idx = charsInRect(srcText.rects, e.rect, 0.5);
		if (idx) {
			const g = expandCitationGroup(srcText.text, idx);
			const gn = parseCitationNumbers(g);
			if (gn.length >= nums.length) { groupText = g; nums = gn; }
		}
		const number = ownNums.length === 1 ? ownNums[0] : nums.length === 1 ? nums[0] : undefined;

		const res = resolveCitation({ refs, page: dest, top: e.target.top, pageText: destText, structure, number, maxY: refStart && dest === refStart.page ? refStart.y : undefined });
		const jumpRect = (): PdfRect => res.entry?.rect ?? [0, (e.target.top ?? 0) - 14, viewer.pages[dest]?.width ?? 600, (e.target.top ?? 0) + 4];

		if (nums.length > 1) {
			const list = h("div", { class: "rn-list", "data-testid": "rn-cite-list" });
			for (const n of nums) {
				let ref: Reference | null = n === number && res.ref ? res.ref : null;
				if (!ref) {
					// find the member's own bibliography entry (this page or the next) and match its text; the resolved
					// list's numbering can differ from the PDF's, so the index is only the fallback
					for (const p of [dest, dest + 1]) {
						if (p >= viewer.pages.length) break;
						const r = resolveCitation({ refs, page: p, top: undefined, pageText: p === dest ? destText : await pageText(p), number: n, maxY: refStart && p === refStart.page ? refStart.y : undefined });
						if (r.entry && r.ref) { ref = r.ref; break; }
					}
					ref ??= refs.find((r) => r.index === n) ?? null;
				}
				const head = h("div", { class: "rn-li-head" },
					h("span", { class: "rn-li-num" }, `[${n}]`),
					h("span", null, ref ? (ref.title ?? ref.raw ?? "") : "(not found in the resolved bibliography)",
						ref?.inLibraryKey ? h("span", { class: "rn-badge" }, "In library") : null),
				);
				const li = h("div", { class: "rn-li", "data-ref-index": String(n) }, head);
				let body: HTMLElement | null = null;
				li.addEventListener("click", () => {
					if (!ref) return;
					if (body) { body.remove(); body = null; return; }
					body = h("div", { class: "rn-li-body" }, buildRefCard(api, { ref, compact: true, onShowInRefs: showInRefs }));
					body.addEventListener("click", (ev) => ev.stopPropagation());
					li.append(body);
				});
				list.append(li);
			}
			return h("div", null, h("div", { class: "rn-meta" }, `${nums.length} references: ${groupText.trim()}`), list);
		}
		return buildRefCard(api, {
			ref: res.ref,
			rawText: res.entry?.text,
			onJump: () => jump(res.entry?.page ?? dest, jumpRect()),
			onShowInRefs: showInRefs,
		});
	}

	async function showCitation(e: LinkClick, pinned: boolean) {
		const token = ++linkToken;
		const content = await citationContent(e);
		if (token !== linkToken) return;
		popups.show(keyOf(e), { x: e.clientX, y: e.clientY }, content, pinned);
	}

	/** Where a citation link's (first) bibliography entry is, for clicking straight through to it. */
	async function citationTarget(e: LinkClick): Promise<{ page: number; rect: PdfRect }> {
		const dest = e.target.page!;
		const [refs, destText] = await Promise.all([api.refs(), pageText(dest)]);
		const number = parseCitationNumbers(e.text ?? "")[0];
		const res = resolveCitation({ refs, page: dest, top: e.target.top, pageText: destText, structure, number, maxY: refStart && dest === refStart.page ? refStart.y : undefined });
		const top = e.target.top ?? 0;
		return res.entry ? { page: res.entry.page, rect: res.entry.rect } : { page: dest, rect: [0, top - 14, viewer.pages[dest]?.width ?? 600, top + 4] };
	}

	// a click goes straight to the reference; hovering shows the popup
	own(viewer.onLink((e) => {
		if (!isRefLink(e)) return;
		e.preventDefault();
		linkToken++;
		popups.hide();
		void citationTarget(e).then((t) => jump(t.page, t.rect));
	}));
	own(viewer.onLinkHover((e) => {
		if (!e) { linkToken++; popups.scheduleHide(400); return; }
		if (!isRefLink(e)) return;
		void showCitation(e, false);
	}));

	// ---------------------------------------------------------------- where each numbered reference is cited
	type CiteSite = { page: number; rect: PdfRect };
	let citeIndex: Promise<Map<number, CiteSite[]>> | null = null;
	const add = (map: Map<number, CiteSite[]>, n: number, page: number, rect: PdfRect) => {
		const list = map.get(n) ?? [];
		// the same citation from a link annotation and from the structure: overlapping rects
		const overlaps = (r: PdfRect) => r[0] < rect[2] + 2 && rect[0] < r[2] + 2 && r[1] < rect[3] + 2 && rect[1] < r[3] + 2;
		if (!list.some((s) => s.page === page && overlaps(s.rect))) list.push({ page, rect });
		map.set(n, list);
	};

	/**
	 * Citation sites from the document structure: its paragraphs mark citations (rx-cite anchors) but carry no
	 * positions for them, so each anchor's text is found in the page text inside the paragraph's area, in order.
	 */
	async function structureCiteSites(): Promise<{ page: number; rect: PdfRect; nums: number[] }[]> {
		const out: { page: number; rect: PdfRect; nums: number[] }[] = [];
		for (const b of structure.blocks) {
			if (!b.html?.includes('data-kind="ref"') || b.type === "reference") continue;
			const anchors = [...b.html.matchAll(/<a class="rx-cite"[^>]*data-kind="ref"[^>]*>(.*?)<\/a>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").trim());
			if (!anchors.some((t) => /\d/.test(t))) continue;
			const pt = await pageText(b.page);
			let lo = Infinity, hi = -1;
			for (const r of b.rects) {
				const ix = charsInRect(pt.rects, r, 1);
				if (ix) { lo = Math.min(lo, ix[0]); hi = Math.max(hi, ix[1]); }
			}
			if (hi < 0) continue;
			let cursor = lo;
			for (const t of anchors) {
				if (!/\d/.test(t)) continue;
				const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
				const m = new RegExp(`(?<!\\d)${esc}(?!\\d)`, "g");
				m.lastIndex = cursor;
				const hit = m.exec(pt.text);
				if (!hit || hit.index > hi) continue;
				const idx: [number, number] = [hit.index, hit.index + hit[0].length];
				cursor = idx[1];
				let nums = parseCitationNumbers(t);
				const g = parseCitationNumbers(expandCitationGroup(pt.text, idx));
				if (g.length > nums.length) nums = g;
				const rect = unionRects(rangeRects(pt.rects, idx[0], idx[1]));
				if (rect && nums.length) out.push({ page: b.page, rect, nums });
			}
		}
		return out;
	}

	/** Reference number -> places in the text that cite it (from citation links, groups like "[3–5]" expanded). */
	function citationIndex(): Promise<Map<number, CiteSite[]>> {
		citeIndex ??= (async () => {
			await ready;
			const map = new Map<number, CiteSite[]>();
			const last = refStart ? refStart.page : viewer.pages.length - 1;
			for (let p = 0; p <= last; p++) {
				const [links, pt] = await Promise.all([viewer.pageLinks(p), pageText(p)]);
				for (const l of links) {
					if (!isRefLink({ page: p, rect: l.rect, target: l.target, text: l.text } as LinkClick)) continue;
					let nums = parseCitationNumbers(l.text ?? "");
					const idx = charsInRect(pt.rects, l.rect, 0.5);
					if (idx) {
						const g = parseCitationNumbers(expandCitationGroup(pt.text, idx));
						if (g.length > nums.length) nums = g;
					}
					for (const n of nums) add(map, n, p, l.rect);
				}
			}
			// citations found by the layout analysis (PDFs without link annotations have only these)
			for (const site of await structureCiteSites()) for (const n of site.nums) add(map, n, site.page, site.rect);
			for (const list of map.values()) list.sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
			return map;
		})();
		return citeIndex;
	}

	/** Where reference n is cited, each with the sentence around the citation; clicking one goes there. */
	async function citedByContent(n: number, sites: CiteSite[]): Promise<HTMLElement> {
		const label = (s: CiteSite) => `p. ${viewer.pages[s.page]?.label ?? s.page + 1}`;
		const shown = sites.slice(0, 12);
		const rows = await Promise.all(shown.map(async (s) => {
			const pt = await pageText(s.page);
			const idx = charsInRect(pt.rects, s.rect, 0.5);
			const ctx = idx ? sentenceAround(pt.text, idx) : null;
			const row = h("button", { class: "rn-ctx", type: "button", title: "Go to this citation" },
				h("span", { class: "rn-ctx-pg" }, label(s)),
				ctx ? h("span", null, ctx.before, h("mark", null, ctx.cite), ctx.after) : h("span", { class: "rn-note" }, "Go to citation"),
			);
			row.addEventListener("click", () => { popups.hide(); jump(s.page, s.rect, n); });
			return row;
		}));
		return h("div", { "data-testid": "rn-cited-by" },
			h("div", { class: "rn-title" }, `Reference ${n}`),
			sites.length
				? h("div", { class: "rn-meta" }, `Cited ${sites.length === 1 ? "once" : `${sites.length} times`} in this paper${sites.length > shown.length ? ` (first ${shown.length} shown)` : ""}`)
				: h("div", { class: "rn-note" }, "No citation links to this reference were found in the text."),
			rows.length ? h("div", { class: "rn-ctx-list" }, ...rows) : null,
		);
	}

	// ---------------------------------------------------------------- citations in the reading view (reflow/)
	// reflow dispatches 'reader-next:citation' {page, top, text, clientX, clientY, kind} for links in its text
	// (page/top = the link's destination); a click we handle is cancelled so reflow doesn't jump instead.
	const onReadingCite = (ev: Event) => {
		const d = (ev as CustomEvent).detail as { page: number; top?: number; text: string; clientX: number; clientY: number; kind: "hover" | "click" } | undefined;
		if (!d || !Number.isFinite(d.page)) return;
		const pinned = d.kind === "click"; // the reading view handles clicks itself now; kept for older senders
		const m = findFigureMentions(d.text)[0];
		const it = m && figItems.length ? findByKey(figItems, m.key) : undefined;
		if (it) {
			if (pinned) ev.preventDefault();
			popups.show(`rfig:${it.key}`, { x: d.clientX, y: d.clientY }, figureContent(it), pinned);
			return;
		}
		const e = {
			page: d.page, rect: [0, 0, 0, 0] as PdfRect, target: { kind: "internal" as const, page: d.page, top: d.top },
			text: d.text, clientX: d.clientX, clientY: d.clientY, preventDefault() { /* reflow event */ },
		} satisfies LinkClick;
		if (!isRefLink(e)) return;
		if (pinned) ev.preventDefault();
		void showCitation(e, pinned);
	};
	const onReadingLeave = () => { linkToken++; popups.scheduleHide(400); };
	// a bibliography entry hovered in the reading view: {text, index (1-based position), clientX, clientY}
	const onReadingBib = async (ev: Event) => {
		const d = (ev as CustomEvent).detail as { text: string; index: number; clientX: number; clientY: number } | undefined;
		if (!d) return;
		const n = markerOf(d.text) ?? d.index;
		const token = ++linkToken;
		const content = await citedByContent(n, (await citationIndex()).get(n) ?? []);
		if (token !== linkToken) return;
		popups.show(`rbib:${n}`, { x: d.clientX, y: d.clientY }, content, false);
	};
	const onReadingBibClick = async (ev: Event) => {
		const d = (ev as CustomEvent).detail as { text: string; index: number } | undefined;
		if (!d) return;
		const n = markerOf(d.text) ?? d.index;
		const s = (await citationIndex()).get(n)?.[0];
		linkToken++;
		popups.hide();
		if (s) jump(s.page, s.rect, n);
	};
	window.addEventListener("reader-next:citation", onReadingCite);
	window.addEventListener("reader-next:citation-leave", onReadingLeave);
	window.addEventListener("reader-next:bib-hover", onReadingBib);
	window.addEventListener("reader-next:bib-click", onReadingBibClick);
	own(() => {
		window.removeEventListener("reader-next:bib-hover", onReadingBib);
		window.removeEventListener("reader-next:bib-click", onReadingBibClick);
		window.removeEventListener("reader-next:citation", onReadingCite);
		window.removeEventListener("reader-next:citation-leave", onReadingLeave);
	});

	// ---------------------------------------------------------------- figure / supplementary / author-year hover targets
	function figureContent(it: FigItem): HTMLElement {
		const preview = h("div", { class: "rn-fig-preview" });
		void thumb(it, 400).then((el) => { if (el) preview.append(el); else preview.remove(); });
		return h("div", { "data-testid": "rn-fig-popup" },
			h("div", { class: "rn-title" }, it.label, h("span", { class: "rn-pg" }, `page ${viewer.pages[it.page]?.label ?? it.page + 1}`)),
			preview,
			it.caption ? h("div", { class: "rn-abs", style: { maxHeight: "170px" } }, it.caption) : h("div", { class: "rn-note" }, "No caption found."),
			h("div", { class: "rn-row" }, button(`Go to ${it.kind}`, () => { popups.hide(); jump(it.page, it.rect); }, { primary: true })),
		);
	}

	/** go: where a click on the mention leads (hover shows `content`). */
	type Hot = { rects: PdfRect[]; key: string; content: () => Promise<HTMLElement> | HTMLElement; go?: () => void };

	own(viewer.onPageOverlay((page, layer, toScreen) => {
		let alive = true;
		const nodes: HTMLElement[] = [];
		(async () => {
			const [pt] = await Promise.all([pageText(page), ready]);
			if (!alive || !pt.text) return;
			const lines = computeLines(pt.text, pt.rects);
			const hots: Hot[] = [];
			const covered: [number, number][] = [];
			const overlaps = (a: number, b: number) => covered.some(([s, e]) => a < e && b > s);
			const startsCaption = (i: number) => {
				const line = lines[lineAt(lines, i)];
				return !!line && i - line.start <= 2 && !!captionStart(line.text) ? line : null;
			};

			// figures & tables
			for (const m of findFigureMentions(pt.text)) {
				const it = figItems.length ? findByKey(figItems, m.key) : undefined;
				if (!it) continue;
				const capLine = startsCaption(m.start);
				// the caption's own label is not a mention
				if (capLine && it.page === page && it.caption && norm(it.caption).startsWith(norm(capLine.text).slice(0, 15))) continue;
				covered.push([m.start, m.end]);
				hots.push({ rects: rangeRects(pt.rects, m.start, m.end), key: `fig:${page}:${m.start}`, content: () => figureContent(it), go: () => jump(it.page, it.rect) });
			}
			// supplementary material
			for (const m of findSupplementaryMentions(pt.text)) {
				if (overlaps(m.start, m.end) || startsCaption(m.start)) continue;
				covered.push([m.start, m.end]);
				hots.push({ rects: rangeRects(pt.rects, m.start, m.end), key: `supp:${page}:${m.start}`, content: () => supp.mentionContent(m, () => popups.hide()) });
			}
			// author-year citations: only those resolving to a unique bibliography entry, outside the list itself
			if (!refStart || page <= refStart.page) {
				const refs = await api.refs();
				if (!alive) return;
				if (refs.some((r) => r.authors?.length && r.year)) {
					for (const ay of findAuthorYear(pt.text)) {
						if (overlaps(ay.start, ay.end)) continue;
						const y = lines[lineAt(lines, ay.start)]?.y2;
						if (refStart && page === refStart.page && (y === undefined || y <= refStart.y + 2)) continue;
						const ref = resolveAuthorYear(refs, ay);
						if (!ref) continue;
						hots.push({ rects: rangeRects(pt.rects, ay.start, ay.end), key: `ay:${page}:${ay.start}`, content: () => buildRefCard(api, { ref, onShowInRefs: showInRefs }) });
					}
				}
			}
			// bibliography entries: hover shows where the paper cites them, with jumps
			if (refStart && page >= refStart.page) {
				const cites = await citationIndex();
				if (!alive) return;
				for (const line of lines) {
					const n = markerOf(line.text);
					if (n === null || n === undefined || (page === refStart.page && line.y2 > refStart.y + 2)) continue;
					hots.push({ rects: [lineRect(line)], key: `bib:${page}:${n}`, content: () => citedByContent(n, cites.get(n) ?? []), go: () => { const s = cites.get(n)?.[0]; if (s) jump(s.page, s.rect, n); } });
				}
			}
			if (!alive) return;

			// in-text citation links: a coloured highlight under the PDF's own link (hover/click stay with the viewer)
			for (const l of await viewer.pageLinks(page)) {
				if (!alive) return;
				if (!isRefLink({ page, rect: l.rect, target: l.target, text: l.text } as LinkClick)) continue;
				const s = toScreen(l.rect);
				const el = h("div", { class: "rn-cite", style: { left: s.left + "px", top: s.top + "px", width: s.width + "px", height: s.height + "px" } });
				layer.append(el);
				nodes.push(el);
			}

			for (const hot of hots) {
				for (const r of hot.rects) {
					const s = toScreen(r);
					const el = h("div", {
						class: "rn-hot", "data-hot": hot.key,
						style: { left: s.left + "px", top: s.top + "px", width: s.width + "px", height: s.height + "px" },
					});
					let timer: ReturnType<typeof setTimeout> | undefined;
					el.addEventListener("pointerenter", (ev) => {
						popups.cancelHide();
						timer = setTimeout(async () => {
							const content = await hot.content();
							if (!alive) return;
							popups.show(hot.key, { x: ev.clientX, y: ev.clientY }, content, false);
						}, 220);
					});
					el.addEventListener("pointerleave", () => { clearTimeout(timer); popups.scheduleHide(350); });
					if (hot.go) {
						el.style.cursor = "pointer";
						el.addEventListener("click", () => { clearTimeout(timer); popups.hide(); hot.go!(); });
					}
					layer.append(el);
					nodes.push(el);
				}
			}
		})().catch((e) => console.warn("[academic] overlay failed:", e));
		return () => { alive = false; for (const n of nodes) n.remove(); };
	}));

	// ---------------------------------------------------------------- tabs
	/** A rendered crop of the figure/table region (label + caption only if rendering fails). */
	const thumb = async (it: FigItem, maxWidth: number): Promise<HTMLElement | null> => {
		try { return await viewer.renderRegion(it.page, it.area ?? it.rect, maxWidth); }
		catch { return null; }
	};

	own(viewer.addSidebarTab({
		id: "figures-tables", title: "Figures & Tables", icon: "image",
		render(container) {
			let alive = true;
			const scroll = h("div", { class: "rn-scroll" });
			const root = h("div", { class: "rn-tab", "data-testid": "rn-figures-tab" }, scroll);
			container.append(root);
			const draw = () => {
				if (!alive) return;
				scroll.textContent = "";
				if (!isReady) { scroll.append(h("div", { class: "rn-empty" }, "Analysing document…")); return; }
				if (!figItems.length) { scroll.append(h("div", { class: "rn-empty" }, "No figures or tables were detected in this PDF.")); return; }
				for (const [title, kind] of [["Figures", "figure"], ["Tables", "table"]] as const) {
					const list = figItems.filter((i) => i.kind === kind);
					if (!list.length) continue;
					scroll.append(h("div", { class: "rn-sec" }, `${title} (${list.length})`));
					for (const it of list) {
						const th = h("div", { class: "rn-thumb rn-thumb-lg" }, kind === "figure" ? "▦" : "▤");
						void thumb(it, 300).then((el) => { if (el && alive) { th.textContent = ""; th.append(el); } });
						const row = h("div", { class: "rn-item rn-figitem", tabindex: "0", role: "button", "data-key": it.key ?? "" },
							th,
							h("div", { class: "rn-grow" },
								h("div", { class: "rn-lbl" }, it.label, h("span", { class: "rn-pg" }, `p. ${viewer.pages[it.page]?.label ?? it.page + 1}`)),
								it.caption ? h("div", { class: "rn-cap" }, it.caption.replace(/^\s*(?:Supplementary\s+)?(?:Figure|Fig\.?|Table)\s*S?\d+\s*[.:|]?\s*/i, "")) : null,
							),
						);
						const go = () => jump(it.page, it.rect);
						row.addEventListener("click", go);
						row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
						scroll.append(row);
					}
				}
			};
			draw();
			figListeners.add(draw);
			return () => { alive = false; figListeners.delete(draw); root.remove(); };
		},
	}));

	own(viewer.addSidebarTab({
		id: "references", title: "References", icon: "quote",
		render(container) {
			let alive = true;
			let loaded = false;
			let refs: Reference[] = [];
			const input = h("input", { class: "rn-input", type: "search", placeholder: "Filter references", "aria-label": "Filter references" });
			const scroll = h("div", { class: "rn-scroll" }, h("div", { class: "rn-empty" }, "Loading…"));
			const refresh = button("Refresh", () => void load(true));
			const root = h("div", { class: "rn-tab", "data-testid": "rn-references-tab" }, h("div", { class: "rn-tab-head" }, input, refresh), scroll);
			container.append(root);

			async function jumpToEntry(r: Reference) {
				const se = structure.references.find((e) => e.index === r.index);
				if (se && se.rects[0]) return jump(se.page, se.rects[0]);
				await ready;
				const start = refStart?.page ?? 0;
				for (let p = start; p < viewer.pages.length; p++) {
					const t = await pageText(p);
					const hit = computeLines(t.text, t.rects).find((l) => markerOf(l.text) === r.index && (p > start || !refStart || l.y2 <= refStart.y));
					if (hit) return jump(p, lineRect(hit));
				}
			}

			function rowFor(r: Reference): HTMLElement {
				const meta = [r.authors?.[0] && (r.authors.length > 1 ? `${r.authors[0]} et al.` : r.authors[0]), r.year, r.venue].filter(Boolean).join(" · ");
				const row = h("div", { class: "rn-item", tabindex: "0", role: "button", "data-ref-index": String(r.index), style: { flexWrap: "wrap" } },
					h("span", { class: "rn-li-num" }, `[${r.index}]`),
					h("div", { class: "rn-grow" },
						h("div", { class: "rn-lbl", style: { fontWeight: "500" } }, r.title ?? r.raw ?? "", r.inLibraryKey ? h("span", { class: "rn-badge" }, "In library") : null),
						meta ? h("div", { class: "rn-cap", style: { WebkitLineClamp: "1" } }, meta) : null,
					),
				);
				let body: HTMLElement | null = null;
				const toggle = () => {
					if (body) { body.remove(); body = null; return; }
					body = h("div", { style: { flexBasis: "100%", paddingLeft: "2.4em" } }, buildRefCard(api, {
						ref: r, compact: true, onJump: () => void jumpToEntry(r),
						onChange: () => row.querySelector(".rn-lbl")?.append(r.inLibraryKey && !row.querySelector(".rn-badge") ? h("span", { class: "rn-badge" }, "In library") : ""),
						onShowInRefs: undefined,
					}));
					body.addEventListener("click", (ev) => ev.stopPropagation());
					row.append(body);
				};
				row.addEventListener("click", toggle);
				row.addEventListener("keydown", (ev) => { if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); toggle(); } });
				return row;
			}

			function draw() {
				if (!alive) return;
				const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
				scroll.textContent = "";
				const shown = refs.filter((r) => !q.length || q.every((t) => [r.index, r.title, r.raw, r.authors?.join(" "), r.year, r.venue, r.doi].filter((x) => x != null).join(" ").toLowerCase().includes(t)));
				if (!refs.length) scroll.append(h("div", { class: "rn-empty" }, "No bibliography could be resolved for this paper."));
				else if (!shown.length) scroll.append(h("div", { class: "rn-empty" }, "No matches."));
				for (const r of shown) scroll.append(rowFor(r));
			}
			async function load(force: boolean) {
				scroll.textContent = "";
				scroll.append(h("div", { class: "rn-empty" }, force ? "Refreshing…" : "Loading…"));
				try { refs = force ? (await api.refList(true)).references : await api.refs(); }
				catch { refs = []; }
				loaded = true;
				draw();
				if (pendingRefFocus !== null) refsFocus?.(pendingRefFocus);
			}
			input.addEventListener("input", draw);
			void load(false);

			refsFocus = (index) => {
				if (!loaded) return; // applied by load() when the list arrives
				pendingRefFocus = null;
				input.value = "";
				draw();
				const el = scroll.querySelector<HTMLElement>(`[data-ref-index="${index}"]`);
				el?.scrollIntoView({ block: "center" });
				el?.classList.add("rn-flash");
				setTimeout(() => el?.classList.remove("rn-flash"), 1600);
			};
			return () => { alive = false; refsFocus = null; root.remove(); };
		},
	}));

	own(viewer.addSidebarTab({ id: "supplementary", title: "Supplementary", icon: "paperclip", render: (c) => supp.renderTab(c) }));

	return () => { for (const d of disposers.splice(0).reverse()) { try { d(); } catch { /* ignore */ } } };
};
