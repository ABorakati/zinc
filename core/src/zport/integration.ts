// Word processor (citation plugin) endpoints on the Zotero port. See index.ts.
//
// This is the server half of Zotero's "HTTP integration" (zotero/zotero: xpcom/server/server_connectorIntegration.js,
// xpcom/httpIntegrationClient.js, xpcom/integration.js). It is the protocol the official Zotero Word add-in for the new Word
// (zotero/zotero-word-js-integration) and the Google Docs plugin speak. The older desktop "Word for Windows/Mac" plugins do NOT
// use it (Zotero drives Word in-process); zotero-next cannot emulate those.
//
//   POST /connector/document/execCommand   {command, docId}   -> {command, arguments}     (the first request for the client)
//   POST /connector/document/respond       <result of the previous request> -> next {command, arguments}
//
// zotero-next is the brain: it asks the client ("Application.getActiveDocument", "Document.getFields", "Field.setText", ...)
// and the client answers each request with the next HTTP call, until zotero-next sends "Document.complete".
// Only one transaction runs at a time (a second execCommand answers 503, as Zotero does).
//
// Dialogs (citation picker, bibliography editor, document preferences) are zotero-next UI, not the word processor's. They are
// described as plain JSON requests and answered by a UI client over
//   GET  /zotero-next/integration/dialogs        -> {pending: [{id, kind, payload}]}
//   POST /zotero-next/integration/dialogs/<id>   {result} (or {result: null} to cancel)
// With no UI client polling, document preferences fall back to the Quick Copy style and the other dialogs cancel with a message
// shown in the word processor. Tests (and the app, in-process) can install a UI with setIntegrationUI().
import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import { citeService } from "../cite/api";
import { itemToCsl } from "../cite/csl";
import {
	type BibliographyData,
	type CitationData,
	type CitationItem,
	type CslItem,
	type DocPrefs,
	type Run,
	CITATION_SCHEMA,
	buildPrefsXml,
	defaultPrefs,
	itemUri,
	keysOfCitationItem,
	newCitationID,
	numericId,
	parseFieldCode,
	parsePrefsXml,
	richToRuns,
	runsToHtml,
	runsToPlain,
	runsToRtf,
	styleIdToUrl,
	styleUrlToId,
} from "../cite/docfields";
import { CslFormatter, type DocCitation, type StyleSource } from "../cite/docformat";
import { registerZRoute } from "./routes";

// ---------------------------------------------------------------------------------------------------------------- protocol

// Dialog constants (must match the plugins, see integration.js)
const ICON_STOP = 0;
const ICON_WARNING = 1;
const ICON_CAUTION = 2;
const BTN_OK = 0;
const BTN_OK_CANCEL = 1;
const BTN_YES_NO = 2;

class UserCancelled extends Error {}
/** A message for the user, shown in the word processor (Zotero.Exception.Alert). */
class Alert extends Error {}

type Json = any;

