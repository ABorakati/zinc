// Sidebar controller: library search, picking items, writing/refreshing Zotero-compatible fields in the active
// Word document through the add-in host. No DOM in here, so it runs unchanged under bun test against a mock host
// or against the harness that drives an invisible Word.
import type { ZoteroItemData } from "../../../core/src/api-types";
import { parseQuery } from "../../../core/src/search";
import { CslFormatter, type DocCitation, type StyleSource, libraryItemToCsl } from "./csl";
import {
	type BibliographyData,
	type CitationData,
	type CitationItem,
	type CslItem,
	type DocPrefs,
	type ParsedField,
	type Run,
	CITATION_SCHEMA,
	buildBiblCode,
	buildItemCode,
	buildPrefsXml,
	defaultPrefs,
	itemUri,
	keysOfCitationItem,
	newCitationID,
	numericId,
	parseFieldCode,
	parsePrefsXml,
	styleIdToUrl,
	styleUrlToId,
	uriToKey,
} from "./fields";
import type { Host } from "./host";

// ---------------------------------------------------------------- shapes shared with the UI

export interface LibRow {
	key: string;
	title: string;
	creators: string;
	year: number | null;
	publication: string;
	itemType: string;
	doi: string;
}

export interface FieldInfo {
	story: "main" | "fn" | "en";
	idx: number;
	kind: "item" | "bibl";
	code: string;
	text: string;
	start: number;
	end: number;
	note?: number;
}
export interface DocField extends FieldInfo {
	parsed: ParsedField;
}

/** One item in the "Add citation" tray. */
export interface Pick {
	key: string | null; // library key when the item is in the library
	cslId: string;
	csl: CslItem;
	uris: string[];
	inLibrary: boolean;
	title: string;
	creators: string;
	year: string;
	locator: string;
	label: string;
	prefix: string;
	suffix: string;
	suppressAuthor: boolean;
}

export interface CitedItemView {
	key: string | null;
	inLibrary: boolean;
	trashed: boolean;
	title: string;
	authors: string;
	year: string;
	journal: string;
	abstract: string;
	doi: string;
	itemType: string;
	locator: string;
	prefix: string;
	suffix: string;
}
export interface CitationView {
	ref: { story: string; idx: number };
	citationID: string;
	items: CitedItemView[];
	text: string;
}

export interface RefreshReport {
	citations: number;
	updated: number;
	bibliographies: number;
	missing: string[];
	style: string;
	/** which fields were rewritten (kind#index and why), for diagnostics */
	changed: string[];
}

export interface HostInfo {
	version: string;
	library: { dbPath: string; dbExists: boolean; items?: number; error?: string; dataDir: string };
	uri: { base: string; userId: string | null; source: string };
	settings: Record<string, any>;
	zn: { up: boolean; api: string; launcher: string; launcherExists: boolean };
}

const DEFAULT_STYLE = "vancouver";

// ---------------------------------------------------------------- helpers

export function authorsOf(csl: CslItem, max = 6): string {
	const list = (csl.author as { family?: string; given?: string; literal?: string }[] | undefined) ?? [];
	const names = list.map((a) => a.literal ?? [a.family, (a.given ?? "").split(/[\s.-]+/).filter(Boolean).map((g) => g[0]).join("")].filter(Boolean).join(" "));
	if (names.length > max) return names.slice(0, max).join(", ") + ", et al.";
	return names.join(", ");
}

const issuedYear = (csl: CslItem): string => {
	const issued = csl.issued as { "date-parts"?: number[][]; raw?: string; literal?: string } | undefined;
	const y = issued?.["date-parts"]?.[0]?.[0];
	if (y) return String(y);
	const m = /\d{4}/.exec(issued?.raw ?? issued?.literal ?? "");
	return m ? m[0] : "";
};

function hashId(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return "emb" + h.toString(36);
}

