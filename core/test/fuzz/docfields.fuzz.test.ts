// Fuzz: Word field codes and document preferences (core/src/cite/docfields.ts, shared with word/sidebar/src/fields.ts)
// and the popup helpers in word/sidebar/src/cited.ts.
//
// Properties: parse(serialise(x)) round-trips; garbage field codes / prefs / RTF / HTML never throw; whatever parseFieldCode
// accepts can be fed to the other helpers without throwing; HTML built from runs never carries injected markup.
import { describe, expect, test } from "bun:test";
import {
	defaultPrefs,
	buildBiblCode,
	buildItemCode,
	buildPrefsXml,
	decodeEntities,
	htmlToRuns,
	isHandEdited,
	keysOfCitationItem,
	mergeCitationData,
	parseFieldCode,
	parsePrefsXml,
	prepareForEditing,
	richToRuns,
	rtfToPlain,
	rtfToRuns,
	runsToHtml,
	runsToPlain,
	runsToRtf,
	splitCitationData,
	styleIdToUrl,
	styleUrlToId,
	uriToKey,
	type BibliographyData,
	type CitationData,
	type DocPrefs,
	type Run,
} from "../../src/cite/docfields";
import {
	escapeHtml,
	metaLine,
	noteChips,
	popupHeight,
	runsToHtml as safeRunsToHtml,
	targetFromCursor,
} from "../../../word/sidebar/src/cited";
import { describeError, fc, fuzz, messyText, mutated } from "./harness";

// ---------------------------------------------------------------- generators

const str = fc.string({ unit: "grapheme", maxLength: 20 });
const key8 = fc.stringMatching(/^[A-Z0-9]{8}$/);
const json = fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<unknown>;

const citationItem = fc.record(
	{
		id: fc.oneof(fc.integer({ min: 1, max: 1e6 }), str),
		uris: fc.array(
			key8.map((k) => `http://zotero.org/users/123/items/${k}`),
			{ maxLength: 2 },
		),
		locator: str,
		label: fc.constantFrom("page", "chapter", "section"),
		prefix: str,
		suffix: str,
		"suppress-author": fc.boolean(),
		itemData: fc.record({ id: str, type: fc.constantFrom("article-journal", "book"), title: str }),
	},
	{ requiredKeys: ["id", "uris"] },
);
const citationData: fc.Arbitrary<CitationData> = fc.record(
	{
		citationID: fc.stringMatching(/^[A-Za-z0-9]{8}$/),
		properties: fc.record(
			{
				formattedCitation: str,
				plainCitation: str,
				noteIndex: fc.integer({ min: 0, max: 20 }),
				dontUpdate: fc.boolean(),
				custom: str,
			},
			{ requiredKeys: [] },
		),
		citationItems: fc.array(citationItem, { minLength: 1, maxLength: 4 }),
		schema: fc.constant("https://github.com/citation-style-language/schema/raw/master/csl-citation.json"),
	},
	{ requiredKeys: ["citationID", "properties", "citationItems"] },
) as fc.Arbitrary<CitationData>;
const biblData: fc.Arbitrary<BibliographyData> = fc.record({
	uncited: fc.array(fc.array(str, { maxLength: 2 }), { maxLength: 2 }),
	omitted: fc.array(json, { maxLength: 2 }),
	custom: fc.array(json, { maxLength: 2 }),
});

const run: fc.Arbitrary<Run> = fc.record(
	{
		t: fc.oneof(
			fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
			fc.constantFrom("\\", "{", "}", "\n", "\t", "&amp;", "<b>", "a b", " lead", "😀", "é", "\\i", "\\par", "{\\i{}x}"),
		),
		i: fc.constant(1 as const),
		b: fc.constant(1 as const),
		sup: fc.constant(1 as const),
		sub: fc.constant(1 as const),
		sc: fc.constant(1 as const),
	},
	{ requiredKeys: ["t"] },
);
// sup and sub are exclusive in RTF (\super resets \sub): generate only valid styled runs
const runs = fc.array(run, { maxLength: 6 }).map((rs) =>
	rs
		.map((r) => (r.sup && r.sub ? { ...r, sub: undefined } : r))
		.map((r) => {
			const o: Run = { t: r.t };
			for (const k of ["i", "b", "sup", "sub", "sc"] as const) if (r[k]) o[k] = 1;
			return o;
		}),
);

