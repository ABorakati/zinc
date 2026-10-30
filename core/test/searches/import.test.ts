import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { createSavedSearch, listSavedSearches } from "../../src/searches/store";
import { convertConditions, readZoteroSavedSearches } from "../../src/searches/zotero-import";
import { tempDir } from "../fixture";

test("converts Zotero saved search conditions", () => {
	const s = convertConditions("Recent imaging", [
		{ condition: "joinMode", operator: "any", value: "" },
		{ condition: "tag", operator: "is", value: "imaging" },
		{ condition: "title", operator: "contains", value: "kidney" },
		{ condition: "year", operator: "isGreaterThan", value: "2019" },
		{ condition: "dateAdded", operator: "isInTheLast", value: "3 months" },
		{ condition: "collection", operator: "is", value: "0_ABCD2345" },
		{ condition: "noChildren", operator: "true", value: "" },
		{ condition: "recursive", operator: "true", value: "" },
		{ condition: "savedSearch", operator: "is", value: "XXXXXXXX" }, // unsupported
		{ condition: "tag", operator: "weirdOp", value: "x" },
	]);
	expect(s.options).toEqual({ match: "any", includeParentsAndChildren: false, searchSubcollections: true, topLevelOnly: true, includeTrash: false });
	expect(s.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`)).toEqual([
		"tag is imaging",
		"title contains kidney",
		"year isAfter 2019",
		"dateAdded isInTheLast 3 months",
		"collection is 0_ABCD2345",
	]);
	expect(s.skipped.length).toBe(2);
});

test("reads saved searches from a Zotero-shaped database and imports them", () => {
	const z = new Database(":memory:");
	z.run("CREATE TABLE savedSearches (savedSearchID INTEGER PRIMARY KEY, savedSearchName TEXT)");
	z.run("CREATE TABLE savedSearchConditions (savedSearchID INT, searchConditionID INT, condition TEXT, operator TEXT, value TEXT)");
	z.run("INSERT INTO savedSearches VALUES (1, 'Zebras'), (2, 'Empty')");
	z.run("INSERT INTO savedSearchConditions VALUES (1, 1, 'title', 'contains', 'zebra'), (1, 2, 'creator', 'is', 'Lee'), (2, 1, 'libraryID', 'is', '1')");
	const found = readZoteroSavedSearches(z);
	z.close(true);
	expect(found.map((f) => f.name)).toEqual(["Empty", "Zebras"]);

	const db = openDb(join(tempDir(), "imp.sqlite"));
	for (const f of found.filter((x) => x.conditions.length)) createSavedSearch(db, { name: f.name, conditions: f.conditions, options: f.options });
	const saved = listSavedSearches(db);
	expect(saved.map((s) => s.name)).toEqual(["Zebras"]);
	expect(saved[0].conditions).toHaveLength(2);
	db.close(true);
});
