// Citations & bibliographies (core/src/cite/*). Engine: citeproc-js over items converted to CSL-JSON.
// Styles are fetched from zotero.org/styles on demand and cached in <db dir>/styles/<id>.csl; locales come from the
// CSL locales repository and are cached in <db dir>/locales/. Settings live in <db dir>/cite-settings.json.
//
// GET    /api/cite/styles?q=&limit=      -> CiteStyleInfo[]
//        q empty: the default styles plus every installed style; otherwise the best matches (title / short
//        title / id substring) from the Zotero style repository index (styles.json, cached for a week).
//        If the index cannot be fetched (offline) only installed + default styles are searched.
// POST   /api/cite/styles                {id} -> CiteStyleInfo   (downloads and caches the style; dependent
//        styles also fetch their independent parent. 404 when zotero.org has no such style.)
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
	dependent: boolean;
	installed: boolean;
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
