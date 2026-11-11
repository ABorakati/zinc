// Compiles search conditions into a parameterised SQL predicate over top-level items (alias `i`).
// Safety: fields and operators come from fixed whitelists, JSON paths only from the schema whitelist,
// and every user value is bound as a parameter. Params are pushed in the textual order of their `?`.

import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { canonicalField } from "../schema-data";
import raw from "../schema-data/schema.json" with { type: "json" };
import { parseQuery, sanitizeQuery } from "../search";
import {
	DEFAULT_OPTIONS,
	OPERATORS,
	QUICK_MODES,
	type Operator,
	type QuickSearchMode,
	type SearchCondition,
	type SearchDefinition,
	type SearchOptions,
} from "./types";

export interface Compiled {
	sql: string; // boolean expression over alias `i`
	params: (string | number)[];
	includeTrash: boolean;
	empty: boolean; // no usable conditions: matches nothing
}

type Kind = "text" | "creator" | "year" | "date" | "datetime" | "itemType" | "tag" | "collection" | "note" | "fileType" | "fulltext" | "any";

interface Spec {
	kind: Kind;
	field: string;
	expr?: (a: string) => string; // text / date: raw SQL expression of the value
	yearFallback?: boolean; // date: fall back to the items.year column
	col?: string; // datetime: column name
}

const TEXT_OPS: Operator[] = ["is", "isNot", "contains", "doesNotContain", "beginsWith"];
const DATE_OPS: Operator[] = ["is", "isNot", "isBefore", "isAfter", "isInTheLast"];
const OPS: Record<Kind, Operator[]> = {
	text: TEXT_OPS,
	creator: TEXT_OPS,
	year: ["is", "isNot", "isBefore", "isAfter", "contains", "beginsWith"],
	date: DATE_OPS,
	datetime: DATE_OPS,
	itemType: ["is", "isNot", "contains", "doesNotContain"],
	tag: TEXT_OPS,
	collection: ["is", "isNot"],
	note: ["contains", "doesNotContain"],
	fileType: ["is", "isNot"],
	fulltext: ["contains", "doesNotContain"],
	any: TEXT_OPS,
};

// Zotero also accepts the text operators on date fields (saved searches use "contains 2021" on a date); they match the stored text
const TEXT_ON_DATE: Operator[] = ["contains", "doesNotContain", "beginsWith"];
const allowed = (spec: Spec, op: Operator): boolean =>
	OPS[spec.kind].includes(op) || ((spec.kind === "date" || spec.kind === "datetime") && TEXT_ON_DATE.includes(op));

const MAX_CONDITIONS = 50;
const MAX_VALUE = 500;

// base field -> concrete fields mapped onto it in some item type (publicationTitle <- bookTitle, ...)
const BASE_MAP = new Map<string, string[]>();
for (const t of raw.itemTypes as { fields: { field: string; baseField?: string }[] }[]) {
	for (const f of t.fields) {
		if (!f.baseField) continue;
		const l = BASE_MAP.get(f.baseField) ?? [];
		if (!l.includes(f.field)) l.push(f.field);
		BASE_MAP.set(f.baseField, l);
	}
}

// Date-type fields: the schema's date fields (meta.fields) and every field mapped onto one (dateDecided, dateEnacted, issueDate, priorityDate ...)
const DATE_FIELDS = new Set<string>(
	Object.entries((raw.meta as { fields: Record<string, { type?: string }> }).fields)
		.filter(([, v]) => v.type === "date")
		.map(([k]) => k),
);
for (const [base, fields] of BASE_MAP) if (DATE_FIELDS.has(base)) for (const f of fields) DATE_FIELDS.add(f);

const jsonField = (a: string, f: string) => `json_extract(${a}.data, '$.${f}')`;

