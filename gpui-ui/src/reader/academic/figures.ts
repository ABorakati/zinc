// Figure & table index: from DocStructure when available, else from caption lines found in the page text.
import type { DocStructure, PdfRect } from "../structure/types";
import { captionStart, labelKey } from "./mentions";
import { computeLines, joinLines, lineRect, unionRects, type Line } from "./textlines";

export interface FigItem {
	id: string;
	kind: "figure" | "table";
	label: string; // "Figure 2" (or "Figure" / "Table" when unlabeled)
	key: string | null; // "figure:2"
	page: number;
	rect: PdfRect; // area to reveal (the figure/table; the caption in scanned mode)
	area?: PdfRect; // scanned mode: estimated figure/table body (for previews), caption included
	caption?: string;
	scanned?: boolean;
}

export function indexFromStructure(s: DocStructure | null | undefined): FigItem[] {
	if (!s) return [];
	const byId = new Map(s.blocks.map((b) => [b.id, b]));
	const out: FigItem[] = [];
	for (const f of [...s.figures, ...s.tables]) {
		const cap = f.caption ?? (f.captionBlockId ? byId.get(f.captionBlockId)?.text : undefined);
		const key = labelKey(f.label) ?? labelKey(cap);
		// unlabelled pieces are mostly continuation fragments of a labelled table; they would only clutter the list
		if (!key) continue;
		const label = key
			? (f.kind === "figure" ? "Figure " : "Table ") + key.split(":")[1]
			: (f.label ?? (f.kind === "figure" ? "Figure" : "Table"));
		out.push({ id: f.id, kind: f.kind, label, key, page: f.page, rect: f.rect, caption: cap?.trim() || undefined });
	}
	return sortItems(out);
}

export function sortItems(items: FigItem[]): FigItem[] {
	return [...items].sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3]);
}

/** Caption paragraphs ("Figure 1. ...") of one page. */
export function scanCaptionsInPage(page: number, pt: { text: string; rects: PdfRect[] }): FigItem[] {
	const lines = computeLines(pt.text, pt.rects);
	const out: FigItem[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		const cs = captionStart(l.text);
		if (!cs) continue;
		// "Supplementary Table S1." ending a wrapped sentence is not a caption: bare label needs a capitalised continuation
		if (!l.text.slice(cs.end).trim()) {
			const nx = lines[i + 1];
			if (!nx || !/^[A-Z“"(]/.test(nx.text.trim())) continue;
		}
		const lh = Math.max(l.y2 - l.y1, 6);
		const ext = [l];
		for (let j = i + 1; j < lines.length && ext.length < 7; j++) {
			const n = lines[j]!;
			const p = ext[ext.length - 1]!;
			if (n.y2 > p.y2 + lh * 0.5 || p.y1 - n.y2 > lh * 1.3) break;
			if (Math.abs(n.y2 - n.y1 - lh) > lh * 0.25) break;
			if (captionStart(n.text)) break;
			if (Math.abs(n.x1 - l.x1) > 40) break;
			// table captions sit directly above the table body (same font): stop once the title sentence is complete
			if (cs.kind === "table" && (/[.]\s*$/.test(p.text) || ext.length >= 3)) break;
			ext.push(n);
		}
		const rect = unionRects(ext.map(lineRect))!;
		const area = guessArea(lines, rect, cs.kind);
		out.push({
			id: `scan-${page}-${i}`,
			kind: cs.kind,
			label: cs.label,
			key: cs.key,
			page,
			rect,
			area,
			caption: joinLines(ext),
			scanned: true,
		});
	}
	return out;
}

/**
 * Estimate the figure/table body next to a caption from the page's text lines alone: figures sit
 * above their caption up to the nearest body-text line, tables below it down to a large gap before
 * body text (or the next caption). The result includes the caption. Undefined if nothing plausible.
 */
export function guessArea(lines: Line[], cap: PdfRect, kind: "figure" | "table"): PdfRect | undefined {
	if (!lines.length) return undefined;
	const hs = lines.map((l) => l.y2 - l.y1).sort((a, b) => a - b);
	const body = hs[hs.length >> 1] || 10;
	const [left, , right] = cap;
	const colW = Math.max(right - left, 1);
	const inCol = (l: Line) => Math.min(l.x2, right) - Math.max(l.x1, left) > 0;
	const isBody = (l: Line) => inCol(l) && Math.abs(l.y2 - l.y1 - body) < body * 0.2 && l.x2 - l.x1 > colW * 0.85;
	const pageTop = Math.max(...lines.map((l) => l.y2)) + 4;
	const pageBottom = Math.min(...lines.map((l) => l.y1)) - 4;
	if (kind === "figure") {
		const above = lines
			.filter((l) => l.y1 >= cap[3] - 1 && (isBody(l) || (inCol(l) && captionStart(l.text))))
			.sort((a, b) => a.y1 - b.y1)[0];
		const top = above ? above.y1 - 2 : pageTop;
		return top - cap[3] >= body * 3 ? [left - 4, cap[1] - 2, right + 4, top] : undefined;
	}
	let bottom = pageBottom;
	let prev = cap[1];
	for (const l of lines.filter((x) => inCol(x) && x.y2 <= cap[1] + 1).sort((a, b) => b.y2 - a.y2)) {
		if (captionStart(l.text)) {
			bottom = l.y2 + 2;
			break;
		}
		if (prev - l.y2 > body * 2.2 && isBody(l)) {
			bottom = prev - 2;
			break;
		}
		prev = l.y1;
	}
	return cap[1] - bottom >= body * 2 ? [left - 4, bottom, right + 4, cap[3] + 2] : undefined;
}

/** Structure items first; scanned captions fill in labels the structure does not have. */
export function mergeIndex(structured: FigItem[], scanned: FigItem[]): FigItem[] {
	const have = new Set(structured.map((i) => i.key).filter(Boolean));
	const extra: FigItem[] = [];
	for (const s of scanned) {
		if (s.key && have.has(s.key)) continue;
		if (s.key) have.add(s.key);
		extra.push(s);
	}
	return sortItems([...structured, ...extra]);
}

export function findByKey(items: FigItem[], key: string): FigItem | undefined {
	return items.find((i) => i.key === key);
}
