// The agent API: the tools an AI agent uses (through the add-in's MCP server) to manage citations in the document open in
// Word. No DOM and no UI: every tool is a thin function over App (app.ts), so fields stay real Zotero fields and a
// citation made here is indistinguishable from one made in the sidebar. The tool names, descriptions and input schemas
// live in addin/McpTools.json, which the C# MCP server serves and this module validates against.
import spec from "../../addin/McpTools.json";
import { App, type CitedItemView, type Pick, type RefreshReport, type DocField, viewOfCitationItem } from "./app";
import type { Host } from "./host";
import { newCitationID, styleUrlToId, type CitationData, type DocPrefs } from "./fields";

export interface ToolDef {
	name: string;
	title?: string;
	description: string;
	inputSchema: JsonSchema;
	annotations?: { readOnlyHint?: boolean };
}
export interface JsonSchema {
	type?: string;
	description?: string;
	enum?: unknown[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	oneOf?: JsonSchema[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	pattern?: string;
	additionalProperties?: boolean;
}

export const TOOL_DEFS: ToolDef[] = (spec as unknown as { tools: ToolDef[] }).tools;

// ---------------------------------------------------------------- argument validation (the JSON-schema subset the tools use)

function typeOk(type: string | undefined, v: unknown): boolean {
	switch (type) {
		case undefined:
			return true;
		case "string":
			return typeof v === "string";
		case "integer":
			return typeof v === "number" && Number.isInteger(v);
		case "number":
			return typeof v === "number" && Number.isFinite(v);
		case "boolean":
			return typeof v === "boolean";
		case "array":
			return Array.isArray(v);
		case "object":
			return typeof v === "object" && v !== null && !Array.isArray(v);
		default:
			return true;
	}
}

/** Problems found in `v` against `schema`, as readable lines ("items[1].key: must match ..."). */
export function validate(schema: JsonSchema, v: unknown, path = "arguments"): string[] {
	if (schema.oneOf) {
		const tries = schema.oneOf.map((s) => validate(s, v, path));
		if (tries.some((t) => t.length === 0)) return [];
		return [`${path}: ${tries.map((t) => t[0]).join(" / or ")}`];
	}
	if (!typeOk(schema.type, v)) return [`${path}: must be ${schema.type === "integer" ? "an integer" : "a " + schema.type}`];
	const out: string[] = [];
	if (schema.enum && !schema.enum.includes(v))
		out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
	if (typeof v === "string") {
		if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${path}: must not be empty`);
		if (schema.maxLength !== undefined && v.length > schema.maxLength) out.push(`${path}: at most ${schema.maxLength} characters`);
		if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${path}: must match ${schema.pattern}`);
	}
	if (typeof v === "number") {
		if (schema.minimum !== undefined && v < schema.minimum) out.push(`${path}: must be at least ${schema.minimum}`);
		if (schema.maximum !== undefined && v > schema.maximum) out.push(`${path}: must be at most ${schema.maximum}`);
	}
	if (Array.isArray(v)) {
		if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`);
		if (schema.items) v.forEach((x, i) => out.push(...validate(schema.items!, x, `${path}[${i}]`)));
	}
	if (typeof v === "object" && v !== null && !Array.isArray(v)) {
		const o = v as Record<string, unknown>;
		for (const r of schema.required ?? []) if (o[r] === undefined || o[r] === null) out.push(`${path}.${r}: required`);
		for (const [k, val] of Object.entries(o)) {
			const sub = schema.properties?.[k];
			if (!sub) {
				if (schema.additionalProperties === false) out.push(`${path}.${k}: unknown argument`);
				continue;
			}
			if (val === undefined || val === null) continue;
			out.push(...validate(sub, val, `${path}.${k}`));
		}
	}
	return out;
}

// ---------------------------------------------------------------- shapes returned to the agent

export interface CitationItemOut {
	key: string | null;
	title: string;
	authors: string;
	year: string;
	locator: string;
	label: string;
	prefix: string;
	suffix: string;
	suppressAuthor: boolean;
	inLibrary: boolean;
}
export interface CitationOut {
	index: number;
	fieldId: string | null;
	story: "main" | "fn" | "en";
	/** the citation as rendered in the document */
	text: string;
	items: CitationItemOut[];
	/** the field code could not be read (damaged); only index and text are known */
	unreadable?: boolean;
}

type Position = "cursor" | "end" | { afterText: string; occurrence?: number };
interface ItemArg {
	key: string;
	locator?: string;
	label?: string;
	prefix?: string;
	suffix?: string;
	suppressAuthor?: boolean;
}

const noteName = (n: number) => (n === 1 ? "footnotes" : n === 2 ? "endnotes" : "inline");

function reportOut(r: RefreshReport) {
	return {
		citations: r.citations,
		updated: r.updated,
		bibliographies: r.bibliographies,
		style: r.style,
		missingItems: r.missing,
		keptHandEdited: r.kept ?? 0,
	};
}

// ---------------------------------------------------------------- the agent

export class Agent {
	readonly app: App;
	private chain: Promise<unknown> = Promise.resolve();
	private tools = new Map(TOOL_DEFS.map((t) => [t.name, t]));

	constructor(readonly host: Host) {
		this.app = new App(host);
	}

	/** Name, description and schema of every tool (what tools/list serves). */
	listTools(): ToolDef[] {
		return TOOL_DEFS;
	}

	/**
	 * Run one tool. Calls are queued one after another (two agents must not interleave edits of one document). A tool that
	 * changes the document runs inside one Word undo record named "Zinc: <tool>".
	 */
	call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
		const def = this.tools.get(name);
		if (!def) return Promise.reject(new Error(`Unknown tool: ${name}`));
		const problems = validate(def.inputSchema, args ?? {});
		if (problems.length) return Promise.reject(new Error(`Invalid arguments for ${name}: ${problems.join("; ")}`));
		const run = this.chain.then(() => this.run(def, args ?? {}));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async run(def: ToolDef, args: Record<string, unknown>): Promise<unknown> {
		const name = def.name;
		if (!this.app.info) await this.app.init(true);
		const handler = HANDLERS[name];
		if (!handler) throw new Error(`Tool not implemented: ${name}`);
		if (name === "list_documents" || name === "search_library" || name === "search_styles") return handler(this, args);
		// aim every doc.* call of this tool at the requested document (or the active one)
		await this.host.call("doc.target", { document: (args.document as string | undefined) ?? null });
		const st = await this.app.docState();
		if (!st.hasDoc) throw new Error("No document is open in Word.");
		const writes = def.annotations?.readOnlyHint === false;
		if (!writes) return handler(this, args);
		if (st.readOnly) throw new Error(`The document ${st.name ?? ""} is read-only.`);
		await this.host.call("doc.begin", { name: "Zinc: " + name });
		try {
			return await handler(this, args);
		} finally {
			await this.host.call("doc.end");
		}
	}

	// ---- helpers used by the handlers ---------------------------------------------------------------------------

	/** Citations in document order, with the items resolved against the library. */
	async citations(): Promise<{ list: CitationOut[]; fields: DocField[]; all: DocField[] }> {
		const all = await this.app.readFields();
		const items = all.filter((f) => f.kind === "item");
		const cited = items.flatMap((f) => (f.parsed?.kind === "item" ? f.parsed.data.citationItems : []));
		const res = await this.app.resolveAll(cited);
		const list = items.map((f, i): CitationOut => {
			const story = f.story;
			if (f.parsed?.kind !== "item") return { index: i + 1, fieldId: null, story, text: f.text, items: [], unreadable: true };
			const d = f.parsed.data;
			return {
				index: i + 1,
				fieldId: d.citationID,
				story,
				text: f.text,
				items: d.citationItems.map((ci) => itemOut(viewOfCitationItem(ci, res.get(ci)), ci["suppress-author"] === true, ci.label)),
			};
		});
		return { list, fields: items, all };
	}

	async findCitation(args: { index?: number; fieldId?: string }): Promise<{ out: CitationOut; field: DocField }> {
		if (args.index === undefined && !args.fieldId) throw new Error("Give 'index' (1-based, from list_citations) or 'fieldId'.");
		const { list, fields } = await this.citations();
		let i = -1;
		if (args.fieldId) {
			i = list.findIndex((c) => c.fieldId === args.fieldId);
			if (i < 0) throw new Error(`No citation with fieldId ${args.fieldId}. Call list_citations for the current ones.`);
		} else {
			i = args.index! - 1;
			if (i < 0 || i >= list.length) throw new Error(`There is no citation number ${args.index}: the document has ${list.length}.`);
		}
		const field = fields[i]!;
		if (field.parsed?.kind !== "item") throw new Error(`Citation ${i + 1} has a damaged field code and cannot be edited by this tool.`);
		return { out: list[i]!, field };
	}

	/** Library items -> tray picks with the per-item options applied. */
	async picks(items: ItemArg[]): Promise<Pick[]> {
		const picks: Pick[] = [];
		for (const it of items) {
			const p = await this.app.pickFromKey(it.key);
			if (!p) throw new Error(`Item ${it.key} is not in the library. Use search_library to find the key.`);
			if (it.locator?.trim()) {
				p.locator = it.locator.trim();
				p.label = it.label ?? "page";
			}
			if (it.prefix) p.prefix = it.prefix;
			if (it.suffix) p.suffix = it.suffix;
			if (it.suppressAuthor) p.suppressAuthor = true;
			picks.push(p);
		}
		return picks;
	}

	/** A document position for the host's insert (undefined = at the cursor). */
	async resolvePosition(position: Position | undefined, dflt: "cursor" | "end"): Promise<number | undefined> {
		const pos = position ?? dflt;
		if (pos === "cursor") return undefined;
		if (pos === "end") return (await this.host.call<{ pos: number }>("doc.locate", { end: true })).pos;
		return (await this.host.call<{ pos: number }>("doc.locate", { afterText: pos.afterText, occurrence: pos.occurrence ?? 1 })).pos;
	}

	async prefsOut(): Promise<Record<string, unknown>> {
		const st = await this.app.docState();
		const d = this.app.defaults;
		const p: DocPrefs | null = st.prefs;
		if (!p)
			return {
				document: st.name,
				configured: false,
				styleId: d.style,
				locale: d.locale,
				citationPlacement: "inline",
				automaticUpdates: true,
				hasBibliography: false,
			};
		return {
			document: st.name,
			configured: true,
			styleId: styleUrlToId(p.styleId),
			styleUrl: p.styleId,
			locale: p.locale,
			citationPlacement: noteName(p.noteType),
			automaticUpdates: !p.delayCitationUpdates,
			hasBibliography: p.hasBibliography,
			fieldType: p.fieldType,
		};
	}
}

function itemOut(v: CitedItemView, suppressAuthor: boolean, label: string | undefined): CitationItemOut {
	return {
		key: v.key,
		title: v.title,
		authors: v.authors,
		year: v.year,
		locator: v.locator,
		label: v.locator ? (label ?? "page") : "",
		prefix: v.prefix,
		suffix: v.suffix,
		suppressAuthor,
		inLibrary: v.inLibrary,
	};
}

// ---------------------------------------------------------------- tool handlers

type Handler = (a: Agent, args: any) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
	async list_documents(a) {
		const docs = await a.host.call<{ name: string; path: string; active: boolean; saved: boolean; readOnly: boolean }[]>("doc.list");
		return { documents: docs };
	},

	async search_library(a, args: { query: string; limit?: number }) {
		const rows = await a.app.search(args.query, args.limit ?? 10);
		return {
			count: rows.length,
			items: rows.map((r) => ({
				key: r.key,
				title: r.title,
				creators: r.creators,
				year: r.year,
				publication: r.publication,
				itemType: r.itemType,
				doi: r.doi,
			})),
		};
	},

	async search_styles(a, args: { query: string; limit?: number }) {
		const rows = await a.host.call<{ id: string; title: string; format?: string | null; dependent?: boolean; installed?: boolean }[]>(
			"style.search",
			{ q: args.query, limit: args.limit ?? 15 },
		);
		return { styles: rows.map((s) => ({ id: s.id, title: s.title, format: s.format ?? null, installed: !!s.installed })) };
	},

	async list_citations(a) {
		const st = await a.app.docState();
		const { list, all } = await a.citations();
		const bib = all.find((f) => f.kind === "bibl");
		return {
			document: st.name,
			style: st.prefs ? styleUrlToId(st.prefs.styleId) : null,
			citationPlacement: st.prefs ? noteName(st.prefs.noteType) : "inline",
			count: list.length,
			citations: list,
			bibliography: { present: !!bib, text: bib ? bib.text.slice(0, 400) : undefined },
		};
	},

	async insert_citation(a, args: { items: ItemArg[]; position?: Position }) {
		const picks = await a.picks(args.items);
		const at = await a.resolvePosition(args.position, "cursor");
		const id = newCitationID();
		const report = await a.app.insertCitation(picks, { at, citationID: id });
		const { list } = await a.citations();
		const mine = list.find((c) => c.fieldId === id);
		return { inserted: mine ?? null, report: reportOut(report) };
	},

	async edit_citation(a, args: { index?: number; fieldId?: string; items: ItemArg[] }) {
		const { field } = await a.findCitation(args);
		const cid = (field.parsed as { data: CitationData }).data.citationID;
		const picks = await a.picks(args.items);
		const report = await a.app.updateCitation({ story: field.story, idx: field.idx }, cid, picks);
		const { list } = await a.citations();
		return { edited: list.find((c) => c.fieldId === cid) ?? null, report: reportOut(report) };
	},

	async delete_citation(a, args: { index?: number; fieldId?: string }) {
		const { out, field } = await a.findCitation(args);
		const report = await a.app.deleteCitation({ story: field.story, idx: field.idx }, out.fieldId!);
		return { deleted: out, remaining: (await a.citations()).list.length, report: reportOut(report) };
	},

	async insert_bibliography(a, args: { position?: Position }) {
		const had = (await a.app.readFields()).some((f) => f.kind === "bibl");
		const at = had ? undefined : await a.resolvePosition(args.position, "end");
		const report = await a.app.insertBibliography({ at });
		const bib = (await a.app.readFields()).find((f) => f.kind === "bibl");
		return {
			created: !had,
			bibliography: bib ? { text: bib.text.slice(0, 2000), entries: bib.text.split(/\r|\n/).filter((l) => l.trim()).length } : null,
			report: reportOut(report),
		};
	},

	async get_document_prefs(a) {
		return a.prefsOut();
	},

	async set_style(a, args: { styleId: string; locale?: string }) {
		const id = styleUrlToId(args.styleId.trim());
		const cur = (await a.app.docState()).prefs;
		const locale = args.locale ?? cur?.locale ?? a.app.defaults.locale;
		const report = await a.app.setStyle(id, locale);
		return { prefs: await a.prefsOut(), report: reportOut(report) };
	},

	async set_document_prefs(a, args: { noteType?: "footnotes" | "endnotes"; automaticUpdates?: boolean }) {
		if (args.noteType === undefined && args.automaticUpdates === undefined)
			throw new Error("Give 'noteType' and/or 'automaticUpdates'.");
		let note: { applied: boolean; reason?: string; report?: ReturnType<typeof reportOut> } | undefined;
		if (args.noteType !== undefined) {
			const r = await a.app.setNoteType(args.noteType === "endnotes" ? 2 : 1);
			note = r
				? { applied: true, report: reportOut(r) }
				: { applied: false, reason: "The document's style is an in-text style; footnotes/endnotes only apply to note styles." };
		}
		if (args.automaticUpdates !== undefined) await a.app.setAutoUpdate(args.automaticUpdates);
		return { prefs: await a.prefsOut(), noteType: note };
	},

	async refresh(a, args: { mergeAdjacent?: boolean; overwriteEditedText?: boolean }) {
		const r = await a.app.refreshAll({
			merge: args.mergeAdjacent === true,
			onModified: args.overwriteEditedText === true ? "overwrite" : "keep",
		});
		return reportOut(r);
	},
};

export const HANDLER_NAMES = Object.keys(HANDLERS);
