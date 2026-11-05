// citeproc-js for whole-document formatting (Word/LibreOffice citations): numbering, ibid., disambiguation across a
// document's citations in order. Shared by the Word add-in sidebar and the core's word-processor integration endpoints.
// Same engine and same Zotero item -> CSL-JSON conversion as ./engine.
import CSL from "citeproc";
import { itemToCsl } from "./csl";
import type { ZoteroItemData } from "../api-types";
import { type CslItem, type Run, htmlToRuns, runsToPlain, runsToRtf } from "./docfields";

/** The two host calls the engine needs (styles and locales come from the add-in; it reads data\styles and caches downloads). */
export interface StyleSource {
	styleXml(id: string): Promise<string>;
	localeXml(lang: string): Promise<string | null>;
}

export interface ResolvedStyle {
	xml: string;
	defaultLocale?: string;
	xclass: "note" | "in-text";
	title: string;
	hasBibliography: boolean;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;

/** Fetch a style; a dependent style resolves to its independent parent with the dependent's locale (as core's StyleStore.resolveStyle). */
export async function resolveStyle(src: StyleSource, id: string, depth = 0): Promise<ResolvedStyle> {
	const xml = await src.styleXml(id);
	const parent = /<link\b[^>]*\brel="independent-parent"[^>]*>/.exec(xml);
	const title = decodeXml(/<info>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/.exec(xml)?.[1]?.trim() ?? id);
	if (!parent) {
		return {
			xml,
			defaultLocale: /<style\b[^>]*\bdefault-locale="([^"]+)"/.exec(xml)?.[1],
			xclass: /<style\b[^>]*\bclass="note"/.test(xml) ? "note" : "in-text",
			title,
			hasBibliography: /<bibliography[\s>]/.test(xml),
		};
	}
	if (depth > 2) throw new Error(`style "${id}": too many parent levels`);
	const href = /\bhref="([^"]+)"/.exec(parent[0])?.[1] ?? "";
	const pid = href.replace(/\/+$/, "").split("/").pop() ?? "";
	if (!pid) throw new Error(`style "${id}" has an unreadable independent-parent link`);
	const resolved = await resolveStyle(src, pid, depth + 1);
	const depLocale = /<style\b[^>]*\bdefault-locale="([^"]+)"/.exec(xml)?.[1];
	return { ...resolved, defaultLocale: depLocale ?? resolved.defaultLocale, title: title || resolved.title };
}