/** One integration transaction: the held HTTP request of the client, and the request/answer ping-pong. */
class Transaction {
	private release: ((res: Response) => void) | null = null;
	private waiting: { resolve: (v: Json) => void; reject: (e: Error) => void } | null = null;
	/** Resolves with the response to the client's current request. */
	hold(): Promise<Response> {
		return new Promise((resolve) => (this.release = resolve));
	}
	/** Send a command to the client and wait for its answer. */
	call(command: string, args: Json[] = []): Promise<Json> {
		return new Promise((resolve, reject) => {
			this.waiting = { resolve, reject };
			this.send({ command, arguments: args });
		});
	}
	private send(body: unknown) {
		const r = this.release;
		this.release = null;
		if (!r) throw new Error("integration: no client request is waiting");
		r(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
	}
	/** The client's answer; returns the response to hold until the next command. */
	answer(data: Json): Promise<Response> {
		const w = this.waiting;
		this.waiting = null;
		const next = this.hold();
		if (data && typeof data === "object" && data.error) {
			const e = data.error === "Alert" ? new Alert(String(data.message ?? "")) : new Error(`${data.error}: ${data.message ?? ""}`);
			w?.reject(e);
		} else w?.resolve(data);
		return next;
	}
	/** Tell the client the transaction is over (no answer expected). */
	complete(docId: string) {
		if (this.release) this.send({ command: "Document.complete", arguments: [docId] });
	}
}

let current: { tx: Transaction } | null = null;

// ---------------------------------------------------------------------------------------------------------------- UI (dialogs)

export interface CitationDialog {
	isNote: boolean;
	/** the citation being edited (empty for a new one) */
	items: { key: string | null; title: string; creators: string; year: string; locator: string; label: string; prefix: string; suffix: string; suppressAuthor: boolean; authorOnly: boolean }[];
	unsorted: boolean;
	style: string;
}
export interface CitationChoice {
	/** `key`: a library item; `existing`: index into the dialog's items (an embedded item that is not in the library) */
	items: { key?: string; existing?: number; locator?: string; label?: string; prefix?: string; suffix?: string; suppressAuthor?: boolean; authorOnly?: boolean }[];
	unsorted?: boolean;
}
export interface BibliographyDialog {
	entries: { id: string; key: string | null; text: string; defaultText: string; cited: boolean; uncited: boolean; omitted: boolean; custom: boolean }[];
}
export interface BibliographyChoice {
	/** CSL ids (item keys) left out */
	omitted: string[];
	/** keys of uncited library items to list */
	uncited: string[];
	/** CSL id -> replacement text (HTML, RTF or plain) */
	custom: Record<string, string>;
}
export interface DocPrefsDialog {
	style: string;
	locale: string;
	noteType: number;
	fieldType: string;
	supportedNotes: string[];
	delayCitationUpdates: boolean;
	automaticJournalAbbreviations: boolean;
	isNew: boolean;
}
export interface DocPrefsChoice {
	style: string;
	locale?: string;
	/** 1 footnotes, 2 endnotes (used when the style is a note style) */
	noteType?: number;
	fieldType?: string;
	delayCitationUpdates?: boolean;
	automaticJournalAbbreviations?: boolean;
}

export interface IntegrationUI {
	citation(req: CitationDialog): Promise<CitationChoice | null>;
	bibliography(req: BibliographyDialog): Promise<BibliographyChoice | null>;
	docPrefs(req: DocPrefsDialog): Promise<DocPrefsChoice | null>;
}

type DialogKind = "citation" | "bibliography" | "docPrefs";
interface Pending {
	id: string;
	kind: DialogKind;
	payload: unknown;
	resolve: (v: any) => void;
}
const pending = new Map<string, Pending>();
let lastPoll = 0;
let customUI: IntegrationUI | null = null;
export const integrationOptions = {
	/** how long after the last poll of a UI client dialogs are still queued for it */
	uiPollWindowMs: 60_000,
	/** give up on an unanswered dialog (treated as cancel) */
	dialogTimeoutMs: 15 * 60_000,
};

/** Install the in-process UI (tests, or the app); null goes back to the HTTP dialog queue. */
export function setIntegrationUI(ui: IntegrationUI | null) {
	customUI = ui;
}

function ask<T>(kind: DialogKind, payload: unknown): Promise<T | null> {
	return new Promise((resolve) => {
		const id = newCitationID();
		const t = setTimeout(() => {
			pending.delete(id);
			resolve(null);
		}, integrationOptions.dialogTimeoutMs);
		pending.set(id, {
			id,
			kind,
			payload,
			resolve: (v) => {
				clearTimeout(t);
				resolve((v ?? null) as T | null);
			},
		});
	});
}
const uiAvailable = () => customUI !== null || Date.now() - lastPoll < integrationOptions.uiPollWindowMs;

const ui: IntegrationUI = {
	citation: (r) => (customUI ? customUI.citation(r) : ask("citation", r)),
	bibliography: (r) => (customUI ? customUI.bibliography(r) : ask("bibliography", r)),
	docPrefs: (r) => (customUI ? customUI.docPrefs(r) : ask("docPrefs", r)),
};

// ---------------------------------------------------------------------------------------------------------------- the document client

interface WireField {
	id: string;
	/** field code without the "ADDIN ZOTERO_" prefix: "ITEM CSL_CITATION {...}", "BIBL {...} CSL_BIBLIOGRAPHY" or "TEMP" */
	code: string;
	text: string;
	noteIndex?: number;
	noteType?: number;
	/** adjacent to the next field */
	adjacent?: boolean | string;
}

interface AppInfo {
	documentID: string;
	outputFormat: "html" | "rtf" | "text";
	supportedNotes: string[];
	supportsTextInsertion: boolean;
	supportsCitationMerging: boolean;
	processorName: string;
}

/** Typed wrapper over the requests Zotero sends to an HTTP integration client. */
class Doc {
	info!: AppInfo;
	constructor(private tx: Transaction) {}
	private c(command: string, ...args: Json[]) {
		return this.tx.call(command, args);
	}
	async open() {
		const r = await this.tx.call("Application.getActiveDocument", []);
		this.info = {
			documentID: r.documentID,
			outputFormat: r.outputFormat || "html",
			supportedNotes: r.supportedNotes || ["footnotes"],
			supportsTextInsertion: !!r.supportsTextInsertion,
			supportsCitationMerging: !!r.supportsCitationMerging,
			processorName: r.processorName || "HTTP Integration",
		};
	}
	get id() {
		return this.info.documentID;
	}
	getDocumentData(): Promise<string> {
		return this.c("Document.getDocumentData", this.id).then((s) => s ?? "");
	}
	setDocumentData(data: string) {
		return this.c("Document.setDocumentData", this.id, data);
	}
	setBibliographyStyle(firstLineIndent: number, indent: number, lineSpacing: number, entrySpacing: number, tabStops: number[]) {
		return this.c("Document.setBibliographyStyle", this.id, firstLineIndent, indent, lineSpacing, entrySpacing, tabStops, tabStops.length);
	}
	canInsertField(fieldType: string): Promise<boolean> {
		return this.c("Document.canInsertField", this.id, fieldType);
	}
	cursorInField(fieldType: string): Promise<WireField | null> {
		return this.c("Document.cursorInField", this.id, fieldType);
	}
	insertField(fieldType: string, noteType: number): Promise<WireField> {
		return this.c("Document.insertField", this.id, fieldType, noteType);
	}
	getFields(fieldType: string): Promise<WireField[]> {
		return this.c("Document.getFields", this.id, fieldType).then((r) => r ?? []);
	}
	convert(ids: string[], fieldType: string, noteTypes: number[]) {
		return this.c("Document.convert", this.id, ids, fieldType, noteTypes);
	}
	insertText(html: string) {
		return this.c("Document.insertText", this.id, html);
	}
	activate() {
		return this.c("Document.activate", this.id);
	}
	cleanup() {
		return this.c("Document.cleanup", this.id);
	}
	/** For OK_CANCEL and YES_NO a truthy result is the affirmative choice. */
	async alert(text: string, icon = ICON_WARNING, buttons = BTN_OK): Promise<number> {
		const r = await this.c("Document.displayAlert", this.id, text, icon, buttons);
		return Number(r) || 0;
	}
	setCode(f: WireField, code: string) {
		f.code = code;
		return this.c("Field.setCode", this.id, f.id, code);
	}
	setText(f: WireField, html: string) {
		return this.c("Field.setText", this.id, f.id, html, true);
	}
	del(f: WireField) {
		return this.c("Field.delete", this.id, f.id);
	}
	removeCode(f: WireField) {
		return this.c("Field.removeCode", this.id, f.id);
	}
	select(f: WireField) {
		return this.c("Field.select", this.id, f.id);
	}
}

// ---------------------------------------------------------------------------------------------------------------- library access

interface Resolved {
	cslId: string;
	csl: CslItem;
	key: string | null;
}

class Library {
	readonly uriBase: string;
	constructor(readonly db: Database) {
		let k: string | undefined;
		try {
			k = (db.query("SELECT value FROM meta WHERE name = 'library_key'").get() as { value: string } | null)?.value;
		} catch {}
		this.uriBase = `http://zotero.org/users/local/${k ?? "znlocal0"}`;
	}
	get(key: string): ZoteroItemData | null {
		const row = this.db.query("SELECT key, data, deleted FROM items WHERE key = ?").get(key) as { key: string; data: string; deleted: number } | null;
		if (!row || row.deleted) return null;
		const d = JSON.parse(row.data) as ZoteroItemData;
		d.key = row.key;
		return d;
	}
	/** Resolve a cited item: the library item named by one of its URIs, else the copy embedded in the field. */
	resolve(ci: CitationItem): Resolved | null {
		for (const k of keysOfCitationItem(ci)) {
			const d = this.get(k);
			if (d) return { cslId: k, csl: itemToCsl(d) as CslItem, key: k };
		}
		if (ci.itemData) {
			const id = hashId((ci.uris ?? [])[0] ?? JSON.stringify(ci.itemData.title ?? ci.id));
			return { cslId: id, csl: { ...ci.itemData, id }, key: null };
		}
		return null;
	}
}

function hashId(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return "emb" + h.toString(36);
}

// ---------------------------------------------------------------------------------------------------------------- session

const FIELD_PREFIX = "ADDIN ZOTERO_";
const toFull = (code: string) => FIELD_PREFIX + code.trim();
const uriList = (x: unknown): string[] => (Array.isArray(x) ? x : [x]).filter((u): u is string => typeof u === "string");

interface ParsedField {
	wire: WireField;
	index: number;
	kind: "item" | "bibl" | "other";
	cite?: CitationData;
	bibl?: BibliographyData;
	noteIndex: number;
}

/** normal: rewrite what changed; refresh: also merge adjacent citations; reset: rewrite all text (style change) */
type Mode = "normal" | "refresh" | "reset";

class Session {
	prefs!: DocPrefs;
	/** new document: no document data yet */
	isNew = false;
	private fmtCache = new Map<string, Promise<CslFormatter>>();
	lib: Library;
	styles: StyleSource;
	private store;

