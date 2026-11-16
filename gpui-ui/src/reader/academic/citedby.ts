// "Cited in this paper": for every numbered reference, the places in the text that cite it (reader-next/src/academic/index.ts
// citationIndex). Sources: the PDF's citation links (a link whose destination is the bibliography), "[3, 5-7]" groups found in the page
// text, and the citations the layout analysis marks in the paragraphs (PDFs without link annotations have only these).
import type { ReaderContext } from "../plugins";
import { fromNRect } from "../structure/pagetext";
import type { DocStructure, PdfRect } from "../structure/types";
import { expandCitationGroup, isInReferences, parseCitationNumbers, type RefStart } from "./citations";
import { charsInRect, rangeRects, unionRects } from "./textlines";

export interface CiteSite {
	page: number;
	rect: PdfRect;
}
export type CiteIndex = Map<number, CiteSite[]>;

interface Deps {
	ctx: ReaderContext;
	pageText(i: number): Promise<{ text: string; rects: PdfRect[] }>;
	structure(): DocStructure;
	refStart(): RefStart | null;
}

const BRACKET_GROUP = /\[\s*\d{1,3}(?:\s*[,;–—−\-]\s*\d{1,3})*\s*\]/g;

const overlaps = (a: PdfRect, b: PdfRect) => a[0] < b[2] + 2 && b[0] < a[2] + 2 && a[1] < b[3] + 2 && b[1] < a[3] + 2;

export async function buildCiteIndex(d: Deps): Promise<CiteIndex> {
	const map: CiteIndex = new Map();
	const add = (n: number, page: number, rect: PdfRect) => {
		const list = map.get(n) ?? [];
		// the same citation from a link, from the page text and from the structure: overlapping rects
		if (!list.some((s) => s.page === page && overlaps(s.rect, rect))) list.push({ page, rect });
		map.set(n, list);
	};
	const rs = d.refStart();
	const last = rs ? rs.page : d.ctx.pageCount() - 1;
	for (let p = 0; p <= last; p++) {
		const [links, pt] = await Promise.all([d.ctx.pageLinks?.(p).catch(() => []) ?? Promise.resolve([]), d.pageText(p)]);
		const size = d.ctx.pageSize(p);
		const covered: PdfRect[] = [];
		for (const l of links) {
			if (l.target.kind !== "page") continue;
			const rect = fromNRect(l.rect, size.w, size.h);
			const idx = charsInRect(pt.rects, rect, 0.5);
			const text = idx ? pt.text.slice(idx[0], idx[1]) : "";
			const dsize = d.ctx.pageSize(l.target.page);
			const top = l.target.y >= 0 ? (1 - l.target.y) * dsize.h : undefined;
			if (!(isInReferences(rs, l.target.page, top) || (!!rs && l.target.page === rs.page && parseCitationNumbers(text).length > 0)))
				continue;
			let nums = parseCitationNumbers(text);
			if (idx) {
				const gn = parseCitationNumbers(expandCitationGroup(pt.text, idx));
				if (gn.length >= nums.length) nums = gn;
			}
			for (const n of nums) add(n, p, rect);
			covered.push(rect);
		}
		// "[3, 5-7]" groups with no link
		BRACKET_GROUP.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = BRACKET_GROUP.exec(pt.text))) {
			const rect = unionRects(rangeRects(pt.rects, m.index, m.index + m[0].length));
			if (!rect || covered.some((c) => overlaps(c, rect))) continue;
			if (rs && p === rs.page && rect[3] <= rs.y + 2) continue; // inside the bibliography itself
			for (const n of parseCitationNumbers(m[0])) add(n, p, rect);
		}
	}
	// citations marked by the layout analysis: the paragraphs carry the anchors but no positions, so each anchor's text is found in the
	// page text inside the paragraph's area, in order
	for (const b of d.structure().blocks) {
		if (!b.html?.includes('data-kind="ref"') || b.type === "reference") continue;
		const anchors = [...b.html.matchAll(/<a class="rx-cite"[^>]*data-kind="ref"[^>]*>(.*?)<\/a>/g)].map((m) =>
			m[1]!.replace(/<[^>]*>/g, "").trim(),
		);
		if (!anchors.some((t) => /\d/.test(t))) continue;
		const pt = await d.pageText(b.page);
		let lo = Infinity,
			hi = -1;
		for (const r of b.rects) {
			const ix = charsInRect(pt.rects, r, 1);
			if (ix) {
				lo = Math.min(lo, ix[0]);
				hi = Math.max(hi, ix[1]);
			}
		}
		if (hi < 0) continue;
		let cursor = lo;
		for (const t of anchors) {
			if (!/\d/.test(t)) continue;
			const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
			const re = new RegExp(`(?<!\\d)${esc}(?!\\d)`, "g");
			re.lastIndex = cursor;
			const hit = re.exec(pt.text);
			if (!hit || hit.index > hi) continue;
			const idx: [number, number] = [hit.index, hit.index + hit[0].length];
			cursor = idx[1];
			let nums = parseCitationNumbers(t);
			const g = parseCitationNumbers(expandCitationGroup(pt.text, idx));
			if (g.length > nums.length) nums = g;
			const rect = unionRects(rangeRects(pt.rects, idx[0], idx[1]));
			if (rect) for (const n of nums) add(n, b.page, rect);
		}
	}
	for (const list of map.values()) list.sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
	return map;
}
