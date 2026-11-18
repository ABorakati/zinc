// Pure conversions between Zinc's reader types (annotations/model.ts: Zotero's annotation JSON; plugins.ts: normalised rects) and the
// WIT records of reader.wit in jco's shape. No UI, no signals: unit-tested in convert.test.ts.
import type { MenuItem } from "../../ui/core";
import { COLORS, nowIso, type Annotation, type AnnotationType, type Position } from "../../reader/annotations/model";
import { selectionToPosition } from "../../reader/annotations/geometry";
import type { NRect } from "../../reader/plugins";
import { fromNRect } from "../../reader/structure/pagetext";
import type { PdfRect } from "../../reader/structure/types";
import type {
	AnnotationKind,
	MenuEntry,
	Rect,
	TextSelection,
	WitAnnotation,
	WitAnnotationPatch,
	WitNewAnnotation,
	WitPosition,
} from "./types";
import { fail } from "./types";

const KINDS: readonly string[] = ["highlight", "underline", "note", "image", "ink", "text"];
export const isKind = (k: unknown): k is AnnotationKind => typeof k === "string" && KINDS.includes(k);
const HEX = /^#[0-9a-f]{6}$/i;

/** Fluent ids of Zotero.Annotations.COLORS, in the palette's order. */
const COLOR_IDS = ["general-yellow", "general-red", "general-green", "general-blue", "general-purple", "general-magenta", "general-orange", "general-gray"];
export const annotationColors = (): { id: string; hex: string }[] => COLORS.map((c, i) => ({ id: COLOR_IDS[i]!, hex: c.value }));

/** "#rrggbb", lower-cased; throws invalid-argument for anything else. */
export function hexColor(c: unknown, what = "color"): string {
	if (typeof c !== "string" || !HEX.test(c)) return fail("invalid-argument", `${what} must be "#rrggbb", got ${JSON.stringify(c)}`);
	return c.toLowerCase();
}

/** A `types.color` as "#rrggbb" (alpha dropped), or undefined for tokens (they depend on the theme). */
export function witColorToHex(c: { tag: string; val?: unknown } | undefined): string | undefined {
	if (!c) return undefined;
	const hex = (n: number) => `#${(n >>> 8).toString(16).padStart(6, "0")}`;
	if (c.tag === "rgba") return hex(Number(c.val));
	if (c.tag === "themed") return hex(Number((c.val as { light: number }).light));
	return undefined;
}

const round3 = (n: number) => Math.round(n * 1e3) / 1e3;

// ---------------------------------------------------------------- rects and positions

/** Normalised page rect (top-left origin, 0..1) <-> PDF points (bottom-left origin). */
export const nrectToPdf = (r: NRect, w: number, h: number): Rect => fromNRect(r, w, h);
export function pdfToNrect(r: Rect, w: number, h: number): NRect {
	return { x: r[0] / w, y: 1 - r[3] / h, w: (r[2] - r[0]) / w, h: (r[3] - r[1]) / h };
}

export function toWitPosition(p: Position): WitPosition {
	return {
		pageIndex: p.pageIndex,
		rects: (p.rects ?? []).map((r) => [...r] as Rect),
		nextPageRects: (p.nextPageRects ?? []).map((r) => [...r] as Rect),
		paths: (p.paths ?? []).map((x) => [...x]),
		width: p.width,
		fontSize: p.fontSize,
		rotation: p.rotation,
		selector: undefined,
	};
}

export function fromWitPosition(p: WitPosition): Position {
	if (p.selector !== undefined && p.pageIndex === undefined) return fail("unavailable", "EPUB and snapshot positions (selector) are not supported by Zinc's PDF reader");
	if (p.pageIndex === undefined) return fail("invalid-argument", "position.page-index is required for a PDF annotation");
	const out: Position = { pageIndex: p.pageIndex };
	if (p.rects?.length) out.rects = p.rects.map((r) => r.map(round3) as PdfRect);
	if (p.nextPageRects?.length) out.nextPageRects = p.nextPageRects.map((r) => r.map(round3) as PdfRect);
	if (p.paths?.length) out.paths = p.paths.map((x) => x.map(round3));
	if (p.width !== undefined) out.width = p.width;
	if (p.fontSize !== undefined) out.fontSize = p.fontSize;
	if (p.rotation !== undefined) out.rotation = p.rotation;
	return out;
}

/** Zotero stores a position as JSON in one field of at most 65000 characters: a longer one becomes several annotations (rects split). */
export const POSITION_MAX = 65000;
export function splitPosition(p: Position): Position[] {
	if (JSON.stringify(p).length <= POSITION_MAX || !p.rects || p.rects.length < 2) return [p];
	const out: Position[] = [];
	let cur: PdfRect[] = [];
	for (const r of p.rects) {
		const next = [...cur, r];
		if (cur.length && JSON.stringify({ ...p, rects: next, nextPageRects: undefined }).length > POSITION_MAX) {
			out.push({ ...p, rects: cur, nextPageRects: undefined });
			cur = [r];
		} else cur = next;
	}
	if (cur.length) out.push({ ...p, rects: cur, nextPageRects: out.length ? undefined : p.nextPageRects });
	return out;
}

// ---------------------------------------------------------------- annotations

const ms = (iso: string | undefined): bigint => {
	const t = iso ? Date.parse(iso) : NaN;
	return BigInt(Number.isFinite(t) ? t : Date.now());
};

