// Hover-card lookup and one-click "add reference to library".
import type { Database } from "bun:sqlite";
import type { ItemDetail, Reference, ReferenceDetail, ZoteroItemData } from "../api-types";
import { HttpError, createItem } from "../db";
import { fulltextService } from "../fulltext/service";
import { indexItem } from "../search";
import { buildLibraryIndex, normalizeDoi } from "./ids";
import { mailtoFor } from "./net";
import {
	compact,
	crossrefWork,
	crossrefYear,
	oaWorkToDetail,
	openAlexLookup,
	stripMarkup,
} from "./sources";

export const addHooks = {
	/** Starts a Find Full Text job for one item (tests replace it). */
	findFullText: (db: Database, key: string): void => {
		void fulltextService(db)
			.start([key])
			.catch((e) => console.error("find full text failed:", e));
	},
};

export class AlreadyInLibrary extends Error {
	constructor(public key: string) {
		super("already in the library");
	}
}

// Lookups go to OpenAlex/Crossref (a second or more each), so results are kept in the database: found works
// for 30 days, "not found" for a day. The library match is redone on each request (cheap, see libraryIndex).
const DETAIL_TTL = 30 * 86400_000;
const MISS_TTL = 86400_000;

function detailCache(db: Database) {
	db.exec("CREATE TABLE IF NOT EXISTS reference_detail_cache(k TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)");
	return {
		get(k: string): ReferenceDetail | null | undefined {
			const row = db.query("SELECT data, fetched_at FROM reference_detail_cache WHERE k = ?").get(k) as { data: string | null; fetched_at: number } | null;
			if (!row || Date.now() - row.fetched_at > (row.data ? DETAIL_TTL : MISS_TTL)) return undefined;
			try { return row.data ? JSON.parse(row.data) as ReferenceDetail : null; } catch { return undefined; }
		},
		set(k: string, d: ReferenceDetail | null) {
			db.query("INSERT OR REPLACE INTO reference_detail_cache(k, data, fetched_at) VALUES(?, ?, ?)").run(k, d ? JSON.stringify(d) : null, Date.now());
		},
	};
}

/** The library DOI/title index, rebuilt at most every 30 s (it scans every item; hover cards ask often). */
let libIndex: { db: Database; at: number; index: ReturnType<typeof buildLibraryIndex> } | null = null;
function libraryIndex(db: Database) {
	if (!libIndex || libIndex.db !== db || Date.now() - libIndex.at > 30_000) libIndex = { db, at: Date.now(), index: buildLibraryIndex(db) };
	return libIndex.index;
}

export async function lookupReference(db: Database, q: { doi?: string | null; title?: string | null }): Promise<ReferenceDetail> {
	const doi = normalizeDoi(q.doi);
	const title = q.title?.trim() || null;
	if (!doi && !title) throw new HttpError(400, "doi or title is required");
	const cache = detailCache(db);
	const ck = doi ? `doi:${doi}` : `title:${title!.toLowerCase()}`;
	const hit = cache.get(ck);
	if (hit === null) throw new HttpError(404, "work not found");
	if (hit) {
		const inLib = libraryIndex(db).match(hit);
		return inLib ? { ...hit, inLibraryKey: inLib } : hit;
	}
	const detail = await fetchDetail(db, doi, title);
	cache.set(ck, detail);
	if (!detail) throw new HttpError(404, "work not found");
	const inLib = libraryIndex(db).match(detail);
	if (inLib) detail.inLibraryKey = inLib;
	return detail;
}

