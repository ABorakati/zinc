// FTS5 search index over top-level items (metadata, child notes, extracted full text).

import type { Database } from "bun:sqlite";
import type { SearchHit, SearchResult, ZoteroItemData } from "./api-types";
import { codePointChar } from "./entity";
import { rebuildQuickIndex } from "./migrations/quick-search";

const NON_INDEXED = "('attachment', 'note', 'annotation')";

export function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(\d+);/g, (_, n) => codePointChar(Number(n)))
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

interface ItemRow {
	rowid: number;
	key: string;
	title: string | null;
	publication: string | null;
	data: string;
}

function insertRow(db: Database, r: ItemRow): void {
	const data = JSON.parse(r.data) as ZoteroItemData;
	// item JSON can come from sync or imports: a field of the wrong JSON type must not break indexing (SQLite cannot bind objects)
	const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
	const creators = (Array.isArray(data.creators) ? (data.creators as unknown[]) : [])
		.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
		.map((c) => s(c.name) || [s(c.firstName), s(c.lastName)].filter(Boolean).join(" "))
		.filter(Boolean)
		.join(" ");
	const tags = (db.query("SELECT tag FROM item_tags WHERE item_key = ?").all(r.key) as { tag: string }[])
		.map((t) => t.tag)
		.join(" ");
	const notes = (
		db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0").all(r.key) as {
			data: string;
		}[]
	)
		.map((n) => stripHtml(s((JSON.parse(n.data) as ZoteroItemData).note)))
		.join(" ");
	const fulltext =
		(
			db
				.query(
					`SELECT group_concat(f.content, ' ') AS t FROM items a JOIN fulltext f ON f.attachment_key = a.key
					 WHERE a.parent_key = ?`,
				)
				.get(r.key) as { t: string | null }
		).t ?? "";
	db.query(
		"INSERT INTO search(rowid, title, creators, abstract, publication, tags, notes, fulltext) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
	).run(r.rowid, r.title ?? "", creators, s(data.abstractNote), r.publication ?? "", tags, notes, fulltext);
}

export function rebuildSearchIndex(db: Database): void {
	db.transaction(() => {
		// The trigram index (migration 3) is kept by triggers; rebuilding it here is the recovery path.
		if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quick_search'").get()) rebuildQuickIndex(db);
		db.run("DELETE FROM search");
		const rows = db.query(
			`SELECT rowid, key, title, publication, data FROM items
			 WHERE parent_key IS NULL AND item_type NOT IN ${NON_INDEXED}`,
		);
		for (const r of rows.iterate() as Iterable<ItemRow>) insertRow(db, r);
	})();
}

// Re-index one item. A child (attachment / note) re-indexes its parent.
export function indexItem(db: Database, key: string): void {
	db.transaction(() => {
		let row = db.query("SELECT rowid, key, title, publication, data, parent_key, item_type FROM items WHERE key = ?").get(key) as
			| (ItemRow & { parent_key: string | null; item_type: string })
			| null;
		if (row?.parent_key) {
			row = db
				.query("SELECT rowid, key, title, publication, data, parent_key, item_type FROM items WHERE key = ?")
				.get(row.parent_key) as typeof row;
		}
		if (!row) return;
		db.query("DELETE FROM search WHERE rowid = ?").run(row.rowid);
		if (row.item_type === "attachment" || row.item_type === "note" || row.item_type === "annotation") return;
		insertRow(db, row);
	})();
}

// ---------------------------------------------------------------- query

export interface Term {
	text: string; // words separated by single spaces
	prefix: boolean;
}

// Split user input into safe terms: bare words, "quoted phrases", and a trailing * for prefix match.
export function parseQuery(q: string): Term[] {
	const terms: Term[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(q)) !== null) {
		const raw = m[1] ?? m[2];
		const prefix = m[2] !== undefined && raw.endsWith("*");
		const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		if (words.length === 0) continue;
		terms.push({ text: words.join(" "), prefix });
	}
	return terms.slice(0, 32);
}

