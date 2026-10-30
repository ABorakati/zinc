// Reads saved searches from a Zotero database (use a snapshot copy, never the live file)
// and converts them to zotero-next saved searches.

import type { Database } from "bun:sqlite";
import { normalizeConditions, normalizeOptions } from "./compile";
import { DEFAULT_OPTIONS, type SearchCondition, type SearchOptions } from "./types";

export interface ZoteroSavedSearch {
	name: string;
	conditions: SearchCondition[];
	options: SearchOptions;
	skipped: string[]; // conditions that could not be converted, with the reason
}

const OPERATOR_MAP: Record<string, SearchCondition["operator"]> = {
	is: "is",
	isNot: "isNot",
	contains: "contains",
	doesNotContain: "doesNotContain",
	beginsWith: "beginsWith",
	isLessThan: "isBefore",
	isGreaterThan: "isAfter",
	isBefore: "isBefore",
	isAfter: "isAfter",
	isInTheLast: "isInTheLast",
};

// Zotero condition names with no equivalent here (or that only matter to Zotero's UI).
const IGNORED = new Set(["libraryID", "tempTable", "noChildren", "includeParentsAndChildren", "includeParents", "includeChildren", "recursive", "deleted", "joinMode"]);

const truthy = (v: string) => /^(true|1)$/i.test(v.trim());

/** Pure conversion of one search's raw condition rows. */
export function convertConditions(name: string, rows: { condition: string; operator: string; value: string }[]): ZoteroSavedSearch {
	const options: SearchOptions = { ...DEFAULT_OPTIONS };
	const conditions: SearchCondition[] = [];
	const skipped: string[] = [];
	for (const r of rows) {
		const c = r.condition;
		if (c === "joinMode") options.match = r.operator === "any" ? "any" : "all";
		else if (c === "noChildren") options.topLevelOnly = truthy(r.operator) || truthy(r.value);
		else if (c === "includeParentsAndChildren" || c === "includeParents" || c === "includeChildren") options.includeParentsAndChildren = truthy(r.operator) || truthy(r.value);
		else if (c === "recursive") options.searchSubcollections = truthy(r.operator) || truthy(r.value);
		else if (c === "deleted") options.includeTrash = truthy(r.operator) || truthy(r.value);
		if (IGNORED.has(c)) continue;
		const op = OPERATOR_MAP[r.operator];
		if (!op) {
			skipped.push(`${c} ${r.operator} ${r.value}: unsupported operator`);
			continue;
		}
		// Zotero's own "any field" and quicksearch conditions
		const field = c === "anyField" || c === "quicksearch-fields" || c === "quicksearch-everything" ? "anyField" : c;
		if (c === "quicksearch-titleAndCreator") {
			conditions.push({ field: "title", operator: "contains", value: r.value }, { field: "creator", operator: "contains", value: r.value });
			options.match = "any";
			continue;
		}
		try {
			conditions.push(...normalizeConditions([{ field, operator: op, value: r.value }]));
		} catch (e) {
			skipped.push(`${c} ${r.operator} ${r.value}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { name, conditions, options: normalizeOptions(options), skipped };
}

/** Reads every saved search from a Zotero database handle. */
export function readZoteroSavedSearches(zdb: Database): ZoteroSavedSearch[] {
	const searches = zdb
		.query("SELECT savedSearchID AS id, savedSearchName AS name FROM savedSearches ORDER BY savedSearchName COLLATE NOCASE")
		.all() as { id: number; name: string }[];
	const cond = zdb.query(
		"SELECT condition, operator, value FROM savedSearchConditions WHERE savedSearchID = ? ORDER BY searchConditionID",
	);
	return searches.map((s) =>
		convertConditions(s.name, cond.all(s.id) as { condition: string; operator: string; value: string }[]),
	);
}
