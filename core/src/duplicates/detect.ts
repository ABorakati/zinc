// Fast in-memory duplicate detection modeled on Zotero's duplicate detection rules.
// Candidates match by:
//   1. Identical normalised DOI (same itemType, or both in {journalArticle, preprint, conferencePaper})
//   2. Identical normalised ISBN (same itemType)
//   3. Normalised title (lowercase, strip punctuation/diacritics/HTML) + matching first-author last name
//      (or both creatorless) + years within 1 (or a year missing), with identical itemType.
// Pairs in `duplicate_exclusions` are never matched or grouped together.

import type { Database } from "bun:sqlite";
import type { Creator } from "../api-types";
import { codePointChar } from "../entity";
import schemaSql from "./schema.sql" with { type: "text" };

export type DuplicateReason = "doi" | "isbn" | "title";

export interface DuplicateSet {
	keys: string[];
	reason: DuplicateReason;
	title?: string;
	creatorsSummary?: string;
	year?: number | null;
	itemType?: string;
}

export interface DuplicateList {
	sets: DuplicateSet[];
	total: number;
}

const ready = new WeakSet<Database>();

export function ensureDuplicatesSchema(db: Database): void {
	if (ready.has(db)) return;
	db.exec(schemaSql);
	ready.add(db);
}

const SPECIAL_CHARS: Record<string, string> = {
	ß: "ss",
	æ: "ae",
	œ: "oe",
	ø: "o",
	ł: "l",
	đ: "d",
	ð: "d",
	þ: "th",
};

export function stripDiacritics(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[ßæœøłđðþ]/g, (c) => SPECIAL_CHARS[c] ?? c);
}

export function normalizeTitle(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	const noHtml = raw
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, n) => codePointChar(Number(n)));
	const lower = stripDiacritics(noHtml.toLowerCase());
	return lower
		.replace(/['’\u2018\u2019]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function normalizeDoi(raw: unknown, extra?: unknown): string | null {
	let s = typeof raw === "string" ? raw.trim() : "";
	if (!s && typeof extra === "string" && extra.includes("DOI")) {
		const m = /(?:^|\n)\s*DOI:\s*(\S+)/i.exec(extra);
		if (m) s = m[1].trim();
	}
	if (!s) return null;
	s = s
		.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|urn:doi:|doi:\s*)/i, "")
		.trim()
		.replace(/[.,;]+$/, "")
		.toLowerCase();
	return s || null;
}

function isbn10To13(isbn10: string): string {
	const core = "978" + isbn10.slice(0, 9);
	let sum = 0;
	for (let i = 0; i < 12; i++) {
		sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
	}
	const check = (10 - (sum % 10)) % 10;
	return core + String(check);
}

export function normalizeIsbns(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	const parts = raw
		.split(/[,;\n\r/]+/)
		.map((p) => p.replace(/[\s-]+/g, "").toUpperCase())
		.filter(Boolean);
	const out: string[] = [];
	for (const p of parts) {
		if (/^\d{9}[\dX]$/.test(p)) {
			out.push(isbn10To13(p));
		} else if (p.length >= 10) {
			out.push(p);
		}
	}
	return out.length > 1 ? [...new Set(out)] : out;
}

export function extractFirstAuthorLastName(creatorsJson: string | null): string | null {
	if (!creatorsJson) return null;
	let creators: Creator[];
	try {
		const parsed = JSON.parse(creatorsJson);
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		creators = parsed;
	} catch {
		return null;
	}
	const authors = creators.filter((c) => c && c.creatorType === "author");
	const list = authors.length > 0 ? authors : creators;
	for (const c of list) {
		if (!c) continue;
		const raw = (c.lastName || c.name || c.firstName || "").trim();
		if (!raw) continue;
		const norm = normalizeTitle(raw);
		if (norm) return norm;
	}
	return null;
}

const DOI_CROSS_TYPES = new Set(["journalArticle", "preprint", "conferencePaper"]);

export function canMatchByDoi(typeA: string, typeB: string): boolean {
	if (typeA === typeB) return true;
	return DOI_CROSS_TYPES.has(typeA) && DOI_CROSS_TYPES.has(typeB);
}

export function titleTokenSet(normTitle: string): Set<string> {
	if (!normTitle) return new Set();
	return new Set(normTitle.split(/\s+/).filter(Boolean));
}

/**
 * Checks whether two normalised titles are similar enough to be considered the same work:
 * - Token Jaccard >= 0.6, OR
 * - One normalised title contains the other (handles subtitles and truncated titles).
 * When `strict` is true (shared/supplement DOI with > 5 items), requires non-trivial length for substring containment.
 */
