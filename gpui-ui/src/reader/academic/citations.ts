// Citation destination -> bibliography reference matching. Pure functions (no DOM), unit-tested.
import type { DocStructure, PdfRect } from "../structure/types";
import type { Reference } from "./types";
import { extractDoi, MATCH_THRESHOLD, matchReference, normalizeText, scoreReference } from "./match";
import { type AuthorYear } from "./mentions";
import { computeLines, joinLines, lineRect, unionRects, type Line } from "./textlines";

// ---------------------------------------------------------------- numeric citation groups

const DASH = /[-‐‑‒–—−]/;

/** "[3–6]" -> [3,4,5,6]; "[3, 5, 9]" -> [3,5,9]; "(12)" -> [12]; anything with words -> []. */
export function parseCitationNumbers(s: string): number[] {
	const t = s.replace(/[\s  ]+/g, " ").trim();
	if (!t || /[A-Za-z]/.test(t)) return [];
	const inner = t.replace(/^[\[(]\s*/, "").replace(/\s*[\])]$/, "");
	if (!/^[\d\s,;\-‐‑‒–—−]+$/.test(inner)) return [];
	const out: number[] = [];
	for (const part of inner.split(/[,;]/)) {
		const p = part.trim();
		if (!p) continue;
		const r = p
			.split(DASH)
			.map((x) => x.trim())
			.filter(Boolean);
		if (r.length === 1) {
			const n = Number(r[0]);
			if (!Number.isInteger(n) || n < 1 || n > 999) return [];
			out.push(n);
		} else if (r.length === 2) {
			const a = Number(r[0]);
			const b = Number(r[1]);
			if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 999 || b < a || b - a > 60) return [];
			for (let i = a; i <= b; i++) out.push(i);
		} else return [];
	}
	return [...new Set(out)];
}

/**
 * Expand the text under a link to its whole bracket group using page text: for a link whose text is just "5"
 * inside "[3, 5, 9]" returns "[3, 5, 9]". `idx` is the char range of the link text in the page text.
 */
export function expandCitationGroup(text: string, idx: [number, number]): string {
	let a = idx[0];
	let b = idx[1];
	const open = "[(";
	const close = "])";
	let l = a;
	while (l > 0 && a - l < 30 && !open.includes(text[l - 1]!) && /[\d,;\-‐‑‒–—−\s]/.test(text[l - 1]!)) l--;
	let r = b;
	while (r < text.length && r - b < 30 && !close.includes(text[r]!) && /[\d,;\-‐‑‒–—−\s]/.test(text[r]!)) r++;
	const hasOpen = l > 0 && open.includes(text[l - 1]!);
	const hasClose = r < text.length && close.includes(text[r]!);
	if (hasOpen && hasClose) return text.slice(l - 1, r + 1);
	// superscript style "...decades,10–16 leading": the contiguous digit/dash/comma run without spaces
	let s = a;
	let e = b;
	const run = /[\d,\-‐‑‒–—−]/;
	while (s > 0 && b - s < 30 && run.test(text[s - 1]!)) s--;
	while (e < text.length && e - a < 30 && run.test(text[e]!)) e++;
	const g = text.slice(s, e).replace(/^[^\d]+|[^\d]+$/g, "");
	return g || text.slice(a, b);
}

const ABBREV = /(?:\bet al|\bFigs?|\bTab|\be\.g|\bi\.e|\bvs|\bcf|\bRefs?|\bNo|\bDr|\bapprox|\bSuppl?|\b[A-Z])\.$/;

/**
 * The sentence around a citation (char range `idx` of the page text), split so the citation can be marked:
 * the sentence start up to the citation, the citation itself, and the rest of the sentence. Line-break hyphens
 * are joined and whitespace collapsed; long sentences are cut with "…".
 */
