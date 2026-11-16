// Bibliographic data sources: OpenAlex, Crossref, Semantic Scholar. Pure fetch + mapping, no DB access.
import type { Reference, ReferenceDetail } from "../api-types";
import { normalizeDoi, normalizeTitle, wordOverlap } from "./ids";
import { getJson, mapLimit, withMailto } from "./net";
import { parseEntry } from "./parse";

export type RefCore = Omit<Reference, "index">;

export const OA_SELECT = "id,doi,title,authorships,publication_year,primary_location,open_access,cited_by_count";
export const OA_DETAIL_SELECT = `${OA_SELECT},referenced_works_count,abstract_inverted_index,type`;

export function compact<T extends object>(o: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (v === undefined || v === null || v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	return out as T;
}

/** "Jane A. Smith" -> "Smith JA" */
export function formatName(display: string): string {
	const parts = display.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 2) return display.trim();
	const family = parts[parts.length - 1];
	const initials = parts
		.slice(0, -1)
		.map((p) => p.replace(/[^\p{L}]/gu, "")[0]?.toUpperCase() ?? "")
		.join("");
	return `${family} ${initials}`.trim();
}

function initialsOf(given: string): string {
	return given
		.split(/[\s.\-]+/)
		.filter(Boolean)
		.map((p) => p[0].toUpperCase())
		.join("");
}