/** Query text -> arguments for the add-in's library search (FTS5 over title/creators/abstract/publication/tags, DOI and year shortcuts). */
export function buildSearchArgs(q: string, limit = 30): { match?: string; doi?: string; year?: number; limit: number } {
	let text = q.trim();
	const doiM = /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text);
	if (doiM && /^\s*(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\./i.test(text)) return { doi: doiM[1]!.replace(/[).,;]+$/, ""), limit };
	let year: number | undefined;
	const ym = /(?:^|\s)((?:19|20)\d{2})(?=\s|$)/.exec(text);
	if (ym) {
		year = Number(ym[1]);
		text = (text.slice(0, ym.index) + " " + text.slice(ym.index + ym[0].length)).trim();
	}
	const terms = parseQuery(text);
	if (terms.length === 0) return year ? { year, limit } : { limit };
	const typing = !/\s$/.test(q) && !q.trim().endsWith('"');
	const parts = terms.map((t, i) => `"${t.text}"${t.prefix || (typing && i === terms.length - 1) ? "*" : ""}`);
	const match = `{title creators abstract publication tags} : (${parts.join(" ")})`;
	return year ? { match, year, limit } : { match, limit };
}

// ---------------------------------------------------------------- the controller

export class App {
	info: HostInfo | null = null;
	private formatters = new Map<string, Promise<CslFormatter>>();
	readonly styles: StyleSource;

	constructor(readonly host: Host) {
		this.styles = {
			styleXml: async (id) => (await host.call<{ xml: string }>("style.xml", { id })).xml,
			localeXml: async (lang) => (await host.call<{ xml: string | null }>("locale.xml", { lang })).xml,
		};
	}

	async init(): Promise<HostInfo> {
		this.info = await this.host.call<HostInfo>("host.info");
		return this.info;
	}

	get uriBase(): string {
		return this.info?.uri.base ?? "http://zotero.org/users/local/znlocal0";
	}

	/** Default style/locale for documents that have none yet. */
	get defaults(): { style: string; locale: string } {
		const s = this.info?.settings ?? {};
		return { style: s.style || DEFAULT_STYLE, locale: s.locale || "" };
	}

	async saveDefaults(style: string, locale: string): Promise<void> {
		await this.host.call("settings.set", { style, locale });
		if (this.info) this.info.settings = { ...this.info.settings, style, locale };
	}

	formatter(styleId: string, locale: string): Promise<CslFormatter> {
		const k = `${styleId}|${locale}`;
		let f = this.formatters.get(k);
		if (!f) {
			f = CslFormatter.create(this.styles, styleId, locale || undefined);
			f.catch(() => this.formatters.delete(k));
			this.formatters.set(k, f);
		}
		return f;
	}

	// ---- library ---------------------------------------------------------------------------------------------

	search(q: string, limit = 30): Promise<LibRow[]> {
		return this.host.call("lib.search", buildSearchArgs(q, limit));
	}

	async libraryItems(keys: string[]): Promise<Map<string, { data: ZoteroItemData; trashed: boolean; itemKey: string }>> {
		const out = new Map<string, { data: ZoteroItemData; trashed: boolean; itemKey: string }>();
		if (keys.length === 0) return out;
		const rows = await this.host.call<{ key: string; found: boolean; trashed?: boolean; itemKey?: string; data?: ZoteroItemData }[]>("lib.items", { keys });
		for (const r of rows) if (r.found && r.data) out.set(r.key, { data: { ...r.data, key: r.itemKey ?? r.key }, trashed: !!r.trashed, itemKey: r.itemKey ?? r.key });
		return out;
	}

	/** A library item as an "Add citation" tray entry. */
	async pickFromKey(key: string): Promise<Pick | null> {
		const m = await this.libraryItems([key]);
		const it = m.get(key);
		if (!it) return null;
		const csl = libraryItemToCsl(it.data);
		return {
			key: it.itemKey,
			cslId: it.itemKey,
			csl,
			uris: [itemUri(this.uriBase, it.itemKey)],
			inLibrary: true,
			title: String(csl.title ?? ""),
			creators: authorsOf(csl, 3),
			year: issuedYear(csl),
			locator: "",
			label: "page",
			prefix: "",
			suffix: "",
			suppressAuthor: false,
		};
	}

	// ---- document --------------------------------------------------------------------------------------------

