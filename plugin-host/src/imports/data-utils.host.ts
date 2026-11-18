// `data-utils` (library.wit): pure helpers that must agree with Zinc. No permission, no core call (see data/utils.ts).
import { defineHandler, witError } from "./registry";
import { parseJson } from "./data/core";
import { displayDate, displayTitle, extractIdentifiers, firstCreator, itemFromCsl, itemToCsl, noteToTitle, parseDate, parseExtra, sortTitle, toIsoDate } from "./data/utils";

function obj(text: string, what: string): Record<string, any> {
	const v = parseJson(text, what);
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw witError("invalid-argument", `${what} must be a JSON object`);
	return v;
}

export default defineHandler({
	interface: "zinc:plugin/data-utils",
	where: "host",
	functions: {
		"parse-date"(_ctx, text: string) {
			return parseDate(text);
		},
		"to-iso-date"(_ctx, text: string) {
			return toIsoDate(text);
		},
		"display-date"(_ctx, text: string) {
			return displayDate(text);
		},
		"item-to-csl-json"(_ctx, item: string) {
			return JSON.stringify(itemToCsl(obj(item, "item")));
		},
		"item-from-csl-json"(_ctx, csl: string) {
			return JSON.stringify(itemFromCsl(obj(csl, "csl")));
		},
		"note-to-title"(_ctx, html: string) {
			return noteToTitle(html);
		},
		"display-title"(_ctx, item: string) {
			return displayTitle(obj(item, "item"));
		},
		"first-creator"(_ctx, item: string) {
			return firstCreator(obj(item, "item"));
		},
		"sort-title"(_ctx, title: string) {
			return sortTitle(title);
		},
		"parse-extra"(_ctx, extra: string) {
			return parseExtra(extra);
		},
		"extract-identifiers"(_ctx, text: string) {
			return extractIdentifiers(text);
		},
	},
});
