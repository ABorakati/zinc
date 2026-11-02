// DOM-free card logic copied from ui/src/cards/{fields,tags,layout}.ts and itemopen.ts (default layout only).
import type { ItemRow } from "../contracts";

/** The web UI's default card layout (ui/src/cards/layout.ts DEFAULT_LAYOUT). */
export const LAYOUT = {
	star: true,
	tags: true,
	allTags: false,
	creators: "full" as "full" | "short" | "summary" | "off",
	meta: ["publication", "year", "itemType"] as const,
	icons: true,
	density: "comfortable" as "comfortable" | "compact",
};

export const STAR_TAG = "Starred";

type Row = ItemRow & { fields?: Record<string, string | undefined> };

/** Creators as "Last F" strings (the core returns strings; the contract also allows objects). */
function creatorNames(it: ItemRow): string[] | undefined {
	const cs = it.creators as unknown[] | undefined;
	if (!cs) return undefined;
	return cs.map((c) => {
		if (typeof c === "string") return c;
		const o = c as { firstName?: string; lastName?: string; name?: string };
		if (o.name) return o.name;
		const initials = (o.firstName ?? "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("");
		return [o.lastName, initials].filter(Boolean).join(" ");
	});
}

/** Card.tsx `authors()`: full list (CSS truncates it), or the summary. */
export function authorsText(it: ItemRow, mode: typeof LAYOUT.creators = LAYOUT.creators): string {
	if (mode === "off") return "";
	const names = creatorNames(it);
	if (mode === "summary" || !names) return it.creatorsSummary ?? "";
	return mode === "short" && names.length > 3 ? names.slice(0, 3).join(", ") + " et al." : names.join(", ");
}

const typeLabel = (t: string) => t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

export interface MetaPart { text: string; accent: boolean }

/** Meta line fields in order, empty ones dropped (fields.ts SPECIAL.publication / year / itemType). */
export function metaParts(it: ItemRow): MetaPart[] {
	const out: MetaPart[] = [];
	for (const id of LAYOUT.meta) {
		if (id === "publication" && it.publication) out.push({ text: it.publication, accent: true });
		else if (id === "year" && it.year) out.push({ text: String(it.year), accent: false });
		else if (id === "itemType") out.push({ text: typeLabel(it.itemType), accent: false });
	}
	return out;
}

export const isRegular = (it: ItemRow) => it.itemType !== "attachment" && it.itemType !== "note" && it.itemType !== "annotation";

export const webUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);
export const doiUrl = (d: string | null | undefined) => (d ? "https://doi.org/" + d.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : null);
export const webpageOf = (it: ItemRow) => (isRegular(it) ? webUrl((it as Row).fields?.url) ?? doiUrl((it as Row).fields?.DOI) : null);

export const openLabel = (ct: string | undefined) => (/epub/i.test(ct ?? "") ? "Open EPUB" : /html/i.test(ct ?? "") ? "Open snapshot" : "Open PDF");
export const needsFullText = (it: ItemRow) => isRegular(it) && !it.primaryAttachment && it.itemType !== "webpage";

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const extraAttachments = (it: ItemRow) => (it.attachmentCount ?? 0) - (it.primaryAttachment ? 1 : 0);

export const isStarred = (it: ItemRow) => !!it.tags?.some((t) => t.tag === STAR_TAG);

/** Coloured tags (GET /api/tag-colors): empty in the spike's library, so no badges show. */
let tagColors = new Map<string, { color: string; position: number }>();
export function setTagColors(list: { name: string; color: string; position: number }[]) {
	tagColors = new Map(list.map((c) => [c.name, c]));
}
/** The tags shown as badges: coloured ones by position (+ the rest alphabetically when `allTags`); never the star tag. */
export function badgeTags(it: ItemRow, showAll = LAYOUT.allTags): { name: string; color?: string }[] {
	const out: { name: string; color?: string; pos: number }[] = [];
	for (const t of it.tags ?? []) {
		if (t.tag === STAR_TAG) continue;
		const c = tagColors.get(t.tag);
		if (c) out.push({ name: t.tag, color: c.color, pos: c.position });
		else if (showAll) out.push({ name: t.tag, pos: 1e9 });
	}
	return out.sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name));
}

// ---- colour mixing (CSS color-mix(in srgb, a pct%, b)) over hex / rgb() strings ----
type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA {
	c = c.trim();
	let m = /^#([0-9a-f]{3,8})$/i.exec(c);
	if (m) {
		let h = m[1]!;
		if (h.length <= 4) h = [...h].map((x) => x + x).join("");
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
	}
	m = /^rgba?\(([^)]+)\)$/i.exec(c);
	if (m) {
		const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
		return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
	}
	return [128, 128, 128, 1];
}
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
export function toHex([r, g, b, a]: RGBA): string {
	return "#" + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a * 255) : "");
}
/** color-mix(in srgb, a pct%, b); `b` may be "transparent". */
export function mix(a: string, pct: number, b: string): string {
	const A = parseColor(a);
	const B = b === "transparent" ? ([A[0], A[1], A[2], 0] as RGBA) : parseColor(b);
	const t = pct / 100;
	const alpha = A[3] * t + B[3] * (1 - t);
	if (alpha === 0) return toHex([A[0], A[1], A[2], 0]);
	const ch = (i: 0 | 1 | 2) => (A[i] * A[3] * t + B[i] * B[3] * (1 - t)) / alpha;
	return toHex([ch(0), ch(1), ch(2), alpha]);
}
/** `c` at alpha `a` (Tailwind "text-primary/90"). */
export const alpha = (c: string, a: number) => { const [r, g, b, a0] = parseColor(c); return toHex([r, g, b, a0 * a]); };
