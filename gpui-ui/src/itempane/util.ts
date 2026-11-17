// Pure helpers shared by the item pane sections (ports of ui/src/itempane/ctx.ts and ui/src/itemopen.ts).
import type { ChildSummary, Creator } from "./net";
import type { Collection } from "../contracts";

export const yearOf = (d?: string) => {
	const m = d?.match(/\b(\d{4})\b/);
	return m ? +m[1]! : null;
};

export const creatorLast = (c: Creator) => (c.name !== undefined ? c.name : (c.lastName ?? ""));
export const creatorFull = (c: Creator) => (c.name !== undefined ? c.name : [c.firstName, c.lastName].filter(Boolean).join(" "));

/** "Smith", "Smith and Jones", "Smith et al." using the first creator type that is present. */
export function creatorsSummary(creators: Creator[] | undefined, primary: string): string {
	const list = creators ?? [];
	let pick = list.filter((c) => c.creatorType === primary);
	if (!pick.length) pick = list.filter((c) => c.creatorType !== "contributor");
	if (!pick.length) pick = list;
	const names = pick.map(creatorLast).filter(Boolean);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthIdx = (s: string) => {
	const l = s.toLowerCase();
	const i = MONTHS.findIndex((m) => m.startsWith(l.slice(0, 3)) && m.startsWith(l));
	return i < 0 ? 0 : i + 1;
};

/** Rough equivalent of Zotero's strToDate: the parsed year/month/day parts, if any. */
export function parseDate(s: string): { y?: string; m?: string; d?: string } | null {
	const t = s.trim();
	if (!t) return null;
	let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
	if (m) return { y: m[1], m: String(+m[2]!), d: m[3] ? String(+m[3]) : undefined };
	m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/); // day/month/year
	if (m) return { y: m[3], m: String(+m[2]!), d: String(+m[1]!) };
	m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
	if (m && monthIdx(m[1]!)) return { y: m[3], m: String(monthIdx(m[1]!)), d: String(+m[2]!) };
	m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
	if (m && monthIdx(m[2]!)) return { y: m[3], m: String(monthIdx(m[2]!)), d: String(+m[1]!) };
	m = t.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
	if (m && monthIdx(m[1]!)) return { y: m[2], m: String(monthIdx(m[1]!)) };
	m = t.match(/\b(\d{4})\b/);
	return m ? { y: m[1] } : null;
}

const pad = (n: string | number) => String(n).padStart(2, "0");
export const daysIn = (y: number, m: number) => new Date(Number.isFinite(y) && y > 0 ? y : 2000, m, 0).getDate();
export function formatDateParts(y: string, m: string, d: string): string {
	if (!/^\d{1,4}$/.test(y)) return "";
	const yy = y.padStart(4, "0");
	if (!m) return yy;
	if (!d) return `${yy}-${pad(m)}`;
	return `${yy}-${pad(m)}-${pad(d)}`;
}
/** True when the text is fully represented by year/month/day parts (so nothing is lost by editing them). */
export function isPlainDate(v: string): boolean {
	const t = v.trim();
	if (!t) return true;
	const p = parseDate(t);
	if (!p?.y) return false;
	return (
		formatDateParts(p.y, p.m ?? "", p.d ?? "") === t ||
		/^\d{4}([-/.]\d{1,2}){0,2}$/.test(t) ||
		/^(\d{1,2}\s+)?[A-Za-z]{3,9}\.?,?\s+(\d{1,2}(st|nd|rd|th)?,?\s+)?\d{4}$/.test(t)
	);
}

export function fmtTimestamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return isNaN(+d)
		? iso
		: d.toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
export const decodeEntities = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		}
		return ENT[e.toLowerCase()] ?? m;
	});

/** First non-empty line of a note's HTML (what the web UI lists as the note title). */
export function firstLine(html: string): string {
	const text = decodeEntities(html.replace(/<\/(p|div|h[1-6]|li|br)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""));
	return (
		text
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? ""
	);
}

// ---- children (ui/src/itemopen.ts) ----
export type ChildKind = "reader" | "url" | "file" | "note" | "none";
const isReaderType = (ct: string | null | undefined) => /pdf|epub|html/i.test(ct ?? "");
export function childKind(c: ChildSummary): ChildKind {
	if (c.itemType === "note") return "note";
	if (c.linkMode === "linked_url") return "url";
	if (!c.hasFile) return "none";
	return isReaderType(c.contentType) ? "reader" : "file";
}

/** The attachment the item opens with (Zotero's "best attachment"): its first PDF with a file, else EPUB, else snapshot; undefined when none has a file. */
export function primaryAttachment(children: readonly ChildSummary[]): ChildSummary | undefined {
	const kids = children.filter((c) => childKind(c) === "reader");
	const rank = (c: ChildSummary) => (/pdf/i.test(c.contentType ?? "") ? 0 : /epub/i.test(c.contentType ?? "") ? 1 : 2);
	return [...kids].sort((a, b) => rank(a) - rank(b))[0];
}

/** primaryAttachment(), only when it is a PDF (the item pane's page preview). */
export function primaryPdf(children: readonly ChildSummary[]): ChildSummary | undefined {
	const a = primaryAttachment(children);
	return a && /pdf/i.test(a.contentType ?? "") ? a : undefined;
}

/** DOI -> https://doi.org/..., else the DOI's own URL if it is one. */
export const doiUrl = (doi: string | undefined) => {
	const d = (doi ?? "")
		.trim()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "");
	return d ? "https://doi.org/" + encodeURI(d) : undefined;
};
export const webUrl = (u: string | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined);

// ---- collections ----
export interface FlatCollection {
	key: string;
	path: string[];
}
/** Every collection with its ancestors-first name chain, sorted by path. */
export function flattenCollections(tree: Collection[]): FlatCollection[] {
	const out: FlatCollection[] = [];
	const walk = (list: Collection[], prefix: string[]) => {
		for (const c of list) {
			const path = [...prefix, c.name];
			out.push({ key: c.key, path });
			if (c.children?.length) walk(c.children, path);
		}
	};
	walk(tree, []);
	return out.sort((a, b) => a.path.join("\u0000").localeCompare(b.path.join("\u0000")));
}
