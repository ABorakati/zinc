// Fuzz: small pure functions fed untrusted data: the venue rule (core/src/venue.ts) and the saved-search SQL compiler
// (core/src/searches/compile.ts: SQL only from the whitelist, values only as bound parameters).
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HttpError, openDb } from "../../src/db";
import { compileSearch, normalizeSearch, operatorsFor, quickSearchClause, assertQuickMode, parseDateValue, parseInTheLast, resolveField } from "../../src/searches/compile";
import { OPERATORS, QUICK_MODES } from "../../src/searches/types";
import { preprintServer, venueOf, VENUE_FIELDS } from "../../src/venue";
import { tempDir } from "../fixture";
import { describeError, fc, fuzz, messyText } from "./harness";

const junk = fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<unknown>;
const text = fc.oneof(fc.string({ unit: "grapheme", maxLength: 30 }), messyText(60));

// ---------------------------------------------------------------- venue

const SERVER_NAMES = ["arXiv", "medRxiv", "bioRxiv", "SSRN", "Research Square", "ChemRxiv", "TechRxiv", "Preprints.org", "Authorea", "PsyArXiv", "SocArXiv", "OSF Preprints", "Qeios", "SciELO Preprints", "Zenodo"];
const venueData = fc.dictionary(
	fc.oneof(fc.constantFrom(...VENUE_FIELDS, "repository", "url", "DOI", "archiveID", "itemType", "title"), fc.string({ maxLength: 6 })),
	fc.oneof(text, junk, fc.constantFrom("https://arxiv.org/abs/1706.03762", "https://evil.com/arxiv.org", "10.48550/arXiv.1706.03762", "arXiv:1706.03762", "https://www.medrxiv.org/content/x", "  ", "")),
	{ maxKeys: 8 },
);
describe("venue", () => {
	fuzz("venueOf and preprintServer are total, and return trimmed non-empty text or null", [venueData, fc.option(text, { nil: undefined })], (d, t) => {
		const v = venueOf(d, t);
		if (v !== null) {
			expect(typeof v).toBe("string");
			expect(v).toBe(v.trim());
			expect(v.length).toBeGreaterThan(0);
		}
		const p = preprintServer(d);
		if (p !== null) expect(SERVER_NAMES).toContain(p);
	}, { normal: 400 });
	fuzz("a non-preprint's venue is its first non-empty container field", [fc.dictionary(fc.constantFrom(...VENUE_FIELDS), fc.oneof(text, fc.constant("  "), fc.constant("")), { maxKeys: 6 })], (d) => {
		const want = VENUE_FIELDS.map((f) => (typeof d[f] === "string" ? (d[f] as string).trim() : "")).find(Boolean) ?? null;
		expect(venueOf({ ...d, itemType: "journalArticle" })).toBe(want);
	});
	fuzz("a look-alike host never names a preprint server", [fc.constantFrom("arxiv.org", "medrxiv.org", "biorxiv.org", "ssrn.com", "zenodo.org", "osf.io"), fc.constantFrom("evil", "x-", "-", "my"), fc.constantFrom(".evil.com", ".example", ".org.evil.org")], (host, pre, post) => {
		for (const url of [`https://${pre}${host}/a`, `https://${host}${post}/a`, `https://example.org/${host}/a`, `https://example.org/?u=${host}`, `https://${host}@evil.example/a`]) {
			expect(preprintServer({ url })).toBeNull();
		}
	});
});

// ---------------------------------------------------------------- saved-search SQL

const dbs: Database[] = [];
const db = openDb(join(tempDir(), "lib.sqlite"));
dbs.push(db);
db.query("INSERT INTO items(key, item_type, title, data, date_added, date_modified) VALUES('AAAAAAA1', 'journalArticle', 'T', ?, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')").run(JSON.stringify({ key: "AAAAAAA1", itemType: "journalArticle", title: "T", date: "2020" }));
afterAll(() => {
	for (const d of dbs) d.close(true);
});

const MARK = "ZQXJmark";
const FIELDS = ["title", "creator", "year", "date", "dateAdded", "dateModified", "itemType", "tag", "collection", "note", "attachmentFileType", "fulltextContent", "anyField", "DOI", "publicationTitle", "abstractNote", "extra", "url", "ISBN"];
const field = fc.oneof(
	{ weight: 6, arbitrary: fc.constantFrom(...FIELDS) },
	{ weight: 2, arbitrary: fc.constantFrom(...FIELDS).chain((f) => fc.constantFrom(`${f}') OR 1=1 --`, `${f}'; DROP TABLE items;--`, `${f} ${MARK}`, `$.${f}`, `${f}.${MARK}`, `'${f}'`, `${f}\0`, `${f}\n`)) },
	{ weight: 1, arbitrary: text },
	{ weight: 1, arbitrary: junk },
);
const value = fc.oneof(
	{ weight: 3, arbitrary: text.map((s) => `${MARK}${s}`) },
	{ weight: 2, arbitrary: fc.constantFrom(`${MARK}'; DROP TABLE items; --`, `${MARK}" OR ""="`, `${MARK}%_\\`, `${MARK}') UNION SELECT 1 --`, "2020", "2020-01-01", "3 days", "-5 weeks", "99999999999 years", "", "  ", "today", "pdf", "COLLAAA1") },
	{ weight: 1, arbitrary: junk },
);
const condition = fc.record({ field, operator: fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...OPERATORS) }, { weight: 1, arbitrary: text }, { weight: 1, arbitrary: junk }), value, required: fc.option(fc.oneof(fc.boolean(), junk), { nil: undefined }) }, { requiredKeys: ["field", "operator", "value"] });
const definition = fc.record(
	{
		name: fc.oneof(text, junk),
		conditions: fc.oneof({ weight: 8, arbitrary: fc.array(condition, { maxLength: 6 }) }, { weight: 1, arbitrary: junk }),
		options: fc.oneof(fc.record({ match: fc.constantFrom("all", "any"), includeParentsAndChildren: fc.boolean(), searchSubcollections: fc.boolean(), topLevelOnly: fc.boolean(), includeTrash: fc.boolean() }, { requiredKeys: [] }), junk),
	},
	{ requiredKeys: [] },
);