export function sentenceAround(
	text: string,
	idx: [number, number],
	maxBefore = 260,
	maxAfter = 160,
): { before: string; cite: string; after: string } {
	const [a, b] = idx;
	let s = a;
	while (s > 0 && a - s < maxBefore) {
		if (/[.!?]/.test(text[s - 1]!) && /\s/.test(text[s] ?? "") && !ABBREV.test(text.slice(Math.max(0, s - 8), s))) break;
		s--;
	}
	let e = b;
	while (e < text.length && e - b < maxAfter) {
		if (
			/[.!?]/.test(text[e]!) &&
			(e + 1 >= text.length || /\s/.test(text[e + 1]!)) &&
			!ABBREV.test(text.slice(Math.max(0, e - 7), e + 1))
		) {
			e++;
			break;
		}
		e++;
	}
	// pdfium marks line-break hyphens as U+FFFE (or a soft hyphen): drop them with the line break
	const clean = (t: string) =>
		t
			.replace(/[￾­]\s*/g, "")
			.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2")
			.replace(/\s+/g, " ");
	return {
		before: (s > 0 && a - s >= maxBefore ? "…" : "") + clean(text.slice(s, a)).trimStart(),
		cite: clean(text.slice(a, b)),
		after: clean(text.slice(b, e)).trimEnd() + (e < text.length && e - b >= maxAfter ? "…" : ""),
	};
}

// ---------------------------------------------------------------- reference-list region

export interface RefStart {
	page: number;
	/** y of the "References" heading (PDF points); destinations on that page below it count. Infinity if unknown. */
	y: number;
}

const HEADING_RE =
	/^\s*(?:\d{1,2}\.?\s+)?(?:references?(?:\s+list)?|bibliography|literature\s+cited|works\s+cited|notes\s+and\s+references|references\s+and\s+notes)\s*:?\s*$/i;

/** Find the page/y where the bibliography starts, scanning pages from the end. */
export function findRefStartInPages(pages: { text: string; rects: PdfRect[] }[]): RefStart | null {
	for (let p = pages.length - 1; p >= 0; p--) {
		const pg = pages[p]!;
		const lines = computeLines(pg.text, pg.rects);
		for (const l of lines) {
			if (l.text.length < 40 && HEADING_RE.test(l.text)) return { page: p, y: l.y2 };
		}
	}
	return null;
}

export function refStartFromStructure(s: DocStructure | null | undefined): RefStart | null {
	if (!s) return null;
	let best: RefStart | null = null;
	for (const r of s.references) {
		const top = Math.max(...r.rects.map((x) => x[3]), -Infinity);
		if (!best || r.page < best.page || (r.page === best.page && top > best.y)) best = { page: r.page, y: top };
	}
	if (best) return { page: best.page, y: best.y + 40 }; // heading sits above the first entry
	for (const b of s.blocks) {
		if (b.type === "heading" && HEADING_RE.test(b.text) && b.rects[0]) return { page: b.page, y: b.rects[0][3] };
	}
	return null;
}

export function isInReferences(start: RefStart | null, page: number, top: number | undefined): boolean {
	if (!start) return false;
	if (page > start.page) return true;
	if (page < start.page) return false;
	return top === undefined ? true : top <= start.y + 2;
}

// ---------------------------------------------------------------- bibliography entry at a destination

export interface Entry {
	page: number;
	text: string; // joined, marker stripped
	marker?: number; // numeric marker when the entry starts with one
	rect: PdfRect;
	lineRects: PdfRect[];
}

const MARKER_RE = /^\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})(?:\.|\]|\s)(?=\s*[\p{Lu}\p{L}“"‘'(]))/u;

export function markerOf(line: string): number | undefined {
	const m = MARKER_RE.exec(line);
	if (!m) return undefined;
	return Number(m[1] ?? m[2] ?? m[3]);
}

function stripMarker(t: string): string {
	return t.replace(/^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.\]]?)\s+/, "");
}

const AUTHOR_START = /^[\p{Lu}][\p{L}'’\-]+(?:\s[\p{L}'’\-]+)?,\s*(?:[\p{Lu}]\.|[\p{Lu}]{1,3}\b|[\p{Lu}][\p{Ll}]+)/u;

