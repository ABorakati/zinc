// Annotation model: Zotero's reader annotation JSON (stored verbatim by the core, synced into Zotero's database
// by core/src/zotero-db/writer.ts). Pure functions only, so they can be unit-tested without a DOM.
// Formats mirror vendor/reader: sortIndex "PPPPP|OOOOOO|TTTTT", note boxes of PDF_NOTE_DIMENSIONS, positions rounded to 3 dp.
import type { PdfRect } from "../contract";

export type AnnotationType = "highlight" | "underline" | "note" | "image" | "ink" | "text";

export interface Position {
	pageIndex: number;
	rects?: PdfRect[]; // highlight/underline/note/image/text: PDF points, origin bottom-left
	nextPageRects?: PdfRect[]; // text selection that continues onto the next page
	paths?: number[][]; // ink: flat [x1, y1, x2, y2, ...] per stroke
	width?: number; // ink stroke width
	fontSize?: number; // text
	rotation?: number; // text
}

export interface Annotation {
	id: string;
	type: AnnotationType;
	color: string;
	sortIndex: string;
	position: Position;
	text?: string;
	comment?: string;
	tags?: { name: string; color?: string }[];
	pageLabel?: string;
	dateCreated?: string;
	dateModified: string;
	authorName?: string;
	[field: string]: unknown;
}

export const COLORS = [
	{ name: "Yellow", value: "#ffd400" },
	{ name: "Red", value: "#ff6666" },
	{ name: "Green", value: "#5fb236" },
	{ name: "Blue", value: "#2ea8e5" },
	{ name: "Purple", value: "#a28ae5" },
	{ name: "Magenta", value: "#e56eee" },
	{ name: "Orange", value: "#f19837" },
	{ name: "Grey", value: "#aaaaaa" },
] as const;
export const DEFAULT_COLOR = COLORS[0].value;

export const NOTE_SIZE = 22; // PDF_NOTE_DIMENSIONS in Zotero's reader (pt)
export const INK_WIDTH = 2;
export const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ"; // Zotero.Utilities.allowedKeyChars

/** An 8-character Zotero object key. `rand` returns a float in [0, 1) (injectable for tests). */
export function generateKey(rand: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): string {
	let k = "";
	for (let i = 0; i < 8; i++) k += KEY_CHARS[Math.floor(rand() * KEY_CHARS.length)];
	return k;
}
export const isKey = (s: unknown): s is string => typeof s === "string" && /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(s);