	constructor(readonly doc: Doc, readonly db: Database) {
		this.lib = new Library(db);
		this.store = citeService(db).store;
		this.styles = {
			styleXml: (id) => this.store.styleXml(id),
			localeXml: (lang) => this.store.locale(lang),
		};
	}

	get outputFormat() {
		return this.doc.info.outputFormat;
	}
	get fieldType() {
		return this.prefs.fieldType || "Field";
	}

	formatter(): Promise<CslFormatter> {
		const id = styleUrlToId(this.prefs.styleId);
		const k = `${id}|${this.prefs.locale}`;
		let f = this.fmtCache.get(k);
		if (!f) {
			f = CslFormatter.create(this.styles, id, this.prefs.locale || undefined);
			this.fmtCache.set(k, f);
		}
		return f;
	}

	// ---- document data

	async load() {
		const raw = await this.doc.getDocumentData();
		if (raw === "ZOTERO_TRANSFER_DOCUMENT") throw new Alert("This document was exported for transfer between word processors. Importing it is not supported by Zinc.");
		const p = parsePrefsXml(raw);
		this.isNew = !p || !p.fieldType;
		this.prefs = p ?? defaultPrefs("vancouver", "");
		if (!p) this.prefs.fieldType = "";
	}

	async save() {
		if (!this.prefs.fieldType) return; // nothing chosen yet (cancelled): leave the document data alone
		await this.doc.setDocumentData(buildPrefsXml(this.prefs));
	}

	/** Make sure the document has preferences: the preferences dialog for a new document (Session.init). */
	async init(require: boolean): Promise<void> {
		if (require) {
			const fields = await this.doc.getFields(this.prefs.fieldType || "Field");
			if (!fields.length) throw new Alert("To use this command, you must first insert a citation or bibliography.");
		}
		if (!this.prefs.fieldType) await this.setDocPrefs();
	}

