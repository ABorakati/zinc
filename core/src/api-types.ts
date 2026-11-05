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
// GET    /api/items?collection=&tag=&q=&sort=&dir=&limit=&offset=&unfiled=1&publications=1&trash=1
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
// PUT    /api/attachments/:key/file            {dataBase64} -> {ok: true, size}  (atomic replace of a PDF attachment's file:
//                                              the reader's Rotate / Delete Pages; core/src/files/replace.ts)
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
// POST   /api/items/:key/duplicate             -> ItemDetail  (a copy of a top-level item: item type, fields, creators,
//        tags, collections, relations; no children. A standalone attachment's copy keeps its file / link / URL.)
// POST   /api/add/create-parent                {itemKey, text? | itemType?} -> {parent: ItemDetail, item: ItemDetail}
//        "Create Parent Item": creates the parent from an identifier (DOI / PMID / PMCID / arXiv ID / ISBN) or empty of
//        itemType, and moves the standalone attachment or note under it (the child leaves its collections, the parent
//        takes them).
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
// POST   /api/fulltext/sign-in                 -> FullTextSignInResult
//        Warm-up: opens the sign-in window of the CONFIGURED institution (settings below; OpenAthens redirector,
//        else library proxy, else Shibboleth) so later Find Full Text runs reuse the session. Resolves when the user
//        signed in, closed the window or it timed out. "unavailable" when the app has no embedded browser,
//        "no_method" when the institution has no sign-in method set up.
// GET    /api/fulltext/sign-in/status          -> FullTextSignInStatus
//        signedIn = a sign-in reached a publisher page in the last 12 h, or the sign-in session holds cookies for
//        the OpenAthens / proxy / IdP hosts.
// GET    /api/fulltext/institutions?q=         -> FullTextInstitutionHit[]  (built-in presets filtered by q, then,
//        for q of 3+ characters, matching identity providers of the SeamlessAccess / UK federation metadata,
//        best effort). Choosing a hit means PUTting its fields into the settings' institution.
// GET    /api/fulltext/settings                -> FullTextSettingsView
// PUT    /api/fulltext/settings                FullTextSettingsPatch -> FullTextSettingsView
//        Stored in fulltext-settings.json next to the library. No institution in the file = the engine default
//        (King's College London). Takes effect for the next Find Full Text run.
//
// Card view additions:
// GET    /api/items?...&include=creators,tags  ItemSummary.creators / .tags filled for each item
// GET    /api/tag-colors                       -> TagColor[]  (Zotero's coloured tags, in position order)
// PUT    /api/tag-colors                       TagColor[] -> TagColor[]
//        Starred items use the tag "Starred" (shown as a star, not a badge).
//
// Import / export (core/src/io/api.ts):
// POST   /api/io/import  {text, format?: "auto"|"bibtex"|"ris"|"csljson"|"pubmed-nbib"|"endnote-xml"|"rdf"|"mods",
//                         collectionName?: string|null, collectionKey?: string, basePath?: string}
//                        -> {created, skipped, errors, collectionKey, format, collections, attachments}
//        basePath is the folder the text came from: relative attachment paths (Zotero RDF) resolve against it.
// POST   /api/io/export  {keys?, collectionKey?, format: "bibtex"|"biblatex"|"ris"|"csljson"|"csv"|"rdf"|"mods",
//                         includeNotes?, dir?} -> {filename, contentType, text, count, path?, files}
//        With `dir` the core writes the file there; Zotero RDF also copies attachment files into files/<n>/.
// GET    /api/io/mendeley -> {databases: MendeleyDatabase[], available: boolean}
// POST   /api/io/mendeley {path?, collectionName?, collectionKey?, linkFiles?} -> Mendeley import result
//        Reads a Mendeley Desktop SQLite library (copied first, never modified). The online Mendeley
//        Reference Manager is not supported.
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
	// requested via ?include=creators: every creator as "Family G" (or the single-field name)
	creators?: string[];
	// requested via ?include=tags
	tags?: { tag: string; type: number }[];
}

export interface TagColor {
	name: string;
	color: string; // CSS hex, e.g. "#FF6666"
	position: number; // 0-based; Zotero assigns number keys 1-9 to the first nine
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

export type FullTextSignInMethod = "openathens" | "saml" | "ezproxy";

/** The user's institution. Empty strings mean "not available at this institution". */
export interface FullTextInstitution {
	/** Preset id ("kcl", "ucl", ...), "other" = hand-entered details, "none" = open access only. */
	id: string;
	name: string;
	realm: string;
	openathensDomain: string; // e.g. "kcl.ac.uk"
	shibbolethEntityId: string; // Shibboleth / UK federation IdP entityID
	proxyPrefix: string; // library proxy login address, e.g. "https://login.kcl.idm.oclc.org/login?url="
	/** Absent = automatic: a window when the app has an embedded browser, else a link for your own browser. */
	loginMode?: "window" | "handoff";
}

export interface FullTextSettingsView {
	institution: FullTextInstitution;
	/** Sign-in methods the institution has set up. */
	methods: FullTextSignInMethod[];
	/** false = open access only. */
	institutional: boolean;
	unpaywallEmail: string;
	concurrency: number;
	/** The app provides an embedded browser (sign-in window available). */
	embeddedBrowser: boolean;
	/** true while no institution was chosen: the engine default is in use. */
	isDefaultInstitution: boolean;
}

/** PUT body; every field optional. institution: null restores the engine default. */
export interface FullTextSettingsPatch {
	institution?: (Partial<FullTextInstitution> & { name?: string }) | null;
	institutional?: boolean;
	unpaywallEmail?: string;
	concurrency?: number;
}

export interface FullTextInstitutionHit {
	id?: string; // preset id; absent for a federation hit (use id "other")
	name: string;
	openathensDomain?: string;
	shibbolethEntityId?: string;
	proxyPrefix?: string;
	methods: FullTextSignInMethod[];
	source: "preset" | "federation";
}

export interface FullTextSignInResult {
	result: "landed" | "pdf" | "closed_by_user" | "handoff" | "timeout" | "ca_blocked" | "unavailable" | "no_method";
	institution: string; // display name
	caError?: string; // Conditional Access code when result is ca_blocked
}

export interface FullTextSignInStatus {
	available: boolean;
	signedIn: boolean;
	realm?: string;
	institution?: string; // display name of the configured institution
	methods?: FullTextSignInMethod[];
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