/** ISO timestamp without milliseconds, as Zotero's reader and sync write it. */
export function nowIso(d = new Date()): string {
	return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const round3 = (n: number) => Math.round(n * 1e3) / 1e3;
export const roundRect = (r: PdfRect): PdfRect => [round3(r[0]), round3(r[1]), round3(r[2]), round3(r[3])];

/** Zotero's roundPositionValues. */
export function roundPosition(p: Position): Position {
	const out: Position = { ...p };
	if (out.rects) out.rects = out.rects.map(roundRect);
	if (out.nextPageRects) out.nextPageRects = out.nextPageRects.map(roundRect);
	if (out.paths) out.paths = out.paths.map((path) => path.map(round3));
	if (out.width !== undefined) out.width = round3(out.width);
	return out;
}

// ---------------------------------------------------------------- sort index

export function formatSortIndex(pageIndex: number, offset: number, top: number): string {
	return [
		String(pageIndex).slice(0, 5).padStart(5, "0"),
		String(offset).slice(0, 6).padStart(6, "0"),
		String(Math.floor(top)).slice(0, 5).padStart(5, "0"),
	].join("|");
}

function rectsDist([ax1, ay1, ax2, ay2]: PdfRect, [bx1, by1, bx2, by2]: PdfRect): number {
	const left = bx2 < ax1, right = ax2 < bx1, bottom = by2 < ay1, top = ay2 < by1;
	if (top && left) return Math.hypot(ax1 - bx2, ay2 - by1);
	if (left && bottom) return Math.hypot(ax1 - bx2, ay1 - by2);
	if (bottom && right) return Math.hypot(ax2 - bx1, ay1 - by2);
	if (right && top) return Math.hypot(ax2 - bx1, ay2 - by1);
	if (left) return ax1 - bx2;
	if (right) return bx1 - ax2;
	if (bottom) return ay1 - by2;
	if (top) return by1 - ay2;
	return 0;
}

/** Index of the character whose rect is closest to `rect` (characters with an empty rect are ignored). */
export function closestOffset(charRects: PdfRect[], rect: PdfRect): number {
	let best = Infinity, idx = 0;
	for (let i = 0; i < charRects.length; i++) {
		const c = charRects[i]!;
		if (c[2] <= c[0] || c[3] <= c[1]) continue;
		const d = rectsDist(c, rect);
		if (d < best) { best = d; idx = i; }
	}
	return idx;
}

/** The rect whose top edge decides the sort index: the highest one on the page. */
export function topMostRect(rects: PdfRect[]): PdfRect | undefined {
	return rects.slice().sort((a, b) => b[3] - a[3])[0];
}

export function boundingRect(p: Position): PdfRect {
	if (p.rects?.length) {
		return [Math.min(...p.rects.map((r) => r[0])), Math.min(...p.rects.map((r) => r[1])), Math.max(...p.rects.map((r) => r[2])), Math.max(...p.rects.map((r) => r[3]))];
	}
	if (p.paths?.length) {
		let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (const path of p.paths) {
			for (let i = 0; i + 1 < path.length; i += 2) {
				x1 = Math.min(x1, path[i]!); x2 = Math.max(x2, path[i]!);
				y1 = Math.min(y1, path[i + 1]!); y2 = Math.max(y2, path[i + 1]!);
			}
		}
		if (x1 !== Infinity) return [x1, y1, x2, y2];
	}
	return [0, 0, 0, 0];
}

/** Zotero's sortIndex: page | character offset nearest to the annotation | distance from the page top. */
export function sortIndexFor(position: Position, pageHeight: number, charRects: PdfRect[]): string {
	const rect = (position.rects && topMostRect(position.rects)) || boundingRect(position);
	const offset = charRects.length ? closestOffset(charRects, rect) : 0;
	return formatSortIndex(position.pageIndex, offset, Math.max(0, pageHeight - rect[3]));
}

export const bySortIndex = (a: Pick<Annotation, "sortIndex">, b: Pick<Annotation, "sortIndex">) =>
	a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0;

// ---------------------------------------------------------------- positions

export function textPosition(pageIndex: number, rects: PdfRect[], nextPageRects?: PdfRect[]): Position {
	const p: Position = { pageIndex, rects: rects.map(roundRect) };
	if (nextPageRects?.length) p.nextPageRects = nextPageRects.map(roundRect);
	return p;
}

/** A sticky note is a NOTE_SIZE box centred on the click. */
export function notePosition(pageIndex: number, x: number, y: number, pageW = Infinity, pageH = Infinity): Position {
	const h = NOTE_SIZE / 2;
	const cx = Math.min(Math.max(x, h), Math.max(h, pageW - h)), cy = Math.min(Math.max(y, h), Math.max(h, pageH - h));
	return { pageIndex, rects: [roundRect([cx - h, cy - h, cx + h, cy + h])] };
}

/** An image (area) annotation from two opposite corners, clamped to the page. */
export function areaPosition(pageIndex: number, a: [number, number], b: [number, number], pageW: number, pageH: number): Position {
	const cl = (v: number, max: number) => Math.min(Math.max(v, 0), max);
	return {
		pageIndex,
		rects: [roundRect([cl(Math.min(a[0], b[0]), pageW), cl(Math.min(a[1], b[1]), pageH), cl(Math.max(a[0], b[0]), pageW), cl(Math.max(a[1], b[1]), pageH)])],
	};
}

export function inkPosition(pageIndex: number, width: number, paths: number[][]): Position {
	return roundPosition({ pageIndex, width, paths });
}

/** Move a position by (dx, dy) PDF points. */
export function translatePosition(p: Position, dx: number, dy: number): Position {
	const out: Position = { ...p };
	if (p.rects) out.rects = p.rects.map((r) => roundRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]));
	if (p.paths) out.paths = p.paths.map((path) => path.map((v, i) => round3(v + (i % 2 ? dy : dx))));
	return out;
}

/** Replace the single rect of a note/image/text position. */
export function withRect(p: Position, r: PdfRect): Position {
	return { ...p, rects: [roundRect(r)] };
}

// ---------------------------------------------------------------- page labels

