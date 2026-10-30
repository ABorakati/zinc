// Citation engine: style/locale store (fetch + disk cache) and citeproc-js formatting.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import CSL from "citeproc";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { itemToCsl } from "./csl";
import {
	type CiteFormat,
	type CiteMode,
	type CiteStyleInfo,
	DEFAULT_STYLES,
} from "./types";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const STYLE_URL = (id: string) => `https://www.zotero.org/styles/${id}`;
const LOCALE_URL = (lang: string) =>
	`https://raw.githubusercontent.com/citation-style-language/locales/master/locales-${lang}.xml`;
const INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const STYLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;

interface IndexEntry {
	title: string;
	name: string;
	titleShort?: string;
	dependent?: number;
	categories?: { format?: string };
}

export class StyleStore {
	private fetchFn: FetchFn;
	private stylesDir: string;
	private localesDir: string;
	private indexFile: string;
	private index: IndexEntry[] | null = null;
	private indexAt = 0;
	private localeMem = new Map<string, string>();

	constructor(public readonly dir: string, fetchFn?: FetchFn) {
		this.fetchFn = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
		this.stylesDir = join(dir, "styles");
		this.localesDir = join(dir, "locales");
		this.indexFile = join(dir, "styles", "styles-index.json");
	}

	private async get(url: string): Promise<string> {
		const res = await this.fetchFn(url, { headers: { "User-Agent": "zotero-next" } });
		if (!res.ok) {
			if (res.status === 404) throw new HttpError(404, `not found: ${url}`);
			throw new HttpError(502, `fetching ${url} failed: HTTP ${res.status}`);
		}
		return res.text();
	}

	private stylePath(id: string): string {
		return join(this.stylesDir, `${id}.csl`);
	}

	isInstalled(id: string): boolean {
		return STYLE_ID_RE.test(id) && existsSync(this.stylePath(id));
	}

	installedIds(): string[] {
		if (!existsSync(this.stylesDir)) return [];
		return readdirSync(this.stylesDir)
			.filter((f) => f.endsWith(".csl"))
			.map((f) => f.slice(0, -4));
	}

