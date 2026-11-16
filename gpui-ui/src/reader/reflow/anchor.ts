// Where the reading view's text sits on the PDF page: the bridge that lets annotations live in the reflowed text.
// A "unit" is one <markdown> of the reading view (a paragraph, a list, a caption, a footnote, one bibliography entry) together
// with the structure blocks it came from. Its text (htmlText of its html) is aligned character by character with the page's
// glyphs that lie inside those blocks (pagetext.ts: the text layer's words, each character a share of its word's box, the
// same geometry the PDF view's own selection uses). Both directions then follow:
//   * an annotation's PDF rects -> the glyphs they cover -> ranges of the unit's text (drawn as <markdown marks>);
//   * a selection in the unit's text -> its glyphs -> per-page character rects (a new annotation, saved like the PDF view's).
// Nothing is guessed: a character with no glyph partner (a ligature the PDF drew as one glyph, a dropped hyphen) maps to
// nothing, and a range whose glyphs cannot be found is not drawn / not created. Pure, no DOM.
import type { PagePt } from "../structure/pagetext";
import type { Block, PdfRect } from "../structure/types";

export interface Glyph {
	page: number;
	rect: PdfRect;
}

/** Comparison keys of a string: case, compatibility forms (ligatures, superscripts), dashes and quotes folded; whitespace,
 *  soft hyphens and private-use delimiters dropped. src[k] is the UTF-16 index in `s` of the character key k came from. */
export function foldKeys(s: string): { keys: string; src: number[] } {
	let keys = "";
	const src: number[] = [];
	for (let i = 0; i < s.length;) {
		const cp = s.codePointAt(i)!;
		const n = cp > 0xffff ? 2 : 1;
		if (cp < 0xf0000 && !/[\s­​-‍﻿]/u.test(String.fromCodePoint(cp))) {
			const f = String.fromCodePoint(cp)
				.normalize("NFKC")
				.toLowerCase()
				.replace(/[‐-―−]/g, "-")
				.replace(/[‘’‛′]/g, "'")
				.replace(/[“”‟″]/g, '"');
			for (let u = 0; u < f.length; u++) {
				if (/\s/.test(f[u]!)) continue;
				keys += f[u];
				src.push(i);
			}
		}
		i += n;
	}
	return { keys, src };
}

/**
 * Align key string `a` with `b`: map[i] is the index in b matched to a[i], or -1. Greedy, resynchronising after a mismatch by
 * skipping up to `maxSkip` characters on either side (or both) where the next `confirm` keys agree again. Linear in practice.
 */
export function alignKeys(a: string, b: string, maxSkip = 12, confirm = 3): Int32Array {
	const map = new Int32Array(a.length).fill(-1);
	const agree = (x: number, y: number): boolean => {
		const n = Math.min(confirm, a.length - x, b.length - y);
		if (n <= 0) return false;
		for (let k = 0; k < n; k++) if (a[x + k] !== b[y + k]) return false;
		return true;
	};
	let i = 0,
		j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			map[i] = j;
			i++;
			j++;
			continue;
		}
		let moved = false;
		for (let d = 1; d <= maxSkip && !moved; d++) {
			if (agree(i, j + d)) {
				j += d;
				moved = true;
			} // glyphs the text does not have (a line-end hyphen)
			else if (agree(i + d, j)) {
				i += d;
				moved = true;
			} // text the glyphs do not have
			else if (agree(i + d, j + d)) {
				i += d;
				j += d;
				moved = true;
			} // a different spelling of the same characters
		}
		if (!moved) {
			i++;
			j++;
		}
	}
	return map;
}

