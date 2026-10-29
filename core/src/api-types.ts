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
// ---- Phase 3 additions ----
// GET    /api/items?...&fields=a,b,c           ItemSummary.fields gets those Zotero data fields
//        (any field from /api/schema, plus itemType, dateModified, accessDate, extra).
//        sort also accepts: itemType | dateModified | publication | noteCount | attachmentCount
//        | any Zotero data field name (sorted case-insensitively on the field's text).
// GET    /api/schema                           -> ZoteroSchema (item types, fields, creator types, labels)
// POST   /api/items                            {data: Partial<ZoteroItemData>} -> ItemDetail
//        data.itemType required; data.parentItem set for child notes/attachments.
// POST   /api/items/:key/related               {keys: string[]} -> ItemDetail  (adds dc:relation both ways)
// DELETE /api/items/:key/related               {keys: string[]} -> ItemDetail
// POST   /api/attachments/:key/reveal          -> {ok: true}  (shows the file in Explorer)
// POST   /api/attachments/:key/open-external   -> {ok: true}  (opens the file in its default app)
// POST   /api/open-url                         {url} -> {ok: true}  (http(s)/doi only, OS browser)
//
// Find Full Text (core/src/fulltext/api.ts, wraps the zotero-fulltext WASM core):
// POST   /api/fulltext/find                    {keys: string[], openAccessOnly?: boolean} -> {jobId}
// GET    /api/fulltext/jobs/:id                -> FullTextJob
// GET    /api/fulltext/jobs/:id/events         -> text/event-stream of FullTextJob snapshots
// POST   /api/fulltext/jobs/:id/cancel         -> {ok: true}
//
// References (core/src/references/api.ts; built-in "Zotero Reference" plugin features):
// GET    /api/references/:itemKey              -> ReferenceList  (the item's bibliography, resolved;
//        accepts an attachment key too and uses its parent). ?refresh=1 bypasses the cache.
// GET    /api/references/lookup?doi=|title=    -> ReferenceDetail  (hover card: abstract, counts, OA link)
// POST   /api/references/add                   {doi?, reference?: Reference, collectionKey?, findFullText?: boolean}
//                                              -> ItemDetail  (creates the item from Crossref/OpenAlex metadata;
//                                              409 {error, key} if it is already in the library)
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
	// requested via ?fields=; values are the item's text for each field, null if empty
	fields?: Record<string, string | null>;
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
	// items linked through data.relations["dc:relation"] (Zotero's "Related")
	related?: { key: string; itemType: string; title: string; creatorsSummary: string; year: number | null }[];
}

export interface ZoteroSchemaField {
	field: string;
	label: string;
	baseField?: string; // e.g. publicationTitle for bookTitle
}

export interface ZoteroSchemaItemType {
	itemType: string;
	label: string;
	fields: ZoteroSchemaField[]; // in Zotero's display order, excluding title-less internal fields
	creatorTypes: { creatorType: string; label: string; primary: boolean }[];
}

export interface ZoteroSchema {
	version: number;
	itemTypes: ZoteroSchemaItemType[];
	fieldLabels: Record<string, string>; // every field name -> English label
}

export interface Reference {
	index: number; // 1-based position in the bibliography
	raw?: string; // the reference string as printed, when parsed from the PDF
	doi?: string;
	title?: string;
	authors?: string[]; // "Family G" style, first few
	year?: number;
	venue?: string;
	url?: string; // landing page (doi.org link, PubMed, publisher)
	openAccessUrl?: string;
	citedByCount?: number;
	inLibraryKey?: string; // top-level item key when this work is already in the library
}

export interface ReferenceList {
	itemKey: string;
	source: string; // e.g. "openalex", "crossref", "semanticscholar", "pdf"
	fetchedAt: string;
	references: Reference[];
}

export interface ReferenceDetail extends Reference {
	abstract?: string;
	referenceCount?: number;
	type?: string; // Crossref/OpenAlex work type
}

export type FullTextItemState =
	| "queued" | "searching" | "downloading" | "attached" | "already-has-pdf"
	| "needs-sign-in" | "not-found" | "failed" | "cancelled";

export interface FullTextJob {
	id: string;
	done: boolean;
	items: {
		key: string; // top-level item key
		title: string;
		state: FullTextItemState;
		source?: string; // e.g. "Unpaywall", "Europe PMC", "KCL OpenAthens"
		message?: string;
		attachmentKey?: string; // set when a PDF was attached
		handoffUrl?: string; // link to open in the browser when it could not be fetched automatically
	}[];
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