	/** Raw CSL XML of a style (downloaded and cached on first use). */
	async styleXml(id: string): Promise<string> {
		if (!STYLE_ID_RE.test(id)) throw new HttpError(400, `invalid style id: ${id}`);
		const p = this.stylePath(id);
		if (existsSync(p)) return readFileSync(p, "utf8");
		let xml: string;
		try {
			xml = await this.get(STYLE_URL(id));
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `style "${id}" not found on zotero.org`);
			throw e;
		}
		if (!/<style[\s>]/.test(xml)) throw new HttpError(502, `zotero.org returned something that is not a CSL style for "${id}"`);
		mkdirSync(this.stylesDir, { recursive: true });
		writeFileSync(p, xml);
		return xml;
	}

	/** The style to run: for a dependent style its independent parent, with the dependent's locale applied. */
	async resolveStyle(id: string, depth = 0): Promise<{ xml: string; defaultLocale?: string }> {
		const xml = await this.styleXml(id);
		const parent = xml.match(/<link\b[^>]*\brel="independent-parent"[^>]*>/);
		if (!parent) return { xml, defaultLocale: xml.match(/<style\b[^>]*\bdefault-locale="([^"]+)"/)?.[1] };
		if (depth > 2) throw new HttpError(502, `style "${id}": too many parent levels`);
		const href = parent[0].match(/\bhref="([^"]+)"/)?.[1] ?? "";
		const pid = href.replace(/\/+$/, "").split("/").pop() ?? "";
		if (!pid) throw new HttpError(502, `style "${id}" has an unreadable independent-parent link`);
		const resolved = await this.resolveStyle(pid, depth + 1);
		const depLocale = xml.match(/<style\b[^>]*\bdefault-locale="([^"]+)"/)?.[1];
		return { xml: resolved.xml, defaultLocale: depLocale ?? resolved.defaultLocale };
	}

	async install(id: string): Promise<CiteStyleInfo> {
		await this.resolveStyle(id); // also fetches the parent of a dependent style
		return this.info(id);
	}

	private async info(id: string): Promise<CiteStyleInfo> {
		const xml = await this.styleXml(id);
		const title = xml.match(/<info>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? id;
		const titleShort = xml.match(/<title-short[^>]*>([\s\S]*?)<\/title-short>/)?.[1]?.trim();
		const klass = xml.match(/<style\b[^>]*\bclass="([^"]+)"/)?.[1];
		const cat = xml.match(/<category\b[^>]*\bcitation-format="([^"]+)"/)?.[1];
		return {
			id,
			title: decodeXml(title),
			titleShort: titleShort ? decodeXml(titleShort) : undefined,
			format: cat ?? (klass === "note" ? "note" : undefined),
			dependent: /rel="independent-parent"/.test(xml),
			installed: true,
		};
	}

	/** locales-xx-XX.xml text from cache or network; null when it does not exist. */
	async locale(lang: string): Promise<string | null> {
		if (!LOCALE_RE.test(lang)) return null;
		const mem = this.localeMem.get(lang);
		if (mem) return mem;
		const p = join(this.localesDir, `locales-${lang}.xml`);
		if (existsSync(p)) {
			const t = readFileSync(p, "utf8");
			this.localeMem.set(lang, t);
			return t;
		}
		try {
			const t = await this.get(LOCALE_URL(lang));
			mkdirSync(this.localesDir, { recursive: true });
			writeFileSync(p, t);
			this.localeMem.set(lang, t);
			return t;
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	private async loadIndex(): Promise<IndexEntry[]> {
		const now = Date.now();
		if (this.index && now - this.indexAt < INDEX_MAX_AGE_MS) return this.index;
		let cached: IndexEntry[] | null = null;
		let cachedAt = 0;
		if (existsSync(this.indexFile)) {
			try {
				cached = JSON.parse(readFileSync(this.indexFile, "utf8"));
				cachedAt = Bun.file(this.indexFile).lastModified;
			} catch {}
		}
		if (cached && now - cachedAt < INDEX_MAX_AGE_MS) {
			this.index = cached;
			this.indexAt = cachedAt;
			return cached;
		}
		try {
			const text = await this.get(INDEX_URL);
			const parsed = JSON.parse(text);
			if (!Array.isArray(parsed)) throw new Error("unexpected styles.json");
			mkdirSync(this.stylesDir, { recursive: true });
			writeFileSync(this.indexFile, text);
			this.index = parsed;
			this.indexAt = now;
			return parsed;
		} catch {
			// offline: a stale index beats none
			this.index = cached ?? [];
			this.indexAt = now - INDEX_MAX_AGE_MS + 3600 * 1000; // retry in an hour
			return this.index;
		}
	}

	async search(q: string, limit = 50): Promise<CiteStyleInfo[]> {
		const installed = new Set(this.installedIds());
		const index = await this.loadIndex();
		const byName = new Map(index.map((e) => [e.name, e]));
		const toInfo = (id: string, e?: IndexEntry, fallbackTitle?: string): CiteStyleInfo => ({
			id,
			title: e?.title ?? fallbackTitle ?? id,
			titleShort: e?.titleShort,
			format: e?.categories?.format,
			dependent: !!e?.dependent,
			installed: installed.has(id),
		});
		const needle = q.trim().toLowerCase();
		if (!needle) {
			const out = DEFAULT_STYLES.map((d) => toInfo(d.id, byName.get(d.id), d.title));
			const seen = new Set(out.map((o) => o.id));
			for (const id of [...installed].sort()) if (!seen.has(id)) out.push(toInfo(id, byName.get(id)));
			return out.slice(0, limit);
		}
		const tokens = needle.split(/\s+/).filter(Boolean);
		const scored: { s: number; info: CiteStyleInfo }[] = [];
		const consider = (id: string, title: string, short: string | undefined, e?: IndexEntry) => {
			const t = title.toLowerCase(), sh = (short ?? "").toLowerCase(), i = id.toLowerCase();
			let s = -1;
			if (i === needle || sh === needle) s = 0;
			else if (t.startsWith(needle) || i.startsWith(needle) || sh.startsWith(needle)) s = 1;
			else if (t.includes(needle) || i.includes(needle) || sh.includes(needle)) s = 2;
			else if (tokens.length > 1 && tokens.every((w) => `${t} ${sh} ${i}`.includes(w))) s = 3; // "harvard cite" -> "Cite Them Right - Harvard"
			if (s < 0) return;
			if (installed.has(id)) s -= 0.5;
			if (e?.dependent) s += 0.3; // prefer independent styles
			scored.push({ s, info: toInfo(id, e, title) });
		};
		const seen = new Set<string>();
		for (const e of index) {
			seen.add(e.name);
			consider(e.name, e.title, e.titleShort, e);
		}
		for (const d of DEFAULT_STYLES) if (!seen.has(d.id)) consider(d.id, d.title, undefined);
		for (const id of installed) if (!seen.has(id) && !DEFAULT_STYLES.some((d) => d.id === id)) consider(id, id, undefined);
		scored.sort((a, b) => a.s - b.s || a.info.title.localeCompare(b.info.title));
		return scored.slice(0, limit).map((x) => x.info);
	}
}

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------- formatting

export interface FormatInput {
	items: ZoteroItemData[];
	style: string;
	locale?: string;
	mode: CiteMode;
	formats: CiteFormat[];
}

function runOnce(
	styleXml: string,
	locales: Map<string, string>,
	lang: string,
	items: ZoteroItemData[],
	mode: CiteMode,
	format: CiteFormat,
): string {
	const csl = new Map(items.map((d) => [d.key, itemToCsl(d)]));
	const sys = {
		retrieveLocale: (l: string) => locales.get(l) ?? locales.get(l.split("-")[0]!) ?? locales.get("en-US") ?? false,
		retrieveItem: (id: string) => csl.get(id),
	};
	const engine = new CSL.Engine(sys, styleXml, lang, false);
	engine.setOutputFormat(format);
	const ids = items.map((d) => d.key);
	if (mode === "citation") {
		engine.updateItems(ids);
		const note = engine.opt.xclass === "note";
		const [, out] = engine.processCitationCluster(
			{ citationItems: ids.map((id) => ({ id })), properties: { noteIndex: note ? 1 : 0 } },
			[],
			[],
		);
		return out.map((o) => o[1]).join("");
	}
	engine.updateItems(ids);
	const bib = engine.makeBibliography();
	if (!bib) throw new HttpError(422, "this style does not define a bibliography");
	const [params, entries] = bib;
	let start = params.bibstart;
	// citeproc emits a bare "{\rtf " opener; a standalone .rtf file needs the full header
	if (format === "rtf" && /^\{\\rtf\s*$/.test(start)) start = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 ";
	return start + entries.join("") + params.bibend;
}

export async function formatItems(store: StyleStore, input: FormatInput): Promise<Record<CiteFormat, string | undefined>> {
	const { xml, defaultLocale } = await store.resolveStyle(input.style);
	if (input.locale && !LOCALE_RE.test(input.locale)) throw new HttpError(400, `invalid locale: ${input.locale}`);
	let lang = input.locale || defaultLocale || "en-US";
	// bare language ("de") -> the CSL primary dialect ("de-DE"), as citeproc-js itself does
	const bases = (CSL as unknown as { LANG_BASES?: Record<string, string> }).LANG_BASES;
	if (!lang.includes("-") && bases?.[lang]) lang = bases[lang]!.replace("_", "-");
	const locales = new Map<string, string>();
	for (const l of new Set(["en-US", lang, defaultLocale].filter(Boolean) as string[])) {
		const t = await store.locale(l);
		if (t) locales.set(l, t);
	}
	if (!locales.has("en-US")) throw new HttpError(502, "the en-US CSL locale could not be loaded");
	const out: Record<CiteFormat, string | undefined> = { html: undefined, text: undefined, rtf: undefined };
	for (const f of input.formats) out[f] = runOnce(xml, locales, lang, input.items, input.mode, f);
	return out;
}