/**
 * A page label for a new annotation. The viewer cannot read the PDF's /PageLabels, so reuse what Zotero's reader
 * stored on existing annotations: an exact match for the page, else the numeric offset they all share, else index + 1.
 */
export function pageLabelFor(pageIndex: number, existing: Pick<Annotation, "pageLabel" | "position">[]): string {
	const known = new Map<number, string>();
	for (const a of existing) if (a.pageLabel) known.set(a.position.pageIndex, a.pageLabel);
	const exact = known.get(pageIndex);
	if (exact) return exact;
	let offset: number | null = null;
	for (const [i, l] of known) {
		if (!/^\d+$/.test(l)) return String(pageIndex + 1);
		const o = Number(l) - i;
		if (offset === null) offset = o;
		else if (offset !== o) return String(pageIndex + 1);
	}
	return String(offset === null ? pageIndex + 1 : Math.max(0, pageIndex + offset));
}

// ---------------------------------------------------------------- construction + wire format

export interface NewAnnotation {
	type: AnnotationType;
	color: string;
	position: Position;
	sortIndex: string;
	pageLabel: string;
	text?: string;
	comment?: string;
	tags?: { name: string }[];
}

/** A full annotation as Zotero's reader's addAnnotation produces it. */
export function makeAnnotation(n: NewAnnotation, opts: { id?: string; now?: string; authorName?: string } = {}): Annotation {
	const now = opts.now ?? nowIso();
	const a: Annotation = {
		id: opts.id ?? generateKey(),
		type: n.type,
		color: n.color,
		sortIndex: n.sortIndex,
		position: roundPosition(n.position),
		text: n.text ?? "",
		comment: n.comment ?? "",
		tags: n.tags ?? [],
		pageLabel: n.pageLabel,
		dateCreated: now,
		dateModified: now,
	};
	if (opts.authorName) a.authorName = opts.authorName;
	return a;
}

/** The JSON PUT to the core: no undefined fields, position rounded; unknown fields survive. */
export function toWire(a: Annotation): Annotation {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) if (v !== undefined) out[k] = v;
	out.position = roundPosition(a.position);
	return out as Annotation;
}

/** Accept only annotations the viewer can place (valid id, type and a position on a page). */
export function isDisplayable(a: unknown): a is Annotation {
	if (!a || typeof a !== "object") return false;
	const x = a as Partial<Annotation>;
	return typeof x.id === "string" && !!x.id && typeof x.type === "string" && typeof x.sortIndex === "string"
		&& !!x.position && typeof x.position.pageIndex === "number" && ((x.position.rects?.length ?? 0) > 0 || (x.position.paths?.length ?? 0) > 0);
}

export const hasText = (a: Annotation) => a.type === "highlight" || a.type === "underline";

// ---------------------------------------------------------------- note from annotations

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML of a Zotero child note listing annotations: quoted text on its colour, then page and comment. */
export function notesHtml(anns: Annotation[], heading = "Annotations"): string {
	const parts = [`<h1>${esc(heading)}</h1>`];
	for (const a of [...anns].sort(bySortIndex)) {
		const page = a.pageLabel ? ` <span>(p. ${esc(a.pageLabel)})</span>` : "";
		const comment = a.comment ? ` ${esc(a.comment).replace(/\n/g, "<br/>")}` : "";
		if (hasText(a) && a.text) {
			parts.push(`<p><span style="background-color: ${esc(a.color)}80">“${esc(a.text)}”</span>${page}${comment}</p>`);
		} else if (a.comment) {
			parts.push(`<p>${esc(a.comment).replace(/\n/g, "<br/>")}${page}</p>`);
		}
	}
	return `<div class="zotero-note znv1">${parts.join("")}</div>`;
}

/** Does the annotation match the search text, the colour set and the tag? */
export function matchesFilter(a: Annotation, f: { query: string; colors: string[]; tag: string }): boolean {
	if (f.colors.length && !f.colors.includes(a.color)) return false;
	if (f.tag && !(a.tags ?? []).some((t) => t.name === f.tag)) return false;
	const q = f.query.trim().toLowerCase();
	if (!q) return true;
	return [a.text, a.comment, a.pageLabel, ...(a.tags ?? []).map((t) => t.name)].some((s) => !!s && s.toLowerCase().includes(q));
}