export function resolveField(name: string): Spec {
	// the name can come from JSON: String() of an object whose toString is not a function throws a TypeError, not a 400
	if (typeof name !== "string") throw new HttpError(400, "the search field must be a string");
	const n = name.trim();
	switch (n.toLowerCase()) {
		case "title": {
			const mapped = BASE_MAP.get("title") ?? [];
			return { kind: "text", field: "title", expr: (a) => `COALESCE(${[`NULLIF(${a}.title, '')`, ...mapped.map((f) => jsonField(a, f))].join(", ")}, NULL)` };
		}
		case "creator":
			return { kind: "creator", field: "creator" };
		case "year":
			return { kind: "year", field: "year" };
		case "date":
			return { kind: "date", field: "date", yearFallback: true, expr: (a) => jsonField(a, "date") };
		case "dateadded":
			return { kind: "datetime", field: "dateAdded", col: "date_added" };
		case "datemodified":
			return { kind: "datetime", field: "dateModified", col: "date_modified" };
		case "itemtype":
			return { kind: "itemType", field: "itemType" };
		case "tag":
			return { kind: "tag", field: "tag" };
		case "collection":
			return { kind: "collection", field: "collection" };
		case "note":
			return { kind: "note", field: "note" };
		case "attachmentfiletype":
			return { kind: "fileType", field: "attachmentFileType" };
		case "fulltextcontent":
			return { kind: "fulltext", field: "fulltextContent" };
		case "anyfield":
			return { kind: "any", field: "anyField" };
	}
	const field = canonicalField(n);
	if (!field || !/^[A-Za-z][A-Za-z0-9]*$/.test(field)) throw new HttpError(400, `unknown search field: ${n}`);
	const mapped = [field, ...(BASE_MAP.get(field) ?? [])];
	const expr = (a: string) => (mapped.length === 1 ? jsonField(a, field) : `COALESCE(${mapped.map((f) => jsonField(a, f)).join(", ")})`);
	if (/Date$/.test(field) || DATE_FIELDS.has(field)) return { kind: "date", field, yearFallback: false, expr };
	return { kind: "text", field, expr };
}

/** Operators accepted for a field (for UIs and validation). */
export function operatorsFor(field: string): Operator[] {
	return OPS[resolveField(field).kind];
}

// ---------------------------------------------------------------- validation

export function normalizeOptions(input: unknown): SearchOptions {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const bool = (k: keyof SearchOptions) => (o[k] === undefined ? (DEFAULT_OPTIONS[k] as boolean) : o[k] === true || o[k] === 1 || o[k] === "true");
	if (o.match !== undefined && o.match !== "all" && o.match !== "any") throw new HttpError(400, "options.match must be 'all' or 'any'");
	return {
		match: o.match === "any" ? "any" : "all",
		includeParentsAndChildren: bool("includeParentsAndChildren"),
		searchSubcollections: bool("searchSubcollections"),
		topLevelOnly: bool("topLevelOnly"),
		includeTrash: bool("includeTrash"),
	};
}

export function normalizeConditions(input: unknown): SearchCondition[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) throw new HttpError(400, "conditions must be an array");
	if (input.length > MAX_CONDITIONS) throw new HttpError(400, `at most ${MAX_CONDITIONS} conditions`);
	return input.map((c, idx) => {
		if (!c || typeof c !== "object") throw new HttpError(400, `condition ${idx + 1} must be an object`);
		const { field, operator, value } = c as Record<string, unknown>;
		if (typeof field !== "string" || !field.trim()) throw new HttpError(400, `condition ${idx + 1}: field is required`);
		if (typeof operator !== "string" || !(OPERATORS as readonly string[]).includes(operator)) {
			throw new HttpError(400, `condition ${idx + 1}: invalid operator ${String(operator)}`);
		}
		if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") {
			throw new HttpError(400, `condition ${idx + 1}: value must be a string`);
		}
		const v = String(value ?? "").trim();
		if (v.length > MAX_VALUE) throw new HttpError(400, `condition ${idx + 1}: value too long`);
		const spec = resolveField(field);
		if (!allowed(spec, operator as Operator)) {
			throw new HttpError(400, `condition ${idx + 1}: operator ${operator} is not valid for ${spec.field}`);
		}
		return { field: spec.field, operator: operator as Operator, value: v };
	});
}