function termToFts(t: Term): string {
	return `"${t.text}"${t.prefix ? "*" : ""}`;
}

export function sanitizeQuery(q: string): string {
	return parseQuery(q).map(termToFts).join(" ");
}

const METADATA_COLS = "{title creators abstract publication tags}";

// For a page of hits, find which column groups matched: highlight() each column and look for
// the marker. Cost depends on the page size, not on how many documents match.
function matchedInAll(db: Database, rowids: number[], match: string): Map<number, SearchHit["matchedIn"]> {
	const hl = (col: number) => `highlight(search, ${col}, '\u0001', '\u0002')`;
	const rows = db
		.query(
			`SELECT rowid, ${[0, 1, 2, 3, 4, 5, 6].map(hl).join(", ")} FROM search
			 WHERE search MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
		)
		.values(match, JSON.stringify(rowids)) as [number, ...string[]][];
	const out = new Map<number, SearchHit["matchedIn"]>(rowids.map((r) => [r, []]));
	for (const row of rows) {
		const has = (i: number) => (row[i + 1] as string).includes("\u0001");
		const list = out.get(row[0] as number)!;
		if ([0, 1, 2, 3, 4].some(has)) list.push("metadata");
		if (has(5)) list.push("notes");
		if (has(6)) list.push("fulltext");
	}
	return out;
}

// rank is FTS5 bm25 (title weighted highest): lower is better, hits are sorted ascending.
// The page is chosen on rank alone and snippet() runs only for its rows: in one query SQLite can evaluate snippet() for every
// match before sorting, and on a library with PDF full text that re-reads the large fulltext column once per match.
export function search(db: Database, q: string, opts: { limit?: number; offset?: number } = {}): SearchResult {
	const terms = parseQuery(q ?? "");
	if (terms.length === 0) return { total: 0, hits: [] };
	const match = terms.map(termToFts).join(" ");
	const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
	const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
	const total = (
		db
			.query("SELECT count(*) AS n FROM search s JOIN items i ON i.rowid = s.rowid WHERE search MATCH ? AND i.deleted = 0")
			.get(match) as { n: number }
	).n;
	const ranked = db
		.query(
			`SELECT s.rowid AS rowid, bm25(search, 10.0, 5.0, 3.0, 2.0, 2.0, 1.0, 1.0) AS rank
			 FROM search s JOIN items i ON i.rowid = s.rowid
			 WHERE search MATCH ? AND i.deleted = 0
			 ORDER BY rank LIMIT ? OFFSET ?`,
		)
		.all(match, limit, offset) as { rowid: number; rank: number }[];
	const details = new Map(
		(
			ranked.length
				? (db
						.query(
							`SELECT s.rowid AS rowid, i.key, i.title, i.creators_summary, i.year,
								snippet(search, -1, '<mark>', '</mark>', '…', 16) AS snippet
							 FROM search s JOIN items i ON i.rowid = s.rowid
							 WHERE search MATCH ?1 AND s.rowid IN (SELECT value FROM json_each(?2))`,
						)
						.all(match, JSON.stringify(ranked.map((r) => r.rowid))) as {
						rowid: number;
						key: string;
						title: string | null;
						creators_summary: string | null;
						year: number | null;
						snippet: string;
					}[])
				: []
		).map((r) => [r.rowid, r]),
	);
	const rows = ranked.flatMap((r) => {
		const d = details.get(r.rowid);
		return d ? [{ ...d, rank: r.rank }] : [];
	});
	const matched = rows.length ? matchedInAll(db, rows.map((r) => r.rowid), match) : new Map();
	const hits: SearchHit[] = rows.map((r) => ({
		key: r.key,
		title: r.title ?? "",
		creatorsSummary: r.creators_summary ?? "",
		year: r.year,
		snippet: r.snippet,
		matchedIn: matched.get(r.rowid),
		rank: r.rank,
	}));
	return { total, hits };
}
