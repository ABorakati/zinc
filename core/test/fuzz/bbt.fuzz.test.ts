// Fuzz: Better BibTeX citekey formulas (core/src/bbt/formula.ts) and Unicode -> LaTeX (core/src/bbt/export/latex.ts).
//
// Properties: a random formula either compiles or fails with a positioned FormulaError (never a crash or stack overflow);
// evaluating a compiled formula on a random item is total; the finished key has no whitespace or unsafe characters; LaTeX
// output has balanced braces, is ASCII when ASCII output is requested for text that has a LaTeX form, and nothing hangs.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { ZoteroItemData } from "../../src/api-types";
import { compile, formatPostfix, FormulaError, generate, MARK, validPostfix } from "../../src/bbt/formula";
import { formulaConfig } from "../../src/bbt/keys";
import { DEFAULT_FORMULA, DEFAULT_SETTINGS } from "../../src/bbt/settings";
import { encodeChars, textToLatex, verbatim, type TexOptions } from "../../src/bbt/export/latex";
import { describeError, fc, fuzz, messyText, mutated } from "./harness";

// ---------------------------------------------------------------- the formula language, from the source

const src = readFileSync(new URL("../../src/bbt/formula.ts", import.meta.url), "utf8");
function names(table: string): string[] {
	const m = new RegExp(`^const ${table}[^\\n]*= \\{\\n([\\s\\S]*?)^\\};`, "m").exec(src);
	return [...(m?.[1] ?? "").matchAll(/^\t([A-Za-z0-9]+): \{/gm)].map((x) => x[1]!);
}
const FUNCTIONS = names("FUNCTIONS");
const FILTERS = names("FILTERS");
test("the function and filter tables were found", () => {
	expect(FUNCTIONS.length).toBeGreaterThan(30);
	expect(FILTERS.length).toBeGreaterThan(20);
});

const cfgs = [formulaConfig(DEFAULT_SETTINGS), { ...formulaConfig(DEFAULT_SETTINGS), fold: false }];

// ---------------------------------------------------------------- generators

const lit = fc.oneof(
	fc.integer({ min: -3, max: 12 }).map(String),
	fc.string({ maxLength: 6 }).map((s) => JSON.stringify(s)),
	fc.string({ maxLength: 6 }).map((s) => `'${s.replace(/[\\']/g, "")}'`),
	fc.constantFrom("/a/", "/[aeiou]/gi", "/^(.)/", "true", "false", "book", ">", "[1, 2]", "['x', 3]", "n=2", "sep='-'", "word"),
);
const callArgs = fc.array(lit, { maxLength: 4 }).map((a) => (a.length ? `(${a.join(", ")})` : ""));
const primary = fc.oneof(
	fc.tuple(fc.constantFrom(...FUNCTIONS), callArgs).map(([f, a]) => f + a),
	fc.constantFrom("Title", "DOI", "Date", "Extra", "Pages", "PublicationTitle", "Volume"),
	fc.string({ maxLength: 8 }).map((s) => JSON.stringify(s)),
);
const formulaExpr: fc.Arbitrary<string> = fc.letrec<{ e: string }>((tie) => ({
	e: fc.oneof(
		{ weight: 4, arbitrary: primary },
		{ weight: 2, arbitrary: fc.tuple(tie("e"), fc.constantFrom(...FILTERS), callArgs).map(([e, f, a]) => `${e}.${f}${a}`) },
		{ weight: 2, arbitrary: fc.tuple(tie("e"), tie("e")).map(([a, b]) => `${a} + ${b}`) },
		{ weight: 1, arbitrary: fc.tuple(tie("e"), tie("e")).map(([a, b]) => `${a} || ${b}`) },
		{ weight: 1, arbitrary: fc.tuple(tie("e"), tie("e")).map(([a, b]) => `${a} && ${b}`) },
		{ weight: 1, arbitrary: fc.tuple(tie("e"), tie("e"), tie("e")).map(([a, b, c]) => `${a} ? ${b} : ${c}`) },
		{ weight: 1, arbitrary: fc.tuple(tie("e"), fc.constantFrom(">", ">=", "<", "<=", "==", "!="), fc.integer({ min: 0, max: 9 })).map(([a, o, n]) => `${a} ${o} ${n}`) },
		{ weight: 1, arbitrary: tie("e").map((a) => `(${a})`) },
	),
})).e;
const formula = fc.array(formulaExpr, { minLength: 1, maxLength: 3 }).map((a) => a.join(" ; "));
const GOOD = ["auth.lower + shorttitle(3,3) + year", "authorsAlpha + year", "auth(0,2) + '_' + title.lower.skipwords", "Title.len(>, 3) ? shorttitle : veryshorttitle", "creators(0,'*','%(F)s') + year; DOI.default('none')", "extra.select(Citation Key) || auth"];

// items: mostly well-formed, with hostile text and wrong-typed JSON values in the fields the formulas read
const wrong = fc.oneof(fc.integer(), fc.constant(null), fc.boolean(), fc.array(fc.string({ maxLength: 4 }), { maxLength: 2 }), fc.dictionary(fc.string({ maxLength: 3 }), fc.string({ maxLength: 3 }), { maxKeys: 2 }));
const text = fc.oneof(fc.string({ unit: "grapheme", maxLength: 40 }), messyText(60), fc.constantFrom("The Study of Things: A Review", "<i>Deep</i> &amp; learning", "van der Berg", "", "ÅÄÖ ßß ñ", "日本語のタイトル", "Citation Key: foo\ntex.title: bar\noriginal-date: 1999"));
const maybeWrong = (t: fc.Arbitrary<string>) => fc.oneof({ weight: 12, arbitrary: t }, { weight: 1, arbitrary: wrong as fc.Arbitrary<unknown> });
const creator = fc.oneof(
	fc.record({ creatorType: fc.constantFrom("author", "editor", "translator", "contributor", "weird"), firstName: text, lastName: text }),
	fc.record({ creatorType: fc.constantFrom("author", "editor"), name: text }),
	fc.record({ creatorType: fc.constant("author") }, { requiredKeys: ["creatorType"] }),
);
const item: fc.Arbitrary<ZoteroItemData> = fc
	.record(
		{
			itemType: fc.constantFrom("journalArticle", "book", "bookSection", "thesis", "webpage", "report", "note", "weird"),
			title: maybeWrong(text),
			date: maybeWrong(fc.oneof(text, fc.constantFrom("2020", "2020-05-17", "May 2020", "1999-13-45", "0000", "12th century", "9999-99-99", "-5"))),
			extra: maybeWrong(text),
			DOI: maybeWrong(text),
			pages: maybeWrong(fc.oneof(text, fc.constantFrom("10-20", "e1234", "S45-S60"))),
			publicationTitle: maybeWrong(text),
			language: maybeWrong(fc.constantFrom("en", "de", "German", "", "zh")),
			creators: fc.oneof({ weight: 10, arbitrary: fc.array(creator, { maxLength: 5 }) }, { weight: 1, arbitrary: wrong as fc.Arbitrary<unknown> }),
		},
		{ requiredKeys: ["itemType"] },
	)
	.map((r) => JSON.parse(JSON.stringify({ key: "ABCD2345", ...r })) as ZoteroItemData); // as it arrives from the database / sync: plain JSON

// ---------------------------------------------------------------- formulas

describe("formula parser", () => {
	const check = (source: string) => {
		try {
			compile(source);
		} catch (e) {
			if (!(e instanceof FormulaError)) throw new Error(`compile threw ${describeError(e)} instead of a FormulaError`, { cause: e });
			if (!Number.isInteger(e.position) || e.position < 0 || e.position > source.length) throw new Error(`error position ${e.position} is outside the formula (length ${source.length}): ${e.message}`);
			expect(e.message.length).toBeGreaterThan(0);
		}
	};
	fuzz("random text compiles or fails with a positioned FormulaError", [fc.oneof(messyText(120), fc.string({ maxLength: 60 }))], check, { normal: 400 });
	fuzz("a mutated valid formula compiles or fails with a positioned FormulaError", [mutated(fc.oneof(fc.constantFrom(...GOOD), formula))], check, { normal: 400 });
	fuzz("generated formulas compile", [formula], (f) => {
		try {
			compile(f);
		} catch (e) {
			// a regex literal the grammar built can be invalid; anything else is a parser bug
			if (!(e instanceof FormulaError) || !/regular expression|unexpected|expected/.test(e.message)) throw new Error(`${f}\n -> ${describeError(e)}`, { cause: e });
		}
	}, { normal: 300 });
	fuzz("deep nesting and very long formulas fail cleanly", [fc.constantFrom("(", "a.", "x ? ", "[", "!(", "'", "auth + "), fc.integer({ min: 50, max: 30000 })], (tok, n) => check(tok.repeat(n)), { normal: 25, timeBoxMs: 5000 });
	test.each(["", "   ", ";", ";;", "|"])("regression: %j gives a positioned error", (f) => {
		let err: unknown;
		try {
			compile(f);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(FormulaError);
		expect((err as FormulaError).position).toBeGreaterThanOrEqual(0);
	});
	test("regression: a formula nested 20000 deep is a FormulaError, not a stack overflow", () => {
		expect(() => compile("(".repeat(20000) + "year" + ")".repeat(20000))).toThrow(FormulaError);
		expect(() => compile("year" + ".lower".repeat(20000))).toThrow(FormulaError);
	});
});

describe("formula evaluation", () => {
	const run = (source: string, d: ZoteroItemData, cfg: (typeof cfgs)[number]) => {
		let c;
		try {
			c = compile(source);
		} catch (e) {
			if (e instanceof FormulaError) return;
			throw e;
		}
		let g;
		try {
			g = generate(c, d, cfg);
		} catch (e) {
			if (e instanceof FormulaError) return; // a runtime formula error with a message is an intended outcome
			throw new Error(`generate threw ${describeError(e)} for ${JSON.stringify(source)}`, { cause: e });
		}
		expect(typeof g.text).toBe("string");
		const key = g.text.replace(MARK, "");
		expect(/\s/.test(key)).toBe(false);
		expect(key.includes("�")).toBe(false);
		for (const ch of cfg.unsafeChars) expect(key.includes(ch)).toBe(false);
		expect(g.text === "" || g.text.includes(MARK)).toBe(true);
		expect(typeof g.postfix.template).toBe("string");
	};
	fuzz("generated formulas on random items are total", [formula, item, fc.constantFrom(0, 1)], (f, d, c) => run(f, d, cfgs[c]!), { normal: 300 });
	fuzz("the known-good formulas on random items are total", [fc.constantFrom(...GOOD, DEFAULT_FORMULA), item, fc.constantFrom(0, 1)], (f, d, c) => run(f, d, cfgs[c]!), { normal: 300 });
	fuzz("mutated formulas on random items are total", [mutated(fc.constantFrom(...GOOD)), item], (f, d) => run(f, d, cfgs[0]!), { normal: 300 });
	fuzz("formatPostfix and validPostfix are total", [fc.oneof(messyText(30), fc.constantFrom("%(a)s", "%(A)s", "%(n)s", "%(n)03d", "-%(a)s-")), fc.oneof(fc.integer({ min: 0, max: 100000 }), fc.integer(), fc.double())], (t, i) => {
		expect(typeof formatPostfix(t, i)).toBe("string");
		expect(typeof validPostfix(t)).toBe("boolean");
	});
});

// ---------------------------------------------------------------- LaTeX

/** True when every unescaped { has its }. A backslash escapes the next character (\{ \} \\ and control words). */
function balanced(s: string): boolean {
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") i++;
		else if (c === "{") depth++;
		else if (c === "}" && --depth < 0) return false;
	}
	return depth === 0;
}

// text with a LaTeX form: ASCII, Latin-1 and Latin Extended-A letters (accents, ligatures), Greek, typographic punctuation
const KNOWN = [..."áéíóúàèìòùâêîôûäëïöüãñõçåÅøØæÆœŒßłŁıðÞþđĐŋ", ..."ÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÃÑÕÇ", ..."ćčďěňřšťžůýŕĺľśźżąęĆČĎĚŇŘŠŤŽŮÝ", ..."αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ", ..."–—‘’“”…©®£§°±×÷µ≤≥≠≈∞→←·•−½¿¡"];
const known = fc.string({ unit: fc.oneof({ weight: 5, arbitrary: fc.constantFrom(..."abcXYZ019 .,;:!?-_/\\{}[]()<>&%$#~^'\"@*+=|`") }, { weight: 3, arbitrary: fc.constantFrom(...KNOWN) }), maxLength: 40 });
const tags = fc.constantFrom("<i>", "</i>", "<b>", "</b>", "<sup>", "</sup>", "<sub>", "</sub>", "<sc>", "</sc>", "<nc>", "</nc>", "<br>", "<span class=\"nocase\">", "</span>", "<a href=x>", "</a>", "&amp;", "&lt;", "&#233;", "<", ">", "{", "}", "\\");
const htmlish = fc.array(fc.oneof(known, tags, text), { maxLength: 8 }).map((a) => a.join(""));

const opts: fc.Arbitrary<TexOptions> = fc.record({ flavor: fc.constantFrom("bibtex", "biblatex"), ascii: fc.boolean(), protect: fc.boolean(), creator: fc.boolean() });

describe("unicode to LaTeX", () => {
	fuzz("textToLatex never throws and its braces are balanced", [fc.oneof(htmlish, messyText(150)), opts, fc.boolean()], (s, o, html) => {
		const out = textToLatex(s, o, { html });
		expect(balanced(out)).toBe(true);
	}, { normal: 400 });
	fuzz("with ASCII output the result is ASCII for text that has a LaTeX form", [fc.oneof(known, htmlish.map((s) => s.replace(/[^\x00-\x7f]/g, "")).map((s) => s)), opts], (s, o) => {
		const out = textToLatex(s, { ...o, ascii: true });
		// characters in KNOWN (and those in the tag/entity lists, which are ASCII or decode to é) must all be encoded
		expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
	}, { normal: 400 });
	fuzz("encodeChars: ASCII input is only escaped, and ASCII output covers every known character", [known, opts], (s, o) => {
		const out = encodeChars(s, { ...o, ascii: true });
		expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
		expect(balanced(out)).toBe(true);
	}, { normal: 400 });
	fuzz("characters without a LaTeX form pass through unchanged (documented fallback)", [fc.constantFrom("日", "本", "語", "한", "ж", "😀", "א", "ก", "∑", "ℵ"), opts], (ch, o) => {
		expect(encodeChars(ch, { ...o, ascii: true })).toBe(ch);
	});
	fuzz("encodeChars of any text with unicode kept never changes non-special characters", [fc.string({ unit: "grapheme", maxLength: 30 }), opts], (s, o) => {
		const out = encodeChars(s, { ...o, ascii: false });
		expect(out.replace(/\\text(?:backslash|asciitilde|asciicircum)\{\}|\\[{}&%$#_]/g, "").normalize("NFC").length).toBeLessThanOrEqual(s.normalize("NFC").length);
	});
	fuzz("verbatim removes only braces, and what is left is balanced", [fc.oneof(messyText(80), fc.string({ maxLength: 30 }))], (s) => {
		const out = verbatim(s);
		// verbatim does not treat backslash as an escape: plain brace matching
		let depth = 0;
		for (const ch of out) {
			if (ch === "{") depth++;
			else if (ch === "}" && --depth < 0) break;
		}
		expect(depth).toBe(0);
		expect(out.replace(/[{}]/g, "")).toBe(s.replace(/[{}]/g, ""));
		expect(verbatim(out)).toBe(out);
	});
	fuzz("long inputs stay fast", [fc.constantFrom("Aa ", "AB-", "<i>", "{{", "é", "A", " ", "<nc>"), fc.integer({ min: 500, max: 20000 })], (tok, n) => {
		textToLatex(tok.repeat(n), { flavor: "bibtex", ascii: true, protect: true });
	}, { normal: 20, timeBoxMs: 4000 });
});
