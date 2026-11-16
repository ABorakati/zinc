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
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
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
	format(
		citations: DocCitation[],
		items: Map<string, CslItem>,
		uncited: string[] = [],
		wantBibliography = true,
		edits: BibliographyEdits = {},
	): FormatResult {
		const engine = this.newEngine((id) => items.get(id));
		const latest = new Map<string, string>();
		const pre: [string, number][] = [];
		for (const c of citations) {
			const citationItems = c.items.filter((i) => items.has(i.id));
			if (citationItems.length === 0) {
				pre.push([c.citationID, c.noteIndex]);
				continue;
			}
			const [, changed] = engine.processCitationCluster(cluster(c, citationItems), pre.slice(), []);
			for (const [, text, cid] of changed) latest.set(cid, text);
			pre.push([c.citationID, c.noteIndex]);
		}
		const out = new Map<string, CitationOut>();
		for (const [cid, html] of latest) out.set(cid, citationOut(html));
		const ids = uncited.filter((id) => items.has(id));
		if (wantBibliography && this.style.hasBibliography && ids.length) engine.updateUncitedItems(ids);
		return { citations: out, bibliography: wantBibliography ? this.bibliography(engine, edits) : null };
	}

	/** The engine and what it was last given for formatDocument (one document per formatter; see there). */
	private doc: DocState | null = null;

	/**
	 * format() for repeated refreshes of one document. The citeproc engine is kept between calls (building one parses the
	 * style, about 0.7 s for APA), and when the citations changed only a little since the last call, just the inserted,
	 * edited and deleted ones go through citeproc, with the rest of the document as context, the way Zotero updates a
	 * document after an edit. Only for un-numbered in-text styles (author-date: the ones whose engine is slow to build).
	 * Anything else (numbered and note styles, item data changed, citations moved, a citation with no resolvable items,
	 * many changes) is formatted from scratch on a new engine, exactly as format() does. Returns the same result as
	 * format() would for the same arguments.
	 * Use it only for a formatter that serves one document; one-off previews keep using format().
	 */
	formatDocument(
		citations: DocCitation[],
		items: Map<string, CslItem>,
		uncited: string[] = [],
		wantBibliography = true,
		edits: BibliographyEdits = {},
	): FormatResult {
		const itemSig = new Map<string, string>();
		for (const [id, it] of items) itemSig.set(id, JSON.stringify(it));
		const sig = new Map<string, string>();
		for (const c of citations) sig.set(c.citationID, citationSig(c));
		const resolvable = (c: DocCitation) => c.items.filter((i) => items.has(i.id));

		const incremental = !!this.doc && this.doc.order.length > 0 && this.canUpdate(this.doc, citations, itemSig, sig, resolvable);
		const st = incremental ? this.doc! : this.rebuild(citations, items, resolvable);
		if (incremental) {
			// incremental: process the new and edited citations in document order; deleted ones drop out of the context lists
			st.items = items;
			const known = new Set(st.order);
			const todo = citations.filter((c) => !known.has(c.citationID) || st.sig.get(c.citationID) !== sig.get(c.citationID));
			const pending = new Set(todo.filter((c) => !known.has(c.citationID)).map((c) => c.citationID));
			const deleted = st.order.filter((cid) => !sig.has(cid));
			// a document that only lost citations: reprocess the one after the first deletion so citeproc drops them
			if (!todo.length && deleted.length) {
				const at = Math.min(...deleted.map((cid) => st.order.indexOf(cid)));
				const keep = st.order.filter((cid) => sig.has(cid));
				const next = keep.find((cid) => st.order.indexOf(cid) > at) ?? keep[keep.length - 1];
				const c = citations.find((x) => x.citationID === next);
				if (c) todo.push(c);
			}
			for (const c of todo) {
				const i = citations.indexOf(c);
				const pre = citations.slice(0, i).map((x) => [x.citationID, x.noteIndex] as [string, number]);
				const post = citations
					.slice(i + 1)
					.filter((x) => !pending.has(x.citationID))
					.map((x) => [x.citationID, x.noteIndex] as [string, number]);
				const [, changed] = st.engine.processCitationCluster(cluster(c, resolvable(c)), pre, post);
				for (const [, text, cid] of changed) st.html.set(cid, text);
				pending.delete(c.citationID);
			}
			for (const cid of deleted) st.html.delete(cid);
			st.order = citations.map((c) => c.citationID);
			st.sig = sig;
		}
		st.itemSig = itemSig;
		this.doc = st;

		const out = new Map<string, CitationOut>();
		for (const c of citations) {
			const html = st.html.get(c.citationID);
			if (html !== undefined) out.set(c.citationID, citationOut(html));
		}
		// uncited items are always set (an empty list clears the previous call's)
		if (wantBibliography && this.style.hasBibliography) st.engine.updateUncitedItems(uncited.filter((id) => items.has(id)));
		return { citations: out, bibliography: wantBibliography ? this.bibliography(st.engine, edits) : null };
	}

	/** Whether the kept engine can take this call incrementally: same item data, citations only inserted, edited or deleted. */
	private canUpdate(
		st: DocState,
		citations: DocCitation[],
		itemSig: Map<string, string>,
		sig: Map<string, string>,
		resolvable: (c: DocCitation) => DocCitationItem[],
	): boolean {
		// only author-date and other un-numbered in-text styles: after some edits a kept engine numbers a numeric style's items in
		// the wrong order, and note styles' ibid./subsequent forms were not tested. Both are cheap to rebuild (10-20 ms).
		if (this.numbered || this.style.xclass === "note") return false;
		for (const [id, s] of itemSig) if (st.itemSig.has(id) && st.itemSig.get(id) !== s) return false;
		if (citations.some((c) => resolvable(c).length === 0)) return false;
		if (sig.size !== citations.length) return false; // a repeated citationID
		const known = new Set(st.order);
		const common = citations.filter((c) => known.has(c.citationID)).map((c) => c.citationID);
		const before = st.order.filter((cid) => sig.has(cid));
		if (common.length !== before.length || common.some((cid, i) => cid !== before[i])) return false; // moved
		const changes =
			citations.filter((c) => !known.has(c.citationID) || st.sig.get(c.citationID) !== sig.get(c.citationID)).length +
			(st.order.length - common.length);
		if (changes > Math.max(5, Math.floor(citations.length / 4))) return false;
		return true;
	}

	/** The style numbers its citations (citation-number), so the order of first citation decides the numbering. */
	private get numbered(): boolean {
		return /\bcitation-number\b/.test(this.style.xml);
	}

	/** A new engine with every citation processed in document order: format()'s way. */
	private rebuild(citations: DocCitation[], items: Map<string, CslItem>, resolvable: (c: DocCitation) => DocCitationItem[]): DocState {
		const st = { items } as DocState;
		st.engine = this.newEngine((id) => st.items.get(id));
		st.html = new Map();
		const pre: [string, number][] = [];
		for (const c of citations) {
			const citationItems = resolvable(c);
			if (citationItems.length) {
				const [, changed] = st.engine.processCitationCluster(cluster(c, citationItems), pre.slice(), []);
				for (const [, text, cid] of changed) st.html.set(cid, text);
			}
			pre.push([c.citationID, c.noteIndex]);
		}
		st.order = citations.map((c) => c.citationID);
		st.sig = new Map(citations.map((c) => [c.citationID, citationSig(c)]));
		st.itemSig = new Map();
		return st;
	}

	private newEngine(retrieveItem: (id: string) => CslItem | undefined): CiteprocEngine {
		const sys = {
			retrieveLocale: (l: string) => this.locales.get(l) ?? this.locales.get(l.split("-")[0]!) ?? this.locales.get("en-US") ?? false,
			retrieveItem,
		};
		const engine = new CSL.Engine(sys, this.style.xml, this.lang, false);
		engine.setOutputFormat("html");
		return engine;
	}

	/** The bibliography of everything the engine has cited plus its uncited items, with the bibliography editor's edits. */
	private bibliography(engine: CiteprocEngine, edits: BibliographyEdits): BibliographyOut | null {
		if (!this.style.hasBibliography) return null;
		const bib = engine.makeBibliography();
		if (!bib) return null;
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
		return {
			runs: mergeRuns(runs),
			entries: plain,
			all,
			hanging: !!params.hangingindent,
			secondFieldAlign: !!params["second-field-align"],
			entrySpacing: Number(params.entryspacing ?? 1),
		};
	}
}

type CiteprocEngine = InstanceType<typeof CSL.Engine>;
interface DocState {
	engine: CiteprocEngine;
	/** what the engine's retrieveItem reads; replaced on every call */
	items: Map<string, CslItem>;
	/** citation ids in document order, and each one's content signature, as of the last call */
	order: string[];
	sig: Map<string, string>;
	/** CSL item JSON by id as of the last call */
	itemSig: Map<string, string>;
	/** latest HTML per citation id */
	html: Map<string, string>;
}

function cluster(c: DocCitation, citationItems: DocCitationItem[]) {
	return {
		citationID: c.citationID,
		citationItems,
		properties: c.unsorted ? { noteIndex: c.noteIndex, unsorted: true } : { noteIndex: c.noteIndex },
	};
}
function citationSig(c: DocCitation): string {
	return JSON.stringify([c.noteIndex, !!c.unsorted, c.items]);
}
function citationOut(html: string): CitationOut {
	const runs = htmlToRuns(html);
	return { runs, plain: runsToPlain(runs), rtf: runsToRtf(runs) };
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
