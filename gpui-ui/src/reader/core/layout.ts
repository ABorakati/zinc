// Page layouts of the reader, as in Zotero's View menu: the scroll mode (vertical, horizontal, wrapped) and spreads (none, odd,
// even). Pure geometry: pages are grouped into ROWS, and a row is one item of the reader's virtualised page list (vertical and
// wrapped), or one column of the horizontally scrolled strip (horizontal). Only the rows near the viewport are mounted, whatever
// the mode, so tiling, prefetch and the virtualised list stay as fast as with one page per row.
//
//   vertical    one unit per row, stacked downwards (the default)
//   wrapped     as many units per row as fit the viewport width (at least one), rows stacked downwards
//   horizontal  one unit per column, columns side by side, scrolled sideways
//
// A unit is one page, or with spreads two facing pages: "odd" spreads pair pages 1+2, 3+4, ...; "even" spreads keep page 1 on its
// own and pair 2+3, 4+5, ... (pdf.js / Zotero). The pages of a row are consecutive. Everything is in css px; the main axis is y for
// vertical / wrapped and x for horizontal.
export type ScrollMode = "vertical" | "horizontal" | "wrapped";
export type SpreadMode = "none" | "odd" | "even";
export const SCROLL_MODES: readonly ScrollMode[] = ["vertical", "horizontal", "wrapped"];
export const SPREAD_MODES: readonly SpreadMode[] = ["none", "odd", "even"];
export const isScrollMode = (v: unknown): v is ScrollMode => typeof v === "string" && (SCROLL_MODES as readonly string[]).includes(v);
export const isSpreadMode = (v: unknown): v is SpreadMode => typeof v === "string" && (SPREAD_MODES as readonly string[]).includes(v);

export interface LayoutInput {
	n: number;
	/** displayed page box in css px (zoom and rotation applied) */
	w(i: number): number;
	h(i: number): number;
	scroll: ScrollMode;
	spread: SpreadMode;
	/** viewport width in css px (wrapped mode packs rows to it) */
	viewW: number;
	/** around the whole layout, between units, between the two pages of a spread */
	pad: number;
	gap: number;
	spreadGap: number;
}

export interface Layout {
	scroll: ScrollMode;
	spread: SpreadMode;
	n: number;
	rows: number;
	/** first page of row r; first[rows] = n */
	first: Int32Array;
	pageRow: Int32Array;
	/** main-axis extent of row r, its padding included (what the list measures for the row) */
	ext: Float64Array;
	/** where row r starts on the main axis: prefix sums of ext, rows + 1 entries */
	start: Float64Array;
	/** padding before / after the content of row r on the main axis */
	lead: Float64Array;
	trail: Float64Array;
	/** vertical / wrapped: the width of the row's content; horizontal: the height of the column's content (its tallest page) */
	size: Float64Array;
	/** page offset inside its row's content: x along the row, y across it (centred in the row's tallest page / the column's height) */
	px: Float64Array;
	py: Float64Array;
	/** widest row (vertical, wrapped) / tallest column (horizontal), css px */
	maxSize: number;
	/** start[rows]: the whole layout's main-axis length */
	total: number;
}

/** Index of the first page of every unit. */
export function unitStarts(n: number, spread: SpreadMode): number[] {
	const out: number[] = [];
	if (spread === "none") {
		for (let i = 0; i < n; i++) out.push(i);
		return out;
	}
	let i = 0;
	if (spread === "even" && n > 0) {
		out.push(0);
		i = 1;
	}
	for (; i < n; i += 2) out.push(i);
	return out;
}

/** Pages [a, b) of the unit that starts at `a`. */
const unitEnd = (starts: number[], k: number, n: number) => (k + 1 < starts.length ? starts[k + 1]! : n);