const center = (r: PdfRect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const inside = (r: PdfRect, x: number, y: number, tx: number, ty: number) =>
	x >= r[0] - tx && x <= r[2] + tx && y >= r[1] - ty && y <= r[3] + ty;
const empty = (r: PdfRect) => r[2] <= r[0] || r[3] <= r[1];

/** The glyphs of a page that lie in a block, in the page's reading order. */
export function glyphsOfBlock(pt: PagePt, b: Block): { glyphs: Glyph[]; text: string } {
	const glyphs: Glyph[] = [];
	let text = "";
	for (let i = 0; i < pt.rects.length; i++) {
		const r = pt.rects[i]!;
		if (empty(r)) continue;
		const [x, y] = center(r);
		if (!b.rects.some((br) => inside(br, x, y, 1.5, 1.5))) continue;
		glyphs.push({ page: b.page, rect: r });
		text += pt.text[i] ?? "";
	}
	return { glyphs, text };
}

export interface Unit {
	/** htmlText of the unit's html: what mark ranges and selection offsets index */
	text: string;
	glyphs: Glyph[];
	/** per UTF-16 index of `text`: the glyph it was matched to, or -1 */
	toGlyph: Int32Array;
	/** per glyph: the text index matched to it, or -1 */
	toText: Int32Array;
	/** folded keys of `text` (for locating painted runs) */
	keys: { keys: string; src: number[] };
}

/** Build a unit from its text and its blocks' glyphs (`pages` holds the page text of every page the blocks are on). */
export function buildUnit(text: string, blocks: Block[], pages: Map<number, PagePt>): Unit {
	const glyphs: Glyph[] = [];
	let gtext = "";
	for (const b of blocks) {
		const pt = pages.get(b.page);
		if (!pt) continue;
		const g = glyphsOfBlock(pt, b);
		glyphs.push(...g.glyphs);
		gtext += g.text;
	}
	const kt = foldKeys(text);
	// one key per glyph, so the glyph of a key is its index; a glyph whose character folds to several keys ("ﬁ") takes the first
	let gk = "";
	const gsrc: number[] = [];
	for (let i = 0; i < gtext.length; i++) {
		const f = foldKeys(gtext[i]!).keys;
		for (let u = 0; u < f.length; u++) {
			gk += f[u];
			gsrc.push(i);
		}
	}
	const map = alignKeys(kt.keys, gk);
	const toGlyph = new Int32Array(text.length).fill(-1);
	const toText = new Int32Array(glyphs.length).fill(-1);
	for (let k = 0; k < map.length; k++) {
		const m = map[k]!;
		if (m < 0) continue;
		const ti = kt.src[k]!,
			gi = gsrc[m]!;
		if (toGlyph[ti] === -1) toGlyph[ti] = gi;
		if (toText[gi] === -1) toText[gi] = ti;
	}
	return { text, glyphs, toGlyph, toText, keys: kt };
}

/** Rects of an annotation on a page: `pageIndex` holds `rects`, the next page `nextPageRects`. */
export interface PageRects {
	page: number;
	rects: PdfRect[];
}

/**
 * Ranges of the unit's text covered by an annotation: the text matched to every glyph whose centre lies in one of its rects.
 * Matched characters closer than `gap` text characters apart join into one range (the spaces between words have no glyph).
 */
export function rangesFor(u: Unit, where: PageRects[], gap = 3): [number, number][] {
	const hit: number[] = [];
	u.glyphs.forEach((g, gi) => {
		const ti = u.toText[gi]!;
		if (ti < 0) return;
		const [x, y] = center(g.rect);
		if (where.some((w) => w.page === g.page && w.rects.some((r) => inside(r, x, y, 0.5, 0.5)))) hit.push(ti);
	});
	if (!hit.length) return [];
	hit.sort((a, b) => a - b);
	const out: [number, number][] = [];
	let a = hit[0]!,
		b = hit[0]! + 1;
	for (const t of hit.slice(1)) {
		if (t <= b + gap) b = Math.max(b, t + 1);
		else {
			out.push([a, b]);
			a = t;
			b = t + 1;
		}
	}
	out.push([a, b]);
	// a range ending on a high surrogate would cut a character in two
	return out.map(([s, e]) => [s, e < u.text.length && /[\ud800-\udbff]/.test(u.text[e - 1]!) ? e + 1 : e]);
}

/** Does any glyph of the unit fall in the rects? (cheap prefilter for annotations far away) */
export function touches(blocks: Block[], where: PageRects[]): boolean {
	return blocks.some((b) =>
		where.some(
			(w) =>
				w.page === b.page &&
				w.rects.some((r) => b.rects.some((br) => r[0] < br[2] + 2 && r[2] > br[0] - 2 && r[1] < br[3] + 2 && r[3] > br[1] - 2)),
		),
	);
}

/**
 * Where a painted run of the unit (a paragraph of its <markdown>, as the selection reports it) starts in the unit's text: the
 * offset of its folded keys inside the unit's, searching from `fromKey`. Returns the key offset, or -1.
 */
export function locateRun(u: Unit, runText: string, fromKey = 0): number {
	const r = foldKeys(runText).keys;
	if (!r) return -1;
	return u.keys.keys.indexOf(r, fromKey);
}

/**
 * The glyphs of a selection inside one painted run: `start`/`end` are UTF-16 offsets in `runText`, `at` the key offset the run
 * starts at in the unit (locateRun). Glyphs come back in text order; characters with no glyph are skipped.
 */
export function glyphsOfRunRange(u: Unit, runText: string, at: number, start: number, end: number): Glyph[] {
	const rk = foldKeys(runText);
	const out: Glyph[] = [];
	const seen = new Set<number>();
	for (let k = 0; k < rk.src.length; k++) {
		const s = rk.src[k]!;
		if (s < start || s >= end) continue;
		const ti = u.keys.src[at + k];
		if (ti === undefined) continue;
		const gi = u.toGlyph[ti]!;
		if (gi < 0 || seen.has(gi)) continue;
		seen.add(gi);
		out.push(u.glyphs[gi]!);
	}
	return out;
}

/** Glyphs grouped per page, in order of first appearance. */
export function byPage(glyphs: Glyph[]): { page: number; rects: PdfRect[] }[] {
	const m = new Map<number, PdfRect[]>();
	for (const g of glyphs) {
		const l = m.get(g.page) ?? [];
		l.push(g.rect);
		m.set(g.page, l);
	}
	return [...m].map(([page, rects]) => ({ page, rects }));
}
