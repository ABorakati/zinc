// academic/ plugin entry (see ../contract.ts): citation popups, figures & tables navigator, references tab,
// supplementary files tab. Uses only ViewerHandle + structure/load.ts; vanilla DOM so it needs no UI framework.
import type { DocStructure, LinkClick, PdfRect, ReaderPlugin } from "../contract";
import { loadStructure } from "../structure/load";
import { createApi, type Reference } from "./api";
import { buildRefCard } from "./card";
import {
	expandCitationGroup, findRefStartInPages, isInReferences, markerOf, parseCitationNumbers,
	refStartFromStructure, resolveAuthorYear, resolveCitation, type RefStart,
} from "./citations";
import { button, h, PopupManager, useStyles } from "./dom";
import { findByKey, indexFromStructure, mergeIndex, scanCaptionsInPage, type FigItem } from "./figures";
import { captionStart, findAuthorYear, findFigureMentions, findSupplementaryMentions } from "./mentions";
import { createSupplement } from "./supplement";
import { charsInRect, computeLines, lineAt, lineRect, rangeRects } from "./textlines";

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
	/** Jump somewhere remembering where we were. */
	function jump(page: number, rect: PdfRect) {
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
			if (back.length && goBack()) e.preventDefault();
		}
		else if (e.key === "ArrowLeft" && e.altKey && back.length) {
			if (goBack()) e.preventDefault();
		}
	};
	window.addEventListener("keydown", onKey, true);
	own(() => window.removeEventListener("keydown", onKey, true));

	// ---------------------------------------------------------------- citation popups
	let refsFocus: ((index: number) => void) | null = null;
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
					body = h("div", { class: "rn-li-body" }, buildRefCard(api, { ref, compact: true, onShowInRefs: (i) => refsFocus?.(i) }));
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
			onJump: () => jump(dest, jumpRect()),
			onShowInRefs: (i) => refsFocus?.(i),
		});
	}

	async function showCitation(e: LinkClick, pinned: boolean) {
		const token = ++linkToken;
		const content = await citationContent(e);
		if (token !== linkToken) return;
		popups.show(keyOf(e), { x: e.clientX, y: e.clientY }, content, pinned);
	}

	own(viewer.onLink((e) => {
		if (!isRefLink(e)) return;
		e.preventDefault();
		void showCitation(e, true);
	}));
	own(viewer.onLinkHover((e) => {
		if (!e) { linkToken++; popups.scheduleHide(400); return; }
		if (!isRefLink(e)) return;
		void showCitation(e, false);
	}));

	// ---------------------------------------------------------------- figure / supplementary / author-year hover targets
	function figureContent(it: FigItem): HTMLElement {
		return h("div", { "data-testid": "rn-fig-popup" },
			h("div", { class: "rn-title" }, it.label, h("span", { class: "rn-pg" }, `page ${viewer.pages[it.page]?.label ?? it.page + 1}`)),
			it.caption ? h("div", { class: "rn-abs", style: { maxHeight: "170px" } }, it.caption) : h("div", { class: "rn-note" }, "No caption found."),
			h("div", { class: "rn-row" }, button(`Go to ${it.kind}`, () => { popups.hide(); jump(it.page, it.rect); }, { primary: true })),
		);
	}

	type Hot = { rects: PdfRect[]; key: string; content: () => Promise<HTMLElement> | HTMLElement };

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
				hots.push({ rects: rangeRects(pt.rects, m.start, m.end), key: `fig:${page}:${m.start}`, content: () => figureContent(it) });
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
						hots.push({ rects: rangeRects(pt.rects, ay.start, ay.end), key: `ay:${page}:${ay.start}`, content: () => buildRefCard(api, { ref, onShowInRefs: (i) => refsFocus?.(i) }) });
					}
				}
			}
			if (!alive) return;

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
					layer.append(el);
					nodes.push(el);
				}
			}
		})().catch((e) => console.warn("[academic] overlay failed:", e));
		return () => { alive = false; for (const n of nodes) n.remove(); };
	}));

	// ---------------------------------------------------------------- tabs
	/** Thumbnail via an optional viewer.renderRegion(page, rect, maxWidth) extension; label + caption only otherwise. */
	const thumb = async (it: FigItem): Promise<HTMLElement | null> => {
		const fn = (viewer as unknown as { renderRegion?: (page: number, rect: PdfRect, maxWidth: number) => Promise<unknown> }).renderRegion;
		if (typeof fn !== "function") return null;
		try {
			const out = await fn.call(viewer, it.page, it.rect, 128);
			if (out instanceof HTMLCanvasElement || out instanceof HTMLImageElement) return out;
			if (typeof out === "string") return h("img", { src: out, alt: "" });
			if (out instanceof Blob) return h("img", { src: URL.createObjectURL(out), alt: "" });
			if (typeof ImageBitmap !== "undefined" && out instanceof ImageBitmap) {
				const c = document.createElement("canvas");
				c.width = out.width;
				c.height = out.height;
				c.getContext("2d")?.drawImage(out, 0, 0);
				return c;
			}
		}
		catch { /* label only */ }
		return null;
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
						const th = h("div", { class: "rn-thumb" }, kind === "figure" ? "▦" : "▤");
						void thumb(it).then((el) => { if (el && alive) { th.textContent = ""; th.append(el); } });
						const row = h("div", { class: "rn-item", tabindex: "0", role: "button", "data-key": it.key ?? "" },
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
				draw();
			}
			input.addEventListener("input", draw);
			void load(false);

			refsFocus = (index) => {
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
