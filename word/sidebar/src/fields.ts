// Zotero-compatible field codes and document preferences (pure functions, no Word, no DOM).
//
//   citation    ADDIN ZOTERO_ITEM CSL_CITATION {json}
//   bibliography ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY
//   prefs       custom document properties ZOTERO_PREF_1.. holding one XML-escaped <data> document
//
// Format reference: zotero/zotero chrome/content/zotero/xpcom/integration.js (Zotero.Integration.Session /
// Citation / Bibliography) and the Word plugin's document-data storage.

export const CITATION_SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";
export const ZOTERO_STYLE_PREFIX = "http://www.zotero.org/styles/";

export type CslItem = Record<string, unknown> & { id: string | number; type?: string };

export interface CitationItem {
	id: string | number;
	uris: string[];
	itemData?: CslItem;
	locator?: string;
	label?: string;
	prefix?: string;
	suffix?: string;
	"suppress-author"?: boolean;
	"author-only"?: boolean;
	[k: string]: unknown;
}

export interface CitationData {
	citationID: string;
	properties: { formattedCitation?: string; plainCitation?: string; noteIndex?: number; [k: string]: unknown };
	citationItems: CitationItem[];
	schema?: string;
	[k: string]: unknown;
}

export interface BibliographyData {
	uncited: unknown[];
	omitted: unknown[];
	custom: unknown[];
	[k: string]: unknown;
}

// ---------------------------------------------------------------- field codes

export type ParsedField =
	| { kind: "item"; data: CitationData }
	| { kind: "bibl"; data: BibliographyData }
	| null;

/** Parse the text of a Word field code (with or without the surrounding spaces). Null when it is not a Zotero field or the JSON is bad. */
export function parseFieldCode(code: string): ParsedField {
	const c = code.trim();
	let m = /^ADDIN\s+ZOTERO_ITEM\b\s*(?:CSL_CITATION\s*)?([\s\S]*)$/.exec(c);
	if (m) {
		try {
			const data = JSON.parse(m[1]!.trim()) as CitationData;
			if (!data || typeof data !== "object" || !Array.isArray(data.citationItems)) return null;
			data.properties ??= {};
			return { kind: "item", data };
		} catch {
			return null;
		}
	}
	m = /^ADDIN\s+ZOTERO_BIBL\b\s*([\s\S]*?)\s*(?:CSL_BIBLIOGRAPHY)?\s*$/.exec(c);
	if (m) {
		try {
			const data = JSON.parse(m[1]!.trim() || "{}") as BibliographyData;
			data.uncited ??= [];
			data.omitted ??= [];
			data.custom ??= [];
			return { kind: "bibl", data };
		} catch {
			return null;
		}
	}
	return null;
}

export function buildItemCode(data: CitationData): string {
	return `ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(data)}`;
}

export function buildBiblCode(data: BibliographyData = { uncited: [], omitted: [], custom: [] }): string {
	return `ADDIN ZOTERO_BIBL ${JSON.stringify(data)} CSL_BIBLIOGRAPHY`;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function randomId(n = 8): string {
	let s = "";
	const bytes = new Uint8Array(n);
	crypto.getRandomValues(bytes);
	for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
	return s;
}

/** Zotero citation IDs are 8-char random strings (it uses Zotero.randomString()). */
export const newCitationID = (): string => randomId(8);

// ---------------------------------------------------------------- item URIs <-> keys

const KEY_RE = /^[A-Z0-9]{8}$/i;

export function itemUri(base: string, key: string): string {
	return `${base.replace(/\/+$/, "")}/items/${key}`;
}

/** Item key of a Zotero item URI (http://zotero.org/users/<id|local/xxx>/items/<KEY>, or groups/<id>/items/<KEY>). */
export function uriToKey(uri: string): string | null {
	const m = /^https?:\/\/(?:www\.)?zotero\.org\/(?:users\/(?:local\/)?[^/]+|groups\/[^/]+)\/items\/([A-Za-z0-9]+)\/?$/.exec(uri.trim());
	return m && KEY_RE.test(m[1]!) ? m[1]!.toUpperCase() : null;
}

export function keysOfCitationItem(ci: CitationItem): string[] {
	const out: string[] = [];
	for (const u of ci.uris ?? []) {
		const k = typeof u === "string" ? uriToKey(u) : null;
		if (k && !out.includes(k)) out.push(k);
	}
	return out;
}

/** Zotero keeps a numeric item id in citationItems[].id; the number is local to a database and ignored on load. A stable positive int from the key keeps the field deterministic. */
export function numericId(key: string): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h % 2147483000) + 1;
}