	async docState(): Promise<{ hasDoc: boolean; name?: string; prefs: DocPrefs | null; readOnly?: boolean }> {
		const s = await this.host.call<{ hasDoc: boolean; name?: string; prefsXml?: string | null; readOnly?: boolean }>("doc.state");
		return { hasDoc: s.hasDoc, name: s.name, prefs: parsePrefsXml(s.prefsXml), readOnly: s.readOnly };
	}

	async readFields(): Promise<DocField[]> {
		const infos = await this.host.call<FieldInfo[]>("doc.fields");
		return infos.map((f) => ({ ...f, parsed: parseFieldCode(f.code) }));
	}

	private async writePrefs(p: DocPrefs): Promise<void> {
		await this.host.call("doc.setPrefs", { xml: buildPrefsXml(p) });
	}

	// ---- resolving cited items -------------------------------------------------------------------------------

	private async resolveAll(items: CitationItem[]): Promise<Map<CitationItem, Resolved>> {
		const keys = new Set<string>();
		for (const ci of items) for (const k of keysOfCitationItem(ci)) keys.add(k);
		const lib = await this.libraryItems([...keys]);
		// items whose key is gone from the library: a merged duplicate keeps the old URI in dc:replaces
		const lost: string[] = [];
		for (const ci of items) if (!keysOfCitationItem(ci).some((k) => lib.has(k))) lost.push(...(ci.uris ?? []));
		let replaced: Record<string, string> = {};
		if (lost.length) replaced = await this.host.call("lib.byUri", { uris: [...new Set(lost)] });
		const extra = await this.libraryItems([...new Set(Object.values(replaced))]);
		const out = new Map<CitationItem, Resolved>();
		for (const ci of items) {
			let hit: { data: ZoteroItemData; trashed: boolean; itemKey: string } | undefined;
			let replacedFrom: string | undefined;
			for (const k of keysOfCitationItem(ci)) {
				if (lib.has(k)) {
					hit = lib.get(k);
					break;
				}
			}
			if (!hit) {
				for (const u of ci.uris ?? []) {
					const nk = replaced[u];
					if (nk && extra.has(nk)) {
						hit = extra.get(nk);
						replacedFrom = u;
						break;
					}
				}
			}
			if (hit) {
				out.set(ci, {
					cslId: hit.itemKey,
					csl: libraryItemToCsl(hit.data),
					key: hit.itemKey,
					inLibrary: true,
					trashed: hit.trashed,
					data: hit.data,
					replacedFrom,
				});
			} else if (ci.itemData) {
				const id = hashId((ci.uris ?? [])[0] ?? JSON.stringify(ci.itemData.title ?? ci.id));
				out.set(ci, { cslId: id, csl: { ...ci.itemData, id }, key: null, inLibrary: false, trashed: false });
			}
		}
		return out;
	}

	// ---- cursor -> cited items -------------------------------------------------------------------------------

	/** What the sidebar shows when the cursor is inside a citation: the items with their abstracts. */
	async describeCitation(cursor: { inField: boolean; kind?: string; code?: string; ref?: { story: string; idx: number }; text?: string }): Promise<CitationView | null> {
		if (!cursor.inField || cursor.kind !== "item" || !cursor.code || !cursor.ref) return null;
		const parsed = parseFieldCode(cursor.code);
		if (!parsed || parsed.kind !== "item") return null;
		const data = parsed.data;
		const res = await this.resolveAll(data.citationItems);
		const items: CitedItemView[] = data.citationItems.map((ci) => {
			const r = res.get(ci);
			const csl = (r?.csl ?? ci.itemData ?? {}) as CslItem;
			const d = r?.data;
			return {
				key: r?.key ?? null,
				inLibrary: !!r?.inLibrary && !r?.trashed,
				trashed: !!r?.trashed,
				title: String(csl.title ?? "(untitled)"),
				authors: authorsOf(csl),
				year: issuedYear(csl),
				journal: String(csl["container-title"] ?? csl.publisher ?? ""),
				abstract: String(d?.abstractNote ?? csl.abstract ?? ""),
				doi: String(csl.DOI ?? ""),
				itemType: String(d?.itemType ?? csl.type ?? ""),
				locator: ci.locator ?? "",
				prefix: ci.prefix ?? "",
				suffix: ci.suffix ?? "",
			};
		});
		return { ref: cursor.ref, citationID: data.citationID, items, text: cursor.text ?? "" };
	}