const TABLES = ["items", "collections", "item_tags", "fulltext"];
const counts = () => JSON.stringify(TABLES.map((t) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n));

describe("saved-search compiler", () => {
	fuzz("random conditions give parameterised SQL from the whitelist, or an HttpError", [definition], (input) => {
		const before = counts();
		let def;
		try {
			def = normalizeSearch(JSON.parse(JSON.stringify(input)));
		} catch (e) {
			if (!(e instanceof HttpError)) throw new Error(`normalizeSearch threw ${describeError(e)}`, { cause: e });
			return;
		}
		let c;
		try {
			c = compileSearch(db, def);
		} catch (e) {
			if (!(e instanceof HttpError)) throw new Error(`compileSearch threw ${describeError(e)} for ${JSON.stringify(def)}`, { cause: e });
			return;
		}
		// no user text in the SQL: every value is a bound parameter, every field/operator a whitelist entry
		expect(c.sql.includes(MARK)).toBe(false);
		expect(c.sql.includes("DROP")).toBe(false);
		expect((c.sql.match(/\?/g) ?? []).length).toBe(c.params.length);
		for (const p of c.params) expect(typeof p === "string" || typeof p === "number").toBe(true);
		// the SQL must be valid and run read-only
		db.query(`SELECT count(*) AS n FROM items i WHERE ${c.sql}`).get(...c.params);
		expect(counts()).toBe(before);
		// json paths come from the schema whitelist only
		for (const m of c.sql.matchAll(/json_extract\(\w+\.data, '([^']*)'\)/g)) expect(m[1]).toMatch(/^\$\.[A-Za-z][A-Za-z0-9]*$/);
	}, { normal: 400 });

	fuzz("unknown or injected field names are refused", [fc.constantFrom("x'); DROP TABLE items;--", "title' OR '1'='1", "a b", "", "  ", "$.title", "title\0", "../x", "tit-le", "1title", "__proto__", "constructor")], (f) => {
		expect(() => resolveField(f)).toThrow(HttpError);
	});
	// found by the nightly fuzz: the test's own String(f) threw a TypeError for this; resolveField now refuses non-strings with a 400
	test("regression: a field name that is not a string is an HttpError", () => {
		for (const f of [{ toString: 0 }, null, 3, ["title"]]) expect(() => resolveField(f as never)).toThrow(HttpError);
	});

	fuzz("operatorsFor, parseDateValue, parseInTheLast are total (HttpError or a value)", [field, text, fc.date({ noInvalidDate: true })], (f, v, now) => {
		for (const fn of [() => operatorsFor(f as string), () => parseDateValue(v), () => parseInTheLast(v, now)]) {
			try {
				fn();
			} catch (e) {
				if (!(e instanceof HttpError)) throw new Error(`threw ${describeError(e)} for ${JSON.stringify([f, v])}`, { cause: e });
			}
		}
	});

	fuzz("quick search clauses bind every value", [text.map((s) => `${MARK}${s}`), fc.constantFrom(...QUICK_MODES, "bogus")], (q, mode) => {
		let m;
		try {
			m = assertQuickMode(mode);
		} catch (e) {
			if (!(e instanceof HttpError)) throw e;
			return;
		}
		const c = quickSearchClause(q, m);
		expect(c.sql.includes(MARK)).toBe(false);
		expect((c.sql.match(/\?/g) ?? []).length).toBe(c.params.length);
		db.query(`SELECT count(*) AS n FROM items i WHERE ${c.sql || "1"}`).get(...c.params);
	}, { normal: 300 });

	test("regression: the worst hand-written case compiles to bound parameters", () => {
		const def = normalizeSearch({ name: "x", conditions: [{ field: "title", operator: "contains", value: "'; DROP TABLE items; --" }], options: {} });
		const c = compileSearch(db, def);
		expect(c.sql).not.toContain("DROP");
		expect(c.params.some((p) => String(p).includes("DROP TABLE"))).toBe(true);
	});
});
