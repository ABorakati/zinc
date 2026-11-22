// Citation engine: style catalogue/locale store (fetch + disk cache) and citeproc-js formatting.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import CSL from "citeproc";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { itemToCsl } from "./csl";
import { type CiteFormat, type CiteMode, type CiteStyleInfo, DEFAULT_STYLES } from "./types";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const STYLE_URL = (id: string) => `https://www.zotero.org/styles/${id}`;
const LOCALE_URL = (lang: string) => `https://raw.githubusercontent.com/citation-style-language/locales/master/locales-${lang}.xml`;
const INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
const FETCH_TIMEOUT_MS = 60_000;
const INDEX_MAX_AGE_MS = 24 * 3600 * 1000;
const INDEX_RETRY_MS = 3600 * 1000;
const PREVIEW_CACHE_MAX = 300;
const STYLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;

/** "install": the style ends up in <dir>/styles. "preview": it only goes to the throw-away <dir>/style-cache. */
export type StyleMode = "install" | "preview";
export type IndexState = "fresh" | "cached" | "none";

interface IndexEntry {
	title: string;
	name: string;
	titleShort?: string;
	dependent?: number;
	categories?: { format?: string; fields?: string[] };
	updated?: string;
}

/** A catalogue row with lower-cased search text; `installed` is applied per query. */
interface Rec {
	id: string;
	title: string;
	short?: string;
	format?: string;
	fields?: string[];
	updated?: string;
	dependent: boolean;
	t: string;
	sh: string;
	i: string;
}

function mkRec(id: string, title: string, o: Partial<Rec> = {}): Rec {
	return { id, title, dependent: false, ...o, t: title.toLowerCase(), sh: (o.short ?? "").toLowerCase(), i: id.toLowerCase() };
}

export interface StyleSearch {
	q?: string;
	format?: string;
	field?: string;
	installed?: boolean;
	/** With an empty q: only the default styles and the installed ones. */
	quick?: boolean;
	limit?: number;
	offset?: number;
}

interface Meta {
	mtime: number;
	size: number;
	rec: Rec;
	parent?: string;
}

export class StyleStore {
	private fetchFn: FetchFn;
	private stylesDir: string;
	private localesDir: string;
	private cacheDir: string;
	private previewDir: string;
	private indexFile: string;
	private recs: Rec[] = [];
	private recById = new Map<string, Rec>();
	private indexAt = 0;
	private indexLoaded = false;
	private indexInflight: Promise<void> | null = null;
	indexState: IndexState = "none";
	private localeMem = new Map<string, string>();
	private metas = new Map<string, Meta>();

	constructor(
		public readonly dir: string,
		fetchFn?: FetchFn,
		/** how long one download may take (headers and body) before it fails */
		private readonly timeoutMs = FETCH_TIMEOUT_MS,
	) {
		this.fetchFn = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
		this.stylesDir = join(dir, "styles");
		this.localesDir = join(dir, "locales");
		this.cacheDir = join(dir, "style-cache");
		this.previewDir = join(this.cacheDir, "styles");
		this.indexFile = join(this.cacheDir, "styles-index.json");
	}

	private async get(url: string): Promise<string> {
		const signal = AbortSignal.timeout(this.timeoutMs);
		try {
			const res = await this.fetchFn(url, { headers: { "User-Agent": "zinc" }, signal });
			if (!res.ok) {
				if (res.status === 404) throw new HttpError(404, `not found: ${url}`);
				throw new HttpError(502, `fetching ${url} failed: HTTP ${res.status}`);
			}
			return await res.text();
		} catch (e) {
			if (signal.aborted) throw new HttpError(504, `fetching ${url} timed out`);
			throw e;
		}
	}

	private stylePath(id: string): string {
		return join(this.stylesDir, `${id}.csl`);
	}

	private previewPath(id: string): string {
		return join(this.previewDir, `${id}.csl`);
	}

	isInstalled(id: string): boolean {
		return STYLE_ID_RE.test(id) && existsSync(this.stylePath(id));
	}

	isBundled(id: string): boolean {
		return DEFAULT_STYLES.some((d) => d.id === id);
	}

	installedIds(): string[] {
		if (!existsSync(this.stylesDir)) return [];
		return readdirSync(this.stylesDir)
			.filter((f) => f.endsWith(".csl"))
			.map((f) => f.slice(0, -4));
	}