/** Extend from line k to the end of one bibliography entry. */
function extentFrom(lines: Line[], k: number): Line[] {
	const first = lines[k]!;
	const firstMarker = markerOf(first.text);
	const out = [first];
	const lh = Math.max(first.y2 - first.y1, 6);
	let chars = first.text.length;
	for (let j = k + 1; j < lines.length && out.length < 10 && chars < 900; j++) {
		const l = lines[j]!;
		const prev = out[out.length - 1]!;
		// column change or big vertical gap
		if (l.y2 > prev.y2 + lh * 0.5) break;
		if (prev.y1 - l.y2 > lh * 1.35) break;
		if (firstMarker !== undefined) {
			const mk = markerOf(l.text);
			if (mk !== undefined && (mk === firstMarker + 1 || (/^\s*\[\d+\]/.test(l.text) && mk !== firstMarker))) break;
		} else {
			// author-year: hanging indent (continuation lines indented) or a new "Surname, I." start
			const second = lines[k + 1];
			const hanging = !!second && second.y2 < first.y2 && second.x1 > first.x1 + 3;
			if (hanging) {
				if (l.x1 <= first.x1 + 2.5) break;
			} else if (AUTHOR_START.test(l.text) && /[.)d]s*$/.test(prev.text)) break;
		}
		out.push(l);
		chars += l.text.length;
	}
	return out;
}

/**
 * Candidate bibliography entries whose first line is at (or just below) `top` on a page. More than one candidate
 * is returned when several columns have a line at that height; the caller disambiguates by marker / best match.
 */
export function entryCandidates(page: number, pt: { text: string; rects: PdfRect[] }, top: number): Entry[] {
	const lines = computeLines(pt.text, pt.rects);
	const near: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (l.y2 <= top + 5 && l.y2 >= top - 16) near.push(i);
	}
	// lines level with `top` (e.g. one per column) are all candidates; otherwise the closest of each run
	const exact = near.filter((i) => Math.abs(lines[i]!.y2 - top) <= 4);
	const picked: number[] = [];
	let run: number[] = [];
	const flush = () => {
		if (!run.length) return;
		picked.push(run.reduce((a, b) => (Math.abs(lines[b]!.y2 - top) < Math.abs(lines[a]!.y2 - top) ? b : a)));
		run = [];
	};
	for (const i of exact.length ? [] : near) {
		if (run.length && i !== run[run.length - 1]! + 1) flush();
		run.push(i);
	}
	flush();
	if (exact.length) picked.push(...exact);
	return picked.map((k) => {
		const ext = extentFrom(lines, k);
		const rects = ext.map(lineRect);
		const text = joinLines(ext);
		return { page, text: stripMarker(text), marker: markerOf(lines[k]!.text), rect: unionRects(rects)!, lineRects: rects };
	});
}

/** The entry that starts with the explicit marker N on this page (numbered bibliographies), or null. */
export function entryByMarker(page: number, pt: { text: string; rects: PdfRect[] }, n: number, maxY = Infinity): Entry | null {
	const lines = computeLines(pt.text, pt.rects);
	for (let k = 0; k < lines.length; k++) {
		if (markerOf(lines[k]!.text) !== n || lines[k]!.y2 > maxY + 2) continue;
		const ext = extentFrom(lines, k);
		const rects = ext.map(lineRect);
		return { page, text: stripMarker(joinLines(ext)), marker: n, rect: unionRects(rects)!, lineRects: rects };
	}
	return null;
}

// ---------------------------------------------------------------- resolve

export interface Resolution {
	ref: Reference | null;
	entry: Entry | null;
	/** how it was found */
	via: "doi" | "text" | "index" | "none";
	score: number;
}

function structureEntry(s: DocStructure | null | undefined, page: number, top: number): Entry | null {
	if (!s) return null;
	for (const e of s.references) {
		if (e.page !== page) continue;
		for (const r of e.rects) {
			if (top >= r[1] - 4 && top <= r[3] + 8) {
				return { page, text: stripMarker(e.text), marker: e.index, rect: unionRects(e.rects) ?? r, lineRects: e.rects };
			}
		}
	}
	return null;
}

function structureEntryByIndex(s: DocStructure | null | undefined, n: number): Entry | null {
	// the printed marker ("18." / "[18]") first; the entry's position in the list only for unmarked lists
	const refs = s?.references ?? [];
	const e =
		refs.find((r) => markerOf(r.text) === n) ??
		(refs.some((r) => markerOf(r.text) != null) ? undefined : refs.find((r) => r.index === n));
	if (!e || !e.rects.length) return null;
	return { page: e.page, text: stripMarker(e.text), marker: n, rect: unionRects(e.rects)!, lineRects: e.rects };
}

