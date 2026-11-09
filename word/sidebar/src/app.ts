// Sidebar controller: library search, picking items, writing/refreshing Zotero-compatible fields in the active
// Word document through the add-in host. No DOM in here, so it runs unchanged under bun test against a mock host
// or against the harness that drives an invisible Word.
//
// Zotero-plugin features implemented here (all on top of the host's doc.* field operations):
//   - refresh with merging of adjacent citations (Citation.mergeCitation) and protection of hand-edited citation text
//     (properties.dontUpdate), custom citation text (properties.custom) and unsorted items (properties.unsorted);
//   - splitting a multi-item citation into one citation per item;
//   - the bibliography editor (omitted / custom entry text / uncited items, stored in the ZOTERO_BIBL field code);
//   - "Unlink citations" (fields -> plain text);
//   - document preferences: converting citations between inline / footnotes / endnotes when the style class or the note
//     type changes, and "Automatically update citations" off (a new or edited citation is formatted on its own only).
// Not implemented: storing citations as bookmarks (the fieldType pref is kept as is), journal abbreviations (the pref is kept).
import type { ZoteroItemData } from "../../../core/src/api-types";
import { parseQuery } from "../../../core/src/search";
import { CslFormatter, type DocCitation, type DocCitationItem, type FormatResult, type StyleSource, libraryItemToCsl } from "./csl";
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
	isHandEdited,
	itemUri,
	keysOfCitationItem,
	mergeCitationData,
	newCitationID,
	numericId,
	parseFieldCode,
	parsePrefsXml,
	prepareForEditing,
	richToRuns,
	runsToPlain,
	runsToRtf,
	splitCitationData,
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
type ItemField = DocField & { parsed: { kind: "item"; data: CitationData } };

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
	/** adjacent citations folded into the one before them */
	merged?: number;
	/** hand-edited citations left alone (their text is not rewritten) */
	kept?: number;
}

/** A citation whose text in the document differs from what was last written there (the user typed into it). */
export interface ModifiedCitation {
	ref: { story: string; idx: number };
	citationID: string;
	/** what the add-in wrote */
	was: string;
	/** what the document shows now */
	now: string;
}

export type ModifiedChoice = "keep" | "overwrite";

/** Where and how insertCitation puts a new citation. */
export interface InsertOptions {
	/** document position (from the host's doc.locate) to insert at instead of the cursor */
	at?: number;
	/** the new field's citationID (default: a fresh one), so the caller can find the field again */
	citationID?: string;
}

export interface RefreshOptions {
	/** fold citations that touch each other into the first one (what Zotero does on Refresh). Default false. */
	merge?: boolean;
	/** hand-edited citations: keep the edit (flag it dontUpdate), overwrite it, or ask. Default "keep": never overwritten silently. */
	onModified?: ModifiedChoice | ((items: ModifiedCitation[]) => Promise<ModifiedChoice> | ModifiedChoice);
}

/** One entry of the bibliography editor. */
export interface BibEditorEntry {
	/** CSL id of the (first) item of the entry */
	cslId: string;
	/** item URIs as stored in the document, for the field code */
	uris: string[];
	title: string;
	/** what the bibliography shows for the entry now (custom text when set) */
	runs: Run[];
	/** the style's own formatting */
	defaultRuns: Run[];
	cited: boolean;
	/** in the "add uncited item" list of the bibliography field (and not cited in the text) */
	uncited: boolean;
	omitted: boolean;
	custom: boolean;
}

/** What the bibliography editor writes back into the ZOTERO_BIBL field code. Each list that is given replaces the stored one. */
export interface BibliographyChanges {
	/** URIs of the items left out of the bibliography */
	omitted?: string[][];
	/** URIs of the items listed although the text does not cite them */
	uncited?: string[][];
	/** replacement entry text (single-item entries only) */
	custom?: { uris: string[]; runs: Run[] }[];
}

