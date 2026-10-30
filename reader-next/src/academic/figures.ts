// Figure & table index: from DocStructure when available, else from caption lines found in the page text.
import type { DocStructure, PdfRect } from "../contract";
import { captionStart, labelKey } from "./mentions";
import { computeLines, joinLines, lineRect, unionRects } from "./textlines";

export interface FigItem {
	id: string;
	kind: "figure" | "table";
	label: string; // "Figure 2" (or "Figure" / "Table" when unlabeled)
	key: string | null; // "figure:2"
	page: number;
	rect: PdfRect; // area to reveal (the figure/table; the caption in scanned mode)
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
		const label = key ? (f.kind === "figure" ? "Figure " : "Table ") + key.split(":")[1] : f.label ?? (f.kind === "figure" ? "Figure" : "Table");
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
			if (Math.abs((n.y2 - n.y1) - lh) > lh * 0.25) break;
			if (captionStart(n.text)) break;
			if (Math.abs(n.x1 - l.x1) > 40) break;
			// table captions sit directly above the table body (same font): stop once the title sentence is complete
			if (cs.kind === "table" && (/[.]\s*$/.test(p.text) || ext.length >= 3)) break;
			ext.push(n);
		}
		const rect = unionRects(ext.map(lineRect))!;
		out.push({ id: `scan-${page}-${i}`, kind: cs.kind, label: cs.label, key: cs.key, page, rect, caption: joinLines(ext), scanned: true });
	}
	return out;
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