async function fetchDetail(db: Database, doi: string | null, title: string | null): Promise<ReferenceDetail | null> {
	const mailto = mailtoFor(db);
	let detail: ReferenceDetail | null = null;
	const w = await openAlexLookup({ doi, title }, mailto).catch(() => null);
	if (w) detail = oaWorkToDetail(w);
	else if (doi) {
		const m = await crossrefWork(doi, mailto).catch(() => null);
		if (m) {
			detail = compact({
				index: 0,
				doi,
				title: m.title?.[0] ? stripMarkup(m.title[0]) : undefined,
				authors: (m.author ?? []).slice(0, 6).map((a: any) => (a.family ? `${a.family} ${(a.given ?? "").split(/[\s.\-]+/).filter(Boolean).map((p: string) => p[0].toUpperCase()).join("")}`.trim() : a.name)).filter(Boolean),
				year: crossrefYear(m),
				venue: m["container-title"]?.[0],
				url: `https://doi.org/${doi}`,
				abstract: typeof m.abstract === "string" ? stripMarkup(m.abstract).replace(/^abstract\s*/i, "") : undefined,
				citedByCount: typeof m["is-referenced-by-count"] === "number" ? m["is-referenced-by-count"] : undefined,
				referenceCount: typeof m["references-count"] === "number" ? m["references-count"] : undefined,
				type: m.type,
			}) as ReferenceDetail;
		}
	}
	return detail;
}

// ---------------------------------------------------------------- Crossref -> Zotero

const TYPE_MAP: Record<string, string> = {
	"journal-article": "journalArticle",
	"book-chapter": "bookSection",
	"book-part": "bookSection",
	"book-section": "bookSection",
	book: "book",
	monograph: "book",
	"edited-book": "book",
	"reference-book": "book",
	"proceedings-article": "conferencePaper",
	"posted-content": "preprint",
	dissertation: "thesis",
	report: "report",
	"report-component": "report",
	dataset: "dataset",
	standard: "standard",
};

function creatorsFrom(m: any): NonNullable<ZoteroItemData["creators"]> {
	const out: NonNullable<ZoteroItemData["creators"]> = [];
	const push = (list: any[] | undefined, creatorType: string) => {
		for (const a of list ?? []) {
			if (a.family) out.push({ creatorType, firstName: a.given ?? "", lastName: a.family });
			else if (a.name) out.push({ creatorType, name: a.name });
		}
	};
	push(m.author, "author");
	push(m.editor, "editor");
	return out;
}

function dateFrom(m: any): string | undefined {
	const parts: number[] | undefined = (m.issued ?? m["published-print"] ?? m["published-online"] ?? m.created)?.["date-parts"]?.[0];
	if (!parts || typeof parts[0] !== "number") return undefined;
	return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("-");
}

export function crossrefToItem(m: any, doi: string): Partial<ZoteroItemData> {
	const type = TYPE_MAP[m.type] ?? "journalArticle";
	const container: string | undefined = m["container-title"]?.[0] ? stripMarkup(m["container-title"][0]) : undefined;
	const short: string | undefined = m["short-container-title"]?.[0];
	const tags: { tag: string; type?: number }[] = [];
	if (Array.isArray(m.subject)) {
		for (const s of m.subject) {
			const str = String(s).trim();
			if (str) tags.push({ tag: str, type: 1 });
		}
	}
	const common = {
		title: m.title?.[0] ? stripMarkup(m.title[0]) : "",
		creators: creatorsFrom(m),
		date: dateFrom(m),
		DOI: doi,
		url: m.URL || `https://doi.org/${doi}`,
		abstractNote: typeof m.abstract === "string" ? stripMarkup(m.abstract).replace(/^abstract\s*/i, "") : undefined,
		language: m.language,
		tags: tags.length ? tags : undefined,
	};
	const issn = Array.isArray(m.ISSN) ? m.ISSN[0] : undefined;
	const isbn = Array.isArray(m.ISBN) ? m.ISBN[0] : undefined;
	let extra: Record<string, unknown>;
	switch (type) {
		case "bookSection":
			extra = { bookTitle: container, publisher: m.publisher, pages: m.page, ISBN: isbn, place: m["publisher-location"] };
			break;
		case "book":
			extra = { publisher: m.publisher, place: m["publisher-location"], ISBN: isbn, volume: m.volume, edition: m["edition-number"] };
			break;
		case "conferencePaper":
			extra = { proceedingsTitle: container, publisher: m.publisher, volume: m.volume, pages: m.page, ISBN: isbn, ISSN: issn };
			break;
		case "preprint":
			extra = { repository: m.institution?.[0]?.name ?? m.publisher ?? container };
			break;
		case "thesis":
			extra = { university: m.institution?.[0]?.name ?? m.publisher };
			break;
		case "report":
			extra = { institution: m.institution?.[0]?.name ?? m.publisher, reportNumber: m.number };
			break;
		case "dataset":
			extra = { repository: m.publisher };
			break;
		case "standard":
			extra = { organization: m.publisher };
			break;
		default:
			extra = {
				publicationTitle: container,
				volume: m.volume,
				issue: m.issue,
				pages: m.page,
				ISSN: issn,
				journalAbbreviation: short,
			};
	}
	return { itemType: type, ...compact({ ...common, ...extra }) } as Partial<ZoteroItemData>;
}