export interface ResolveInput {
	refs: Reference[];
	page: number;
	top: number | undefined;
	pageText: { text: string; rects: PdfRect[] } | null;
	structure?: DocStructure | null;
	/** only consider lines at or below this y (the heading's y on the page where the list starts) */
	maxY?: number;
	/** the number the citation points to, e.g. 12 for "[12]" */
	number?: number;
}

export function resolveCitation(inp: ResolveInput): Resolution {
	const { refs } = inp;
	let candidates: Entry[] = [];
	let se = inp.top !== undefined ? structureEntry(inp.structure, inp.page, inp.top) : null;
	// many PDFs point every citation at the top of the list: the printed number beats the destination's position
	if (inp.number !== undefined && se?.marker !== inp.number) se = structureEntryByIndex(inp.structure, inp.number) ?? se;
	if (se) candidates = [se];
	else if (inp.pageText) {
		// an explicit marker equal to the cited number is the most reliable anchor; else whatever sits at the destination's top
		const em = inp.number !== undefined ? entryByMarker(inp.page, inp.pageText, inp.number, inp.maxY) : null;
		if (em) candidates = [em];
		else if (inp.top !== undefined) candidates = entryCandidates(inp.page, inp.pageText, inp.top);
	}

	// disambiguate columns: marker equal to the cited number wins
	if (candidates.length > 1 && inp.number !== undefined) {
		const byMarker = candidates.filter((c) => c.marker === inp.number);
		if (byMarker.length) candidates = byMarker;
	}

	let best: Resolution = { ref: null, entry: candidates[0] ?? null, via: "none", score: 0 };
	for (const c of candidates) {
		const dois = [extractDoi(c.text)].filter(Boolean) as string[];
		const m = matchReference(refs, { text: c.text, dois });
		if (m) {
			const sc = scoreReference(m, { text: c.text, dois });
			if (sc > best.score) best = { ref: m, entry: c, via: sc === 1 ? "doi" : "text", score: sc };
		}
	}

	const idx = best.entry?.marker ?? inp.number;
	const byIndex = idx !== undefined ? refs.find((r) => r.index === idx) : undefined;
	if (byIndex) {
		const sc = best.entry ? scoreReference(byIndex, { text: best.entry.text }) : 0;
		// the numbered reference agrees with the printed text (or we have no text): prefer it over a looser text match
		if (!best.ref || (sc >= MATCH_THRESHOLD && best.ref !== byIndex && sc >= best.score - 0.1) || (best.score < 0.8 && !best.entry)) {
			best = { ref: byIndex, entry: best.entry, via: sc >= MATCH_THRESHOLD ? "text" : "index", score: sc };
		} else if (!best.ref) best = { ref: byIndex, entry: best.entry, via: "index", score: sc };
	}
	return best;
}

// ---------------------------------------------------------------- author-year

export function lastNameOf(author: string): string {
	const first = author.split(",")[0]!.trim();
	const parts = first.split(/\s+/);
	if (parts.length > 1 && /^[A-Z]{1,3}\.?$/.test(parts[parts.length - 1]!)) return normalizeText(parts.slice(0, -1).join(" "));
	return normalizeText(parts[parts.length - 1]);
}

/** Resolve "Smith et al., 2020" to a unique bibliography entry (surname + year [+ second author]); null if ambiguous. */
export function resolveAuthorYear(refs: Reference[], ay: AuthorYear): Reference | null {
	const sn = normalizeText(ay.surname);
	const cands = refs.filter((r) => {
		if (r.year !== ay.year || !r.authors?.length) return false;
		const names = r.authors.map(lastNameOf);
		if (names[0] !== sn) return false;
		if (ay.second && !(names[1] && names[1] === normalizeText(ay.second))) return false;
		if (ay.etAl && names.length < 2) return false;
		return true;
	});
	if (cands.length === 1) return cands[0]!;
	if (cands.length > 1 && ay.suffix) {
		const i = ay.suffix.charCodeAt(0) - 97;
		const sorted = [...cands].sort((a, b) => a.index - b.index);
		return sorted[i] ?? null;
	}
	return null;
}
