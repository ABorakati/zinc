// JS pre-clipping of single-line text, instead of `textOverflow: "ellipsis"`.
//
// Why: GPUI's text.rs reuses a text measurement only when there is no truncate width, so every ellipsis text re-shapes on every
// taffy measure (~2x a plain text: ~80 us vs ~36 us), and a list repaints / re-measures hundreds of them while scrolling. A text
// that is already short enough to fit is a plain nowrap text; the box around it clips (`overflow: hidden`) whatever the estimate
// got wrong by a pixel or two.
//
// The width is estimated from Inter's advance widths (assets/fonts/Inter-Variable.ttf, default instance, 1000 units per em; the
// printable ASCII range, read from the font's hmtx). Characters outside ASCII use a class estimate.
// Estimates are cached per string, so a row that is evaluated again (a scroll back, a new page) pays nothing.

/** Advance widths of U+0020..U+007E in Inter, per 1000 em. */
const ADV = [
	281, 288, 466, 633, 642, 982, 644, 300, 365, 365, 501, 662, 288, 460, 288, 360, 631, 407, 610, 618, 646, 593, 620, 566, 619, 620, 288,
	302, 662, 662, 662, 511, 966, 690, 654, 730, 722, 601, 590, 746, 743, 269, 571, 672, 565, 903, 753, 765, 639, 765, 644, 642, 646, 744,
	690, 985, 682, 679, 629, 365, 360, 365, 471, 456, 323, 562, 612, 571, 612, 583, 370, 613, 591, 242, 242, 549, 242, 876, 591, 600, 612,
	612, 376, 528, 327, 591, 562, 818, 546, 562, 552, 426, 333, 426, 662,
];
const ELLIPSIS = "…";
const ELLIPSIS_EM = 0.864;

/** Width of one char in em. */
function emOf(code: number): number {
	if (code >= 32 && code < 127) return ADV[code - 32]! / 1000;
	if (code === 0xb7) return 0.288;
	if (code === 0x2026) return ELLIPSIS_EM;
	if (code === 0x2013 || code === 0x2014) return code === 0x2013 ? 0.5 : 0.94;
	if (code >= 0xc0 && code < 0x250) return 0.6; // Latin-1 supplement / Latin extended: mostly letters, a little wider than the lower-case mean
	if (code >= 0x2e80 && code < 0xa000) return 1; // CJK
	if (code >= 0xac00 && code < 0xd7b0) return 1; // Hangul
	if (code >= 0x1f000) return 1.1; // emoji / symbols
	return 0.62;
}

/**
 * Inter gets a little wider with weight (variable wght). The table is the default instance (400): GPUIX's drawn widths match it
 * within ~1% (measured on card / table screenshots against native-ellipsis cuts); 500+ is the usual wght growth.
 */
const stretch = (weight: number) => (weight >= 700 ? 1.045 : weight >= 600 ? 1.03 : weight >= 500 ? 1.015 : 1);

const cache = new Map<string, number>();

/** Estimated single-line width (px) of `s` in Inter at `size` px, `weight` (default 400). */
export function textWidth(s: string, size: number, weight = 400): number {
	const key = `${size}|${weight}|${s}`;
	let w = cache.get(key);
	if (w === undefined) {
		let em = 0;
		for (const ch of s) em += emOf(ch.codePointAt(0)!); // by code point: an emoji is one character, not two UTF-16 units
		w = em * size * stretch(weight);
		if (cache.size > 20000) cache.clear();
		cache.set(key, w);
	}
	return w;
}

/**
 * `s` cut to fit `maxPx` with a trailing "…" when it does not (like `text-overflow: ellipsis`). The budget is shaved by 1.5% (`shave`) so an
 * estimate that is a little low still ends inside the box.
 */
export function clipText(s: string, maxPx: number, size: number, weight = 400, shave = 0.985): string {
	if (!s) return s;
	const budget = maxPx * shave;
	if (budget <= 0) return "";
	if (textWidth(s, size, weight) <= budget) return s;
	const ell = ELLIPSIS_EM * size * stretch(weight);
	if (budget <= ell) return ELLIPSIS;
	const k = size * stretch(weight);
	let em = 0,
		i = 0;
	const limit = (budget - ell) / k;
	while (i < s.length) {
		const cp = s.codePointAt(i)!;
		const next = em + emOf(cp);
		if (next > limit) break;
		em = next;
		i += cp > 0xffff ? 2 : 1; // never cut between the two halves of a surrogate pair
	}
	return s.slice(0, i).trimEnd() + ELLIPSIS;
}