	/** Tray entries for editing an existing citation. */
	async picksFromCitation(code: string): Promise<{ picks: Pick[]; citationID: string } | null> {
		const parsed = parseFieldCode(code);
		if (!parsed || parsed.kind !== "item") return null;
		const res = await this.resolveAll(parsed.data.citationItems);
		const picks: Pick[] = [];
		for (const ci of parsed.data.citationItems) {
			const r = res.get(ci);
			if (!r) continue;
			picks.push({
				key: r.key,
				cslId: r.cslId,
				csl: r.csl,
				uris: r.key ? [itemUri(this.uriBase, r.key)] : ci.uris ?? [],
				inLibrary: r.inLibrary,
				title: String(r.csl.title ?? ""),
				creators: authorsOf(r.csl, 3),
				year: issuedYear(r.csl),
				locator: ci.locator ?? "",
				label: ci.label ?? "page",
				prefix: ci.prefix ?? "",
				suffix: ci.suffix ?? "",
				suppressAuthor: !!ci["suppress-author"],
			});
		}
		return { picks, citationID: parsed.data.citationID };
	}

	// ---- building fields -------------------------------------------------------------------------------------

	private citationDataFromPicks(picks: Pick[], citationID: string, noteIndex = 0): CitationData {
		return {
			citationID,
			properties: { formattedCitation: "", plainCitation: "", noteIndex },
			citationItems: picks.map((p) => {
				const nid = p.key ? numericId(p.key) : (typeof p.csl.id === "number" ? p.csl.id : numericId(p.cslId));
				const ci: CitationItem = {
					id: nid,
					uris: p.uris,
					itemData: { ...p.csl, id: nid },
				};
				if (p.locator.trim()) {
					ci.locator = p.locator.trim();
					ci.label = p.label || "page";
				}
				if (p.prefix) ci.prefix = p.prefix;
				if (p.suffix) ci.suffix = p.suffix;
				if (p.suppressAuthor) ci["suppress-author"] = true;
				return ci;
			}),
			schema: CITATION_SCHEMA,
		};
	}

	/** Make sure the document carries style preferences (Zotero needs them to refresh it). Returns them. */
	private async ensurePrefs(): Promise<DocPrefs> {
		const st = await this.docState();
		if (st.prefs) return st.prefs;
		const d = this.defaults;
		const p = defaultPrefs(d.style, d.locale);
		await this.writePrefs(p);
		return p;
	}

