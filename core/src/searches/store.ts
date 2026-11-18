// Saved search persistence (table created lazily from searches/schema.sql).

import type { Database } from "bun:sqlite";
import { generateKey, HttpError, nowIso } from "../db";
import schemaSql from "./schema.sql" with { type: "text" };
import { compileSearch, normalizeConditions, normalizeOptions } from "./compile";
import type { SavedSearch, SearchDefinition } from "./types";

const ready = new WeakSet<Database>();

/** Creates saved_searches and the search indexes on first use of a database. */
export function ensureSearchSchema(db: Database): void {
	if (ready.has(db)) return;
	db.exec(schemaSql);
	ready.add(db);
}

interface Row {
	key: string;
	name: string;
	conditions: string;
	options: string;
	date_modified: string;
}

function parse<T>(s: string, fallback: T): T {
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

function toSaved(r: Row): SavedSearch {
	return {
		key: r.key,
		name: r.name,
		conditions: normalizeConditionsSafe(parse(r.conditions, [])),
		options: normalizeOptions(parse(r.options, {})),
		dateModified: r.date_modified,
	};
}

// A stored row should always be valid, but never let one bad row break listing.
function normalizeConditionsSafe(input: unknown) {
	try {
		return normalizeConditions(input);
	} catch {
		return [];
	}
}

function cleanName(name: unknown): string {
	if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name is required");
	const n = name.trim();
	if (n.length > 200) throw new HttpError(400, "name too long");
	return n;
}

// Blank-valued conditions are dropped; at least one real condition is required; the SQL must compile.
function cleanDefinition(db: Database, conditions: unknown, options: unknown): SearchDefinition {
	const def = {
		conditions: normalizeConditions(conditions).filter((c) => c.value !== ""),
		options: normalizeOptions(options),
	};
	if (def.conditions.length === 0) throw new HttpError(400, "at least one condition with a value is required");
	compileSearch(db, def); // throws 400 on bad values
	return def;
}

export function listSavedSearches(db: Database): SavedSearch[] {
	ensureSearchSchema(db);
	return (db.query("SELECT * FROM saved_searches ORDER BY name COLLATE NOCASE, key").all() as Row[]).map(toSaved);
}

export function getSavedSearch(db: Database, key: string): SavedSearch | null {
	ensureSearchSchema(db);
	const r = db.query("SELECT * FROM saved_searches WHERE key = ?").get(key) as Row | null;
	return r ? toSaved(r) : null;
}

export function createSavedSearch(
	db: Database,
	input: { name?: unknown; conditions?: unknown; options?: unknown; key?: unknown },
): SavedSearch {
	ensureSearchSchema(db);
	const name = cleanName(input.name);
	const def = cleanDefinition(db, input.conditions, input.options);
	let key = generateKey();
	if (input.key !== undefined && input.key !== null) {
		if (typeof input.key !== "string" || !/^[A-Za-z0-9]{8}$/.test(input.key)) throw new HttpError(400, "key must be 8 letters or digits");
		if (db.query("SELECT 1 FROM saved_searches WHERE key = ?").get(input.key)) throw new HttpError(409, `saved search key already used: ${input.key}`);
		key = input.key;
	}
	while (db.query("SELECT 1 FROM saved_searches WHERE key = ?").get(key)) key = generateKey();
	db.query("INSERT INTO saved_searches(key, name, conditions, options, date_modified) VALUES(?, ?, ?, ?, ?)").run(
		key,
		name,
		JSON.stringify(def.conditions),
		JSON.stringify(def.options),
		nowIso(),
	);
	return getSavedSearch(db, key)!;
}

export function updateSavedSearch(
	db: Database,
	key: string,
	patch: { name?: unknown; conditions?: unknown; options?: unknown },
): SavedSearch {
	const cur = getSavedSearch(db, key);
	if (!cur) throw new HttpError(404, "saved search not found");
	const name = patch.name !== undefined ? cleanName(patch.name) : cur.name;
	const def =
		patch.conditions !== undefined || patch.options !== undefined
			? cleanDefinition(db, patch.conditions ?? cur.conditions, patch.options ?? cur.options)
			: { conditions: cur.conditions, options: cur.options };
	db.query("UPDATE saved_searches SET name = ?, conditions = ?, options = ?, date_modified = ? WHERE key = ?").run(
		name,
		JSON.stringify(def.conditions),
		JSON.stringify(def.options),
		nowIso(),
		key,
	);
	return getSavedSearch(db, key)!;
}

export function deleteSavedSearch(db: Database, key: string): void {
	ensureSearchSchema(db);
	if (!getSavedSearch(db, key)) throw new HttpError(404, "saved search not found");
	db.query("DELETE FROM saved_searches WHERE key = ?").run(key);
}