// ---------------------------------------------------------------- document preferences

export interface DocPrefs {
	/** Zotero style id URL, e.g. http://www.zotero.org/styles/vancouver */
	styleId: string;
	locale: string;
	sessionId: string;
	hasBibliography: boolean;
	bibliographyStyleHasBeenSet: boolean;
	fieldType: string;
	/** 0 = in-text, 1 = footnotes, 2 = endnotes */
	noteType: number;
	automaticJournalAbbreviations: boolean;
	/** other <pref> elements, kept verbatim */
	extraPrefs: Record<string, string>;
}

const xmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unXmlAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function styleIdToUrl(id: string): string {
	return /^https?:\/\//.test(id) ? id : ZOTERO_STYLE_PREFIX + id;
}
/** Short zotero.org style id ("vancouver") from a style URL; other URLs are returned whole. */
export function styleUrlToId(url: string): string {
	return url.startsWith(ZOTERO_STYLE_PREFIX) ? url.slice(ZOTERO_STYLE_PREFIX.length) : url;
}

export function defaultPrefs(styleId: string, locale: string): DocPrefs {
	return {
		styleId: styleIdToUrl(styleId),
		locale,
		sessionId: randomId(8),
		hasBibliography: false,
		bibliographyStyleHasBeenSet: false,
		fieldType: "Field",
		noteType: 0,
		automaticJournalAbbreviations: false,
		extraPrefs: {},
	};
}

const bool = (v: string | undefined) => v === "1" || v === "true";

export function parsePrefsXml(xml: string | null | undefined): DocPrefs | null {
	if (!xml || !/<data\b/.test(xml)) return null;
	const style = /<style\b([^>]*)\/?>/.exec(xml);
	if (!style) return null;
	const attr = (s: string, name: string) => {
		const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
		return m ? unXmlAttr(m[1]!) : undefined;
	};
	const prefs: DocPrefs = {
		styleId: attr(style[1]!, "id") ?? "",
		locale: attr(style[1]!, "locale") ?? "",
		sessionId: /<session\b[^>]*\bid="([^"]*)"/.exec(xml)?.[1] ?? randomId(8),
		hasBibliography: bool(attr(style[1]!, "hasBibliography")),
		bibliographyStyleHasBeenSet: bool(attr(style[1]!, "bibliographyStyleHasBeenSet")),
		fieldType: "Field",
		noteType: 0,
		automaticJournalAbbreviations: false,
		extraPrefs: {},
	};
	for (const m of xml.matchAll(/<pref\b([^>]*?)\/?>/g)) {
		const name = attr(m[1]!, "name");
		const value = attr(m[1]!, "value") ?? "";
		if (!name) continue;
		if (name === "fieldType") prefs.fieldType = value;
		else if (name === "noteType") prefs.noteType = Number(value) || 0;
		else if (name === "automaticJournalAbbreviations") prefs.automaticJournalAbbreviations = bool(value);
		else prefs.extraPrefs[name] = value;
	}
	return prefs;
}

export function buildPrefsXml(p: DocPrefs, zoteroVersion = "7.0.11"): string {
	const extra = Object.entries(p.extraPrefs)
		.map(([k, v]) => `<pref name="${xmlAttr(k)}" value="${xmlAttr(v)}"/>`)
		.join("");
	return (
		`<data data-version="3" zotero-version="${zoteroVersion}">` +
		`<session id="${xmlAttr(p.sessionId)}"/>` +
		`<style id="${xmlAttr(p.styleId)}"${p.locale ? ` locale="${xmlAttr(p.locale)}"` : ""} hasBibliography="${p.hasBibliography ? 1 : 0}" bibliographyStyleHasBeenSet="${p.bibliographyStyleHasBeenSet ? 1 : 0}"/>` +
		`<prefs><pref name="fieldType" value="${xmlAttr(p.fieldType)}"/>` +
		`<pref name="automaticJournalAbbreviations" value="${p.automaticJournalAbbreviations}"/>` +
		`<pref name="noteType" value="${p.noteType}"/>${extra}</prefs></data>`
	);
}

// ---------------------------------------------------------------- formatted text: runs, plain text, RTF

