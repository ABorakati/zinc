// Helpers for the translator-import tests: pull the embedded testCases out of a vendored Zotero translator and compare an
// expected Zotero item (what the translator produces) with an item zotero-next's own importer produced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToMultipart } from "../../src/zotero-db/zotero-date";

const TRANSLATORS = join(import.meta.dir, "..", "..", "vendor", "zotero", "translators");

export interface TranslatorCase {
	type: "import" | "web" | "search";
	input: string;
	items: Record<string, any>[] | "multiple";
}

/** The `testCases` array a translator file embeds between the BEGIN/END TEST CASES markers (plain JSON after `var testCases =`). */
export function loadTestCases(file: string): TranslatorCase[] {
	const src = readFileSync(join(TRANSLATORS, file), "utf8");
	const start = src.indexOf("/** BEGIN TEST CASES **/");
	const end = src.indexOf("/** END TEST CASES **/");
	if (start < 0 || end < 0) throw new Error(`${file}: no test cases`);
	const body = src.slice(start, end).replace("/** BEGIN TEST CASES **/", "").trim().replace(/^var testCases =\s*/, "").replace(/;\s*$/, "");
	return JSON.parse(body) as TranslatorCase[];
}

const norm = (s: unknown): string =>
	String(s ?? "")
		.normalize("NFC")
		.replace(/[‐-―−]/g, "-")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/\s+/g, " ")
		.trim();
const lc = (s: unknown) => norm(s).toLowerCase();
const sortableDate = (d: unknown) => strToMultipart(String(d ?? "")).slice(0, 10);

// Fields compared when the translator's item has them. Dates compare by their sortable form; pages ignore dash type.
const TEXT_FIELDS = [
	"title", "publicationTitle", "bookTitle", "proceedingsTitle", "volume", "issue", "pages", "publisher", "university", "institution",
	"DOI", "ISBN", "ISSN", "url", "place", "edition", "numPages", "series", "seriesNumber", "thesisType", "reportNumber", "conferenceName",
];

export interface Mismatch {
	field: string;
	expected: unknown;
	got: unknown;
}

/** Differences between the translator's item and ours, over the fields both sides can express. */
export function compareItem(expected: Record<string, any>, got: Record<string, any> | undefined): Mismatch[] {
	if (!got) return [{ field: "(item)", expected: expected.title, got: undefined }];
	const out: Mismatch[] = [];
	if (expected.itemType !== got.itemType) out.push({ field: "itemType", expected: expected.itemType, got: got.itemType });
	for (const f of TEXT_FIELDS) {
		if (expected[f] === undefined) continue;
		const a = f === "DOI" ? lc(expected[f]) : norm(expected[f]);
		const b = f === "DOI" ? lc(got[f]) : norm(got[f]);
		if (a !== b) out.push({ field: f, expected: expected[f], got: got[f] });
	}
	if (expected.date !== undefined && sortableDate(expected.date) !== sortableDate(got.date)) out.push({ field: "date", expected: expected.date, got: got.date });
	const key = (c: any) => `${c.creatorType}|${lc(c.lastName ?? c.name)}|${lc(c.firstName)}`;
	const ec: string[] = (expected.creators ?? []).map(key);
	const gc: string[] = (got.creators ?? []).map(key);
	if (ec.join("\n") !== gc.join("\n")) out.push({ field: "creators", expected: ec, got: gc });
	const et = new Set((expected.tags ?? []).map((t: any) => lc(typeof t === "string" ? t : t.tag)));
	const gt = new Set((got.tags ?? []).map((t: any) => lc(typeof t === "string" ? t : t.tag)));
	if (et.size && [...et].some((t) => !gt.has(t as string))) out.push({ field: "tags", expected: [...et], got: [...gt] });
	return out;
}
