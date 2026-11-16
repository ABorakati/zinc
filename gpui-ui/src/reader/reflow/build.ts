// DocStructure -> a flat list of renderable items for the reading view. Pure (no DOM).
import type { Block, DocStructure, FigureOrTable, PdfRect } from "../structure/types";

export type ReflowItem =
	| { kind: "title"; id: string; blockIds: string[]; page: number; html: string }
	| { kind: "heading"; id: string; blockIds: string[]; page: number; level: number; html: string }
	| { kind: "para"; id: string; blockIds: string[]; page: number; html: string }
	| { kind: "list"; id: string; blockIds: string[]; page: number; html: string }
	| { kind: "code"; id: string; blockIds: string[]; page: number; text: string }
	| { kind: "equation"; id: string; blockIds: string[]; page: number; rect: PdfRect; text: string }
	| {
			kind: "figure";
			id: string;
			blockIds: string[];
			page: number;
			rect: PdfRect;
			type: "figure" | "table";
			label?: string;
			captionHtml: string;
			wide: boolean;
	  }
	| { kind: "notes"; id: string; blockIds: string[]; page: number; html: string[] }
	| { kind: "refs"; id: string; blockIds: string[]; page: number; entries: { id: string; html: string; page: number }[] };

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const stripTags = (h: string) => h.replace(/<[^>]*>/g, "");

/** Remove soft hyphens and join leftover "hy-\nphen" line breaks; collapse whitespace. */
export function dehyphenate(s: string): string {
	return s
		.replace(/­/g, "")
		.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, "$1$2")
		.replace(/[ \t]*\r?\n[ \t]*/g, " ");
}

/** Join the end of a paragraph with the start of its continuation (next column or page). */
export function joinHtml(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	const ta = stripTags(a);
	const tb = stripTags(b);
	// "informa-" + "tion" -> "information" (only when the next fragment starts lower-case)
	if (/\p{L}-$/u.test(ta) && /^\p{Ll}/u.test(tb)) return a.replace(/-((?:<\/[^>]+>)*)$/, "$1") + b;
	if (/\s$/.test(ta) || /^\s/.test(tb)) return a + b;
	return a + " " + b;
}

/**
 * Does this paragraph continue in the next fragment (so the next paragraph should be joined to it)?
 * crossBreak: the next fragment starts in another column or on another page, where an unfinished
 * sentence ("…the European Society for" | "Organ Transplantation…") continues even before a capital.
 */