/** A piece of result text with its character formatting (what the add-in applies to the Word field result). */
export interface Run {
	t: string;
	i?: 1;
	b?: 1;
	sup?: 1;
	sub?: 1;
	sc?: 1;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/** citeproc-js HTML output -> formatted runs. Paragraph-level divs become "\r" separators between entries (callers pass one entry at a time). */
export function htmlToRuns(html: string): Run[] {
	const runs: Run[] = [];
	const stack: { tag: string; i?: 1; b?: 1; sup?: 1; sub?: 1; sc?: 1; margin?: boolean }[] = [];
	const state = (): Omit<Run, "t"> => {
		const s: Omit<Run, "t"> = {};
		for (const f of stack) {
			if (f.i) s.i = 1;
			if (f.b) s.b = 1;
			if (f.sup) s.sup = 1;
			if (f.sub) s.sub = 1;
			if (f.sc) s.sc = 1;
		}
		return s;
	};
	const push = (t: string) => {
		if (!t) return;
		const st = state();
		const last = runs[runs.length - 1];
		if (last && last.i === st.i && last.b === st.b && last.sup === st.sup && last.sub === st.sub && last.sc === st.sc) last.t += t;
		else runs.push({ t, ...st });
	};
	const tokens = html.match(/<\/?[a-zA-Z][^>]*>|[^<]+|</g) ?? [];
	for (const tok of tokens) {
		if (tok[0] !== "<" || tok.length === 1) {
			// source newlines/indentation between tags are not content; <br> is
			push(decodeEntities(tok.replace(/\s*[\r\n]+\s*/g, " ")));
			continue;
		}
		const close = tok[1] === "/";
		const name = (/^<\/?([a-zA-Z0-9]+)/.exec(tok)?.[1] ?? "").toLowerCase();
		if (name === "br") {
			push("\n");
			continue;
		}
		if (close) {
			// pop to the matching open tag
			for (let k = stack.length - 1; k >= 0; k--) {
				if (stack[k]!.tag === name) {
					const f = stack.splice(k, 1)[0]!;
					if (f.margin) push("\t"); // second-field-align: label, tab, text
					break;
				}
			}
			continue;
		}
		const f: (typeof stack)[number] = { tag: name };
		if (name === "i" || name === "em") f.i = 1;
		else if (name === "b" || name === "strong") f.b = 1;
		else if (name === "sup") f.sup = 1;
		else if (name === "sub") f.sub = 1;
		else if (name === "span" && /font-variant:\s*small-caps/i.test(tok)) f.sc = 1;
		else if (name === "span" && /font-style:\s*italic/i.test(tok)) f.i = 1;
		else if (name === "span" && /font-weight:\s*bold/i.test(tok)) f.b = 1;
		else if (name === "div" && /csl-left-margin/.test(tok)) f.margin = true;
		stack.push(f);
	}
	return runs;
}

export const runsToPlain = (runs: Run[]): string => runs.map((r) => r.t).join("");

/** Zotero's formattedCitation is RTF-ish: {\i{}text}, \super x\nosupersub{}, \uc0舑{} for non-ASCII. */
export function runsToRtf(runs: Run[]): string {
	let out = "";
	for (const r of runs) {
		let s = "";
		for (const ch of r.t) {
			const cp = ch.codePointAt(0)!;
			if (ch === "\\") s += "\\\\";
			else if (ch === "{") s += "\\{";
			else if (ch === "}") s += "\\}";
			else if (ch === "\n" || ch === "\r") s += "\\\n";
			else if (ch === "\t") s += "\\tab{}";
			else if (cp > 127) {
				// RTF \u takes a signed 16-bit value; astral code points are a surrogate pair
				const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
				for (const u of units) s += `\\uc0\\u${u > 32767 ? u - 65536 : u}{}`;
			} else s += ch;
		}
		if (r.sup) s = `\\super ${s}\\nosupersub{}`;
		if (r.sub) s = `\\sub ${s}\\nosupersub{}`;
		if (r.i) s = `{\\i{}${s}}`;
		if (r.b) s = `{\\b{}${s}}`;
		if (r.sc) s = `{\\scaps{}${s}}`;
		out += s;
	}
	return out;
}

/** Inverse of runsToRtf, enough to read back what Zotero itself stored (used when we only have formattedCitation). */
export function rtfToPlain(rtf: string): string {
	return rtf
		.replace(/\\uc0\\u(-?\d+)\{\}/g, (_, n: string) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
		.replace(/\\(?:super|sub|nosupersub|i|b|scaps)\b ?\{?\}?/g, "")
		.replace(/\\tab\{\}/g, "\t")
		.replace(/\\\n/g, "\n")
		.replace(/\\([\\{}])/g, "$1")
		.replace(/[{}]/g, "");
}