export function buildLayout(p: LayoutInput): Layout {
	const { n, pad, gap, spreadGap } = p;
	const starts = unitStarts(n, p.spread);
	const uw: number[] = [];
	for (let k = 0; k < starts.length; k++) {
		const a = starts[k]!,
			b = unitEnd(starts, k, n);
		let w = 0;
		for (let i = a; i < b; i++) w += p.w(i) + (i > a ? spreadGap : 0);
		uw.push(w);
	}
	// rows as runs of units: [first unit, end unit)
	const runs: [number, number][] = [];
	if (p.scroll === "wrapped") {
		const avail = Math.max(1, p.viewW - pad * 2);
		let a = 0,
			cur = 0;
		for (let k = 0; k < starts.length; k++) {
			const add = (k > a ? gap : 0) + uw[k]!;
			if (k > a && cur + add > avail + 0.5) {
				runs.push([a, k]);
				a = k;
				cur = uw[k]!;
			} else cur += add;
		}
		if (starts.length) runs.push([a, starts.length]);
	} else {
		for (let k = 0; k < starts.length; k++) runs.push([k, k + 1]);
	}
	const rows = runs.length;
	const first = new Int32Array(rows + 1),
		pageRow = new Int32Array(n);
	const ext = new Float64Array(rows),
		start = new Float64Array(rows + 1),
		lead = new Float64Array(rows),
		trail = new Float64Array(rows),
		size = new Float64Array(rows);
	const px = new Float64Array(n),
		py = new Float64Array(n);
	const horiz = p.scroll === "horizontal";
	let maxSize = 0;
	for (let r = 0; r < rows; r++) {
		const [ka, kb] = runs[r]!;
		const a = starts[ka]!,
			b = unitEnd(starts, kb - 1, n);
		first[r] = a;
		let x = 0,
			hmax = 0;
		for (let k = ka; k < kb; k++) {
			const ua = starts[k]!,
				ub = unitEnd(starts, k, n);
			if (k > ka) x += gap;
			for (let i = ua; i < ub; i++) {
				if (i > ua) x += spreadGap;
				px[i] = x;
				pageRow[i] = r;
				x += p.w(i);
				hmax = Math.max(hmax, p.h(i));
			}
		}
		for (let i = a; i < b; i++) py[i] = Math.round((hmax - p.h(i)) / 2);
		lead[r] = r === 0 ? pad : gap / 2;
		trail[r] = r === rows - 1 ? pad : gap / 2;
		size[r] = horiz ? hmax : x;
		ext[r] = lead[r]! + (horiz ? x : hmax) + trail[r]!;
		start[r + 1] = start[r]! + ext[r]!;
		maxSize = Math.max(maxSize, size[r]!);
	}
	first[rows] = n;
	return {
		scroll: p.scroll,
		spread: p.spread,
		n,
		rows,
		first,
		pageRow,
		ext,
		start,
		lead,
		trail,
		size,
		px,
		py,
		maxSize,
		total: start[rows] ?? 0,
	};
}

/** The row at main-axis position `pos` (clamped to the layout). */
export function rowAt(l: Layout, pos: number): number {
	if (l.rows <= 1) return 0;
	let lo = 0,
		hi = l.rows - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (l.start[mid]! <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** The pages of row r. */
export function rowPages(l: Layout, r: number): number[] {
	const out: number[] = [];
	for (let i = l.first[r] ?? 0; i < (l.first[r + 1] ?? 0); i++) out.push(i);
	return out;
}

/**
 * Width (PDF points) and page count of the median unit, for "fit width": with spreads the two pages together fit the viewport
 * (in every scroll mode; in wrapped mode that is one unit per row, as in pdf.js, and zooming out wraps more onto a row).
 */
export function medianUnit(n: number, spread: SpreadMode, widthPt: (i: number) => number): { w: number; pages: number } {
	const starts = unitStarts(n, spread);
	if (!starts.length) return { w: 612, pages: 1 };
	const us = starts.map((a, k) => {
		const b = unitEnd(starts, k, n);
		let w = 0;
		for (let i = a; i < b; i++) w += widthPt(i);
		return { w, pages: b - a };
	});
	// the median of the full spreads (a lone first / last page would make "fit width" zoom a two-page layout too far)
	const full = spread === "none" ? us : us.filter((u) => u.pages === 2);
	const pool = (full.length ? full : us).slice().sort((x, y) => x.w - y.w);
	return pool[pool.length >> 1]!;
}

/** The unit (pages [a, b)) that contains page i. */
export function unitOf(n: number, spread: SpreadMode, i: number): [number, number] {
	if (spread === "none") return [i, i + 1];
	if (spread === "odd") {
		const a = i - (i % 2);
		return [a, Math.min(n, a + 2)];
	}
	if (i === 0) return [0, 1];
	const a = i - ((i - 1) % 2);
	return [a, Math.min(n, a + 2)];
}