const norm = (rs: Run[]): Run[] => {
	const out: Run[] = [];
	for (const r of rs) {
		const t = r.t.replace(/\r\n|\r/g, "\n");
		if (!t) continue;
		const l = out[out.length - 1];
		if (l && l.i === r.i && l.b === r.b && l.sup === r.sup && l.sub === r.sub && l.sc === r.sc) l.t += t;
		else out.push({ ...r, t });
	}
	return out;
};

const prefs: fc.Arbitrary<DocPrefs> = fc.record({
	styleId: fc.oneof(
		fc.constant("http://www.zotero.org/styles/vancouver"),
		str.map((s) => `http://example.org/${s}`),
	),
	locale: fc.oneof(fc.constant("en-GB"), fc.constant(""), str),
	sessionId: fc.oneof(fc.stringMatching(/^[A-Za-z0-9]{8}$/), str),
	hasBibliography: fc.boolean(),
	bibliographyStyleHasBeenSet: fc.boolean(),
	fieldType: fc.constantFrom("Field", "Bookmark"),
	noteType: fc.integer({ min: 0, max: 2 }),
	automaticJournalAbbreviations: fc.boolean(),
	delayCitationUpdates: fc.boolean(),
	dontAskDelayCitationUpdates: fc.boolean(),
	extraPrefs: fc.dictionary(
		fc
			.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,10}$/)
			.filter(
				(k) =>
					![
						"fieldType",
						"noteType",
						"automaticJournalAbbreviations",
						"delayCitationUpdates",
						"dontAskDelayCitationUpdates",
					].includes(k),
			),
		str,
		{ maxKeys: 3 },
	),
});

// ---------------------------------------------------------------- round trips

describe("field codes round trip", () => {
	fuzz("parseFieldCode(buildItemCode(x)) is x", [citationData], (d) => {
		const p = parseFieldCode(buildItemCode(d));
		expect(p?.kind).toBe("item");
		expect(p!.data).toEqual(JSON.parse(JSON.stringify(d)));
	});
	fuzz("parseFieldCode(buildBiblCode(x)) is x", [biblData], (d) => {
		const p = parseFieldCode(buildBiblCode(d));
		expect(p?.kind).toBe("bibl");
		expect(p!.data).toEqual(JSON.parse(JSON.stringify(d)));
	});
	fuzz(
		"surrounding spaces and line breaks do not matter",
		[citationData, fc.stringMatching(/^[ \t\r\n]{0,4}$/), fc.stringMatching(/^[ \t\r\n]{0,4}$/)],
		(d, a, b) => {
			expect(parseFieldCode(a + buildItemCode(d) + b)?.kind).toBe("item");
		},
	);
});

describe("document preferences round trip", () => {
	fuzz("parsePrefsXml(buildPrefsXml(p)) is p", [prefs], (p) => {
		const back = parsePrefsXml(buildPrefsXml(p));
		expect(back).toEqual(p);
	});
	fuzz(
		"parsePrefsXml never throws on garbage or mutated prefs",
		[
			fc.oneof(
				messyText(300),
				mutated(
					fc.constantFrom(
						buildPrefsXml(fc.sample(prefs, { seed: 1, numRuns: 1 })[0]!),
						'{"style":{"styleID":"x","locale":"en"},"prefs":{"noteType":1,"zz":2},"sessionID":"abc"}',
					),
				),
			),
		],
		(s) => {
			const p = parsePrefsXml(s);
			if (p) {
				expect(typeof p.styleId).toBe("string");
				expect(typeof p.sessionId).toBe("string");
				expect(typeof p.noteType).toBe("number");
				expect(p.extraPrefs && typeof p.extraPrefs).toBe("object");
			}
		},
	);
	fuzz("styleIdToUrl / styleUrlToId round trip", [fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/)], (id) => {
		expect(styleUrlToId(styleIdToUrl(id))).toBe(id);
	});
});