function creatorFromAuthor(a: string): { creatorType: string; firstName?: string; lastName?: string; name?: string } {
	const m = a.trim().match(/^(.+?)\s+([\p{Lu}]{1,4})$/u);
	if (m) return { creatorType: "author", lastName: m[1], firstName: m[2] };
	return { creatorType: "author", name: a.trim() };
}

function itemFromReference(r: Reference): Partial<ZoteroItemData> {
	return {
		itemType: "journalArticle",
		title: r.title ?? r.raw ?? "",
		creators: (r.authors ?? []).map(creatorFromAuthor),
		date: r.year ? String(r.year) : undefined,
		publicationTitle: r.venue,
		DOI: r.doi,
		url: r.url ?? (r.doi ? `https://doi.org/${r.doi}` : undefined),
		...(r.raw && r.raw !== r.title ? { extra: `Reference: ${r.raw}` } : {}),
	} as Partial<ZoteroItemData>;
}

export interface AddRequest {
	doi?: string;
	reference?: Reference;
	collectionKey?: string;
	findFullText?: boolean;
}

export async function addReference(db: Database, req: AddRequest): Promise<ItemDetail> {
	const ref = req.reference && typeof req.reference === "object" ? req.reference : undefined;
	const doi = normalizeDoi(req.doi) ?? normalizeDoi(ref?.doi);
	if (!doi && !ref) throw new HttpError(400, "doi or reference is required");
	if (req.collectionKey !== undefined && typeof req.collectionKey !== "string") throw new HttpError(400, "collectionKey must be a string");

	const existing = buildLibraryIndex(db).match({ doi, title: ref?.title, year: ref?.year });
	if (existing) throw new AlreadyInLibrary(existing);

	const mailto = mailtoFor(db);
	let data: Partial<ZoteroItemData> | null = null;
	if (doi) {
		const m = await crossrefWork(doi, mailto).catch(() => null);
		if (m) data = crossrefToItem(m, doi);
	}
	if (!data && doi) {
		// Crossref does not know this DOI (e.g. DataCite): fall back to OpenAlex, then to the supplied reference
		const w = await openAlexLookup({ doi }, mailto).catch(() => null);
		if (w) {
			const d = oaWorkToDetail(w);
			data = itemFromReference({ ...d, doi });
			if (d.abstract) data.abstractNote = d.abstract;
		}
	}
	if (!data && ref) data = itemFromReference(ref);
	if (!data) throw new HttpError(404, "no metadata found for that DOI");
	if (!data.title) throw new HttpError(422, "the source has no title for this work");
	if (req.collectionKey) data.collections = [req.collectionKey];

	const detail = createItem(db, data);
	indexItem(db, detail.data.key);
	if (req.findFullText === true) {
		try {
			addHooks.findFullText(db, detail.data.key);
		} catch (e) {
			console.error("find full text failed:", e);
		}
	}
	return detail;
}
