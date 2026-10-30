// Citations & bibliographies (core/src/cite/*). Engine: citeproc-js over items converted to CSL-JSON.
// Styles are fetched from zotero.org/styles on demand and cached in <db dir>/styles/<id>.csl; locales come from the
// CSL locales repository and are cached in <db dir>/locales/. Settings live in <db dir>/cite-settings.json.
//
// GET    /api/cite/styles?q=&format=&field=&installed=1&quick=1&limit=&offset= -> CiteStyleInfo[]
//        The catalogue is the installed styles (<db dir>/styles/*.csl, incl. ones installed from the browser
//        connector) plus the Zotero Style Repository index (styles.json, ~10,000 styles, cached on disk in
//        <db dir>/style-cache/ and refreshed at most daily; a stale cache is used offline).
//        q matches title / short title / id (ranked: exact, prefix, word prefix, substring, all words);
//        installed styles come first. Empty q lists everything (installed, then repository A-Z).
//        format: author-date | numeric | note | label | author. field: medicine, biology, ... (repository categories).
//        installed=1: installed styles only. quick=1 (empty q): just the default + installed styles.
//        Response headers: X-Total (matches before limit/offset), X-Styles-Index (fresh | cached | none).
// POST   /api/cite/styles   or  /api/cite/styles/install   {id} -> CiteStyleInfo
//        Downloads the style (a dependent style also installs its independent parent, as Zotero does).
//        404 when zotero.org has no such style.
// DELETE /api/cite/styles/<id>   Removes a user-installed style. 409 for the built-in default styles, the
//        current Quick Copy style, and a parent that installed dependent styles still use.
// GET    /api/cite/styles/preview?id=&items=KEY,KEY&locale= -> CiteStylePreview
//        In-text citations (one per sample item) and the bibliography as HTML. Works for styles that are
//        NOT installed: the CSL is fetched into <db dir>/style-cache/styles/ without installing it. items:
//        item keys (first 3 used); omitted, a few varied items from the library; an empty library falls back
//        to built-in sample references.
// POST   /api/cite/format                CiteFormatRequest -> CiteFormatResult
//        keys: item keys (top-level; child notes/attachments resolve to their parent, duplicates are dropped,
//        the order given is kept). style defaults to the Quick Copy style, locale to the Quick Copy locale
//        (then the style's default locale, then en-US). A not-yet-installed style is downloaded automatically.
// GET    /api/cite/settings              -> CiteSettings
// PUT    /api/cite/settings              Partial<CiteSettings> (or {quickCopy: Partial<QuickCopySettings>}) -> CiteSettings

export const DEFAULT_STYLES: { id: string; title: string }[] = [
	{ id: "vancouver", title: "Vancouver" },
	{ id: "apa", title: "American Psychological Association 7th edition" },
	{ id: "nature", title: "Nature" },
	{ id: "the-lancet", title: "The Lancet" },
	{ id: "bmj", title: "BMJ" },
	{ id: "american-medical-association", title: "American Medical Association 11th edition" },
	{ id: "harvard-cite-them-right", title: "Cite Them Right 12th edition - Harvard" },
	{ id: "chicago-author-date", title: "Chicago Manual of Style 18th edition (author-date)" },
];

export type CiteMode = "bibliography" | "citation";
export type CiteFormat = "html" | "text" | "rtf";

export interface CiteStyleInfo {
	id: string; // zotero.org style id, e.g. "vancouver"
	title: string;
	titleShort?: string;
	/** "author-date" | "numeric" | "note" | "label" | "author" ... (from the repository index) */
	format?: string;
	/** Repository subject fields ("medicine", "biology", ...). */
	fields?: string[];
	updated?: string;
	dependent: boolean;
	installed: boolean;
	/** One of the built-in default styles (listed even when not downloaded yet; never removable). */
	bundled?: boolean;
	/** Installed and not a default: can be deleted. */
	removable?: boolean;
}

export interface CiteStylePreview {
	id: string;
	title: string;
	/** Style class: "in-text" or "note". */
	note: boolean;
	installed: boolean;
	/** One in-text citation (HTML) per sample item, as if cited in this order. */
	citations: string[];
	/** The bibliography of the sample items (HTML; "" when the style defines none). */
	bibliography: string;
	/** Keys of the items used; built-in samples have keys starting with "SAMPLE". */
	keys: string[];
	sample: boolean;
}

export interface CiteFormatRequest {
	keys: string[];
	style?: string;
	locale?: string; // BCP-47 tag as used by CSL locales, e.g. "en-GB"
	mode?: CiteMode; // default "bibliography"
	format?: CiteFormat | CiteFormat[]; // default "html"; an array returns several at once
}

/** Only the requested formats are present. */
export interface CiteFormatResult {
	html?: string;
	text?: string;
	rtf?: string;
	/** Item keys that were formatted (after resolving children and dropping duplicates/missing items). */
	keys: string[];
}

export interface QuickCopySettings {
	style: string;
	locale: string; // "" = the style's default locale
	mode: CiteMode;
	format: CiteFormat;
}

export interface CiteSettings {
	quickCopy: QuickCopySettings;
}

export const DEFAULT_SETTINGS: CiteSettings = {
	quickCopy: { style: "vancouver", locale: "", mode: "bibliography", format: "html" },
};