export function toWitAnnotation(
	a: Annotation,
	where: { library: number; attachment: string; readOnly?: boolean; hasImage?: boolean },
): WitAnnotation {
	const external = a.isExternal === true || a.isExternal === "true";
	return {
		key: a.id,
		library: where.library,
		attachment: where.attachment,
		kind: isKind(a.type) ? a.type : "highlight",
		color: String(a.color || "#ffd400").toLowerCase(),
		text: a.text ? a.text : undefined,
		comment: a.comment ?? "",
		pageLabel: a.pageLabel || undefined,
		sortIndex: a.sortIndex,
		position: toWitPosition(a.position),
		tags: (a.tags ?? []).map((t) => ({ name: t.name, color: t.color })),
		authorName: a.authorName || undefined,
		isExternal: external,
		readOnly: !!where.readOnly || external,
		hasImage: where.hasImage ?? (a.type === "image" || a.type === "ink"),
		dateAdded: ms(a.dateCreated),
		dateModified: ms(a.dateModified),
	};
}

/** The fields the store keeps for a new annotation; `sortIndex` and `pageLabel` are the caller's to fill when the plugin left them out. */
export function fromNewAnnotation(n: WitNewAnnotation): {
	key?: string;
	type: AnnotationType;
	color: string;
	text?: string;
	comment?: string;
	sortIndex?: string;
	pageLabel?: string;
	position: Position;
	tags: { name: string }[];
	authorName?: string;
	isExternal: boolean;
} {
	if (!isKind(n.kind)) fail("invalid-argument", `unknown annotation kind ${JSON.stringify(n.kind)}`);
	return {
		key: n.key || undefined,
		type: n.kind,
		color: n.color ? hexColor(n.color) : COLORS[0].value,
		text: n.text,
		comment: n.comment,
		sortIndex: n.sortIndex || undefined,
		pageLabel: n.pageLabel || undefined,
		position: fromWitPosition(n.position),
		tags: (n.tags ?? []).map((name) => ({ name })),
		authorName: n.authorName,
		isExternal: !!n.isExternal,
	};
}

/** An `annotation-patch` as the store's partial update (only the fields that are present). */
export function fromPatch(p: WitAnnotationPatch): Partial<Annotation> {
	const out: Partial<Annotation> = {};
	if (p.kind !== undefined) {
		if (!isKind(p.kind)) fail("invalid-argument", `unknown annotation kind ${JSON.stringify(p.kind)}`);
		out.type = p.kind;
	}
	if (p.color !== undefined) out.color = hexColor(p.color);
	if (p.text !== undefined) out.text = p.text;
	if (p.comment !== undefined) out.comment = p.comment;
	if (p.pageLabel !== undefined) out.pageLabel = p.pageLabel;
	if (p.sortIndex !== undefined) out.sortIndex = p.sortIndex;
	if (p.position !== undefined) out.position = fromWitPosition(p.position);
	if (p.tags !== undefined) out.tags = p.tags.map((name) => ({ name }));
	return out;
}

/** The selection of the reader (normalised rects of its first page, plus every page it touches) as a `text-selection`. */
export function toWitSelection(
	sel: { page: number; text: string; rects: NRect[]; pages?: { page: number; rects: NRect[] }[] },
	size: (page: number) => { w: number; h: number },
	color: string,
	pageLabel?: string,
): TextSelection {
	const pages = (sel.pages ?? [{ page: sel.page, rects: sel.rects }]).map((p) => {
		const s = size(p.page);
		return { page: p.page, rects: p.rects.map((r) => nrectToPdf(r, s.w, s.h)) };
	});
	const pos = selectionToPosition(pages);
	const text = sel.text.replace(/\s+/g, " ").trim();
	return {
		text: sel.text,
		draft: {
			kind: "highlight",
			color,
			text,
			comment: undefined,
			pageLabel,
			sortIndex: undefined,
			position: pos
				? { ...toWitPosition({ pageIndex: pos.pageIndex, rects: pos.rects, nextPageRects: pos.nextPageRects }) }
				: { pageIndex: sel.page, rects: [], nextPageRects: [], paths: [] },
			tags: [],
			isExternal: false,
		},
	};
}

// ---------------------------------------------------------------- menus

const labelOf = (l: MenuEntry["label"]): string => {
	if (!l) return "";
	if (l.tag === "plain") return String(l.val);
	return String((l.val as { fallback?: string; id: string }).fallback ?? (l.val as { id: string }).id);
};

/**
 * A flat `menu-entry` list (children name their `parent`) as Zinc's nested MenuItem list. `run(id)` is called for a chosen item.
 * `visible-when` and `enabled-when` are the extend area's conditions over the main window; a reader menu has no such context, so
 * they are not evaluated here (the entry is shown and enabled).
 */
export function menuEntriesToItems(entries: MenuEntry[], run: (entryId: string) => void): MenuItem[] {
	const children = new Map<string | undefined, MenuEntry[]>();
	for (const e of entries) {
		const p = e.parent ?? undefined;
		const l = children.get(p);
		if (l) l.push(e);
		else children.set(p, [e]);
	}
	const build = (parent: string | undefined, depth: number): MenuItem[] => {
		const out: MenuItem[] = [];
		for (const e of children.get(parent) ?? []) {
			if (e.kind === "separator") {
				if (out.length && !out[out.length - 1]!.separator) out.push({ separator: true });
				continue;
			}
			const item: MenuItem = { label: labelOf(e.label) };
			const swatch = witColorToHex(e.swatch as never);
			if (swatch) {
				item.icon = "circle";
				item.iconColor = swatch;
			}
			if (e.check !== undefined && e.check !== null) item.checked = !!e.check;
			if (e.kind === "submenu") {
				if (depth < 4) item.submenu = build(e.id, depth + 1);
			} else item.onSelect = () => run(e.id);
			out.push(item);
		}
		while (out.length && out[out.length - 1]!.separator) out.pop();
		return out;
	};
	return build(undefined, 0);
}

export const isoNow = nowIso;