export function continuesInto(prevText: string, nextText: string, crossBreak = false): boolean {
	const p = prevText.trimEnd();
	const n = nextText.trimStart();
	if (!p || !n) return false;
	const unfinished = !/[.!?:;…"”')\]]$/.test(p);
	if (crossBreak && unfinished && /^[\p{L}\d(“"]/u.test(n)) return true;
	if (!/^\p{Ll}/u.test(n)) return false; // a new sentence/paragraph starts with a capital, digit or symbol
	if (/\p{L}-$/u.test(p)) return true;
	return unfinished;
}

/**
 * Some PDFs (Elsevier's math fonts among them) map "=" to the glyph "¼" in their text layer:
 * "N ¼ 88". A spaced "¼" between words or numbers is that "=".
 * Others keep ligature characters (U+FB01 for "fi"). Reading fonts mostly lack these code points, so each would be
 * drawn in a fallback font; as plain letters the reading font draws them, with its own ligature where it has one.
 */
export function fixGlyphs(s: string): string {
	return s
		.replace(/(\s)(?:¼|1⁄4)(?=\s)/g, "$1=") // also its normalised form, 1 U+2044 4
		.replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC"));
}

const isTiny = (r: PdfRect) => r[2] - r[0] < 36 || r[3] - r[1] < 24;

export function buildItems(doc: DocStructure): ReflowItem[] {
	const out: ReflowItem[] = [];
	const figById = new Map<string, FigureOrTable>();
	for (const f of [...doc.figures, ...doc.tables]) figById.set(f.id, f);
	const blockById = new Map<string, Block>();
	for (const b of doc.blocks) blockById.set(b.id, b);

	let lastPara: (ReflowItem & { kind: "para" }) | null = null;
	let notes: { html: string; id: string; page: number }[] = [];
	let refs: (ReflowItem & { kind: "refs" }) | null = null;

	const html = (b: Block) => fixGlyphs(dehyphenate(b.html || escapeHtml(b.text)));
	let lastParaBlock: Block | null = null;
	/** b starts on another page or in another column than the previous paragraph fragment. */
	const crossBreak = (b: Block) => {
		const prev = lastParaBlock;
		if (!prev) return false;
		if (prev.page !== b.page) return true;
		const px = prev.rects[0]?.[0],
			bx = b.rects[0]?.[0];
		return px !== undefined && bx !== undefined && Math.abs(px - bx) > 100;
	};
	const flushNotes = () => {
		if (!notes.length) return;
		out.push({
			kind: "notes",
			id: "n" + notes[0].id,
			blockIds: notes.map((n) => n.id),
			page: notes[0].page,
			html: notes.map((n) => n.html),
		});
		notes = [];
	};

	for (const b of doc.blocks) {
		if (b.type !== "reference") refs = null;
		switch (b.type) {
			case "header":
			case "footer":
				break; // running heads, page numbers
			case "title":
				out.push({ kind: "title", id: "r" + b.id, blockIds: [b.id], page: b.page, html: html(b) });
				lastPara = null;
				break;
			case "heading":
				flushNotes();
				out.push({
					kind: "heading",
					id: "r" + b.id,
					blockIds: [b.id],
					page: b.page,
					level: Math.min(Math.max(b.level ?? 2, 1), 5),
					html: html(b),
				});
				lastPara = null;
				break;
			case "paragraph": {
				const h = html(b);
				if (lastPara && continuesInto(stripTags(lastPara.html), stripTags(h), crossBreak(b))) {
					lastPara.html = joinHtml(lastPara.html, h);
					lastPara.blockIds.push(b.id);
				} else {
					lastPara = { kind: "para", id: "r" + b.id, blockIds: [b.id], page: b.page, html: h };
					out.push(lastPara);
				}
				lastParaBlock = b;
				break;
			}
			case "list":
				out.push({
					kind: "list",
					id: "r" + b.id,
					blockIds: [b.id],
					page: b.page,
					html: fixGlyphs(b.html || `<p>${escapeHtml(b.text)}</p>`),
				});
				lastPara = null;
				break;
			case "other":
				if (b.text.trim()) out.push({ kind: "code", id: "r" + b.id, blockIds: [b.id], page: b.page, text: fixGlyphs(b.text) });
				break;
			case "equation": {
				const r = b.rects[0];
				if (r)
					out.push({ kind: "equation", id: "r" + b.id, blockIds: [b.id], page: b.page, rect: [...r] as PdfRect, text: b.text });
				lastPara = null; // text after an equation is a new paragraph
				break;
			}
			case "figure":
			case "table": {
				const f = figById.get(b.id);
				const rect = f?.rect ?? b.rects[0];
				if (!rect || (!f && isTiny(rect))) break; // logos, rules
				const cap = f?.captionBlockId ? blockById.get(f.captionBlockId) : undefined;
				out.push({
					kind: "figure",
					id: "r" + b.id,
					blockIds: [b.id, ...(cap ? [cap.id] : [])],
					page: b.page,
					rect: [...rect] as PdfRect,
					type: f?.kind ?? (b.type === "table" ? "table" : "figure"),
					label: f?.label,
					captionHtml: cap ? html(cap) : "",
					wide: rect[2] - rect[0] > 330,
				});
				break;
			}
			case "caption":
				if (b.captionOf) break; // rendered with its figure (or panel text inside the figure)
				out.push({ kind: "para", id: "r" + b.id, blockIds: [b.id], page: b.page, html: `<i>${html(b)}</i>` });
				break;
			case "footnote":
				notes.push({ html: html(b), id: b.id, page: b.page });
				break;
			case "reference": {
				if (!refs) {
					refs = { kind: "refs", id: "r" + b.id, blockIds: [], page: b.page, entries: [] };
					out.push(refs);
				}
				refs.blockIds.push(b.id);
				refs.entries.push({ id: b.id, html: html(b), page: b.page });
				lastPara = null;
				break;
			}
			default:
				break;
		}
	}
	flushNotes();
	return out;
}

/**
 * Which candidate (an item, or one bibliography entry) a link destination (page, PDF y of its top) lands in.
 * A block rect containing `top` wins, the candidate with the fewest blocks first (an entry beats its whole list);
 * otherwise the block top nearest to `top` on that page; with no `top`, the highest block on the page. -1 if
 * no candidate has a block on that page.
 */
export function bestTarget(cands: { blocks: Block[] }[], page: number, top?: number): number {
	let best = -1;
	let bestScore = Infinity;
	cands.forEach((c, i) => {
		for (const b of c.blocks) {
			if (b.page !== page) continue;
			for (const r of b.rects) {
				const score =
					(top === undefined ? -r[3] : top <= r[3] + 3 && top >= r[1] - 3 ? -1e6 : Math.abs(r[3] - top)) + c.blocks.length * 1e-3; // ties: the more specific candidate
				if (score < bestScore) {
					bestScore = score;
					best = i;
				}
			}
		}
	});
	return best;
}

export interface TocEntry {
	id: string;
	text: string;
	level: number;
}

/**
 * Contents for the reading view, from the headings the layout analysis detected (works without PDF bookmarks).
 * Levels are made relative (the top level found becomes 1, at most 3 levels). Over-long "headings" are paragraphs
 * the analysis misjudged and are skipped; the reference list gets an entry if no heading already names it.
 */
export function tocEntries(items: ReflowItem[]): TocEntry[] {
	const out: TocEntry[] = [];
	let refsNamed = false;
	for (const it of items) {
		if (it.kind === "heading") {
			const text = stripTags(it.html).replace(/\s+/g, " ").trim();
			if (!text || text.length > 120) continue;
			if (/^(references|bibliography|works cited|literature cited)\b/i.test(text)) refsNamed = true;
			out.push({ id: it.id, text, level: it.level });
		} else if (it.kind === "refs" && !refsNamed) {
			out.push({ id: it.id, text: "References", level: 0 });
			refsNamed = true;
		}
	}
	const real = out.filter((e) => e.level > 0).map((e) => e.level);
	const top = real.length ? Math.min(...real) : 1;
	for (const e of out) e.level = e.level === 0 ? 1 : Math.min(e.level - top + 1, 3);
	return out;
}

/** First item that starts on or after `page` (0-based). */
export function firstItemOnPage<T extends { page: number }>(items: T[], page: number): number {
	const i = items.findIndex((it) => it.page === page);
	if (i >= 0) return i;
	const j = items.findIndex((it) => it.page > page);
	return j >= 0 ? j : Math.max(0, items.length - 1);
}