export function shortOaId(id: string): string {
	return id.replace(/^https?:\/\/openalex\.org\//, "");
}

// ---------------------------------------------------------------- OpenAlex

export function oaWorkToRef(w: any): RefCore {
	const doi = normalizeDoi(w.doi);
	const loc = w.primary_location;
	const authors = (w.authorships ?? [])
		.slice(0, 6)
		.map((a: any) => (a?.author?.display_name ? formatName(a.author.display_name) : ""))
		.filter(Boolean);
	return compact({
		doi: doi ?? undefined,
		title: (w.title ?? w.display_name) || undefined,
		authors: authors.length ? authors : undefined,
		year: typeof w.publication_year === "number" ? w.publication_year : undefined,
		venue: loc?.source?.display_name || undefined,
		url: doi ? `https://doi.org/${doi}` : loc?.landing_page_url || (w.id as string | undefined),
		openAccessUrl: w.open_access?.oa_url || undefined,
		citedByCount: typeof w.cited_by_count === "number" ? w.cited_by_count : undefined,
	});
}

export function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string | undefined {
	if (!inv || typeof inv !== "object") return undefined;
	const words: string[] = [];
	for (const [word, positions] of Object.entries(inv)) {
		if (!Array.isArray(positions)) continue;
		for (const p of positions) words[p] = word;
	}
	const text = words
		.filter((w) => w !== undefined)
		.join(" ")
		.trim();
	return text || undefined;
}

export function oaWorkToDetail(w: any): ReferenceDetail {
	return compact({
		index: 0,
		...oaWorkToRef(w),
		abstract: reconstructAbstract(w.abstract_inverted_index),
		referenceCount: typeof w.referenced_works_count === "number" ? w.referenced_works_count : undefined,
		type: w.type || undefined,
	}) as ReferenceDetail;
}

const OA = "https://api.openalex.org";

/** References of a DOI via OpenAlex, in the work's own order. null when OpenAlex has no list. */
export async function openAlexReferences(doi: string, mailto: string | null): Promise<RefCore[] | null> {
	const work = await getJson<{ id?: string; referenced_works?: string[] }>(
		withMailto(`${OA}/works/doi:${encodeURI(doi)}?select=id,referenced_works`, mailto),
	);
	const ids = (work?.referenced_works ?? []).map(shortOaId).filter(Boolean);
	if (ids.length === 0) return null;
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
	const pages = await mapLimit(chunks, 2, async (chunk) => {
		const url = withMailto(`${OA}/works?filter=openalex_id:${chunk.join("|")}&per-page=50&select=${OA_SELECT}`, mailto);
		return (await getJson<{ results?: any[] }>(url))?.results ?? [];
	});
	const byId = new Map<string, any>();
	for (const w of pages.flat()) if (w?.id) byId.set(shortOaId(w.id), w);
	return ids.map((id) => {
		const w = byId.get(id);
		return w ? oaWorkToRef(w) : { url: `https://openalex.org/${id}` };
	});
}

/** Batch-fetch OpenAlex metadata for DOIs; map keyed by normalised DOI. Best effort (errors -> partial). */
export async function openAlexByDois(dois: string[], mailto: string | null): Promise<Map<string, RefCore>> {
	const out = new Map<string, RefCore>();
	const uniq = [...new Set(dois)];
	const chunks: string[][] = [];
	for (let i = 0; i < uniq.length; i += 50) chunks.push(uniq.slice(i, i + 50));
	await mapLimit(chunks, 2, async (chunk) => {
		try {
			const url = withMailto(
				`${OA}/works?filter=doi:${chunk.map((d) => `https://doi.org/${d}`).join("|")}&per-page=50&select=${OA_SELECT}`,
				mailto,
			);
			for (const w of (await getJson<{ results?: any[] }>(url))?.results ?? []) {
				const ref = oaWorkToRef(w);
				if (ref.doi) out.set(ref.doi, ref);
			}
		} catch {
			/* enrichment only */
		}
	});
	return out;
}

/** Merge enrichment into refs that have a DOI: fill gaps, always take counts and OA links. */
export function enrich(refs: RefCore[], meta: Map<string, RefCore>): void {
	for (const r of refs) {
		const m = r.doi ? meta.get(r.doi) : undefined;
		if (!m) continue;
		r.title ||= m.title;
		r.authors = r.authors?.length ? r.authors : m.authors;
		r.year ??= m.year;
		r.venue ||= m.venue;
		r.url ||= m.url;
		r.openAccessUrl ||= m.openAccessUrl;
		r.citedByCount ??= m.citedByCount;
	}
}

/** OpenAlex work for the hover card by DOI, else by title search (best match must resemble the query). */
export async function openAlexLookup(q: { doi?: string | null; title?: string | null }, mailto: string | null): Promise<any | null> {
	if (q.doi) {
		const w = await getJson(withMailto(`${OA}/works/doi:${encodeURI(q.doi)}?select=${OA_DETAIL_SELECT}`, mailto));
		if (w) return w;
	}
	if (q.title) {
		const res = await getJson<{ results?: any[] }>(
			withMailto(`${OA}/works?search=${encodeURIComponent(q.title)}&per-page=5&select=${OA_DETAIL_SELECT}`, mailto),
		);
		const want = normalizeTitle(q.title);
		for (const w of res?.results ?? []) {
			const got = normalizeTitle(w.title ?? w.display_name);
			if (got && (got === want || (wordOverlap(want, got) >= 0.85 && wordOverlap(got, want) >= 0.85))) return w;
		}
	}
	return null;
}

// ---------------------------------------------------------------- Crossref

const CR = "https://api.crossref.org";

export function stripMarkup(s: string): string {
	return s
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export function crossrefRefToCore(r: any): RefCore {
	const raw: string | undefined = typeof r.unstructured === "string" ? r.unstructured.trim() : undefined;
	const parsed = raw ? parseEntry(raw) : undefined;
	const doi = normalizeDoi(r.DOI) ?? parsed?.doi ?? null;
	const year = r.year && /^\d{4}/.test(String(r.year)) ? Number(String(r.year).slice(0, 4)) : parsed?.year;
	const title: string | undefined = r["article-title"] || r["volume-title"] || r["series-title"] || parsed?.title || undefined;
	return compact({
		raw,
		doi: doi ?? undefined,
		title,
		authors: r.author ? [String(r.author)] : parsed?.authors,
		year,
		venue: r["journal-title"] || undefined,
		url: doi ? `https://doi.org/${doi}` : undefined,
	});
}

export async function crossrefWork(doi: string, mailto: string | null): Promise<any | null> {
	return (await getJson<{ message?: any }>(withMailto(`${CR}/works/${encodeURI(doi)}`, mailto)))?.message ?? null;
}

export async function crossrefReferences(doi: string, mailto: string | null): Promise<RefCore[] | null> {
	const msg = await crossrefWork(doi, mailto);
	const list = msg?.reference;
	if (!Array.isArray(list) || list.length === 0) return null;
	return list.map(crossrefRefToCore);
}

export function crossrefYear(m: any): number | undefined {
	const parts = (m?.issued ?? m?.["published-print"] ?? m?.["published-online"] ?? m?.created)?.["date-parts"]?.[0];
	return typeof parts?.[0] === "number" ? parts[0] : undefined;
}

/** Resolve a printed reference to a Crossref work; the hit must plausibly be the same title. */
export async function crossrefQuery(raw: string, mailto: string | null): Promise<RefCore | null> {
	const url = withMailto(
		`${CR}/works?query.bibliographic=${encodeURIComponent(raw.slice(0, 400))}&rows=2&select=DOI,title,author,issued,container-title,is-referenced-by-count,URL`,
		mailto,
	);
	const res = await getJson<{ message?: { items?: any[] } }>(url);
	const rawNorm = normalizeTitle(raw);
	for (const it of res?.message?.items ?? []) {
		const title: string | undefined = it.title?.[0] ? stripMarkup(it.title[0]) : undefined;
		const t = normalizeTitle(title);
		if (t.split(" ").length < 3) continue;
		if (wordOverlap(t, rawNorm) < 0.85) continue;
		const doi = normalizeDoi(it.DOI);
		return compact({
			doi: doi ?? undefined,
			title,
			authors: (it.author ?? [])
				.slice(0, 6)
				.map((a: any) => (a.family ? `${a.family} ${initialsOf(a.given ?? "")}`.trim() : a.name))
				.filter(Boolean),
			year: crossrefYear(it),
			venue: it["container-title"]?.[0],
			url: doi ? `https://doi.org/${doi}` : undefined,
			citedByCount: typeof it["is-referenced-by-count"] === "number" ? it["is-referenced-by-count"] : undefined,
		});
	}
	return null;
}

// ---------------------------------------------------------------- Semantic Scholar

export async function semanticScholarReferences(doi: string): Promise<RefCore[] | null> {
	const fields = "title,year,authors,externalIds,venue,openAccessPdf,citationCount,url";
	const res = await getJson<{ data?: { citedPaper?: any }[] }>(
		`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURI(doi)}/references?fields=${fields}&limit=1000`,
	);
	const data = res?.data;
	if (!Array.isArray(data) || data.length === 0) return null;
	return data.map(({ citedPaper: p }) => {
		const d = normalizeDoi(p?.externalIds?.DOI);
		return compact({
			doi: d ?? undefined,
			title: p?.title || undefined,
			authors: (p?.authors ?? [])
				.slice(0, 6)
				.map((a: any) => (a?.name ? formatName(a.name) : ""))
				.filter(Boolean),
			year: typeof p?.year === "number" ? p.year : undefined,
			venue: p?.venue || undefined,
			url: d ? `https://doi.org/${d}` : p?.url || undefined,
			openAccessUrl: p?.openAccessPdf?.url || undefined,
			citedByCount: typeof p?.citationCount === "number" ? p.citationCount : undefined,
		}) as RefCore;
	});
}
