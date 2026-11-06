// Child process that loads Zotero's own vendored utilities (core/vendor/zotero/utilities) and answers
// one JSON request per line on stdin with one JSON response per line on stdout. Used by the compat tests as an
// oracle: "what does Zotero itself return for this input?". Runs in a child so the globals the utilities
// need (globalThis.Zotero) never leak into the bun test process.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const req = createRequire(import.meta.url);
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "zotero");
const ut = (p: string) => req(join(VENDOR, "utilities", p));

const Zotero: any = ((globalThis as any).Zotero = { isNode: true, locale: "en-US", debug() {}, logError() {} });
Zotero.Date = ut("date");
Zotero.Utilities = { ...ut("utilities"), XRegExp: ut("xregexp-all"), Item: ut("utilities_item") };
ut("xregexp-unicode-zotero")(Zotero.Utilities.XRegExp);
Zotero.Schema = ut("schema.js");
Zotero.Schema.init(JSON.parse(readFileSync(join(VENDOR, "zotero-schema", "schema.json"), "utf8")));
Zotero.Date.init(ut("resource/dateFormats.json"));
const CachedTypes = ut("cachedTypes");
CachedTypes.setTypeSchema(ut("resource/zoteroTypeSchemaData"));
Object.assign(Zotero, CachedTypes);
Zotero.localeCompare = new Intl.Collator(["en-US"], { numeric: true, sensitivity: "base" }).compare;

const ops: Record<string, (...a: any[]) => unknown> = {
	strToDate: (s) => Zotero.Date.strToDate(s),
	strToMultipart: (s) => Zotero.Date.strToMultipart(s),
	strToISO: (s) => Zotero.Date.strToISO(s),
	itemToCSLJSON: (item) => Zotero.Utilities.Item.itemToCSLJSON(item),
	itemFromCSLJSON: (item, csl) => (Zotero.Utilities.Item.itemFromCSLJSON(item, csl), item),
	noteToTitle: (s, opts) => Zotero.Utilities.Item.noteToTitle(s, opts),
	cleanAuthor: (s, type, useComma) => Zotero.Utilities.cleanAuthor(s, type, useComma),
	cleanDOI: (s) => Zotero.Utilities.cleanDOI(s),
	cleanISBN: (s, dv) => Zotero.Utilities.cleanISBN(s, dv),
	cleanISSN: (s) => Zotero.Utilities.cleanISSN(s),
	toISBN13: (s) => Zotero.Utilities.toISBN13(s),
};

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
	if (!line) continue;
	const { id, op, args } = JSON.parse(line);
	let out: any;
	try {
		const v = ops[op]!(...args);
		out = { id, ok: true, value: v === undefined ? null : v };
	} catch (e: any) {
		out = { id, ok: false, error: String(e?.message ?? e) };
	}
	process.stdout.write(JSON.stringify(out) + "\n");
}
