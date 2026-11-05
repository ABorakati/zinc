// Better BibTeX (native): shared types and the HTTP contract of /api/bbt/*.
//
// Ported from / modelled on Better BibTeX (https://github.com/retorquere/zotero-better-bibtex), MIT licence,
// Copyright (c) 2016 Emiliano Heyns. See core/src/bbt/NOTICE for what was derived from it.
//
// HTTP API (all JSON, on the core port; handled by api.ts in this folder):
//   GET  /api/bbt/settings                      -> BbtSettings
//   POST /api/bbt/settings   {patch}            -> {settings, staleKeys, formulaError: string | null}
//        (an invalid formula is rejected with 400 {error}; every other field of the patch is applied)
//   POST /api/bbt/formula    {formula, itemKey?} -> {ok, error?, preview?, position?}
//        preview = the key the formula would give itemKey (or a sample item), without disambiguation
//   GET  /api/bbt/keys?items=K1,K2              -> {keys: {K1: {key, pinned} | null, ...}}
//   POST /api/bbt/pin        {itemKey, key?}    -> {key, pinned: true}   (no key = pin the current key)
//   POST /api/bbt/unpin      {itemKey}          -> {key, pinned: false}  (regenerates immediately)
//   POST /api/bbt/refresh    {items?: string[]} -> {updated}             (no items = the whole library)
//   POST /api/bbt/cite       {items, format?, command?} -> {text}        (Quick Copy: latex|pandoc|key|biblatex|...)
//   GET  /api/bbt/autoexports                   -> {exports: AutoExport[]}
//   POST /api/bbt/autoexports {path, format, scope, trigger?, options?} -> AutoExport   (adds and runs once)
//   POST /api/bbt/autoexports/remove {id}       -> {removed: boolean}
//   POST /api/bbt/autoexports/run    {id}       -> AutoExport            (export now)
// Exports (Better BibTeX / BibLaTeX / CSL JSON / CSL YAML) are formats of the existing POST /api/io/export:
//   format: "betterbibtex" | "betterbiblatex" | "bettercsljson" | "bettercslyaml"
// BBT's own endpoints live on the Zotero port: /better-bibtex/* (see http.ts).

export type BbtExportFormat = "betterbibtex" | "betterbiblatex" | "bettercsljson" | "bettercslyaml";

export const BBT_FORMATS: Record<BbtExportFormat, { label: string; ext: string; contentType: string }> = {
	betterbibtex: { label: "Better BibTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	betterbiblatex: { label: "Better BibLaTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	bettercsljson: { label: "Better CSL JSON", ext: "json", contentType: "application/json; charset=utf-8" },
	bettercslyaml: { label: "Better CSL YAML", ext: "yml", contentType: "application/x-yaml; charset=utf-8" },
};

export type QuickCopyFormat = "latex" | "pandoc" | "key" | "biblatex" | "textcite" | "org-mode" | "typst";

export interface BbtSettings {
	/** BBT formula (default `auth.lower + shorttitle(3,3) + year`); `;` or `|` at top level separate alternatives. */
	citekeyFormat: string;
	/** Transliterate keys to ASCII (BBT: citekeyFold). */
	citekeyFold: boolean;
	/** Characters removed from every key. */
	citekeyUnsafeChars: string;
	/** Comma-separated words the title functions skip. */
	skipWords: string;
	/** Duplicate-key postfix, sprintf style: %(a)s, %(A)s or %(n)s. */
	postfix: string;
	/** Keys that differ only in case count as duplicates. */
	keyCaseInsensitive: boolean;
	/** Better BibTeX: write non-ASCII as LaTeX commands (BBT: asciiBibTeX, default true). */
	asciiBibTeX: boolean;
	/** Better BibLaTeX: write non-ASCII as LaTeX commands (BBT: asciiBibLaTeX, default false = keep unicode). */
	asciiBibLaTeX: boolean;
	/** Brace-protect capitalised words in titles (BBT: exportBraceProtection, default true). */
	exportBraceProtection: boolean;
	/** `both` | `doi` | `url`: which of DOI and URL to keep when an item has both. */
	doiAndUrl: "both" | "doi" | "url";
	/** Include child notes in .bib exports. */
	exportNotes: boolean;
	/** Add the item's Extra text as `note`. */
	exportExtraAsNote: boolean;
	/** Quick Copy format used by "Copy citation key". */
	quickCopy: QuickCopyFormat;
	/** The command for quickCopy latex: `cite` -> \cite{key}. */
	citeCommand: string;
	/** Seconds to wait after the last change before an "on change" auto-export rewrites its file. */
	autoExportDelay: number;
	/** Seconds of quiet before an "on idle" auto-export rewrites its file. */
	autoExportIdle: number;
}

export interface AutoExportScope {
	type: "library" | "collection";
	/** Collection key when type is "collection" (its sub-collections are included). */
	key?: string;
}

export interface AutoExportOptions {
	/** Include child notes (.bib). */
	includeNotes?: boolean;
	/** Override the unicode/ASCII setting for this export. */
	ascii?: boolean;
}

export type AutoExportStatus = "idle" | "pending" | "running" | "done" | "error";

export interface AutoExport {
	id: number;
	path: string;
	format: BbtExportFormat;
	scope: AutoExportScope;
	/** "change": rewrite autoExportDelay seconds after the last change; "idle": after autoExportIdle seconds of quiet. */
	trigger: "change" | "idle";
	options: AutoExportOptions;
	status: AutoExportStatus;
	error: string | null;
	/** ISO time of the last successful write, items written then. */
	lastExport: string | null;
	count: number | null;
	/** Display name of the scope ("My Library" / the collection name). */
	scopeName: string;
}

export interface KeyInfo {
	key: string;
	pinned: boolean;
}
