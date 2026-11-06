// Pure helpers for the reader host's citation popups
// (reader-host/src/host.js bundles this file; keep it free of DOM and framework imports).
import type { Reference } from "../../core/src/api-types";

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/i;

export function extractDoi(text: string | undefined | null): string | undefined {
	const m = text ? DOI_RE.exec(text) : null;
	if (!m) return undefined;
	return m[0].replace(/[.,;:)\]}]+$/, "").toLowerCase();
}

export function normalizeText(s: string | undefined | null): string {
	return (s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

const STOP = new Set(["the", "of", "and", "a", "an", "in", "on", "for", "to", "with", "by", "from", "at", "is", "are"]);

function tokens(s: string): string[] {
	return normalizeText(s).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
}

function surname(author: string): string {
	// "Family G" style; fall back to the first token
	const first = author.split(",")[0]!.trim();
	const parts = first.split(/\s+/);
	// "Smith J" -> Smith; "John Smith" -> Smith (single trailing initial otherwise)
	if (parts.length > 1 && /^[A-Z]{1,3}\.?$/.test(parts[parts.length - 1]!)) return normalizeText(parts.slice(0, -1).join(" "));
	return normalizeText(parts[parts.length - 1]);
}

export interface MatchQuery {
	text: string;
	/** DOIs found in link targets inside the popup, if any */
	dois?: string[];
}

/** Score 0..1 of how well `ref` explains the printed reference `text`. */
export function scoreReference(ref: Reference, q: MatchQuery): number {
	const dois = new Set([...(q.dois ?? []), extractDoi(q.text)].filter(Boolean).map((d) => d!.toLowerCase()));
	if (ref.doi && dois.has(ref.doi.toLowerCase())) return 1;

	const nText = normalizeText(q.text);
	if (!nText) return 0;
	let score = 0;

	const nTitle = normalizeText(ref.title);
	if (nTitle.length >= 12 && nText.includes(nTitle)) score = Math.max(score, 0.95);
	else if (nTitle) {
		const tt = tokens(ref.title!);
		if (tt.length) {
			const textTokens = new Set(tokens(q.text));
			const hit = tt.filter((t) => textTokens.has(t)).length;
			score = Math.max(score, (hit / tt.length) * 0.9);
		}
	}

	if (ref.raw) {
		const nRaw = normalizeText(ref.raw);
		if (nRaw && (nRaw === nText || nRaw.includes(nText) || nText.includes(nRaw))) score = Math.max(score, 0.92);
		else {
			const a = new Set(tokens(ref.raw));
			const b = tokens(q.text);
			if (a.size && b.length) {
				const common = b.filter((t) => a.has(t)).length;
				score = Math.max(score, (common / Math.max(a.size, b.length)) * 0.9);
			}
		}
	}

	// first author surname + year is a weaker signal on its own
	const first = ref.authors?.[0] ? surname(ref.authors[0]) : "";
	if (first && ref.year && new RegExp(`\\b${first.replace(/ /g, "\\s+")}\\b`).test(nText) && nText.includes(String(ref.year))) {
		score = Math.max(score, 0.6 + (score > 0.3 ? 0.1 : 0));
	}
	return Math.min(score, 1);
}

export const MATCH_THRESHOLD = 0.55;

/** Best matching reference, or null when nothing is convincing. */
export function matchReference(refs: Reference[], q: MatchQuery): Reference | null {
	let best: Reference | null = null;
	let bestScore = 0;
	for (const r of refs) {
		const s = scoreReference(r, q);
		if (s > bestScore) { best = r; bestScore = s; }
	}
	return bestScore >= MATCH_THRESHOLD ? best : null;
}

export function doiUrl(doi: string): string {
	return "https://doi.org/" + doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

/** Where "open in browser" should go for a reference. */
export function referenceUrl(r: Reference): string | undefined {
	return r.url ?? (r.doi ? doiUrl(r.doi) : undefined);
}

export function citationText(r: Reference): string {
	if (!r.title && r.raw) return r.raw;
	const parts: string[] = [];
	if (r.authors?.length) parts.push(r.authors.join(", ") + ".");
	if (r.title) parts.push(r.title.replace(/\.$/, "") + ".");
	const tail = [r.venue, r.year].filter(Boolean).join(", ");
	if (tail) parts.push(tail + ".");
	if (r.doi) parts.push("https://doi.org/" + r.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
	return parts.join(" ") || r.raw || "";
}