/** Bibliography changes that make the field code say what the editor entries say (entries with no state to store are dropped). */
export function changesFromEntries(entries: BibEditorEntry[]): Required<BibliographyChanges> {
	return {
		omitted: entries.filter((e) => e.omitted).map((e) => e.uris),
		uncited: entries.filter((e) => e.uncited && !e.cited).map((e) => e.uris),
		custom: entries.filter((e) => e.custom).map((e) => ({ uris: e.uris, runs: e.runs })),
	};
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

/** The CSL id resolveAll will give a cited item: its library key when the URI names one, else the embedded-copy hash. */
function guessCslId(ci: CitationItem): string {
	const k = keysOfCitationItem(ci)[0];
	return k ?? hashId((ci.uris ?? [])[0] ?? JSON.stringify(ci.itemData?.title ?? ci.id));
}

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

	/** `light`: skip the probe of a running zotero-next app (the agent API never needs it). */
	async init(light = false): Promise<HostInfo> {
		this.info = await this.host.call<HostInfo>("host.info", light ? { light: true } : {});
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

	/** The item URI for a library item: groups/<id>/items/<key> for a group item, else the account (or local) URI base. */
	uriForItem(key: string, groupId?: number | null): string {
		return groupId ? itemUri(`http://zotero.org/groups/${groupId}`, key) : itemUri(this.uriBase, key);
	}

	async libraryItems(keys: string[]): Promise<Map<string, LibraryHit>> {
		const out = new Map<string, LibraryHit>();
		if (keys.length === 0) return out;
		const rows = await this.host.call<{ key: string; found: boolean; trashed?: boolean; itemKey?: string; data?: ZoteroItemData; groupId?: number | null }[]>("lib.items", { keys });
		for (const r of rows)
			if (r.found && r.data) out.set(r.key, { data: { ...r.data, key: r.itemKey ?? r.key }, trashed: !!r.trashed, itemKey: r.itemKey ?? r.key, groupId: r.groupId ?? null });
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
			uris: [this.uriForItem(it.itemKey, it.groupId)],
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

	/** Resolve cited items against the library (a merged duplicate is followed through dc:replaces); items gone from it keep their embedded copy. */
	async resolveAll(items: CitationItem[]): Promise<Map<CitationItem, Resolved>> {
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
			let hit: LibraryHit | undefined;
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
					groupId: hit.groupId,
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
		const items: CitedItemView[] = data.citationItems.map((ci) => viewOfCitationItem(ci, res.get(ci)));
		return { ref: cursor.ref, citationID: data.citationID, items, text: cursor.text ?? "" };
	}

	/** Instant first paint of the popup: the items as embedded in the field code, no host call and no formatting. */
	quickView(code: string): PopupCitation | null {
		const parsed = parseFieldCode(code);
		if (!parsed || parsed.kind !== "item") return null;
		const items: PopupItemView[] = parsed.data.citationItems.map((ci) => ({ ...viewOfCitationItem(ci, undefined), reference: [], missing: false, cslId: guessCslId(ci), pending: true }));
		return { citationID: parsed.data.citationID, items };
	}

	/** Compile the document's citation style ahead of the first popup/refresh (call once after init()). */
	async warmUp(): Promise<void> {
		try {
			const prefs = (await this.docState()).prefs;
			const d = this.defaults;
			await this.formatter(prefs ? styleUrlToId(prefs.styleId) : d.style, prefs ? prefs.locale : d.locale);
		} catch {
			/* no document or style yet: the first real use reports it */
		}
	}

	/** What the citation popup shows: each cited item with its full reference in the document's style. */
	async describeForPopup(code: string): Promise<PopupCitation | null> {
		const parsed = parseFieldCode(code);
		if (!parsed || parsed.kind !== "item") return null;
		const data = parsed.data;
		const res = await this.resolveAll(data.citationItems);
		let fmt: CslFormatter | null = null;
		try {
			const prefs = (await this.docState()).prefs;
			const d = this.defaults;
			fmt = await this.formatter(prefs ? styleUrlToId(prefs.styleId) : d.style, prefs ? prefs.locale : d.locale);
		} catch {
			fmt = null; // no style available: fall back to a plain reference
		}
		const items: PopupItemView[] = data.citationItems.map((ci) => {
			const r = res.get(ci);
			const view = viewOfCitationItem(ci, r);
			let reference: Run[] = [];
			if (r && fmt) {
				try {
					const out = fmt.format([{ citationID: "popup", noteIndex: 0, items: [{ id: r.cslId }] }], new Map([[r.cslId, r.csl]]), [], true);
					const entry = out.bibliography?.runs;
					if (entry?.length) reference = stripNumberLabel(entry);
				} catch {
					reference = [];
				}
			}
			if (!reference.length && (r || ci.itemData)) reference = [{ t: plainReference(view) }];
			return { ...view, reference, missing: !r, cslId: r?.cslId ?? guessCslId(ci) };
		});
		return { citationID: data.citationID, items };
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
				// the citation keeps the URIs it was written with (they may name a group library or another account); only an item without any gets a new one
					uris: ci.uris?.length ? ci.uris : r.key ? [this.uriForItem(r.key, r.groupId)] : [],
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

	private citationDataFromPicks(picks: Pick[], citationID: string, noteIndex = 0, keep: CitationData["properties"] = {}): CitationData {
		return {
			citationID,
			properties: { ...keep, formattedCitation: "", plainCitation: "", noteIndex },
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

	/**
	 * A citation formatted on its own, as Zotero's writeDelayedCitation does when "Automatically update citations" is off:
	 * no other citation and no bibliography is touched, so numbering is only what a one-citation document would show.
	 */
	private async previewCitation(data: CitationData, fmt: CslFormatter): Promise<{ runs: Run[]; plain: string; rtf: string; noteIndex: number }> {
		const res = await this.resolveAll(data.citationItems);
		const cslById = new Map<string, CslItem>();
		for (const r of res.values()) cslById.set(r.cslId, r.csl);
		const noteIndex = fmt.style.xclass === "note" ? 1 : 0;
		let runs: Run[];
		if (data.properties.custom) runs = richToRuns(data.properties.custom);
		else {
			const items = data.citationItems.flatMap((ci) => {
				const r = res.get(ci);
				return r ? [docCitationItem(ci, r)] : [];
			});
			const out = fmt.format([{ citationID: "preview", noteIndex, items, unsorted: data.properties.unsorted }], cslById, [], false);
			runs = out.citations.get("preview")?.runs ?? [{ t: "(missing item)" }];
		}
		return { runs, plain: runsToPlain(runs), rtf: runsToRtf(runs), noteIndex };
	}

	/** Insert a citation at the cursor, then format the whole document (or only the new citation when automatic updates are off). */
	async insertCitation(picks: Pick[], opts: InsertOptions = {}): Promise<RefreshReport> {
		if (picks.length === 0) throw new Error("Pick at least one item.");
		const prefs = await this.ensurePrefs();
		const f = await this.formatter(styleUrlToId(prefs.styleId), prefs.locale);
		const note = f.style.xclass === "note";
		if (note && prefs.noteType === 0) {
			prefs.noteType = 1;
			await this.writePrefs(prefs);
		}
		const placement = note ? (prefs.noteType === 2 ? "endnote" : "footnote") : "inline";
		const data = this.citationDataFromPicks(picks, opts.citationID ?? newCitationID());
		const where = opts.at === undefined ? {} : { at: { pos: opts.at } };
		await this.host.call("doc.begin", { name: "Insert citation" });
		try {
			if (prefs.delayCitationUpdates) {
				const p = await this.previewCitation(data, f);
				data.properties = { ...data.properties, formattedCitation: p.rtf, plainCitation: p.plain, noteIndex: p.noteIndex };
				await this.host.call("doc.insert", { kind: "item", code: buildItemCode(data), runs: p.runs, placement, ...where });
				return { citations: 1, updated: 1, bibliographies: 0, missing: [], style: styleUrlToId(prefs.styleId), changed: ["item#new:preview"] };
			}
			await this.host.call("doc.insert", { kind: "item", code: buildItemCode(data), text: "…", placement, ...where });
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/**
	 * Replace the items/locators of an existing citation, then format the whole document (or only this citation when
	 * automatic updates are off). Like Zotero's prepareForEditing the custom text and the item order are kept while the
	 * cached text and the keep-my-edits flag are dropped.
	 */
	async updateCitation(ref: { story: string; idx: number }, citationID: string, picks: Pick[]): Promise<RefreshReport> {
		if (picks.length === 0) throw new Error("A citation needs at least one item (use Delete to remove it).");
		const cur = (await this.readFields()).find((f) => f.story === ref.story && f.idx === ref.idx);
		if (!cur || cur.parsed?.kind !== "item" || cur.parsed.data.citationID !== citationID) throw new Error("The document changed under the sidebar. Refresh and try again.");
		const old = cur.parsed.data.properties;
		const data = this.citationDataFromPicks(picks, citationID, old.noteIndex ?? 0, prepareForEditing(old));
		await this.host.call("doc.begin", { name: "Edit citation" });
		try {
			const prefs = await this.ensurePrefs();
			if (prefs.delayCitationUpdates) {
				const f = await this.formatter(styleUrlToId(prefs.styleId), prefs.locale);
				const p = await this.previewCitation(data, f);
				data.properties = { ...data.properties, formattedCitation: p.rtf, plainCitation: p.plain };
				await this.host.call("doc.set", { ref: { ...ref, kind: "item", cid: citationID }, code: buildItemCode(data), runs: p.runs });
				return { citations: 1, updated: 1, bibliographies: 0, missing: [], style: styleUrlToId(prefs.styleId), changed: ["item#" + ref.idx + ":preview"] };
			}
			await this.host.call("doc.set", { ref: { ...ref, kind: "item", cid: citationID }, code: buildItemCode(data) });
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** A multi-item citation becomes one citation per item, one after another (locator, prefix and suffix stay with their item). */
	async splitCitation(ref: { story: string; idx: number }, citationID: string, opts: { allowProtected?: boolean } = {}): Promise<RefreshReport> {
		const cur = (await this.readFields()).find((f) => f.story === ref.story && f.idx === ref.idx);
		if (!cur || cur.parsed?.kind !== "item" || cur.parsed.data.citationID !== citationID) throw new Error("The document changed under the sidebar. Refresh and try again.");
		if (cur.parsed.data.citationItems.length < 2) throw new Error("This citation has only one item.");
		const pr = cur.parsed.data.properties;
		if (!opts.allowProtected && (pr.custom || pr.dontUpdate || isHandEdited(pr, cur.text))) {
			throw new Error("This citation has custom or hand-edited text that a split would replace. Confirm the split first.");
		}
		const parts = splitCitationData(cur.parsed.data);
		await this.host.call("doc.begin", { name: "Split citation" });
		try {
			// the new fields are inserted first and the original is rewritten last, so until the very end the original is intact
			let inserted = 0;
			try {
				// each new field goes straight after the original, last item first, so they end up in the original order
				for (let i = parts.length - 1; i >= 1; i--) {
					await this.host.call("doc.insert", { kind: "item", code: buildItemCode(parts[i]!), text: "…", after: { story: ref.story, idx: ref.idx } });
					inserted++;
				}
				await this.host.call("doc.set", { ref: { ...ref, kind: "item", cid: citationID }, code: buildItemCode(parts[0]!) });
			} catch (e) {
				const why = e instanceof Error ? e.message : String(e);
				try {
					await this.removeInsertedParts(ref, parts.slice(parts.length - inserted));
				} catch {
					throw new Error(`The split failed (${why}) and could not be fully undone. Press Ctrl+Z in Word to restore the citation.`);
				}
				throw new Error(`The split failed (${why}). The original citation is unchanged.`);
			}
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** Rollback of a failed split: delete the fields just inserted after `ref` (matched by their citation IDs, highest index first). */
	private async removeInsertedParts(ref: { story: string; idx: number }, made: CitationData[]): Promise<void> {
		if (!made.length) return;
		const ids = new Set(made.map((m) => m.citationID));
		const doomed = (await this.readFields()).filter((f) => f.story === ref.story && f.parsed?.kind === "item" && ids.has(f.parsed.data.citationID));
		doomed.sort((a, b) => b.idx - a.idx);
		for (const f of doomed) await this.host.call("doc.delete", { ref: { story: f.story, idx: f.idx, kind: "item", cid: f.parsed?.kind === "item" ? f.parsed.data.citationID : undefined } });
	}

	/** Fold citations that touch each other into the first of them (Zotero's merge on Refresh). Returns how many fields were removed. */
	private async mergeAdjacent(): Promise<number> {
		const fields = await this.readFields();
		const mergeable = (f: DocField): f is ItemField =>
			f.parsed?.kind === "item" && !f.parsed.data.properties.dontUpdate && !f.parsed.data.properties.custom && !isHandEdited(f.parsed.data.properties, f.text);
		const groups: ItemField[][] = [];
		let cur: ItemField[] = [];
		for (const f of fields) {
			const last = cur[cur.length - 1];
			if (mergeable(f) && last && f.story === last.story && (f.note ?? 0) === (last.note ?? 0) && f.start <= last.end) cur.push(f);
			else {
				if (cur.length > 1) groups.push(cur);
				cur = mergeable(f) ? [f] : [];
			}
		}
		if (cur.length > 1) groups.push(cur);
		if (!groups.length) return 0;
		await this.host.call("doc.begin", { name: "Merge citations" });
		try {
			const doomed: ItemField[] = [];
			const rewritten: ItemField[] = [];
			try {
				for (const g of groups) {
					const [first, ...rest] = g as [ItemField, ...ItemField[]];
					const merged = mergeCitationData(first.parsed.data, rest.map((r) => r.parsed.data));
					merged.properties = prepareForEditing(merged.properties);
					await this.host.call("doc.set", { ref: { story: first.story, idx: first.idx, kind: "item", cid: first.parsed.data.citationID }, code: buildItemCode(merged) });
					rewritten.push(first);
					doomed.push(...rest);
				}
				// deletions last, highest index first, so no pending index moves
				doomed.sort((a, b) => b.idx - a.idx);
				for (const f of doomed) await this.host.call("doc.delete", { ref: { story: f.story, idx: f.idx, kind: "item", cid: f.parsed.data.citationID } });
			} catch (e) {
				// put the first citation of each group back as it was: nothing is lost, the touching citations simply stay separate
				for (const first of rewritten) await this.host.call("doc.set", { ref: { story: first.story, idx: first.idx, kind: "item", cid: first.parsed.data.citationID }, code: first.code }).catch(() => {});
				throw new Error(`Merging adjacent citations failed (${e instanceof Error ? e.message : String(e)}); the citations were left as they were. Ctrl+Z in Word undoes anything partial.`);
			}
			return doomed.length;
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** Unlink every Zotero field (citations and bibliographies): the visible text stays, the codes go. Preferences are kept. */
	async unlinkCitations(): Promise<{ unlinked: number }> {
		const fields = await this.readFields();
		if (!fields.length) return { unlinked: 0 };
		await this.host.call("doc.begin", { name: "Unlink citations" });
		try {
			// last field first: removing one only renumbers the fields after it in its story
			for (const f of [...fields].reverse()) {
				const kind = f.parsed?.kind ?? f.kind;
				const cid = f.parsed?.kind === "item" ? f.parsed.data.citationID : undefined;
				await this.host.call("doc.unlink", { ref: { story: f.story, idx: f.idx, kind, ...(cid ? { cid } : {}) } });
			}
		} finally {
			await this.host.call("doc.end");
		}
		return { unlinked: fields.length };
	}

	/**
	 * Move every citation to where the document's note setting wants it (inline, footnote or endnote). Citations marked
	 * dontUpdate and bibliographies are left alone. The caller refreshes afterwards. Returns how many were moved.
	 */
	async convertCitations(target: "inline" | "footnote" | "endnote"): Promise<number> {
		const want = target === "inline" ? "main" : target === "footnote" ? "fn" : "en";
		const todo = (await this.readFields()).filter((f) => f.parsed?.kind === "item" && f.story !== want && !f.parsed.data.properties.dontUpdate);
		if (!todo.length) return 0;
		await this.host.call("doc.begin", { name: "Convert citations" });
		try {
			// last first: converting a citation only renumbers fields after it, never the ones still waiting
			let done = 0;
			for (const f of [...todo].reverse()) {
				const cid = f.parsed?.kind === "item" ? f.parsed.data.citationID : undefined;
				try {
					// the add-in creates the replacement first and removes the original only then, so a failure leaves this citation as it was
					await this.host.call("doc.convert", { ref: { story: f.story, idx: f.idx, kind: "item", cid }, target, code: f.code });
				} catch (e) {
					throw new Error(`Moving citations failed after ${done} of ${todo.length} (${e instanceof Error ? e.message : String(e)}). The failing citation was not changed; Ctrl+Z in Word undoes the ones already moved.`);
				}
				done++;
			}
		} finally {
			await this.host.call("doc.end");
		}
		return todo.length;
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
	async insertBibliography(opts: { at?: number } = {}): Promise<RefreshReport> {
		const fields = await this.readFields();
		const prefs = await this.ensurePrefs();
		if (!fields.some((f) => f.kind === "bibl")) {
			await this.host.call("doc.begin", { name: "Insert bibliography" });
			try {
				await this.host.call("doc.insert", { kind: "bibl", code: buildBiblCode(), text: "…", ...(opts.at === undefined ? {} : { at: { pos: opts.at } }) });
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
		const wasNote = prefs.noteType !== 0;
		prefs.styleId = styleIdToUrl(styleId);
		prefs.locale = locale;
		prefs.bibliographyStyleHasBeenSet = true;
		const f = await this.formatter(styleId, locale);
		const isNote = f.style.xclass === "note";
		prefs.noteType = isNote ? prefs.noteType || 1 : 0;
		await this.writePrefs(prefs);
		await this.host.call("doc.begin", { name: "Change citation style" });
		try {
			// switching between an in-text and a note style moves the existing citations into / out of the notes
			if (wasNote !== isNote) await this.convertCitations(!isNote ? "inline" : prefs.noteType === 2 ? "endnote" : "footnote");
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** Footnotes or endnotes for a note style: existing citations are converted, then everything is reformatted. In-text styles ignore it. */
	async setNoteType(noteType: 1 | 2): Promise<RefreshReport | null> {
		const prefs = await this.ensurePrefs();
		const f = await this.formatter(styleUrlToId(prefs.styleId), prefs.locale);
		if (f.style.xclass !== "note") return null;
		prefs.noteType = noteType;
		await this.writePrefs(prefs);
		await this.host.call("doc.begin", { name: "Change note type" });
		try {
			await this.convertCitations(noteType === 2 ? "endnote" : "footnote");
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
	}

	/** "Automatically update citations": off means a new or edited citation is formatted on its own and only Refresh updates the rest. */
	async setAutoUpdate(auto: boolean): Promise<void> {
		const prefs = await this.ensurePrefs();
		prefs.delayCitationUpdates = !auto;
		await this.writePrefs(prefs);
	}

	/**
	 * The whole-document formatting pass shared by refreshAll (which then writes the result back) and docLabels (which
	 * only reads it): read the fields, resolve the cited items, build the citation list in document order and format it.
	 * `probes` appends one synthetic one-item citation per distinct cited item after the real ones (see docLabels).
	 */
	private async formatDocument(opts: { probes?: boolean; wantBib?: boolean } = {}): Promise<DocFormat> {
		const fields = await this.readFields();
		const items = fields.filter((f): f is DocField & { parsed: { kind: "item"; data: CitationData } } => f.parsed?.kind === "item");
		const bibls = fields.filter((f): f is DocField & { parsed: { kind: "bibl"; data: BibliographyData } } => f.parsed?.kind === "bibl");
		const st = await this.docState();
		let prefs = st.prefs;
		const missing: string[] = [];
		if (!prefs) {
			const d = this.defaults;
			prefs = defaultPrefs(d.style, d.locale);
		}
		const styleId = styleUrlToId(prefs.styleId);
		const base = { fields, items, bibls, st, prefs, styleId, missing, resolved: new Map<CitationItem, Resolved>(), docCitations: [] as DocCitation[], engineIds: [] as string[], probeIds: new Map<string, string>(), cslUris: new Map<string, string[]>(), uncitedIds: new Set<string>() };
		if (items.length === 0 && bibls.length === 0) return { ...base, fmt: null, out: null };
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
						missing.push(String(ci.itemData?.title ?? ci.uris?.[0] ?? ci.id));
						return [];
					}
					return [docCitationItem(ci, r)];
				}),
				unsorted: f.parsed.data.properties.unsorted ? true : undefined,
			});
		}
		const probeIds = new Map<string, string>(); // CSL id -> engine id of its probe citation
		if (opts.probes) {
			const distinct = [...new Set(docCitations.flatMap((c) => c.items.map((i) => i.id)))];
			// a probe straight after a real citation of the same single item would render "Ibid."; start with another item
			const last = docCitations[docCitations.length - 1];
			if (distinct.length > 1 && last && last.items.length === 1 && last.items[0]!.id === distinct[0]) distinct.push(distinct.shift()!);
			let note = docCitations.reduce((m, c) => Math.max(m, c.noteIndex), 0);
			distinct.forEach((id, i) => {
				const pid = `~probe~${i}`;
				probeIds.set(id, pid);
				docCitations.push({ citationID: pid, noteIndex: fmt.style.xclass === "note" ? ++note : 0, items: [{ id }] });
			});
		}
		const uncitedIds = uncitedItems.map((u) => resolved.get(u)?.cslId).filter((x): x is string => !!x);
		// bibliography editor state of the field code(s): item URIs -> CSL ids of the items resolved above
		const cslUris = new Map<string, string[]>();
		const idOfUri = new Map<string, string>();
		for (const [ci, r] of resolved) {
			const list = cslUris.get(r.cslId) ?? [];
			for (const u of ci.uris ?? []) {
				if (!list.includes(u)) list.push(u);
				idOfUri.set(u, r.cslId);
			}
			cslUris.set(r.cslId, list);
		}
		const idForUris = (v: unknown): string | undefined => {
			const uris = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
			for (const u of uris) if (idOfUri.has(u)) return idOfUri.get(u);
			for (const u of uris) {
				const k = uriToKey(u);
				if (k && cslById.has(k)) return k;
			}
			return undefined;
		};
		const omitted = new Set<string>();
		const custom = new Map<string, Run[]>();
		for (const b of bibls) {
			for (const o of b.parsed.data.omitted ?? []) {
				const id = idForUris(o);
				if (id) omitted.add(id);
			}
			for (const c of b.parsed.data.custom ?? []) {
				// [[uris], text] as Zotero stores it (the old id -> text hash form is not read)
				if (!Array.isArray(c) || typeof c[1] !== "string") continue;
				const id = idForUris(c[0]);
				const runs = id ? richToRuns(c[1]) : [];
				if (id && runs.length) custom.set(id, runs);
			}
		}
		// formatDocument keeps the citeproc engine between refreshes of this document (one sidebar = one document)
		const out = fmt.formatDocument(docCitations, cslById, uncitedIds, opts.wantBib ?? bibls.length > 0, { omitted, custom });
		return { ...base, resolved, docCitations, engineIds, probeIds, fmt, out, cslUris, uncitedIds: new Set(uncitedIds) };
	}

	private labelCache: { key: string; at: number; labels: Promise<Map<string, string>> } | null = null;

	/**
	 * Per cited item (by CSL id) the label the document shows for it: numeric styles -> its citation number ("[3]", "3."),
	 * author-date styles -> its in-text citation without the outer parentheses ("Smith et al., 2020"), note styles -> the
	 * short (subsequent-citation) form. It is the output of a one-item citation for that item appended after the real
	 * citations of a whole-document format pass, so numbering, et-al. and year-suffix disambiguation match the document.
	 * Cached ~10 s per document (name + field count + total code length) so repeated clicks are quick.
	 */
	async docLabels(ttlMs = 10_000): Promise<Map<string, string>> {
		const st = await this.docState();
		if (!st.hasDoc) return new Map();
		const fields = await this.readFields();
		const key = `${st.name ?? ""}|${fields.length}|${fields.reduce((n, f) => n + f.code.length, 0)}|${st.prefs?.styleId ?? ""}`;
		const c = this.labelCache;
		if (c && c.key === key && Date.now() - c.at < ttlMs) return c.labels;
		const labels = this.computeLabels();
		this.labelCache = { key, at: Date.now(), labels };
		labels.catch(() => {
			if (this.labelCache?.labels === labels) this.labelCache = null;
		});
		return labels;
	}

	private async computeLabels(): Promise<Map<string, string>> {
		const d = await this.formatDocument({ probes: true, wantBib: false });
		const labels = new Map<string, string>();
		if (!d.out) return labels;
		for (const [id, pid] of d.probeIds) {
			const o = d.out.citations.get(pid);
			const label = o ? tidyLabel(o.plain) : "";
			if (label) labels.set(id, label);
		}
		return labels;
	}

	/** Re-read every Zotero field, re-resolve the items from the library, reformat the whole document and rewrite what changed. */
	async refreshAll(opts: RefreshOptions = {}): Promise<RefreshReport> {
		const merged = opts.merge ? await this.mergeAdjacent() : 0;
		const d = await this.formatDocument();
		const { items, bibls, st, prefs, resolved, docCitations, engineIds, out } = d;
		const report: RefreshReport = { citations: items.length, updated: 0, bibliographies: bibls.length, missing: d.missing, style: d.styleId, changed: [], merged, kept: 0 };
		if (!out) return report;

		// citations whose text the user typed into: never overwritten silently
		const edited = items.filter((f) => !f.parsed.data.properties.dontUpdate && isHandEdited(f.parsed.data.properties, f.text));
		let choice: ModifiedChoice = "keep";
		if (edited.length) {
			const on = opts.onModified ?? "keep";
			choice =
				typeof on === "function"
					? await on(edited.map((f) => ({ ref: { story: f.story, idx: f.idx }, citationID: f.parsed.data.citationID, was: f.parsed.data.properties.plainCitation ?? "", now: f.text })))
					: on;
		}
		const editedSet = new Set(edited);

		await this.host.call("doc.begin", { name: "Refresh citations" });
		try {
			let n = 0;
			for (const f of items) {
				const o = out.citations.get(engineIds[n]!);
				const dc = docCitations[n]!;
				n++;
				if (!o) continue;
				const keepEdit = editedSet.has(f) && choice === "keep";
				// hand-edited text stays as it is; the citation still took part in numbering above
				const frozen = !!f.parsed.data.properties.dontUpdate || keepEdit;
				const custom = f.parsed.data.properties.custom;
				const shown = custom ? richToRuns(custom) : o.runs;
				const data = structuredClone(f.parsed.data) as CitationData;
				if (frozen) {
					data.properties = { ...data.properties, noteIndex: dc.noteIndex, dontUpdate: true };
					if (keepEdit) report.kept = (report.kept ?? 0) + 1;
				} else {
					data.properties = { ...data.properties, formattedCitation: custom ? runsToRtf(shown) : o.rtf, plainCitation: custom ? runsToPlain(shown) : o.plain, noteIndex: dc.noteIndex };
				}
				data.schema ??= CITATION_SCHEMA;
				for (const ci of data.citationItems) {
					const orig = f.parsed.data.citationItems[data.citationItems.indexOf(ci)]!;
					const r = resolved.get(orig);
					if (r?.inLibrary && r.key) {
						const nid = typeof ci.id === "number" ? ci.id : numericId(r.key);
						ci.id = nid;
						ci.itemData = { ...r.csl, id: nid };
						if (r.replacedFrom) ci.uris = [this.uriForItem(r.key, r.groupId)];
					}
				}
				const code = buildItemCode(data);
				const same = JSON.stringify(f.parsed.data) === JSON.stringify(data);
				const wantText = runsToPlain(shown);
				if (same && (frozen || f.text === wantText)) continue;
				await this.host.call("doc.set", { ref: { story: f.story, idx: f.idx, kind: "item", cid: f.parsed.data.citationID }, code, ...(frozen ? {} : { runs: shown }) });
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
					// every entry left out: the field is emptied rather than left showing the old text
					runs: (bib.runs.length ? bib.runs : [{ t: "" }]) as Run[],
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

	// ---- bibliography editor ---------------------------------------------------------------------------------

	/**
	 * The entries of the document's bibliography as the editor shows them: everything cited plus the uncited items of the
	 * field, in the order the style lists them, with whether each is excluded or has custom text. Null without a bibliography field.
	 */
	async bibliographyEditor(): Promise<BibEditorEntry[] | null> {
		const d = await this.formatDocument({ wantBib: true });
		if (!d.out?.bibliography || d.bibls.length === 0) return null;
		const cited = new Set(d.docCitations.flatMap((c) => c.items.map((i) => i.id)));
		return d.out.bibliography.all.map((e) => {
			const id = e.ids[0] ?? "";
			const csl = [...d.resolved.values()].find((r) => r.cslId === id)?.csl;
			const uris = [...new Set(e.ids.flatMap((i) => d.cslUris.get(i) ?? []))];
			return {
				cslId: id,
				uris: uris.length ? uris : [itemUri(this.uriBase, id)],
				title: String(csl?.title ?? "(untitled)"),
				runs: e.runs,
				defaultRuns: e.defaultRuns,
				cited: e.ids.some((i) => cited.has(i)),
				uncited: e.ids.some((i) => d.uncitedIds.has(i)) && !e.ids.some((i) => cited.has(i)),
				omitted: e.omitted,
				custom: e.custom,
			};
		});
	}

	/** Write the editor's choices into the ZOTERO_BIBL field code(s) (as Zotero stores them) and reformat. */
	async saveBibliography(changes: BibliographyChanges): Promise<RefreshReport> {
		const bibls = (await this.readFields()).filter((f) => f.parsed?.kind === "bibl");
		if (!bibls.length) throw new Error("The document has no bibliography.");
		const uris = (l: string[][]) => l.filter((u) => u.length);
		await this.host.call("doc.begin", { name: "Edit bibliography" });
		try {
			for (const b of bibls) {
				const data = { ...(b.parsed as { data: BibliographyData }).data };
				if (changes.omitted) data.omitted = uris(changes.omitted);
				if (changes.uncited) data.uncited = uris(changes.uncited);
				if (changes.custom) data.custom = changes.custom.filter((c) => c.uris.length && c.runs.length).map((c) => [c.uris, runsToRtf(c.runs)]);
				await this.host.call("doc.set", { ref: { story: b.story, idx: b.idx, kind: "bibl" }, code: buildBiblCode(data) });
			}
			return await this.refreshAll();
		} finally {
			await this.host.call("doc.end");
		}
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

/** The citation-engine form of a cited item (the CSL id plus what the cluster says about it). */
function docCitationItem(ci: CitationItem, r: Resolved): DocCitationItem {
	return {
		id: r.cslId,
		locator: ci.locator,
		label: ci.locator ? ci.label ?? "page" : undefined,
		prefix: ci.prefix,
		suffix: ci.suffix,
		"suppress-author": ci["suppress-author"],
		"author-only": ci["author-only"],
	};
}

interface DocFormat {
	fields: DocField[];
	items: (DocField & { parsed: { kind: "item"; data: CitationData } })[];
	bibls: (DocField & { parsed: { kind: "bibl"; data: BibliographyData } })[];
	st: { hasDoc: boolean; name?: string; prefs: DocPrefs | null; readOnly?: boolean };
	prefs: DocPrefs;
	styleId: string;
	missing: string[];
	resolved: Map<CitationItem, Resolved>;
	docCitations: DocCitation[];
	engineIds: string[];
	probeIds: Map<string, string>;
	/** CSL id -> the item URIs the document uses for it (citations and uncited list) */
	cslUris: Map<string, string[]>;
	/** CSL ids listed as uncited in the bibliography field(s) */
	uncitedIds: Set<string>;
	fmt: CslFormatter | null;
	out: FormatResult | null;
}

/** "(Smith et al., 2020)" -> "Smith et al., 2020"; numeric labels ("[3]", "3.", "(3)") stay as the style renders them. */
export function tidyLabel(plain: string): string {
	const t = plain.replace(/\s+/g, " ").trim();
	if (/^[[(]?\d+(?:\s*[,–—-]\s*\d+)*[\])]?\.?$/u.test(t)) return t;
	const m = /^\((.*)\)$/s.exec(t);
	return m && !m[1]!.includes("(") ? m[1]!.trim() : t;
}

export interface PopupItemView extends CitedItemView {
	/** CSL id of the item in the document's formatting pass: the key of docLabels() */
	cslId: string | null;
	/** only the embedded copy has been read so far: library status, reference and abstract are still loading */
	pending?: boolean;
	/** the item's full reference in the document's style (styled runs) */
	reference: Run[];
	/** nothing to show: not in the library and no embedded copy */
	missing: boolean;
}
export interface PopupCitation {
	citationID: string;
	items: PopupItemView[];
}

export function viewOfCitationItem(ci: CitationItem, r: Resolved | undefined): CitedItemView {
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
}

/** A bibliography entry formatted on its own carries the number of a one-item list ("1. ", "[1] "); drop it. */
export function stripNumberLabel(runs: Run[]): Run[] {
	const out = runs.map((r) => ({ ...r }));
	const first = out[0];
	if (first) {
		first.t = first.t.replace(/^\s*(?:\[\d+\]|\(\d+\)|\d{1,3}[.)])\s+/u, "");
		if (!first.t) out.shift();
	}
	return out;
}

/** Fallback reference when no style could be loaded: authors. Title. Journal Year. */
export function plainReference(v: { authors: string; title: string; journal: string; year: string }): string {
	return [v.authors, v.title, [v.journal, v.year].filter(Boolean).join(" ")].filter(Boolean).join(". ").replace(/\.\.+/g, ".") + ".";
}

/** A library row as the add-in returns it (groupId: the zotero.org group of a group-library item, else null). */
export interface LibraryHit {
	data: ZoteroItemData;
	trashed: boolean;
	itemKey: string;
	groupId: number | null;
}

export interface Resolved {
	cslId: string;
	csl: CslItem;
	key: string | null;
	inLibrary: boolean;
	trashed: boolean;
	data?: ZoteroItemData;
	replacedFrom?: string;
	groupId?: number | null;
}

export { uriToKey };