export function normalizeSearch(input: unknown): SearchDefinition {
	const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	return { conditions: normalizeConditions(b.conditions), options: normalizeOptions(b.options) };
}

// ---------------------------------------------------------------- value helpers

const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ESC = "ESCAPE '\\'";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "2020", "2020-05", "2020-05-01", "May 2020", "1 May 2020", "May 1, 2020" -> ISO prefix (YYYY[-MM[-DD]]). */
export function parseDateValue(v: string): string {
	const s = v.trim();
	const bad = () => new HttpError(400, `invalid date: ${v}`);
	let y: number, m: number | null = null, d: number | null = null;
	let mt = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?:[T ].*)?$/.exec(s);
	if (mt) {
		y = Number(mt[1]);
		if (mt[2]) m = Number(mt[2]);
		if (mt[3]) d = Number(mt[3]);
	} else {
		const mon = (x: string) => MONTHS.indexOf(x.slice(0, 3).toLowerCase()) + 1;
		if ((mt = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) [m, d, y] = [mon(mt[1]), Number(mt[2]), Number(mt[3])];
		else if ((mt = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) [d, m, y] = [Number(mt[1]), mon(mt[2]), Number(mt[3])];
		else if ((mt = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) [m, y] = [mon(mt[1]), Number(mt[2])];
		else throw bad();
	}
	if (m !== null && (m < 1 || m > 12)) throw bad();
	if (d !== null && (d < 1 || d > 31)) throw bad();
	return m === null ? pad(y, 4) : d === null ? `${pad(y, 4)}-${pad(m)}` : `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** "<n> <unit>" -> ISO timestamp n units before `now`. */
export function parseInTheLast(v: string, now: Date): string {
	const m = /^\s*(\d{1,4})\s*(day|week|month|year)s?\s*$/i.exec(v);
	if (!m) throw new HttpError(400, `invalid period (expected e.g. "3 months"): ${v}`);
	const n = Number(m[1]);
	const t = new Date(now.getTime());
	switch (m[2].toLowerCase()) {
		case "day":
			t.setUTCDate(t.getUTCDate() - n);
			break;
		case "week":
			t.setUTCDate(t.getUTCDate() - 7 * n);
			break;
		case "month":
			t.setUTCMonth(t.getUTCMonth() - n);
			break;
		default:
			t.setUTCFullYear(t.getUTCFullYear() - n);
	}
	return t.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------- predicates

interface Ctx {
	db: Database;
	opts: SearchOptions;
	now: Date;
	ps: (string | number)[];
}

const p = (c: Ctx, v: string | number) => {
	c.ps.push(v);
	return "?";
};

function textMatch(c: Ctx, expr: string, op: Operator, v: string): string {
	if (op === "is") return `${expr} = ${p(c, v)} COLLATE NOCASE`;
	if (op === "contains") return `${expr} LIKE ${p(c, `%${likeEsc(v)}%`)} ${ESC}`;
	if (op === "beginsWith") return `${expr} LIKE ${p(c, `${likeEsc(v)}%`)} ${ESC}`;
	throw new HttpError(400, `operator ${op} is not a text operator`);
}

// Cheap substring test on the raw JSON before the expensive json_each (only when the term needs no JSON escaping).
function jsonPrefilter(c: Ctx, a: string, v: string): string {
	const token = v
		.split(/[\s,]+/)
		.filter((t) => /^[\p{L}\p{N} .\-_+&@#]+$/u.test(t))
		.sort((x, y) => y.length - x.length)[0];
	return token ? `${a}.data LIKE ${p(c, `%${likeEsc(token)}%`)} ${ESC} AND ` : "";
}

function creatorPred(c: Ctx, a: string, op: Operator, v: string): string {
	const L = "json_extract(j.value, '$.lastName')";
	const F = "json_extract(j.value, '$.firstName')";
	const N = "json_extract(j.value, '$.name')";
	const exprs = [L, F, N, `trim(COALESCE(${F}, '') || ' ' || COALESCE(${L}, ''))`];
	if (op === "is") exprs.push(`trim(COALESCE(${L}, '') || ', ' || COALESCE(${F}, ''))`);
	const pre = jsonPrefilter(c, a, v);
	const cond = exprs.map((e) => textMatch(c, e, op, v)).join(" OR ");
	return `(${pre}EXISTS (SELECT 1 FROM json_each(${a}.data, '$.creators') j WHERE ${cond}))`;
}

function yearPred(c: Ctx, a: string, op: Operator, v: string): string {
	if (op === "contains") return `CAST(${a}.year AS TEXT) LIKE ${p(c, `%${likeEsc(v)}%`)} ${ESC}`;
	if (op === "beginsWith") return `CAST(${a}.year AS TEXT) LIKE ${p(c, `${likeEsc(v)}%`)} ${ESC}`;
	if (!/^-?\d{1,5}$/.test(v)) throw new HttpError(400, `year must be a number: ${v}`);
	const sym = op === "is" ? "=" : op === "isBefore" ? "<" : ">";
	return `${a}.year ${sym} ${p(c, Number(v))}`;
}

function normDate(raw: string, yearExpr: string | null): string {
	const tail = yearExpr
		? `CAST(${yearExpr} AS TEXT)`
		: `CASE WHEN ${raw} GLOB '[0-9][0-9][0-9][0-9]' THEN ${raw} END`;
	return `CASE WHEN ${raw} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${raw}, 1, 10) WHEN ${raw} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*' THEN substr(${raw}, 1, 7) ELSE ${tail} END`;
}

// Compares at the coarser of the two precisions, so 2020 neither precedes nor follows 2020-05-01.
function dateCompare(c: Ctx, norm: string, sym: string, v: string): string {
	const len = v.length;
	return `(SELECT CASE WHEN n IS NULL THEN NULL ELSE substr(n, 1, min(length(n), ${len})) ${sym} substr(${p(c, v)}, 1, min(length(n), ${len})) END FROM (SELECT ${norm} AS n))`;
}

function datePred(c: Ctx, a: string, spec: Spec, op: Operator, v: string): string {
	const norm = spec.kind === "datetime" ? `${a}.${spec.col}` : normDate(spec.expr!(a), spec.yearFallback ? `${a}.year` : null);
	if (op === "isInTheLast") {
		const cutoff = parseInTheLast(v, c.now);
		if (spec.kind === "datetime") return `${a}.${spec.col} >= ${p(c, cutoff)}`;
		return dateCompare(c, norm, ">=", cutoff.slice(0, 10));
	}
	const sym = op === "is" ? "=" : op === "isBefore" ? "<" : ">";
	return dateCompare(c, norm, sym, parseDateValue(v));
}

function tagPred(c: Ctx, a: string, op: Operator, v: string): string {
	return `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_key = ${a}.key AND ${textMatch(c, "t.tag", op, v)})`;
}

const ANY_SKIP = "('key', 'itemType', 'parentItem', 'dateAdded', 'dateModified', 'version', 'linkMode', 'contentType', 'md5', 'mtime')";

function anyFieldPred(c: Ctx, a: string, op: Operator, v: string): string {
	const pre = jsonPrefilter(c, a, v);
	const fields = `EXISTS (SELECT 1 FROM json_each(${a}.data) j WHERE j.type = 'text' AND j.key NOT IN ${ANY_SKIP} AND ${textMatch(c, "j.value", op, v)})`;
	const creators = creatorPred(c, a, op, v);
	const tags = tagPred(c, a, op, v);
	return `(${pre}(${fields} OR ${creators} OR ${tags}))`;
}

function collectionPred(c: Ctx, a: string, v: string): string {
	const stripped = v.replace(/^\d+_/, "");
	let roots = (c.db.query("SELECT key FROM collections WHERE key = ?").all(stripped) as { key: string }[]).map((r) => r.key);
	if (roots.length === 0) {
		roots = (c.db.query("SELECT key FROM collections WHERE name = ? COLLATE NOCASE").all(v) as { key: string }[]).map((r) => r.key);
	}
	let keys = roots;
	if (c.opts.searchSubcollections && roots.length) {
		keys = (
			c.db
				.query(
					`WITH RECURSIVE d(key) AS (
						SELECT value FROM json_each(?) UNION SELECT cc.key FROM collections cc JOIN d ON cc.parent_key = d.key
					) SELECT key FROM d`,
				)
				.all(JSON.stringify(roots)) as { key: string }[]
		).map((r) => r.key);
	}
	if (keys.length === 0) return "0";
	return `EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_key = COALESCE(${a}.parent_key, ${a}.key) AND ci.collection_key IN (SELECT value FROM json_each(${p(c, JSON.stringify(keys))})))`;
}

function ftsPred(c: Ctx, column: string, v: string): string {
	const q = sanitizeQuery(v);
	if (!q) return "0";
	return `i.rowid IN (SELECT rowid FROM search WHERE search MATCH ${p(c, `{${column}} : (${q})`)})`;
}

function notePred(c: Ctx, v: string): string {
	const fts = c.opts.topLevelOnly ? "" : `${ftsPred(c, "notes", v)} OR `; // built first: params follow textual order
	const standalone = `(i.item_type = 'note' AND json_extract(i.data, '$.note') LIKE ${p(c, `%${likeEsc(v)}%`)} ${ESC})`;
	return `(${fts}${standalone})`;
}

const FILE_TYPES: Record<string, string> = {
	pdf: "at.content_type = 'application/pdf'",
	image: "at.content_type LIKE 'image/%'",
	snapshot: "at.content_type IN ('text/html', 'application/xhtml+xml')",
	audio: "at.content_type LIKE 'audio/%'",
	video: "at.content_type LIKE 'video/%'",
	epub: "at.content_type = 'application/epub+zip'",
	document:
		"(at.content_type IN ('application/msword', 'application/rtf', 'text/plain', 'application/vnd.oasis.opendocument.text') OR at.content_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%')",
};

function fileTypePred(c: Ctx, v: string): string {
	const lower = v.toLowerCase();
	let test: string;
	if (FILE_TYPES[lower]) test = FILE_TYPES[lower];
	else if (/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(v)) test = `at.content_type = ${p(c, v)} COLLATE NOCASE`;
	else throw new HttpError(400, `unknown attachment file type: ${v}`);
	const own = `(i.item_type = 'attachment' AND EXISTS (SELECT 1 FROM attachments at WHERE at.item_key = i.key AND ${test}))`;
	if (c.opts.topLevelOnly) return own;
	// `test` may hold a bound value: it appears twice, so re-bind in order.
	const trash = c.opts.includeTrash ? "" : "AND ch.deleted = 0 ";
	const test2 = FILE_TYPES[lower] ?? `at.content_type = ${p(c, v)} COLLATE NOCASE`;
	return `(${own} OR EXISTS (SELECT 1 FROM items ch JOIN attachments at ON at.item_key = ch.key WHERE ch.parent_key = i.key ${trash}AND ${test2}))`;
}

/** The positive form of an operator (isNot -> is, doesNotContain -> contains) plus whether it was negated. */
function positiveOp(op: Operator): { op: Operator; neg: boolean } {
	if (op === "isNot") return { op: "is", neg: true };
	if (op === "doesNotContain") return { op: "contains", neg: true };
	return { op, neg: false };
}

function predicate(c: Ctx, spec: Spec, op: Operator, v: string, a: string): string {
	switch (spec.kind) {
		case "text":
			return textMatch(c, spec.expr!(a), op, v);
		case "creator":
			return creatorPred(c, a, op, v);
		case "year":
			return yearPred(c, a, op, v);
		case "date":
		case "datetime":
			if (TEXT_ON_DATE.includes(op)) return textMatch(c, spec.kind === "datetime" ? `${a}.${spec.col}` : spec.expr!(a), op, v);
			return datePred(c, a, spec, op, v);
		case "itemType":
			return textMatch(c, `${a}.item_type`, op, v);
		case "tag":
			return tagPred(c, a, op, v);
		case "collection":
			return collectionPred(c, a, v);
		case "any":
			return anyFieldPred(c, a, op, v);
		case "note":
			return notePred(c, v);
		case "fileType":
			return fileTypePred(c, v);
		case "fulltext":
			return ftsPred(c, "fulltext", v);
	}
}

const FAMILY = new Set<Kind>(["note", "fileType", "fulltext"]); // already look at children themselves
const NO_LIFT = new Set<Kind>(["collection", "creator", "year", ...FAMILY]);

function conditionClause(c: Ctx, cond: SearchCondition): string {
	const spec = resolveField(cond.field);
	if (!allowed(spec, cond.operator)) throw new HttpError(400, `operator ${cond.operator} is not valid for ${spec.field}`);
	const { op, neg } = positiveOp(cond.operator);
	const own = predicate(c, spec, op, cond.value, "i");
	if (neg) return `NOT COALESCE(${own}, 0)`;
	if (c.opts.includeParentsAndChildren && !c.opts.topLevelOnly && !NO_LIFT.has(spec.kind)) {
		const trash = c.opts.includeTrash ? "" : "AND ch.deleted = 0 ";
		const child = predicate(c, spec, op, cond.value, "ch");
		return `(COALESCE(${own}, 0) OR i.key IN (SELECT ch.parent_key FROM items ch WHERE ch.parent_key IS NOT NULL AND ch.item_type <> 'annotation' ${trash}AND COALESCE(${child}, 0)))`;
	}
	return `COALESCE(${own}, 0)`;
}

export function compileSearch(db: Database, def: SearchDefinition, now: Date = new Date()): Compiled {
	const options = normalizeOptions(def.options);
	const conditions = normalizeConditions(def.conditions).filter((x) => x.value !== "");
	if (conditions.length === 0) return { sql: "0", params: [], includeTrash: options.includeTrash, empty: true };
	const c: Ctx = { db, opts: options, now, ps: [] };
	const clauses = conditions.map((x) => conditionClause(c, x));
	return {
		sql: `(${clauses.join(options.match === "any" ? " OR " : " AND ")})`,
		params: c.ps,
		includeTrash: options.includeTrash,
		empty: false,
	};
}

// ---------------------------------------------------------------- quick search

export function assertQuickMode(mode: string): QuickSearchMode {
	if (!(QUICK_MODES as readonly string[]).includes(mode)) throw new HttpError(400, `invalid qmode: ${mode}`);
	return mode as QuickSearchMode;
}

/**
 * WHERE fragment (alias `i`) for the toolbar search box. Every word must match.
 * fields: any field or tag. everything: also child notes and extracted full text (word match).
 */
export function quickSearchClause(q: string, mode: QuickSearchMode): { sql: string; params: (string | number)[] } {
	const ctx: Ctx = { db: null as unknown as Database, opts: DEFAULT_OPTIONS, now: new Date(), ps: [] };
	const parts: string[] = [];
	for (const term of q.split(/\s+/).filter(Boolean).slice(0, 16)) {
		if (mode === "titleCreatorYear") {
			const like = `%${likeEsc(term)}%`;
			parts.push(`(i.title LIKE ${p(ctx, like)} ${ESC} OR i.creators_summary LIKE ${p(ctx, like)} ${ESC} OR CAST(i.year AS TEXT) LIKE ${p(ctx, like)} ${ESC})`);
			continue;
		}
		let part = anyFieldPred(ctx, "i", "contains", term);
		if (mode === "everything" && parseQuery(term).length) {
			const m = sanitizeQuery(term).replace(/"(\*?)$/, '"*'); // prefix-match the last word
			part = `(${part} OR i.rowid IN (SELECT rowid FROM search WHERE search MATCH ${p(ctx, m)}))`;
		}
		parts.push(`COALESCE(${part}, 0)`);
	}
	return { sql: parts.length ? parts.join(" AND ") : "1", params: ctx.ps };
}
