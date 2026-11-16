// DOI / title normalisation and the in-memory library index used to flag references already in the library.
import type { Database } from "bun:sqlite";

export function normalizeDoi(s: unknown): string | null {
	if (typeof s !== "string") return null;
	// Find the DOI in the raw text first (a raw < or > ends it), then decode it: URL-encoded < and > (%3C %3E) belong to old
	// SICI-style DOIs, as in Zotero.Utilities.cleanDOI.
	let d = s
		.trim()
		.toLowerCase()
		.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//, "")
		.replace(/^doi:\s*/, "");
	if (/^https?%3a%2f%2f/.test(d)) {
		try {
			d = decodeURIComponent(d).replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
		} catch {
			/* keep as is */
		}
	}
	const m = d.match(/10\.\d{4,9}(?:\/|%2f)[^\s"<>]+/);
	if (!m) return null;
	let decoded = m[0];
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		/* an invalid escape: keep the text as written */
	}
	let doi = decoded.replace(/[.,;:]+$/, "");
	// drop an unbalanced trailing bracket picked up from running text
	while (/[)\]]$/.test(doi)) {
		const open = (doi.match(/[([]/g) ?? []).length;
		const close = (doi.match(/[)\]]/g) ?? []).length;
		if (close > open) doi = doi.slice(0, -1).replace(/[.,;:]+$/, "");
		else break;
	}
	return doi || null;
}

export function normalizeTitle(s: unknown): string {
	if (typeof s !== "string") return "";
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/<[^>]*>/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Fraction of `a`'s words that also occur in `b` (word sets). */
export function wordOverlap(a: string, b: string): number {
	const wa = a.split(" ").filter(Boolean);
	if (wa.length === 0) return 0;
	const wb = new Set(b.split(" ").filter(Boolean));
	let hit = 0;
	for (const w of wa) if (wb.has(w)) hit++;
	return hit / wa.length;
}

/** DOI of a Zotero item: data.DOI, "DOI: ..." in extra, or a doi.org URL. */
export function itemDoi(data: Record<string, unknown> | null | undefined): string | null {
	if (!data) return null;
	const direct = normalizeDoi(data.DOI);
	if (direct) return direct;
	const extra = typeof data.extra === "string" ? data.extra : "";
	const m = extra.match(/^\s*DOI:\s*(\S+)/im);
	if (m) {
		const d = normalizeDoi(m[1]);
		if (d) return d;
	}
	const url = typeof data.url === "string" ? data.url : "";
	if (/doi\.org\//i.test(url)) return normalizeDoi(url);
	return null;
}

export interface LibraryIndex {
	size: number;
	byDoi: Map<string, string>;
	byTitle: Map<string, { key: string; year: number | null }[]>;
	match(ref: { doi?: string | null; title?: string | null; year?: number | null }): string | undefined;
}

const NON_TOP = "('attachment','note','annotation')";

/** Build the DOI/title index over top-level, non-deleted items (fast: json_extract in SQL, one pass). */
export function buildLibraryIndex(db: Database, excludeKey?: string): LibraryIndex {
	const rows = db
		.query(
			`SELECT key, title, year,
			   json_extract(data, '$.DOI') AS doi,
			   json_extract(data, '$.extra') AS extra,
			   json_extract(data, '$.url') AS url
			 FROM items
			 WHERE parent_key IS NULL AND deleted = 0 AND item_type NOT IN ${NON_TOP}`,
		)
		.all() as {
		key: string;
		title: string | null;
		year: number | null;
		doi: string | null;
		extra: string | null;
		url: string | null;
	}[];
	const byDoi = new Map<string, string>();
	const byTitle = new Map<string, { key: string; year: number | null }[]>();
	for (const r of rows) {
		if (r.key === excludeKey) continue;
		const doi = itemDoi({ DOI: r.doi, extra: r.extra, url: r.url });
		if (doi && !byDoi.has(doi)) byDoi.set(doi, r.key);
		const t = normalizeTitle(r.title);
		if (t.length >= 10) {
			const list = byTitle.get(t);
			if (list) list.push({ key: r.key, year: r.year });
			else byTitle.set(t, [{ key: r.key, year: r.year }]);
		}
	}
	return {
		size: rows.length,
		byDoi,
		byTitle,
		match(ref) {
			const doi = normalizeDoi(ref.doi);
			if (doi) {
				const k = byDoi.get(doi);
				if (k) return k;
			}
			const t = normalizeTitle(ref.title);
			if (t.length < 10) return undefined;
			const cands = byTitle.get(t);
			if (!cands) return undefined;
			for (const c of cands) {
				if (ref.year != null && c.year != null) {
					if (Math.abs(ref.year - c.year) <= 1) return c.key;
				} else if (t.length >= 30) return c.key; // a long title is distinctive enough without a year
			}
			return undefined;
		},
	};
}
