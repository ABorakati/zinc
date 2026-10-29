// HTTP API contract between the core service (core/src/api.ts) and its clients
// (ui/, reader-host/, later the MCP server). All routes are under
// http://127.0.0.1:23120/api and return JSON unless stated.
//
// GET    /api/collections                      -> Collection[]
// POST   /api/collections                      {name, parentKey?} -> Collection
// PATCH  /api/collections/:key                 {name?, parentKey?} -> Collection
// DELETE /api/collections/:key                 -> {ok: true}   (items are kept)
// POST   /api/collections/:key/items           {keys: string[]} -> {ok: true}
// DELETE /api/collections/:key/items           {keys: string[]} -> {ok: true}
//
// GET    /api/items?collection=&tag=&q=&sort=&dir=&limit=&offset=&unfiled=1&trash=1
//                                              -> ItemList  (top-level items only)
//        sort: title | creator | year | dateAdded (default dateAdded), dir: asc | desc
//        q: plain-text filter over title/creators/year (not full text; use /api/search)
// GET    /api/items/:key                       -> ItemDetail
// PATCH  /api/items/:key                       {data: Partial<ZoteroItemData>} -> ItemDetail
//        {data: {deleted: 1}} moves to the trash, {data: {deleted: 0}} restores (Zotero's convention)
// POST   /api/items/:key/tags                  {tags: string[]} -> {ok: true}
// DELETE /api/items/:key/tags                  {tags: string[]} -> {ok: true}
// GET    /api/tags                             -> {tag: string, count: number}[]
//
// GET    /api/attachments/:key/file            -> file bytes (Content-Type from attachment)
// GET    /api/attachments/:key/annotations     -> ReaderAnnotation[]
// PUT    /api/attachments/:key/annotations     ReaderAnnotation[] (upsert by id) -> {ok: true}
// DELETE /api/attachments/:key/annotations     {ids: string[]} -> {ok: true}
// GET    /api/attachments/:key/view-state      -> object | null
// PUT    /api/attachments/:key/view-state      object -> {ok: true}
//
// GET    /api/search?q=&limit=&offset=         -> SearchResult  (FTS5 over metadata + full text)
//
// Errors: non-2xx with {error: string}.

export interface Collection {
	key: string;
	name: string;
	parentKey: string | null;
	itemCount: number; // top-level items directly in this collection
}

export interface ItemSummary {
	key: string;
	itemType: string;
	title: string;
	creatorsSummary: string;
	year: number | null;
	publication: string | null;
	dateAdded: string;
	// best attachment to open in the reader (first PDF, else EPUB, else snapshot), if any
	primaryAttachment: { key: string; contentType: string } | null;
	attachmentCount: number;
	noteCount: number;
}

export interface ItemList {
	total: number;
	items: ItemSummary[];
}

export interface Creator {
	creatorType: string;
	firstName?: string;
	lastName?: string;
	name?: string; // single-field name
}

// Zotero Web API item `data` object. Fields vary by itemType; common ones listed.
export interface ZoteroItemData {
	key: string;
	itemType: string;
	title?: string;
	creators?: Creator[];
	date?: string;
	abstractNote?: string;
	publicationTitle?: string;
	DOI?: string;
	url?: string;
	extra?: string;
	tags?: { tag: string; type?: number }[];
	collections?: string[];
	relations?: Record<string, string | string[]>;
	parentItem?: string;
	note?: string; // HTML, notes only
	contentType?: string; // attachments only
	linkMode?: string; // attachments only
	filename?: string; // attachments only
	dateAdded?: string;
	dateModified?: string;
	deleted?: number; // 1 while in the trash
	[field: string]: unknown;
}

export interface ChildSummary {
	key: string;
	itemType: "attachment" | "note";
	title: string;
	contentType: string | null;
	linkMode: string | null;
	hasFile: boolean;
	annotationCount: number;
}

export interface ItemDetail {
	data: ZoteroItemData;
	children: ChildSummary[];
	collections: string[];
	tags: { tag: string; type: number }[];
}

// The Zotero reader's annotation object, stored verbatim.
export interface ReaderAnnotation {
	id: string;
	type: string; // highlight | underline | note | text | image | ink
	color?: string;
	sortIndex: string;
	position: unknown;
	text?: string;
	comment?: string;
	tags?: { name: string; color?: string }[];
	pageLabel?: string;
	dateModified: string;
	authorName?: string;
	[field: string]: unknown;
}

export interface SearchHit {
	key: string; // top-level item key
	title: string;
	creatorsSummary: string;
	year: number | null;
	snippet: string; // FTS5 snippet with <mark>…</mark> around matches
	matchedIn: ("metadata" | "fulltext" | "notes")[];
	rank: number;
}

export interface SearchResult {
	total: number;
	hits: SearchHit[];
}