	/** Insert a citation at the cursor, then format the whole document. */
	async insertCitation(picks: Pick[]): Promise<RefreshReport> {
		if (picks.length === 0) throw new Error("Pick at least one item.");
		const prefs = await this.ensurePrefs();
		const f = await this.formatter(styleUrlToId(prefs.styleId), prefs.locale);
		const note = f.style.xclass === "note";
		if (note && prefs.noteType === 0) {
			prefs.noteType = 1;
			await this.writePrefs(prefs);
		}
		const data = this.citationDataFromPicks(picks, newCitationID());
		await this.host.call("doc.begin", { name: "Insert citation" });
		try {
			await this.host.call("doc.insert", { kind: "item", code: buildItemCode(data), text: "…", placement: note ? "footnote" : "inline" });
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** Replace the items/locators of an existing citation, then format the whole document. */
	async updateCitation(ref: { story: string; idx: number }, citationID: string, picks: Pick[]): Promise<RefreshReport> {
		if (picks.length === 0) throw new Error("A citation needs at least one item (use Delete to remove it).");
		const data = this.citationDataFromPicks(picks, citationID);
		await this.host.call("doc.begin", { name: "Edit citation" });
		try {
			await this.host.call("doc.set", { ref: { ...ref, kind: "item", cid: citationID }, code: buildItemCode(data) });
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	async deleteCitation(ref: { story: string; idx: number }, citationID: string): Promise<RefreshReport> {
		await this.host.call("doc.begin", { name: "Delete citation" });
		try {
			await this.host.call("doc.delete", { ref: { ...ref, kind: "item", cid: citationID } });
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** Insert the bibliography at the cursor (or refresh it when the document already has one). */
	async insertBibliography(): Promise<RefreshReport> {
		const fields = await this.readFields();
		const prefs = await this.ensurePrefs();
		if (!fields.some((f) => f.kind === "bibl")) {
			await this.host.call("doc.begin", { name: "Insert bibliography" });
			try {
				await this.host.call("doc.insert", { kind: "bibl", code: buildBiblCode(), text: "…" });
				prefs.hasBibliography = true;
				await this.writePrefs(prefs);
				return await this.refreshAll();
			} finally {
				await this.host.call("doc.end");
			}
		}
		return this.refreshAll();
	}

	/** Change the document's citation style and/or locale and reformat everything. */
	async setStyle(styleId: string, locale: string): Promise<RefreshReport> {
		const prefs = await this.ensurePrefs();
		prefs.styleId = styleIdToUrl(styleId);
		prefs.locale = locale;
		prefs.bibliographyStyleHasBeenSet = true;
		const f = await this.formatter(styleId, locale);
		prefs.noteType = f.style.xclass === "note" ? prefs.noteType || 1 : 0;
		await this.writePrefs(prefs);
		return this.refreshAll();
	}

	async setNoteType(noteType: 1 | 2): Promise<void> {
		const prefs = await this.ensurePrefs();
		prefs.noteType = noteType;
		await this.writePrefs(prefs);
	}

	/** Re-read every Zotero field, re-resolve the items from the library, reformat the whole document and rewrite what changed. */
	async refreshAll(): Promise<RefreshReport> {
		const fields = await this.readFields();
		const items = fields.filter((f): f is DocField & { parsed: { kind: "item"; data: CitationData } } => f.parsed?.kind === "item");
		const bibls = fields.filter((f): f is DocField & { parsed: { kind: "bibl"; data: BibliographyData } } => f.parsed?.kind === "bibl");
		const st = await this.docState();
		let prefs = st.prefs;
		const report: RefreshReport = { citations: items.length, updated: 0, bibliographies: bibls.length, missing: [], style: "", changed: [] };
		if (items.length === 0 && bibls.length === 0) {
			report.style = prefs ? styleUrlToId(prefs.styleId) : this.defaults.style;
			return report;
		}
		if (!prefs) {
			const d = this.defaults;
			prefs = defaultPrefs(d.style, d.locale);
		}
		const styleId = styleUrlToId(prefs.styleId);
		report.style = styleId;
		const fmt = await this.formatter(styleId, prefs.locale);

		// uncited items listed in the bibliography field(s)
		const uncitedItems: CitationItem[] = [];
		for (const b of bibls)
			for (const u of b.parsed.data.uncited ?? []) {
				const uris = (Array.isArray(u) ? u : [u]).filter((x): x is string => typeof x === "string");
				if (uris.length) uncitedItems.push({ id: uris[0]!, uris });
			}
		const all = items.flatMap((f) => f.parsed.data.citationItems);
		const resolved = await this.resolveAll([...all, ...uncitedItems]);
		const cslById = new Map<string, CslItem>();
		for (const r of resolved.values()) cslById.set(r.cslId, r.csl);

		// citations in document order; the engine id is made unique so copy-pasted fields (same citationID) stay independent
		const docCitations: DocCitation[] = [];
		const engineIds: string[] = [];
		let ordinal = 0;
		for (const f of items) {
			ordinal++;
			const eid = `${f.parsed.data.citationID}~${ordinal}`;
			engineIds.push(eid);
			docCitations.push({
				citationID: eid,
				noteIndex: fmt.style.xclass === "note" ? f.note || ordinal : 0,
				items: f.parsed.data.citationItems.flatMap((ci) => {
					const r = resolved.get(ci);
					if (!r) {
						report.missing.push(String(ci.itemData?.title ?? ci.uris?.[0] ?? ci.id));
						return [];
					}
					return [
						{
							id: r.cslId,
							locator: ci.locator,
							label: ci.locator ? ci.label ?? "page" : undefined,
							prefix: ci.prefix,
							suffix: ci.suffix,
							"suppress-author": ci["suppress-author"],
							"author-only": ci["author-only"],
						},
					];
				}),
			});
		}
		const uncitedIds = uncitedItems.map((u) => resolved.get(u)?.cslId).filter((x): x is string => !!x);
		const out = fmt.format(docCitations, cslById, uncitedIds, bibls.length > 0);

		await this.host.call("doc.begin", { name: "Refresh citations" });
		try {
			let n = 0;
			for (const f of items) {
				const o = out.citations.get(engineIds[n]!);
				const dc = docCitations[n]!;
				n++;
				if (!o) continue;
				const data = structuredClone(f.parsed.data) as CitationData;
				data.properties = { ...data.properties, formattedCitation: o.rtf, plainCitation: o.plain, noteIndex: dc.noteIndex };
				data.schema ??= CITATION_SCHEMA;
				for (const ci of data.citationItems) {
					const orig = f.parsed.data.citationItems[data.citationItems.indexOf(ci)]!;
					const r = resolved.get(orig);
					if (r?.inLibrary && r.key) {
						const nid = typeof ci.id === "number" ? ci.id : numericId(r.key);
						ci.id = nid;
						ci.itemData = { ...r.csl, id: nid };
						if (r.replacedFrom) ci.uris = [itemUri(this.uriBase, r.key)];
					}
				}
				const code = buildItemCode(data);
				const same = JSON.stringify(f.parsed.data) === JSON.stringify(data);
				if (same && f.text === o.plain) continue;
				await this.host.call("doc.set", { ref: { story: f.story, idx: f.idx, kind: "item", cid: f.parsed.data.citationID }, code, runs: o.runs });
				report.updated++;
				report.changed.push(`item#${f.idx}:${same ? "text" : "code"}`);
			}
			for (const b of bibls) {
				if (!out.bibliography) continue;
				const bib = out.bibliography;
				const plain = bib.runs.map((r) => r.t).join("");
				if (plain === b.text) continue;
				await this.host.call("doc.set", {
					ref: { story: b.story, idx: b.idx, kind: "bibl" },
					runs: bib.runs as Run[],
					format: { hanging: bib.hanging, secondFieldAlign: bib.secondFieldAlign, entrySpacing: bib.entrySpacing },
				});
				report.updated++;
				const at = [...plain].findIndex((c, i) => c !== b.text[i]);
				report.changed.push(`bibl#${b.idx}: differs at ${at}: ${JSON.stringify(b.text.slice(Math.max(0, at - 10), at + 20))} vs ${JSON.stringify(plain.slice(Math.max(0, at - 10), at + 20))} (len ${b.text.length}/${plain.length})`);
			}
			const wantHas = bibls.length > 0;
			if (!st.prefs || prefs.hasBibliography !== wantHas) {
				prefs.hasBibliography = wantHas;
				await this.writePrefs(prefs);
			}
		} finally {
			await this.host.call("doc.end");
		}
		return report;
	}

	// ---- opening in zotero-next ------------------------------------------------------------------------------

	reveal(key: string): Promise<{ ok: boolean; started?: boolean; error?: string }> {
		return this.host.call("zn.reveal", { key });
	}

	/** Abstract from the running zotero-next lookup (OpenAlex/Crossref) for an item that has none locally. */
	async lookupAbstract(doi: string): Promise<string> {
		try {
			const r = await this.host.call<any>("zn.lookup", { doi });
			const a = r?.abstract ?? r?.abstractNote ?? r?.detail?.abstract;
			return typeof a === "string" ? a : "";
		} catch {
			return "";
		}
	}
}

interface Resolved {
	cslId: string;
	csl: CslItem;
	key: string | null;
	inLibrary: boolean;
	trashed: boolean;
	data?: ZoteroItemData;
	replacedFrom?: string;
}

export { uriToKey };