function decodeXml(s: string): string {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Locale to run with: explicit, else the style's default, else en-US; "de" -> "de-DE" like citeproc-js does. */
export function effectiveLocale(locale: string | undefined, style: ResolvedStyle): string {
	let lang = locale || style.defaultLocale || "en-US";
	const bases = (CSL as unknown as { LANG_BASES?: Record<string, string> }).LANG_BASES;
	if (!lang.includes("-") && bases?.[lang]) lang = bases[lang]!.replace("_", "-");
	return lang;
}

export interface DocCitationItem {
	id: string; // CSL id of the item (library key, or an embedded-item id)
	locator?: string;
	label?: string;
	prefix?: string;
	suffix?: string;
	"suppress-author"?: boolean;
	"author-only"?: boolean;
}
export interface DocCitation {
	citationID: string;
	noteIndex: number;
	items: DocCitationItem[];
	/** keep the items in the order given instead of the style's sort order (Zotero's properties.unsorted) */
	unsorted?: boolean;
}
export interface CitationOut {
	runs: Run[];
	plain: string;
	rtf: string;
}
/** One bibliography entry as citeproc produced it (one item, or several for a collapsed entry). */
export interface BibEntry {
	/** CSL ids of the item(s) in the entry */
	ids: string[];
	/** what the entry shows: custom text when set, else the style's formatting */
	runs: Run[];
	/** the style's own formatting of the entry */
	defaultRuns: Run[];
	/** left out of the bibliography (the "exclude" choice of the bibliography editor) */
	omitted: boolean;
	/** shows custom text (the bibliography editor's "edit entry") */
	custom: boolean;
}
/** Bibliography editor state of a document: what to leave out and what text to replace. */
export interface BibliographyEdits {
	/** CSL ids left out of the bibliography */
	omitted?: Iterable<string>;
	/** CSL id -> replacement text */
	custom?: Map<string, Run[]>;
}
export interface BibliographyOut {
	runs: Run[]; // entries separated by "\r"
	entries: string[]; // plain text per entry
	/** every entry citeproc made, in order, including omitted ones (for the bibliography editor) */
	all: BibEntry[];
	hanging: boolean;
	secondFieldAlign: boolean;
	entrySpacing: number;
}
export interface FormatResult {
	citations: Map<string, CitationOut>;
	bibliography: BibliographyOut | null;
}

export class CslFormatter {
	private constructor(
		readonly style: ResolvedStyle,
		readonly lang: string,
		private locales: Map<string, string>,
	) {}

	static async create(src: StyleSource, styleId: string, locale?: string): Promise<CslFormatter> {
		const style = await resolveStyle(src, styleId);
		if (locale && !LOCALE_RE.test(locale)) throw new Error(`invalid locale: ${locale}`);
		const lang = effectiveLocale(locale, style);
		const locales = new Map<string, string>();
		for (const l of new Set(["en-US", lang, style.defaultLocale].filter(Boolean) as string[])) {
			const t = await src.localeXml(l);
			if (t) locales.set(l, t);
		}
		if (!locales.has("en-US")) throw new Error("the en-US CSL locale could not be loaded");
		return new CslFormatter(style, lang, locales);
	}

	/**
	 * Format every citation of the document in document order (so numbering, ibid., disambiguation and "subsequent"
	 * forms come out as a whole-document Refresh would), then the bibliography of everything cited plus `uncited`.
	 * items: CSL item by CSL id. A citation item whose id is missing from `items` is skipped.
	 */
	format(citations: DocCitation[], items: Map<string, CslItem>, uncited: string[] = [], wantBibliography = true, edits: BibliographyEdits = {}): FormatResult {
		const sys = {
			retrieveLocale: (l: string) => this.locales.get(l) ?? this.locales.get(l.split("-")[0]!) ?? this.locales.get("en-US") ?? false,
			retrieveItem: (id: string) => items.get(id),
		};
		const engine = new CSL.Engine(sys, this.style.xml, this.lang, false);
		engine.setOutputFormat("html");
		const out = new Map<string, CitationOut>();
		const latest = new Map<string, string>();
		const pre: [string, number][] = [];
		for (const c of citations) {
			const citationItems = c.items.filter((i) => items.has(i.id));
			if (citationItems.length === 0) {
				pre.push([c.citationID, c.noteIndex]);
				continue;
			}
			const [, changed] = engine.processCitationCluster(
				{ citationID: c.citationID, citationItems, properties: c.unsorted ? { noteIndex: c.noteIndex, unsorted: true } : { noteIndex: c.noteIndex } },
				pre.slice(),
				[],
			);
			for (const [, text, cid] of changed) latest.set(cid, text);
			pre.push([c.citationID, c.noteIndex]);
		}
		for (const [cid, html] of latest) {
			const runs = htmlToRuns(html);
			out.set(cid, { runs, plain: runsToPlain(runs), rtf: runsToRtf(runs) });
		}
		let bibliography: BibliographyOut | null = null;
		if (wantBibliography && this.style.hasBibliography) {
			const ids = uncited.filter((id) => items.has(id));
			if (ids.length) engine.updateUncitedItems(ids);
			const bib = engine.makeBibliography();
			if (bib) {
				const [params, entries] = bib;
				const omitted = new Set([...(edits.omitted ?? [])].map(String));
				const entryIds = ((params as { entry_ids?: unknown }).entry_ids ?? []) as unknown[];
				const runs: Run[] = [];
				const plain: string[] = [];
				const all: BibEntry[] = [];
				entries.forEach((e, i) => {
					const defaultRuns = htmlToRuns(e);
					const ids = ((entryIds[i] ?? []) as unknown[]).map(String);
					// like Zotero: a custom text only applies to an entry of a single item
					const customRuns = ids.length === 1 ? edits.custom?.get(ids[0]!) : undefined;
					const isOmitted = ids.length > 0 && ids.every((id) => omitted.has(id));
					all.push({ ids, runs: customRuns ?? defaultRuns, defaultRuns, omitted: isOmitted, custom: !!customRuns });
				});
				for (const en of all) {
					if (en.omitted) continue;
					if (runs.length) runs.push({ t: "\r" });
					runs.push(...en.runs);
					plain.push(runsToPlain(en.runs));
				}
				bibliography = {
					runs: mergeRuns(runs),
					entries: plain,
					all,
					hanging: !!params.hangingindent,
					secondFieldAlign: !!params["second-field-align"],
					entrySpacing: Number(params.entryspacing ?? 1),
				};
			}
		}
		return { citations: out, bibliography };
	}
}

function mergeRuns(runs: Run[]): Run[] {
	const out: Run[] = [];
	for (const r of runs) {
		const l = out[out.length - 1];
		if (l && l.i === r.i && l.b === r.b && l.sup === r.sup && l.sub === r.sub && l.sc === r.sc) l.t += r.t;
		else out.push({ ...r });
	}
	return out;
}

/** Library item (Zotero Web API JSON) -> CSL-JSON, with the item key as CSL id. */
export function libraryItemToCsl(data: ZoteroItemData): CslItem {
	return itemToCsl(data) as CslItem;
}