describe("formatted text round trip", () => {
	fuzz("rtfToRuns(runsToRtf(r)) is r", [runs], (rs) => {
		expect(rtfToRuns(runsToRtf(rs))).toEqual(norm(rs));
	});
	fuzz("rtfToPlain(runsToRtf(r)) is the plain text", [runs], (rs) => {
		expect(rtfToPlain(runsToRtf(rs))).toBe(runsToPlain(norm(rs)));
	});
	fuzz("htmlToRuns(runsToHtml(r)) is r", [runs], (rs) => {
		expect(htmlToRuns(runsToHtml(rs))).toEqual(norm(rs));
	});
	fuzz(
		"richToRuns keeps the text of plain strings",
		[fc.string({ unit: "grapheme", maxLength: 30 }).filter((s) => !/[\\{<]/.test(s))],
		(s) => {
			expect(runsToPlain(richToRuns(s))).toBe(s);
		},
	);
});

// ---------------------------------------------------------------- garbage

const SEED_CODES = [
	buildItemCode(fc.sample(citationData, { seed: 7, numRuns: 1 })[0]!),
	buildBiblCode(),
	'ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":1,"uris":["http://zotero.org/users/1/items/ABCD2345"]}],"properties":{}}',
];

describe("garbage input", () => {
	// well-formed JSON with the wrong shapes inside: items that are null / numbers / arrays, uris that are not arrays, ...
	const weird = fc
		.tuple(
			fc.array(fc.oneof(json, fc.record({ id: json, uris: json, locator: json }, { requiredKeys: [] })), { maxLength: 3 }),
			json,
			fc.constantFrom("ZOTERO_ITEM CSL_CITATION", "ZOTERO_ITEM"),
		)
		.map(([items, props, head]) => `ADDIN ${head} ${JSON.stringify({ citationID: "x", citationItems: items, properties: props })}`);
	const garbage = fc.oneof(messyText(400), mutated(fc.constantFrom(...SEED_CODES)), weird);
	fuzz(
		"parseFieldCode never throws, and what it accepts is safe to use",
		[garbage],
		(code) => {
			const p = parseFieldCode(code);
			if (!p || p.kind !== "item") return;
			const d = p.data;
			try {
				expect(typeof d.properties).toBe("object");
				expect(Array.isArray(d.citationItems)).toBe(true);
				for (const ci of d.citationItems) {
					expect(ci !== null && typeof ci === "object").toBe(true);
					keysOfCitationItem(ci);
				}
				mergeCitationData(d, [d]);
				splitCitationData(d);
				prepareForEditing(d.properties);
				isHandEdited(d.properties, "text");
			} catch (e) {
				throw new Error(`accepted field code crashed a helper: ${describeError(e)}`, { cause: e });
			}
		},
		{ normal: 400 },
	);
	fuzz("uriToKey and styleUrlToId never throw", [messyText(200)], (s) => {
		const k = uriToKey(s);
		if (k !== null) expect(k).toMatch(/^[A-Z0-9]{8}$/);
		styleUrlToId(s);
	});
	fuzz(
		"decodeEntities, htmlToRuns, rtfToRuns, richToRuns, rtfToPlain never throw",
		[fc.oneof(messyText(300), mutated("<i>a &amp; b</i><sup>2</sup>&#233;&#x1F600;{\\i{}x}\\uc0\\u233{}"))],
		(s) => {
			decodeEntities(s);
			htmlToRuns(s);
			rtfToRuns(s);
			richToRuns(s);
			rtfToPlain(s);
		},
		{ normal: 400 },
	);
	fuzz(
		"numeric entities outside Unicode do not throw",
		[fc.oneof(fc.integer({ min: 0x110000, max: 2 ** 40 }), fc.integer({ min: 0xd800, max: 0xdfff }), fc.integer({ min: 0, max: 40 }))],
		(cp) => {
			decodeEntities(`&#${cp};`);
			decodeEntities(`&#x${cp.toString(16)};`);
		},
	);
	fuzz(
		"deeply nested or very long markup stays fast",
		[fc.constantFrom("<i>", "<sup>", "{", "{\\i{}", "<span>", "\\super ", "&amp;"), fc.integer({ min: 200, max: 6000 })],
		(tok, n) => {
			const s = tok.repeat(n);
			htmlToRuns(s);
			rtfToRuns(s);
			richToRuns(s);
		},
		{ normal: 30, timeBoxMs: 4000 },
	);
});

// ---------------------------------------------------------------- word/sidebar/src/cited.ts

describe("popup helpers (word/sidebar/src/cited.ts)", () => {
	fuzz(
		"runsToHtml of arbitrary runs contains only the allowed tags",
		[
			fc.array(
				fc.record({
					t: fc.oneof(messyText(30), fc.constantFrom('"><script>alert(1)</script>', "<img src=x onerror=1>", "&lt;")),
					i: fc.constantFrom(1 as const, undefined),
					b: fc.constantFrom(1 as const, undefined),
					sup: fc.constantFrom(1 as const, undefined),
					sub: fc.constantFrom(1 as const, undefined),
					sc: fc.constantFrom(1 as const, undefined),
				}),
				{ maxLength: 5 },
			),
		],
		(rs) => {
			const html = safeRunsToHtml(rs as Run[]);
			const stripped = html.replace(/<\/?(?:i|b|sup|sub|span)>|<span style="font-variant:small-caps">/g, "");
			expect(stripped.includes("<")).toBe(false);
			expect(stripped.includes(">")).toBe(false);
			expect(/&(?!amp;|lt;|gt;|quot;|#39;)/.test(stripped)).toBe(false);
			expect(html.includes("\n")).toBe(false);
		},
	);
	fuzz("escapeHtml output is inert", [messyText(100)], (s) => {
		expect(/[<>"']/.test(escapeHtml(s))).toBe(false);
	});
	fuzz(
		"targetFromCursor accepts any JSON without throwing",
		[fc.oneof(json, fc.record({ code: fc.oneof(fc.constantFrom(...SEED_CODES), messyText(80), json), ref: json }))],
		(c) => {
			const t = targetFromCursor(c);
			if (t) {
				expect(typeof t.code).toBe("string");
				expect(t.ref === null || (typeof t.ref.story === "string" && typeof t.ref.idx === "number")).toBe(true);
			}
		},
	);
	fuzz(
		"metaLine / noteChips / popupHeight are total",
		[
			fc.record({
				authors: fc.option(messyText(20), { nil: undefined }),
				year: fc.option(messyText(5), { nil: undefined }),
				journal: fc.option(messyText(20), { nil: undefined }),
				locator: fc.option(messyText(20), { nil: undefined }),
				prefix: fc.option(messyText(20), { nil: undefined }),
				suffix: fc.option(messyText(20), { nil: undefined }),
			}),
			fc.double({ noNaN: false }),
		],
		(v, h) => {
			metaLine(v as never);
			noteChips(v as never);
			const ph = popupHeight(h);
			expect(Number.isNaN(ph)).toBe(false);
			expect(ph).toBeGreaterThanOrEqual(80);
			expect(ph).toBeLessThanOrEqual(520);
		},
	);
});

describe("regressions found by the fuzzer", () => {
	test("decodeEntities leaves a code point above U+10FFFF alone instead of throwing", () => {
		expect(() => decodeEntities("&#1114112; &#x110000;")).not.toThrow();
		expect(decodeEntities("&#233;&#x1F600;")).toBe("é\u{1F600}");
	});
	test("rtfToPlain: an escaped backslash before i or b is text, not a control word", () => {
		expect(rtfToPlain(String.raw`\\i and \\b`)).toBe(String.raw`\i and \b`);
		expect(rtfToPlain(runsToRtf([{ t: String.raw`\i` }]))).toBe(String.raw`\i`);
	});
	test("a session id with XML specials survives the prefs round trip", () => {
		const p = parsePrefsXml(buildPrefsXml({ ...defaultPrefs("vancouver", "en-GB"), sessionId: 'a&b"<c>' }));
		expect(p?.sessionId).toBe('a&b"<c>');
	});
	test("a field code with null items or non-object properties is not a Zotero citation", () => {
		expect(parseFieldCode('ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[null],"properties":{}}')).toBeNull();
		expect(parseFieldCode('ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[],"properties":"x"}')).toBeNull();
		expect(parseFieldCode('ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":1,"uris":"u"}]}')).toBeNull();
		expect(parseFieldCode("ADDIN ZOTERO_BIBL null CSL_BIBLIOGRAPHY")).toBeNull();
	});
	test("popupHeight(NaN) is the minimum", () => {
		expect(popupHeight(Number.NaN)).toBe(80);
	});
});