	private async download(id: string): Promise<string> {
		let xml: string;
		try {
			xml = await this.get(STYLE_URL(id));
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `style "${id}" not found on zotero.org`);
			throw e;
		}
		if (!/<style[\s>]/.test(xml)) throw new HttpError(502, `zotero.org returned something that is not a CSL style for "${id}"`);
		return xml;
	}

	/**
	 * Raw CSL XML of a style. Installed styles are read from disk. Otherwise it comes from the preview cache or
	 * zotero.org: "install" mode keeps it in the styles folder, "preview" mode only in the throw-away cache.
	 */
	async styleXml(id: string, mode: StyleMode = "install"): Promise<string> {
		if (!STYLE_ID_RE.test(id)) throw new HttpError(400, `invalid style id: ${id}`);
		const p = this.stylePath(id);
		if (existsSync(p)) return readFileSync(p, "utf8");
		const cp = this.previewPath(id);
		if (mode === "install") {
			mkdirSync(this.stylesDir, { recursive: true });
			if (existsSync(cp)) {
				copyFileSync(cp, p);
				return readFileSync(p, "utf8");
			}
			const xml = await this.download(id);
			writeFileSync(p, xml);
			return xml;
		}
		if (existsSync(cp)) return readFileSync(cp, "utf8");
		const xml = await this.download(id);
		mkdirSync(this.previewDir, { recursive: true });
		writeFileSync(cp, xml);
		this.prunePreviewCache();
		return xml;
	}

	private prunePreviewCache(): void {
		try {
			const files = readdirSync(this.previewDir).filter((f) => f.endsWith(".csl"));
			if (files.length <= PREVIEW_CACHE_MAX) return;
			const aged = files.map((f) => ({ f, t: statSync(join(this.previewDir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
			for (const { f } of aged.slice(0, files.length - PREVIEW_CACHE_MAX / 2)) rmSync(join(this.previewDir, f), { force: true });
		} catch {}
	}

	/** The style to run: for a dependent style its independent parent, with the dependent's locale applied. */
	async resolveStyle(id: string, depth = 0, mode: StyleMode = "install"): Promise<{ xml: string; defaultLocale?: string }> {
		const xml = await this.styleXml(id, mode);
		const pid = parentOf(xml, id);
		if (pid === null) return { xml, defaultLocale: xml.match(/<style\b[^>]*\bdefault-locale="([^"]+)"/)?.[1] };
		if (depth > 2) throw new HttpError(502, `style "${id}": too many parent levels`);
		const resolved = await this.resolveStyle(pid, depth + 1, mode);
		const depLocale = xml.match(/<style\b[^>]*\bdefault-locale="([^"]+)"/)?.[1];
		return { xml: resolved.xml, defaultLocale: depLocale ?? resolved.defaultLocale };
	}

	async install(id: string): Promise<CiteStyleInfo> {
		await this.resolveStyle(id); // also fetches the parent of a dependent style
		return this.infoOf(id, true);
	}

	/** Delete a user-installed style. 409 for defaults and for a parent that installed dependent styles use. */
	remove(id: string): void {
		if (!STYLE_ID_RE.test(id)) throw new HttpError(400, `invalid style id: ${id}`);
		if (!this.isInstalled(id)) throw new HttpError(404, `style "${id}" is not installed`);
		if (this.isBundled(id)) throw new HttpError(409, `"${id}" is a built-in default style and cannot be removed`);
		const deps = this.installedIds().filter((d) => d !== id && this.meta(d)?.parent === id);
		if (deps.length)
			throw new HttpError(
				409,
				`"${id}" is the parent of installed style${deps.length === 1 ? "" : "s"} ${deps.slice(0, 3).join(", ")}${deps.length > 3 ? ", ..." : ""}; remove ${deps.length === 1 ? "it" : "them"} first`,
			);
		rmSync(this.stylePath(id), { force: true });
		this.metas.delete(id);
	}

	/** Parsed header of an installed style (cached per file mtime/size). */
	private meta(id: string): Meta | null {
		const p = this.stylePath(id);
		let st;
		try {
			st = statSync(p);
		} catch {
			this.metas.delete(id);
			return null;
		}
		const hit = this.metas.get(id);
		if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
		let xml: string;
		try {
			xml = readFileSync(p, "utf8");
		} catch {
			return null;
		}
		const pi = parseInfo(xml, id);
		const m: Meta = { mtime: st.mtimeMs, size: st.size, rec: pi.rec, parent: pi.parent ?? undefined };
		this.metas.set(id, m);
		return m;
	}

	private async infoOf(id: string, installed: boolean): Promise<CiteStyleInfo> {
		const m = this.meta(id);
		const rec = m?.rec ?? parseInfo(await this.styleXml(id, "preview"), id).rec;
		return toInfo(rec, installed, this.isBundled(id));
	}

	/** Title, format, fields of any style (installed, or fetched into the preview cache). */
	async styleInfo(id: string): Promise<CiteStyleInfo> {
		if (!STYLE_ID_RE.test(id)) throw new HttpError(400, `invalid style id: ${id}`);
		return this.infoOf(id, this.isInstalled(id));
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

	// ------------------------------------------------------------ repository index

	private adopt(entries: IndexEntry[], at: number, state: IndexState): void {
		const recs: Rec[] = [];
		for (const e of entries) {
			if (!e || typeof e.name !== "string" || typeof e.title !== "string" || !STYLE_ID_RE.test(e.name)) continue;
			recs.push(
				mkRec(e.name, e.title, {
					short: e.titleShort || undefined,
					format: e.categories?.format || undefined,
					fields: e.categories?.fields?.length ? e.categories.fields : undefined,
					updated: e.updated || undefined,
					dependent: !!e.dependent,
				}),
			);
		}
		// repository A-Z with independent styles first: the order of an empty search
		recs.sort((a, b) => Number(a.dependent) - Number(b.dependent) || a.t.localeCompare(b.t));
		this.recs = recs;
		this.recById = new Map(recs.map((r) => [r.id, r]));
		this.indexAt = at;
		this.indexLoaded = true;
		this.indexState = state;
	}

	private readCachedIndex(): { entries: IndexEntry[]; at: number } | null {
		try {
			if (!existsSync(this.indexFile)) return null;
			const entries = JSON.parse(readFileSync(this.indexFile, "utf8"));
			if (!Array.isArray(entries)) return null;
			return { entries, at: statSync(this.indexFile).mtimeMs };
		} catch {
			return null;
		}
	}

	/** Load the repository index: memory, then the on-disk cache (< 1 day old), then the network; stale cache offline. */
	async loadIndex(force = false): Promise<void> {
		const now = Date.now();
		if (!force && this.indexLoaded && this.indexState !== "none" && now - this.indexAt < INDEX_MAX_AGE_MS) return;
		if (!force && this.indexLoaded && this.indexState === "none" && now - this.indexAt < INDEX_RETRY_MS) return;
		this.indexInflight ??= this.refreshIndex(force).finally(() => {
			this.indexInflight = null;
		});
		await this.indexInflight;
	}

	private async refreshIndex(force: boolean): Promise<void> {
		const now = Date.now();
		const cached = this.readCachedIndex();
		if (cached && !force && now - cached.at < INDEX_MAX_AGE_MS) {
			this.adopt(cached.entries, cached.at, "fresh");
			return;
		}
		try {
			const text = await this.get(INDEX_URL);
			const parsed = JSON.parse(text);
			if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("unexpected styles.json");
			// keep only what the catalogue uses (the raw file is ~3 MB)
			const slim: IndexEntry[] = parsed.map((e: IndexEntry) => ({
				title: e.title,
				name: e.name,
				titleShort: e.titleShort,
				dependent: e.dependent,
				categories: e.categories,
				updated: e.updated,
			}));
			mkdirSync(this.cacheDir, { recursive: true });
			writeFileSync(this.indexFile, JSON.stringify(slim));
			this.adopt(slim, now, "fresh");
		} catch {
			// offline: a stale index beats none
			const retryAt = now - INDEX_MAX_AGE_MS + INDEX_RETRY_MS; // retry in an hour
			if (cached) this.adopt(cached.entries, retryAt, "cached");
			else if (!this.indexLoaded) this.adopt([], now, "none");
			else {
				this.indexAt = this.indexState === "none" ? now : retryAt;
				if (this.indexState === "fresh") this.indexState = "cached";
			}
		}
	}

	// ------------------------------------------------------------ search

	async searchStyles(o: StyleSearch = {}): Promise<{ styles: CiteStyleInfo[]; total: number; index: IndexState }> {
		await this.loadIndex();
		const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
		const offset = Math.max(o.offset ?? 0, 0);
		const installed = new Set(this.installedIds());
		const needle = (o.q ?? "").trim().toLowerCase();
		const tokens = needle.split(/\s+/).filter(Boolean);
		const wantFormat = o.format || undefined;
		const wantField = o.field || undefined;

		const extra: Rec[] = [];
		for (const id of installed) {
			if (this.recById.has(id)) continue;
			const r = this.meta(id)?.rec;
			if (r) extra.push(r);
		}
		for (const d of DEFAULT_STYLES) if (!this.recById.has(d.id) && !installed.has(d.id)) extra.push(mkRec(d.id, d.title));

		type Hit = { r: Rec; inst: boolean; s: number };
		const hits: Hit[] = [];
		const consider = (r: Rec) => {
			const inst = installed.has(r.id);
			if (o.installed && !inst) return;
			if (wantFormat && r.format !== wantFormat) return;
			if (wantField && !r.fields?.includes(wantField)) return;
			let s = 0;
			if (needle) {
				if (r.i === needle || r.sh === needle || r.t === needle) s = 0;
				else if (r.t.startsWith(needle) || r.i.startsWith(needle) || r.sh.startsWith(needle)) s = 1;
				else if (r.t.includes(` ${needle}`) || r.sh.includes(` ${needle}`) || r.i.includes(`-${needle}`)) s = 2;
				else if (r.t.includes(needle) || r.i.includes(needle) || r.sh.includes(needle)) s = 3;
				else if (tokens.length > 1) {
					const hay = `${r.t} ${r.sh} ${r.i}`;
					if (!tokens.every((w) => hay.includes(w))) return;
					s = 4; // "harvard cite" -> "Cite Them Right - Harvard"
				} else return;
			} else if (o.quick && !inst && !this.isBundled(r.id)) return;
			if (needle && s > 0.5 && this.isBundled(r.id)) s = Math.max(s - 2, 0.5); // the well-known defaults rank near the top
			hits.push({ r, inst, s });
		};
		for (const r of this.recs) consider(r);
		for (const r of extra) consider(r);

		const bundledRank = (id: string) => {
			const k = DEFAULT_STYLES.findIndex((d) => d.id === id);
			return k < 0 ? 999 : k;
		};
		hits.sort((a, b) => {
			if (a.inst !== b.inst) return a.inst ? -1 : 1;
			if (a.s !== b.s) return a.s - b.s;
			if (!needle) {
				const ba = bundledRank(a.r.id),
					bb = bundledRank(b.r.id);
				if (ba !== bb) return ba - bb;
			}
			if (a.r.dependent !== b.r.dependent) return a.r.dependent ? 1 : -1; // prefer independent styles
			if (needle && a.r.t.length !== b.r.t.length) return a.r.t.length - b.r.t.length;
			return a.r.t.localeCompare(b.r.t);
		});
		const styles = hits.slice(offset, offset + limit).map((h) => toInfo(h.r, h.inst, this.isBundled(h.r.id)));
		return { styles, total: hits.length, index: this.indexState };
	}

	async search(q: string, limit = 50): Promise<CiteStyleInfo[]> {
		return (await this.searchStyles({ q, limit, quick: !q.trim() })).styles;
	}
}

function toInfo(r: Rec, installed: boolean, bundled: boolean): CiteStyleInfo {
	return {
		id: r.id,
		title: r.title,
		titleShort: r.short,
		format: r.format,
		fields: r.fields,
		updated: r.updated,
		dependent: r.dependent,
		installed,
		bundled: bundled || undefined,
		removable: installed && !bundled,
	};
}

/** The independent parent's style id, or null for an independent style. */
function parentOf(xml: string, id: string): string | null {
	const link = xml.match(/<link\b[^>]*\brel="independent-parent"[^>]*>/);
	if (!link) return null;
	const href = link[0].match(/\bhref="([^"]+)"/)?.[1] ?? "";
	const pid = href.replace(/\/+$/, "").split("/").pop() ?? "";
	if (!pid) throw new HttpError(502, `style "${id}" has an unreadable independent-parent link`);
	return pid;
}

function parseInfo(xml: string, id: string): { rec: Rec; parent: string | null } {
	const title = xml.match(/<info>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? id;
	const titleShort = xml.match(/<title-short[^>]*>([\s\S]*?)<\/title-short>/)?.[1]?.trim();
	const klass = xml.match(/<style\b[^>]*\bclass="([^"]+)"/)?.[1];
	const cat = xml.match(/<category\b[^>]*\bcitation-format="([^"]+)"/)?.[1];
	const fields = [...xml.matchAll(/<category\b[^>]*\bfield="([^"]+)"/g)].map((m) => m[1]!);
	const updated = xml.match(/<updated>\s*([^<]+?)\s*<\/updated>/)?.[1];
	let parent: string | null = null;
	try {
		parent = parentOf(xml, id);
	} catch {}
	return {
		parent,
		rec: mkRec(id, decodeXml(title), {
			short: titleShort ? decodeXml(titleShort) : undefined,
			format: cat ?? (klass === "note" ? "note" : undefined),
			fields: fields.length ? fields : undefined,
			updated,
			dependent: parent !== null,
		}),
	};
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

/** Locale selection shared by formatting and preview: the language to run in plus the locale files it may need. */
async function prepareLocales(store: StyleStore, requested: string | undefined, defaultLocale: string | undefined) {
	if (requested && !LOCALE_RE.test(requested)) throw new HttpError(400, `invalid locale: ${requested}`);
	let lang = requested || defaultLocale || "en-US";
	// bare language ("de") -> the CSL primary dialect ("de-DE"), as citeproc-js itself does
	const bases = (CSL as unknown as { LANG_BASES?: Record<string, string> }).LANG_BASES;
	if (!lang.includes("-") && bases?.[lang]) lang = bases[lang]!.replace("_", "-");
	const locales = new Map<string, string>();
	for (const l of new Set(["en-US", lang, defaultLocale].filter(Boolean) as string[])) {
		const t = await store.locale(l);
		if (t) locales.set(l, t);
	}
	if (!locales.has("en-US")) throw new HttpError(502, "the en-US CSL locale could not be loaded");
	return { lang, locales };
}

export async function formatItems(store: StyleStore, input: FormatInput): Promise<Record<CiteFormat, string | undefined>> {
	const { xml, defaultLocale } = await store.resolveStyle(input.style);
	const { lang, locales } = await prepareLocales(store, input.locale, defaultLocale);
	const out: Record<CiteFormat, string | undefined> = { html: undefined, text: undefined, rtf: undefined };
	for (const f of input.formats) out[f] = runOnce(xml, locales, lang, input.items, input.mode, f);
	return out;
}

export interface PreviewResult {
	note: boolean;
	citations: string[];
	bibliography: string;
}

/**
 * Sample output of a style: one in-text citation per item (cited one after the other, so numeric styles count up
 * and ibid/disambiguation behave) and the bibliography. Uses the preview cache for styles that are not installed.
 */
export async function previewItems(
	store: StyleStore,
	input: { items: ZoteroItemData[]; style: string; locale?: string },
): Promise<PreviewResult> {
	const { xml, defaultLocale } = await store.resolveStyle(input.style, 0, "preview");
	const { lang, locales } = await prepareLocales(store, input.locale, defaultLocale);
	const csl = new Map(input.items.map((d) => [d.key, itemToCsl(d)]));
	const sys = {
		retrieveLocale: (l: string) => locales.get(l) ?? locales.get(l.split("-")[0]!) ?? locales.get("en-US") ?? false,
		retrieveItem: (id: string) => csl.get(id),
	};
	const engine = new CSL.Engine(sys, xml, lang, false);
	engine.setOutputFormat("html");
	const ids = input.items.map((d) => d.key);
	engine.updateItems(ids);
	const note = engine.opt.xclass === "note";
	const latest = new Map<string, string>();
	const pre: [string, number][] = [];
	for (let i = 0; i < ids.length; i++) {
		const cid = `pv${i}`;
		const ni = note ? i + 1 : 0;
		const [, out] = engine.processCitationCluster(
			{ citationID: cid, citationItems: [{ id: ids[i] }], properties: { noteIndex: ni } },
			pre.slice(),
			[],
		);
		for (const o of out) latest.set(o[2] as string, o[1]);
		pre.push([cid, ni]);
	}
	const citations = ids.map((_, i) => latest.get(`pv${i}`) ?? "");
	let bibliography = "";
	const bib = engine.makeBibliography();
	if (bib) bibliography = bib[0].bibstart + bib[1].join("") + bib[0].bibend;
	return { note, citations, bibliography };
}
