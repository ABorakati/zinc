// `schema` (library.wit): item types, fields and creator types from core's GET /api/schema (no permission: it is public metadata).
import { defineHandler } from "./registry";
import { coreJson } from "./data/core";

// Core's schema has no is-* flags (needs core); these are Zotero's.
const DATE_FIELDS = new Set(["date", "accessDate", "dateAdded", "dateModified", "filingDate", "issueDate", "dateEnacted", "dateDecided", "originalDate"]);
const LONG_FIELDS = new Set(["abstractNote", "extra"]);
const MULTILINE_FIELDS = new Set(["abstractNote", "extra"]);

let cache: { at: number; value: unknown } | undefined;

export default defineHandler({
	interface: "zinc:plugin/schema",
	where: "host",
	functions: {
		async "get-schema"(ctx) {
			if (cache && Date.now() - cache.at < 60_000) return cache.value;
			const s = await coreJson<{
				version: number;
				itemTypes: { itemType: string; label: string; fields: { field: string; label: string; baseField?: string }[]; creatorTypes: { creatorType: string; label: string; primary: boolean }[] }[];
			}>(ctx, "/api/schema");
			const value = {
				version: s.version,
				itemTypes: s.itemTypes.map((t) => ({
					name: t.itemType,
					label: t.label,
					fields: t.fields.map((f) => ({
						name: f.field,
						label: f.label,
						baseField: f.baseField,
						isDate: DATE_FIELDS.has(f.field) || DATE_FIELDS.has(f.baseField ?? ""),
						isLong: LONG_FIELDS.has(f.field),
						isMultiline: MULTILINE_FIELDS.has(f.field),
					})),
					creatorTypes: t.creatorTypes.map((c) => ({ name: c.creatorType, label: c.label, primary: c.primary })),
				})),
			};
			cache = { at: Date.now(), value };
			return value;
		},
	},
});