export function titlesSimilar(normA: string, normB: string, tokensA?: Set<string>, tokensB?: Set<string>, strict = false): boolean {
	if (!normA || !normB) return false;
	if (normA === normB) return true;
	const shorterLen = Math.min(normA.length, normB.length);
	if (shorterLen >= (strict ? 10 : 4) && (normA.includes(normB) || normB.includes(normA))) {
		return true;
	}
	const setA = tokensA ?? titleTokenSet(normA);
	const setB = tokensB ?? titleTokenSet(normB);
	if (setA.size === 0 || setB.size === 0) return false;
	let intersection = 0;
	const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
	for (const tok of small) {
		if (large.has(tok)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union > 0 && intersection / union >= 0.6;
}

function yearsCompatible(yearA: number | null, yearB: number | null): boolean {
	if (yearA === null || yearB === null) return true;
	return Math.abs(yearA - yearB) <= 1;
}

export function pairKey(a: string, b: string): string {
	return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

interface CandidateRow {
	key: string;
	item_type: string;
	title: string | null;
	creators_summary: string | null;
	year: number | null;
	date_added: string;
	doi: string | null;
	isbn: string | null;
	extra: string | null;
	creators_json: string | null;
}

interface IndexedItem {
	idx: number;
	key: string;
	itemType: string;
	title: string;
	creatorsSummary: string;
	normTitle: string;
	year: number | null;
	dateAdded: string;
	firstAuthorLast: string | null;
}

const REASON_PRIORITY: Record<DuplicateReason, number> = {
	doi: 3,
	isbn: 2,
	title: 1,
};

/** Duplicate sets within one library (My Library unless `library` is given): items of different libraries are never candidates. */
export function detectDuplicates(db: Database, opts: { includeSummary?: boolean; library?: number } = {}): DuplicateList {
	ensureDuplicatesSchema(db);

	const exclRows = db.query("SELECT key_a, key_b FROM duplicate_exclusions").all() as {
		key_a: string;
		key_b: string;
	}[];
	const excluded = new Set<string>();
	for (const r of exclRows) {
		excluded.add(pairKey(r.key_a, r.key_b));
	}

	const rows = db
		.query(
			`SELECT
				key,
				item_type,
				title,
				creators_summary,
				year,
				date_added,
				json_extract(data, '$.DOI') AS doi,
				json_extract(data, '$.ISBN') AS isbn,
				json_extract(data, '$.extra') AS extra,
				json_extract(data, '$.creators') AS creators_json
			 FROM items
			 WHERE parent_key IS NULL
			   AND deleted = 0
			   AND library_id = ?
			   AND item_type NOT IN ('attachment', 'note', 'annotation')`,
		)
		.all(opts.library ?? 1) as CandidateRow[];

	const n = rows.length;
	if (n < 2) return { sets: [], total: 0 };

	const items: IndexedItem[] = new Array(n);
	const doiBuckets = new Map<string, number[]>();
	const isbnBuckets = new Map<string, number[]>();
	const titleBuckets = new Map<string, number[]>();

	for (let i = 0; i < n; i++) {
		const r = rows[i];
		const normTitle = normalizeTitle(r.title);
		const firstAuthorLast = normTitle ? extractFirstAuthorLastName(r.creators_json) : null;
		items[i] = {
			idx: i,
			key: r.key,
			itemType: r.item_type,
			title: r.title ?? "",
			creatorsSummary: r.creators_summary ?? "",
			normTitle,
			year: r.year,
			dateAdded: r.date_added,
			firstAuthorLast,
		};

		const doi = normalizeDoi(r.doi, r.extra);
		if (doi) {
			let b = doiBuckets.get(doi);
			if (!b) doiBuckets.set(doi, (b = []));
			b.push(i);
		}

		if (r.isbn) {
			for (const isbn of normalizeIsbns(r.isbn)) {
				const bKey = `${r.item_type}\0${isbn}`;
				let b = isbnBuckets.get(bKey);
				if (!b) isbnBuckets.set(bKey, (b = []));
				b.push(i);
			}
		}

		if (normTitle) {
			const authorKey = firstAuthorLast === null ? "\0NONE" : firstAuthorLast;
			const tKey = `${r.item_type}\0${normTitle}\0${authorKey}`;
			let b = titleBuckets.get(tKey);
			if (!b) titleBuckets.set(tKey, (b = []));
			b.push(i);
		}
	}

	// Lazy token-set cache for items compared within DOI/ISBN buckets
	const tokenCache = new Map<number, Set<string>>();
	const getTokens = (idx: number): Set<string> => {
		let s = tokenCache.get(idx);
		if (!s) {
			s = titleTokenSet(items[idx].normTitle);
			tokenCache.set(idx, s);
		}
		return s;
	};

	// Collect candidate edges in priority order: DOI -> ISBN -> Title
	const edges: { u: number; v: number; reason: DuplicateReason }[] = [];

	for (const bucket of doiBuckets.values()) {
		if (bucket.length < 2) continue;
		const isSupplementDoi = bucket.length > 5;
		for (let i = 0; i < bucket.length; i++) {
			const u = bucket[i];
			for (let j = i + 1; j < bucket.length; j++) {
				const v = bucket[j];
				if (!canMatchByDoi(items[u].itemType, items[v].itemType)) continue;
				if (excluded.has(pairKey(items[u].key, items[v].key))) continue;
				if (!titlesSimilar(items[u].normTitle, items[v].normTitle, getTokens(u), getTokens(v), isSupplementDoi)) {
					continue;
				}
				edges.push({ u, v, reason: "doi" });
			}
		}
	}

	for (const bucket of isbnBuckets.values()) {
		if (bucket.length < 2) continue;
		const isSharedIsbn = bucket.length > 5;
		for (let i = 0; i < bucket.length; i++) {
			const u = bucket[i];
			for (let j = i + 1; j < bucket.length; j++) {
				const v = bucket[j];
				if (excluded.has(pairKey(items[u].key, items[v].key))) continue;
				if (!titlesSimilar(items[u].normTitle, items[v].normTitle, getTokens(u), getTokens(v), isSharedIsbn)) {
					continue;
				}
				edges.push({ u, v, reason: "isbn" });
			}
		}
	}

	for (const bucket of titleBuckets.values()) {
		if (bucket.length < 2) continue;
		for (let i = 0; i < bucket.length; i++) {
			const u = bucket[i];
			for (let j = i + 1; j < bucket.length; j++) {
				const v = bucket[j];
				if (!yearsCompatible(items[u].year, items[v].year)) continue;
				if (excluded.has(pairKey(items[u].key, items[v].key))) continue;
				edges.push({ u, v, reason: "title" });
			}
		}
	}

	if (edges.length === 0) return { sets: [], total: 0 };

	// Complete-linkage clustering: only merge components when all members are mutually title-similar and not excluded
	const parent = new Int32Array(n);
	const members = new Map<number, number[]>();
	const compReason = new Map<number, DuplicateReason>();
	for (let i = 0; i < n; i++) parent[i] = i;

	function find(x: number): number {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]];
			x = parent[x];
		}
		return x;
	}

	for (const { u, v, reason } of edges) {
		const ru = find(u);
		const rv = find(v);
		if (ru === rv) {
			const cur = compReason.get(ru);
			if (!cur || REASON_PRIORITY[reason] > REASON_PRIORITY[cur]) {
				compReason.set(ru, reason);
			}
			continue;
		}
		const mu = members.get(ru) ?? [ru];
		const mv = members.get(rv) ?? [rv];
		let blocked = false;
		for (const a of mu) {
			for (const b of mv) {
				if (excluded.size > 0 && excluded.has(pairKey(items[a].key, items[b].key))) {
					blocked = true;
					break;
				}
				if (!titlesSimilar(items[a].normTitle, items[b].normTitle, getTokens(a), getTokens(b))) {
					blocked = true;
					break;
				}
			}
			if (blocked) break;
		}
		if (blocked) continue;
		// Merge rv into ru
		parent[rv] = ru;
		members.set(ru, [...mu, ...mv]);
		members.delete(rv);
		const r1 = compReason.get(ru);
		const r2 = compReason.get(rv);
		compReason.delete(rv);
		let best = reason;
		if (r1 && REASON_PRIORITY[r1] > REASON_PRIORITY[best]) best = r1;
		if (r2 && REASON_PRIORITY[r2] > REASON_PRIORITY[best]) best = r2;
		compReason.set(ru, best);
	}

	const sets: DuplicateSet[] = [];
	for (const [root, idxs] of members.entries()) {
		if (idxs.length < 2) continue;
		idxs.sort((a, b) => {
			const cmp = items[a].dateAdded.localeCompare(items[b].dateAdded);
			return cmp !== 0 ? cmp : items[a].key.localeCompare(items[b].key);
		});
		const first = items[idxs[0]];
		const entry: DuplicateSet = {
			keys: idxs.map((i) => items[i].key),
			reason: compReason.get(root) ?? "title",
		};
		if (opts.includeSummary) {
			entry.title = first.title;
			entry.creatorsSummary = first.creatorsSummary;
			entry.year = first.year;
			entry.itemType = first.itemType;
		}
		sets.push(entry);
	}

	// Deterministic order by first item's normalized title, then first key
	const keyToTitle = new Map(items.map((it) => [it.key, it.normTitle]));
	sets.sort((a, b) => {
		const ta = keyToTitle.get(a.keys[0]) ?? "";
		const tb = keyToTitle.get(b.keys[0]) ?? "";
		if (ta !== tb) return ta.localeCompare(tb);
		return a.keys[0].localeCompare(b.keys[0]);
	});

	return { sets, total: sets.length };
}