	/** The document preferences dialog. Returns the previous data (null for a new document). */
	async setDocPrefs(): Promise<DocPrefs | null> {
		const old = this.isNew ? null : { ...this.prefs };
		const qc = citeService(this.db).getSettings().quickCopy;
		const req: DocPrefsDialog = {
			style: styleUrlToId(this.prefs.styleId) || qc.style,
			locale: this.prefs.locale,
			noteType: this.prefs.noteType,
			fieldType: this.prefs.fieldType || "Field",
			supportedNotes: this.doc.info.supportedNotes,
			delayCitationUpdates: this.prefs.delayCitationUpdates,
			automaticJournalAbbreviations: this.prefs.automaticJournalAbbreviations,
			isNew: this.isNew,
		};
		let choice: DocPrefsChoice | null;
		if (uiAvailable()) choice = await ui.docPrefs(req);
		else choice = this.isNew ? { style: qc.style, locale: qc.locale, noteType: 1, fieldType: "Field" } : null; // no UI: new documents get the defaults
		if (!choice || !choice.style) throw new UserCancelled("document preferences");
		const styleId = choice.style.replace(/^https?:\/\/www\.zotero\.org\/styles\//, "");
		let resolved: { xml: string };
		try {
			resolved = await this.store.resolveStyle(styleId);
		} catch {
			throw new Alert(`The citation style "${styleId}" could not be loaded.`);
		}
		const isNote = /<style\b[^>]*\bclass="note"/.test(resolved.xml);
		this.prefs = {
			...this.prefs,
			styleId: styleIdToUrl(styleId),
			locale: choice.locale ?? "",
			fieldType: choice.fieldType || this.prefs.fieldType || "Field",
			noteType: isNote ? (choice.noteType === 2 ? 2 : 1) : 0,
			delayCitationUpdates: choice.delayCitationUpdates ?? this.prefs.delayCitationUpdates,
			automaticJournalAbbreviations: choice.automaticJournalAbbreviations ?? this.prefs.automaticJournalAbbreviations,
			hasBibliography: /<bibliography[\s>]/.test(resolved.xml),
			bibliographyStyleHasBeenSet: false,
		};
		this.isNew = false;
		return old;
	}

	// ---- fields

	async readFields(): Promise<ParsedField[]> {
		const wires = await this.doc.getFields(this.fieldType);
		let noteOrdinal = 0;
		return wires.map((wire, index) => {
			const parsed = parseFieldCode(toFull(wire.code));
			const inNote = (wire.noteType ?? 0) > 0 || (wire.noteIndex ?? 0) > 0;
			if (inNote) noteOrdinal++;
			// the Word add-in reports noteType (1 footnote, 2 endnote) but no number: count note fields in document order
			const noteIndex = wire.noteIndex ?? (inNote ? noteOrdinal : 0);
			if (parsed?.kind === "item") return { wire, index, kind: "item", cite: parsed.data, noteIndex } as ParsedField;
			if (parsed?.kind === "bibl") return { wire, index, kind: "bibl", bibl: parsed.data, noteIndex } as ParsedField;
			return { wire, index, kind: "other", noteIndex } as ParsedField;
		});
	}

	/** Items, bibliography edits and formatter input for the fields (shared by update() and the bibliography editor). */
	async prepare(items: ParsedField[], bd: BibliographyData | undefined, missing: string[]) {
		const fmt = await this.formatter();
		const isNote = fmt.style.xclass === "note";
		const cslById = new Map<string, CslItem>();
		const docCitations: DocCitation[] = [];
		for (const f of items) {
			const dcItems: DocCitation["items"] = [];
			for (const ci of f.cite!.citationItems) {
				const r = this.lib.resolve(ci);
				if (!r) {
					missing.push(String(ci.itemData?.title ?? ci.uris?.[0] ?? ci.id));
					continue;
				}
				cslById.set(r.cslId, r.csl);
				dcItems.push({ id: r.cslId, locator: ci.locator, label: ci.locator ? ci.label ?? "page" : undefined, prefix: ci.prefix, suffix: ci.suffix, "suppress-author": ci["suppress-author"], "author-only": ci["author-only"] });
			}
			// the engine id is unique per field so copy-pasted citations (same citationID) stay independent
			docCitations.push({ citationID: `${f.cite!.citationID}~${f.index}`, noteIndex: isNote ? f.noteIndex || f.index + 1 : 0, items: dcItems, unsorted: !!f.cite!.properties.unsorted });
		}
		const idOf = (uris: string[]) => {
			const r = this.lib.resolve({ id: "", uris });
			if (r) cslById.set(r.cslId, r.csl);
			return r?.cslId;
		};
		const uncited = (bd?.uncited ?? []).map((u) => idOf(uriList(u))).filter((x): x is string => !!x);
		const omitted = (bd?.omitted ?? []).map((u) => idOf(uriList(u))).filter((x): x is string => !!x);
		const custom = new Map<string, Run[]>();
		for (const c of bd?.custom ?? []) {
			if (!Array.isArray(c) || typeof c[1] !== "string") continue;
			const id = idOf(uriList(c[0]));
			if (id) custom.set(id, richToRuns(c[1]));
		}
		const out = fmt.format(docCitations, cslById, uncited, true, { omitted, custom });
		return { fmt, out, docCitations, uncited };
	}

	/**
	 * Format the whole document and write back what changed (Session.updateFromDocument + updateDocument).
	 * Fields are updated last to first, like Zotero does.
	 */
	async update(mode: Mode, opts: { forceBibliography?: boolean; ignoreEdits?: boolean } = {}): Promise<{ updated: number; missing: string[] }> {
		const fields = await this.readFields();
		const items = fields.filter((f) => f.kind === "item");
		const bibls = fields.filter((f) => f.kind === "bibl");
		const missing: string[] = [];
		if (!items.length && !bibls.length) return { updated: 0, missing };
		const toDelete = new Set<number>();
		const toRemoveCode = new Set<number>();

		// empty bibliography fields are placeholders: drop their code (Zotero's ignoreEmptyBibliography)
		const liveBibls = bibls.filter((b) => {
			if (mode !== "normal" && b.wire.text.trim() === "") {
				toRemoveCode.add(b.index);
				return false;
			}
			return true;
		});

		// Merge adjacent citations (refresh only): a run of adjacent fields collapses into the field after the run, which keeps the
		// run's items after its own (Citation.mergeCitation) and drops duplicates.
		if (mode === "refresh") {
			let run: ParsedField[] = [];
			for (const f of items) {
				if (f.cite!.properties.dontUpdate) {
					for (const r of run) toDelete.delete(r.index);
					run = [];
					continue;
				}
				if (f.wire.adjacent === true || f.wire.adjacent === "true") {
					run.push(f);
					toDelete.add(f.index);
					continue;
				}
				if (run.length) {
					const seen = new Set<string>();
					const merged: CitationItem[] = [];
					for (const ci of f.cite!.citationItems.concat(...run.map((r) => r.cite!.citationItems))) {
						const k = keysOfCitationItem(ci)[0] ?? String(ci.id);
						if (seen.has(k)) continue;
						seen.add(k);
						merged.push(ci);
					}
					f.cite!.citationItems = merged;
					run = [];
				}
			}
			for (const r of run) toDelete.delete(r.index); // a trailing run has no field after it: keep it
		}
		const active = items.filter((f) => !toDelete.has(f.index));
		const { fmt, out, docCitations } = await this.prepare(active, liveBibls[0]?.bibl, missing);
		const resolved = (ci: CitationItem) => this.lib.resolve(ci);

		let updated = 0;
		for (const f of [...active].reverse()) {
			const dc = docCitations[active.indexOf(f)]!;
			const o = out.citations.get(dc.citationID);
			const data = structuredClone(f.cite!) as CitationData;
			const props = data.properties;
			// citation text edited by hand: ask, "yes" freezes it (dontUpdate)
			const edited = !!props.plainCitation && f.wire.text !== props.plainCitation && !props.dontUpdate;
			if (edited && mode !== "reset" && !opts.ignoreEdits) {
				await this.doc.select(f.wire).catch(() => {});
				const keep = await this.doc.alert(`The citation was edited since Zotero created it. Do you want to keep your changes?\n\nOriginal: ${props.plainCitation}\nModified: ${f.wire.text}`, ICON_CAUTION, BTN_YES_NO);
				if (keep) props.dontUpdate = true;
			}
			let textChanged = false;
			if (!props.dontUpdate) {
				const runs = typeof props.custom === "string" && props.custom ? richToRuns(props.custom) : o?.runs;
				if (runs) {
					const formatted = this.outputFormat === "rtf" ? runsToRtf(runs) : runsToHtml(runs);
					textChanged = mode === "reset" || formatted !== props.formattedCitation || edited;
					if (textChanged) {
						await this.doc.setText(f.wire, this.outputFormat === "rtf" ? `{\\rtf ${formatted}}` : formatted);
						props.formattedCitation = formatted;
						props.plainCitation = runsToPlain(runs);
					}
				}
			}
			props.noteIndex = dc.noteIndex;
			for (let i = 0; i < data.citationItems.length; i++) {
				const ci = data.citationItems[i]!;
				const orig = f.cite!.citationItems[i]!;
				const r = resolved(orig);
				if (!r?.key) continue;
				ci.id = typeof ci.id === "number" ? ci.id : numericId(r.key);
				ci.itemData = { ...r.csl, id: ci.id };
				const local = itemUri(this.lib.uriBase, r.key);
				if (!ci.uris.includes(local) && !keysOfCitationItem(orig).includes(r.key)) ci.uris = [...ci.uris, local];
			}
			data.schema ??= CITATION_SCHEMA;
			const code = `ITEM CSL_CITATION ${JSON.stringify(data)}`;
			if (code !== f.wire.code.trim()) {
				await this.doc.setCode(f.wire, code);
				updated++;
			} else if (textChanged) updated++;
		}

		for (const b of [...liveBibls].reverse()) {
			const bib = out.bibliography;
			const code = `BIBL ${JSON.stringify(b.bibl)} CSL_BIBLIOGRAPHY`;
			if (opts.forceBibliography || code !== b.wire.code.trim()) await this.doc.setCode(b.wire, code);
			if (!bib) {
				await this.doc.setText(b.wire, "{Bibliography}");
				continue;
			}
			// the Bibliography paragraph style is set once so the user's own changes to it survive
			if (!this.prefs.bibliographyStyleHasBeenSet) {
				const indent = bib.hanging || bib.secondFieldAlign ? 720 : 0;
				await this.doc.setBibliographyStyle(-indent, indent, 240, 240 * bib.entrySpacing, []);
				this.prefs.bibliographyStyleHasBeenSet = true;
			}
			const html = bib.all.filter((e) => !e.omitted).map((e) => `<div class="csl-entry">${runsToHtml(e.runs)}</div>`).join("");
			await this.doc.setText(b.wire, html || "{Bibliography}");
			updated++;
		}
		for (const i of [...toRemoveCode].sort((a, b) => b - a)) await this.doc.removeCode(fields[i]!.wire);
		for (const i of [...toDelete].sort((a, b) => b - a)) await this.doc.del(fields[i]!.wire);
		this.prefs.hasBibliography = fmt.style.hasBibliography && liveBibls.length > 0;
		return { updated, missing };
	}

	/** Format one citation on its own, for "automatically update citations" off (Zotero's writeDelayedCitation). */
	async writeDelayed(field: WireField, data: CitationData) {
		const fmt = await this.formatter();
		const items: DocCitation["items"] = [];
		const cslById = new Map<string, CslItem>();
		for (const ci of data.citationItems) {
			const r = this.lib.resolve(ci);
			if (!r) continue;
			cslById.set(r.cslId, r.csl);
			items.push({ id: r.cslId, locator: ci.locator, label: ci.locator ? ci.label ?? "page" : undefined, prefix: ci.prefix, suffix: ci.suffix, "suppress-author": ci["suppress-author"], "author-only": ci["author-only"] });
		}
		const out = fmt.format([{ citationID: "d", noteIndex: fmt.style.xclass === "note" ? 1 : 0, items, unsorted: !!data.properties.unsorted }], cslById, [], false);
		const runs = out.citations.get("d")?.runs ?? [{ t: "{Citation}" }];
		const formatted = this.outputFormat === "rtf" ? runsToRtf(runs) : runsToHtml(runs);
		await this.doc.setText(field, this.outputFormat === "rtf" ? `{\\rtf ${formatted}}` : formatted);
		data.properties.formattedCitation = formatted;
		data.properties.plainCitation = runsToPlain(runs);
		await this.doc.setCode(field, `ITEM CSL_CITATION ${JSON.stringify(data)}`);
	}

	// ---- citation building

	citationData(choice: CitationChoice, old: CitationData | null): CitationData {
		const items: CitationItem[] = [];
		for (const c of choice.items) {
			let ci: CitationItem | null = null;
			if (c.key) {
				const d = this.lib.get(c.key);
				if (!d) throw new Alert(`The item ${c.key} is not in the library.`);
				const nid = numericId(c.key);
				ci = { id: nid, uris: [itemUri(this.lib.uriBase, c.key)], itemData: { ...(itemToCsl(d) as CslItem), id: nid } };
			} else if (c.existing !== undefined && old?.citationItems[c.existing]) ci = structuredClone(old.citationItems[c.existing]!);
			if (!ci) continue;
			delete ci.locator;
			delete ci.label;
			delete ci.prefix;
			delete ci.suffix;
			delete ci["suppress-author"];
			delete ci["author-only"];
			if (c.locator?.trim()) {
				ci.locator = c.locator.trim();
				ci.label = c.label || "page";
			}
			if (c.prefix) ci.prefix = c.prefix;
			if (c.suffix) ci.suffix = c.suffix;
			if (c.suppressAuthor) ci["suppress-author"] = true;
			if (c.authorOnly) ci["author-only"] = true;
			items.push(ci);
		}
		// like prepareForEditing: formatted text is regenerated and dontUpdate dropped; custom text and the sort flag survive
		const props: CitationData["properties"] = { noteIndex: 0 };
		if (old?.properties.custom) props.custom = old.properties.custom;
		if (choice.unsorted ?? old?.properties.unsorted) props.unsorted = true;
		return { citationID: old?.citationID ?? newCitationID(), properties: props, citationItems: items, schema: CITATION_SCHEMA };
	}

	/** Summary of a stored citation for the dialog. */
	dialogItems(data: CitationData | null): CitationDialog["items"] {
		return (data?.citationItems ?? []).map((ci) => {
			const r = this.lib.resolve(ci);
			const csl = (r?.csl ?? ci.itemData ?? {}) as CslItem;
			const authors = ((csl.author as { family?: string; literal?: string }[] | undefined) ?? []).map((a) => a.family ?? a.literal ?? "").filter(Boolean).slice(0, 3).join(", ");
			const issued = (csl.issued as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0];
			return {
				key: r?.key ?? null,
				title: String(csl.title ?? ""),
				creators: authors,
				year: issued ? String(issued) : "",
				locator: ci.locator ?? "",
				label: ci.label ?? "page",
				prefix: ci.prefix ?? "",
				suffix: ci.suffix ?? "",
				suppressAuthor: !!ci["suppress-author"],
				authorOnly: !!ci["author-only"],
			};
		});
	}
}

// ---------------------------------------------------------------------------------------------------------------- commands

/** Note type for a new field: note styles put citations in notes, other styles in the text. */
async function newFieldNoteType(s: Session): Promise<number> {
	const fmt = await s.formatter();
	return fmt.style.xclass === "note" ? s.prefs.noteType || 1 : 0;
}

/** Add/Edit Citation (and Add Note): insert or reuse a field, ask the citation dialog, write it. */
async function cite(s: Session, field: WireField | null, opts: { note?: boolean } = {}): Promise<void> {
	const doc = s.doc;
	let isNew = false;
	let old: CitationData | null = null;
	if (field) {
		const parsed = parseFieldCode(toFull(field.code));
		if (parsed?.kind === "bibl") throw new Alert("The cursor is in a bibliography. Use Add/Edit Bibliography instead.");
		if (parsed?.kind === "item") old = parsed.data;
		else isNew = true; // a leftover TEMP placeholder
	} else {
		if (!(await doc.canInsertField(s.fieldType))) throw new Alert("Citations cannot be inserted at the current cursor position.");
		field = await doc.insertField(s.fieldType, await newFieldNoteType(s));
		await doc.setCode(field, "TEMP");
		isNew = true;
	}
	if (old && (old.properties.dontUpdate || (old.properties.plainCitation && field.text !== old.properties.plainCitation))) {
		const ok = await doc.alert(`The citation was edited since Zotero created it. Editing it will discard those changes.\n\nOriginal: ${old.properties.plainCitation ?? ""}\nModified: ${field.text}`, ICON_WARNING, BTN_OK_CANCEL);
		if (!ok) throw new UserCancelled("editing citation");
	}
	let choice: CitationChoice | null = null;
	if (uiAvailable()) choice = await ui.citation({ isNote: !!opts.note, items: s.dialogItems(old), unsorted: !!old?.properties.unsorted, style: styleUrlToId(s.prefs.styleId) });
	else await doc.alert("Zinc is not showing its citation dialog. Open Zinc and try again.", ICON_STOP, BTN_OK);
	if (!choice || !choice.items.length) {
		if (isNew) await doc.del(field).catch(() => {});
		throw new UserCancelled("inserting citation");
	}
	if (opts.note) {
		// Add Note: the chosen item is a Zotero note; its HTML replaces the field
		const key = choice.items[0]!.key;
		const html = (key ? (s.lib.get(key) as { note?: string } | null) : null)?.note;
		await doc.del(field).catch(() => {});
		if (!html) throw new Alert("Choose a Zotero note to insert.");
		const stripped = html.replace(/<span class="citation"[^>]*data-citation[^>]*>([\s\S]*?)<\/span>/g, "$1");
		await doc.insertText(/^\s*<html>/.test(stripped) ? stripped : `<html><body>${stripped}</body></html>`);
		return;
	}
	const data = s.citationData(choice, old);
	if (!data.citationItems.length) {
		if (isNew) await doc.del(field).catch(() => {});
		throw new UserCancelled("inserting citation");
	}
	if (s.prefs.delayCitationUpdates) {
		await s.writeDelayed(field, data);
		return;
	}
	await doc.setCode(field, `ITEM CSL_CITATION ${JSON.stringify(data)}`);
	await s.update("normal", { ignoreEdits: true });
}

/** The bibliography editor: exclude entries, replace entry text, list uncited items. */
async function editBibliography(s: Session, bf: ParsedField): Promise<void> {
	await s.update("normal", { ignoreEdits: true }); // make sure the document is formatted first
	const fields = await s.readFields();
	const bib = fields.find((f) => f.wire.id === bf.wire.id) ?? fields.find((f) => f.kind === "bibl")!;
	const items = fields.filter((f) => f.kind === "item");
	const { out, uncited } = await s.prepare(items, bib.bibl!, []);
	const cited = new Set<string>();
	for (const f of items) for (const ci of f.cite!.citationItems) cited.add(s.lib.resolve(ci)?.cslId ?? "");
	const entries: BibliographyDialog["entries"] = (out.bibliography?.all ?? []).map((e) => ({
		id: e.ids[0] ?? "",
		key: e.ids[0] && s.lib.get(e.ids[0]) ? e.ids[0] : null,
		text: runsToPlain(e.runs),
		defaultText: runsToPlain(e.defaultRuns),
		cited: e.ids.some((i) => cited.has(i)),
		uncited: e.ids.some((i) => uncited.includes(i)),
		omitted: e.omitted,
		custom: e.custom,
	}));
	let choice: BibliographyChoice | null = null;
	if (uiAvailable()) choice = await ui.bibliography({ entries });
	else await s.doc.alert("Zinc is not showing its bibliography editor. Open Zinc and try again.", ICON_STOP, BTN_OK);
	if (!choice) throw new UserCancelled("bibliography editing");
	const uriOf = (key: string) => (s.lib.get(key) ? [itemUri(s.lib.uriBase, key)] : null);
	const next: BibliographyData = { uncited: [], omitted: [], custom: [] };
	for (const k of choice.uncited ?? []) {
		const u = uriOf(k);
		if (u && !cited.has(k)) next.uncited.push(u);
	}
	for (const id of choice.omitted ?? []) {
		const u = uriOf(id);
		if (u) next.omitted.push(u);
	}
	for (const [id, text] of Object.entries(choice.custom ?? {})) {
		const u = uriOf(id);
		if (u && text) next.custom.push([u, runsToRtf(richToRuns(text))]);
	}
	bib.bibl = next;
	await s.doc.setCode(bib.wire, `BIBL ${JSON.stringify(next)} CSL_BIBLIOGRAPHY`);
	await s.update("normal", { forceBibliography: true, ignoreEdits: true });
}

async function addEditBibliography(s: Session, mode: { create: boolean; edit: boolean }): Promise<void> {
	const fmt = await s.formatter();
	if (!fmt.style.hasBibliography) throw new Alert("The selected citation style does not define a bibliography.");
	const existing = [...(await s.readFields())].reverse().find((f) => f.kind === "bibl");
	if (existing && mode.edit) return editBibliography(s, existing);
	if (!existing && !mode.create) throw new Alert("To edit a bibliography, you must first insert one.");
	if (!existing || mode.create) {
		if (!(await s.doc.canInsertField(s.fieldType))) throw new Alert("Citations cannot be inserted at the current cursor position.");
		const at = await s.doc.cursorInField(s.fieldType);
		if (at && !(await s.doc.alert("Replace the selected field with a bibliography?", ICON_STOP, BTN_OK_CANCEL))) throw new UserCancelled("inserting bibliography");
		const f = at ?? (await s.doc.insertField(s.fieldType, 0));
		await s.doc.setCode(f, `BIBL ${JSON.stringify({ uncited: [], omitted: [], custom: [] })} CSL_BIBLIOGRAPHY`);
	}
	s.prefs.hasBibliography = true;
	await s.update(s.prefs.delayCitationUpdates ? "reset" : "normal", { forceBibliography: true, ignoreEdits: true });
}

async function runCommand(command: string, doc: Doc, db: Database): Promise<void> {
	const s = new Session(doc, db);
	await s.load();
	try {
		await dispatch(s, command);
	} catch (e) {
		// like Zotero, a cancelled command still writes the session's document data (e.g. the style chosen for a new document)
		if (e instanceof UserCancelled) await s.save().catch(() => {});
		throw e;
	}
	await s.save();
}

async function dispatch(s: Session, command: string): Promise<void> {
	const doc = s.doc;
	switch (command) {
		case "addCitation":
			await s.init(false);
			await cite(s, null);
			break;
		case "editCitation": {
			await s.init(true);
			const f = await doc.cursorInField(s.fieldType);
			if (!f) throw new Alert("Click on a citation to edit it.");
			await cite(s, f);
			break;
		}
		case "addEditCitation":
			await s.init(false);
			await cite(s, await doc.cursorInField(s.fieldType));
			break;
		case "addNote":
			await s.init(false);
			if (!(await doc.canInsertField(s.fieldType))) throw new Alert("Citations cannot be inserted at the current cursor position.");
			await cite(s, null, { note: true });
			break;
		case "addBibliography":
			await s.init(true);
			await addEditBibliography(s, { create: true, edit: false });
			break;
		case "editBibliography":
			await s.init(true);
			await addEditBibliography(s, { create: false, edit: true });
			break;
		case "addEditBibliography":
			await s.init(true);
			await addEditBibliography(s, { create: true, edit: true });
			break;
		case "refresh":
			await s.init(true);
			await s.update("refresh", { forceBibliography: true });
			break;
		case "removeCodes": {
			await s.init(true);
			const fields = await s.readFields();
			if (await doc.alert("Are you sure you want to unlink citations? This prevents Zotero from updating citations and bibliographies in this document.", ICON_WARNING, BTN_OK_CANCEL)) {
				for (let i = fields.length - 1; i >= 0; i--) await doc.removeCode(fields[i]!.wire);
			}
			break;
		}
		case "setDocPrefs": {
			const haveFields = !s.isNew && (await doc.getFields(s.fieldType)).length > 0;
			const old = await s.setDocPrefs();
			if (!old) break;
			if (haveFields) {
				const fields = await s.readFields();
				const convert = old.noteType !== s.prefs.noteType || old.fieldType !== s.prefs.fieldType;
				if (convert) {
					const ids: string[] = [];
					const types: number[] = [];
					for (const f of fields) {
						if (f.kind === "item" && !f.cite!.properties.dontUpdate) {
							ids.push(f.wire.id);
							types.push(s.prefs.noteType);
						} else if (f.kind === "bibl" && old.fieldType !== s.prefs.fieldType) {
							ids.push(f.wire.id);
							types.push(0);
						}
					}
					if (ids.length) await doc.convert(ids, s.prefs.fieldType, types);
				}
				await s.update("reset", { forceBibliography: true, ignoreEdits: true });
			}
			break;
		}
		default:
			throw new Alert(`The command "${command}" is not supported by Zinc.`);
	}
}

async function execute(command: string, tx: Transaction, db: Database): Promise<void> {
	const doc = new Doc(tx);
	let opened = false;
	try {
		await doc.open();
		opened = true;
		await runCommand(command, doc, db);
	} catch (e) {
		if (!(e instanceof UserCancelled)) {
			const msg = e instanceof Alert ? e.message : "Zinc could not complete the command. " + (e instanceof Error ? e.message : String(e));
			if (!(e instanceof Alert)) console.error(`[zport] integration ${command} failed:`, e);
			if (opened) await doc.alert(msg, ICON_STOP, BTN_OK).catch(() => {});
		}
	} finally {
		if (opened) {
			try {
				await doc.cleanup();
				await doc.activate();
			} catch {}
		}
		tx.complete(opened ? doc.id : "");
	}
}

// ---------------------------------------------------------------------------------------------------------------- routes

async function jsonBody(req: Request): Promise<Json> {
	const text = await req.text();
	let v: Json = text;
	try {
		v = JSON.parse(text);
		if (typeof v === "string") v = JSON.parse(v); // some clients double-encode
	} catch {}
	return v;
}

registerZRoute("POST", "/connector/document/execCommand", async (req, { db }) => {
	const body = await jsonBody(req);
	if (!body || typeof body.command !== "string") return new Response("Invalid request", { status: 400 });
	if (current) return new Response("Integration transaction is already in progress", { status: 503, headers: { "Content-Type": "text/plain" } });
	const tx = new Transaction();
	current = { tx };
	const first = tx.hold();
	void execute(body.command, tx, db).finally(() => {
		current = null;
	});
	return first;
});

registerZRoute("POST", "/connector/document/respond", async (req) => {
	const body = await jsonBody(req);
	if (!current) return new Response("No integration transaction is in progress", { status: 409, headers: { "Content-Type": "text/plain" } });
	return current.tx.answer(body);
});

registerZRoute("GET", "/zotero-next/integration/dialogs", () => {
	lastPoll = Date.now();
	return Response.json({ pending: [...pending.values()].map(({ id, kind, payload }) => ({ id, kind, payload })), inProgress: !!current });
});

registerZRoute("POST", /^\/zotero-next\/integration\/dialogs\/[A-Za-z0-9]+$/, async (req, { url }) => {
	lastPoll = Date.now();
	const id = url.pathname.split("/").pop()!;
	const p = pending.get(id);
	if (!p) return Response.json({ error: "no such dialog" }, { status: 404 });
	const body = (await jsonBody(req)) as { result?: unknown } | null;
	pending.delete(id);
	p.resolve(body?.result ?? null);
	return Response.json({ ok: true });
});
