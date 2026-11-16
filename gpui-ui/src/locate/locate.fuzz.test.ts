// Fuzz: the Locate menu's pure URL builders (openurl.ts, engines.ts). Item text and engine files are untrusted
// (translators, imported Zotero engines, OpenSearch documents), the result goes to the user's browser.
//
// Properties: always a valid http(s) URL or null; a value never changes the structure of the URL (no unencoded injection:
// the query keeps its shape, the host stays the engine's / doi.org's / scholar's); parsers fail only with an Error.
import { describe, expect, test } from "bun:test";
import {
	coerceEngines,
	engineSubmission,
	engineUrl,
	mergeEngines,
	moveEngine,
	parseOpenSearch,
	parseZoteroEngine,
	parseZoteroEngines,
	upsertEngine,
	type LocateEngine,
} from "./engines";
import {
	buildOpenUrl,
	googleScholarUrl,
	normalizeDoi,
	openUrlParams,
	pageRange,
	pmidOf,
	viewOnlineUrl,
	wellFormed,
	type LocateItem,
} from "./openurl";
import { fc, fuzz, messyText } from "../fuzzHarness";

const junk = fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<unknown>;
const text = fc.oneof(
	messyText(40),
	fc.string({ unit: "grapheme", maxLength: 30 }),
	fc.constantFrom("", " ", "A & B #1", "100% sure?", "x=1&y=2", "日本語", "a b+c", "10.1/abc", "https://doi.org/10.1/x", "doi:10.1/y"),
);
const maybe = (a: fc.Arbitrary<unknown>) =>
	fc.oneof({ weight: 6, arbitrary: a }, { weight: 1, arbitrary: junk }, { weight: 1, arbitrary: fc.constant(undefined) });

const item: fc.Arbitrary<LocateItem> = fc
	.record(
		{
			itemType: fc.oneof(
				fc.constantFrom("journalArticle", "book", "bookSection", "thesis", "webpage", "report", "preprint", "bogus"),
				text,
			),
			title: maybe(text),
			DOI: maybe(text),
			url: maybe(text),
			date: maybe(text),
			publicationTitle: maybe(text),
			journalAbbreviation: maybe(text),
			bookTitle: maybe(text),
			proceedingsTitle: maybe(text),
			containerTitle: maybe(text),
			volume: maybe(text),
			issue: maybe(text),
			pages: maybe(text),
			ISSN: maybe(text),
			ISBN: maybe(text),
			PMID: maybe(text),
			extra: maybe(text),
			creators: maybe(
				fc.array(
					fc.record(
						{ creatorType: maybe(text), firstName: maybe(text), lastName: maybe(text), name: maybe(text) },
						{ requiredKeys: [] },
					),
					{ maxLength: 3 },
				),
			),
		},
		{ requiredKeys: ["itemType"] },
	)
	.map((r) => r as unknown as LocateItem);

const KNOWN_KEYS = new Set([
	"url_ver",
	"ctx_ver",
	"rft_val_fmt",
	"rft.genre",
	"rft.atitle",
	"rft.btitle",
	"rft.jtitle",
	"rft.volume",
	"rft.issue",
	"rft.spage",
	"rft.epage",
	"rft.date",
	"rft.issn",
	"rft.isbn",
	"rft.aulast",
	"rft.aufirst",
	"rft_id",
]);

describe("openurl.ts", () => {
	fuzz(
		"viewOnlineUrl is null or an http(s) URL; a DOI fallback stays on doi.org",
		[item],
		(it) => {
			const u = viewOnlineUrl(it);
			if (u === null) return;
			const url = new URL(u); // must parse
			expect(["http:", "https:"]).toContain(url.protocol);
			if (!/^https?:\/\//i.test(typeof it.url === "string" ? it.url.trim() : "")) {
				expect(url.hostname).toBe("doi.org");
				expect(url.username + url.password).toBe("");
			}
		},
		{ normal: 400 },
	);

	fuzz(
		"a DOI can never move the link off doi.org",
		[text],
		(d) => {
			const u = viewOnlineUrl({ DOI: d });
			if (u === null) return;
			const url = new URL(u);
			expect(url.hostname).toBe("doi.org");
			expect(url.protocol).toBe("https:");
			expect(url.username).toBe("");
		},
		{ normal: 400 },
	);

	fuzz(
		"googleScholarUrl carries the exact title in q",
		[text],
		(t) => {
			const u = googleScholarUrl(t);
			if (u === null) return expect(t.trim()).toBe("");
			const url = new URL(u);
			expect(url.hostname).toBe("scholar.google.com");
			expect([...url.searchParams.keys()]).toEqual(["q"]);
			expect(url.searchParams.get("q")).toBe(wellFormed(t.trim()));
		},
		{ normal: 300 },
	);

	fuzz(
		"openUrlParams only uses OpenURL keys, with non-empty values",
		[item],
		(it) => {
			for (const [k, v] of openUrlParams(it)) {
				expect(KNOWN_KEYS.has(k)).toBe(true);
				expect(v.length).toBeGreaterThan(0);
			}
		},
		{ normal: 400 },
	);

	fuzz(
		"buildOpenUrl: null or a valid URL on the resolver's host, every value intact",
		[
			item,
			fc.oneof(
				fc.constantFrom(
					"https://resolver.example/openurl",
					"https://resolver.example/openurl?x=1",
					"https://resolver.example/r?",
					"https://resolver.example/r?a=b&",
					"http://r.example:8080/",
					"https://r.example/a#frag",
					"https://r.example/?q=1#frag",
				),
				text,
			),
		],
		(it, resolver) => {
			const u = buildOpenUrl(it, resolver);
			if (u === null) return;
			const url = new URL(u);
			const base = new URL(resolver.trim());
			expect(url.host).toBe(base.host);
			expect(url.pathname).toBe(base.pathname);
			const want = openUrlParams(it);
			const baseCount = [...base.searchParams].length;
			const got = [...url.searchParams];
			// our parameters arrive in order, each with exactly its text, after the resolver's own query
			expect(got.length).toBe(baseCount + want.length);
			expect(got.slice(baseCount)).toEqual(want);
			expect(got.slice(0, baseCount)).toEqual([...base.searchParams]);
		},
		{ normal: 400 },
	);

	fuzz(
		"helpers are total",
		[maybe(text), maybe(text)],
		(a, b) => {
			normalizeDoi(a);
			pageRange(a as string | undefined);
			pmidOf({ PMID: a as string, extra: b as string });
		},
		{ normal: 300 },
	);

	test("regression: an item type named like an Object.prototype member is a plain document, and a lone surrogate does not throw", () => {
		const params = Object.fromEntries(openUrlParams({ itemType: "valueOf", title: "T" }));
		expect(params["rft.genre"]).toBe("document");
		expect(googleScholarUrl("a\ud800b")).toBe("https://scholar.google.com/scholar?q=a%EF%BF%BDb");
		expect(viewOnlineUrl({ DOI: "10.1/\ud800" })).toBe("https://doi.org/10.1/%EF%BF%BD");
		expect(openUrlParams({ itemType: "book", creators: {} as never }).length).toBeGreaterThan(0);
	});

	test("regression: the OpenURL query goes before a fragment, not into it", () => {
		const u = buildOpenUrl({ itemType: "journalArticle", title: "A study" }, "https://r.example/resolve#frag")!;
		const url = new URL(u);
		expect(url.searchParams.get("rft.atitle")).toBe("A study");
		expect(url.hash).toBe("#frag");
	});
});

// ---------------------------------------------------------------- engines

const google = parseZoteroEngine({
	_name: "G",
	_urlTemplate: "https://e.example/s?q={z:title}&a={rft:aufirst?}&y={z:year?}&x=1",
	_urlNamespaces: {
		rft: "info:ofi/fmt:kev:mtx:journal",
		z: "http://www.zotero.org/namespaces/openSearch#",
		"": "http://a9.com/-/spec/opensearch/1.1/",
	},
})!;
const template = fc.oneof(
	fc.constantFrom(
		"https://e.example/s?q={z:title}&x=1",
		"https://e.example/{z:title}",
		"https://{z:title}.example/",
		"https://e.example/?{z:openURL}",
		"https://e.example/?q={searchTerms}",
		"{z:title}",
		"https://e.example/?a={rft:aulast?}{rft:aufirst?}",
		"https://e.example/?c={ctx:version}&d={rft:date?}",
		"https://e.example/?t={z:itemType}&u={z:url?}",
		"javascript:alert({z:title})",
		"ftp://e.example/{z:title}",
	),
	fc
		.array(
			fc.oneof(
				messyText(8),
				fc.constantFrom(
					"{z:title}",
					"{z:year?}",
					"{rft:aulast}",
					"{searchTerms}",
					"{x}",
					"{}",
					"{:}",
					"{z:}",
					"https://e.example/?q=",
					"&",
					"?",
				),
				fc.constantFrom("{z:DOI?}"),
			),
			{ maxLength: 8 },
		)
		.map((a) => a.join("")),
);
const engine: fc.Arbitrary<LocateEngine> = fc.record({
	name: fc.string({ minLength: 1, maxLength: 6 }),
	alias: fc.string({ maxLength: 4 }),
	description: fc.constant(null),
	icon: fc.constant(null),
	iconSourceUri: fc.constant(null),
	urlTemplate: template,
	urlParams: fc.dictionary(
		fc.string({ maxLength: 5 }),
		fc.oneof(text, fc.constantFrom("{z:title}", "{z:year?}", "{rft:aulast}", "{searchTerms?}")),
		{ maxKeys: 3 },
	),
	urlNamespaces: fc.constant(google.urlNamespaces),
	method: fc.constantFrom("GET" as const, "POST" as const),
	enabled: fc.boolean(),
});

describe("engines.ts", () => {
	fuzz(
		"engineUrl is null or a valid http(s) URL",
		[engine, item],
		(e, it) => {
			const u = engineUrl(e, it);
			if (u === null) return;
			expect(["http:", "https:"]).toContain(new URL(u).protocol);
			expect(e.method).toBe("GET");
		},
		{ normal: 500 },
	);

	fuzz(
		"a title cannot escape its {z:title} slot in a query",
		[text.filter((t) => t.trim() !== "")],
		(title) => {
			const e: LocateEngine = { ...google, urlTemplate: "https://e.example/s?q={z:title}&x=1" };
			const s = engineSubmission(e, { itemType: "journalArticle", title });
			expect(s).not.toBeNull();
			const url = new URL(s!.url);
			expect(url.hostname).toBe("e.example");
			expect([...url.searchParams.keys()]).toEqual(["q", "x"]);
			expect(url.searchParams.get("q")).toBe(wellFormed(title));
			expect(url.searchParams.get("x")).toBe("1");
			expect(url.hash).toBe("");
		},
		{ normal: 400 },
	);

	fuzz(
		"a title cannot escape the path or host slots either",
		[text.filter((t) => t.trim() !== "")],
		(title) => {
			for (const [tpl, check] of [
				["https://e.example/{z:title}", (u: URL) => u.hostname === "e.example" && u.search === "" && u.hash === ""],
				["https://{z:title}.example/", (u: URL) => u.hostname.endsWith(".example") && u.pathname === "/" && u.username === ""],
			] as const) {
				const e: LocateEngine = { ...google, urlTemplate: tpl };
				const u = engineUrl(e, { itemType: "journalArticle", title });
				if (u === null) continue;
				let url: URL;
				try {
					url = new URL(u);
				} catch {
					continue; // an unusable host name: the menu refuses to open it (it needs a valid URL)
				}
				expect(check(url)).toBe(true);
			}
		},
		{ normal: 400 },
	);

	fuzz(
		"extra parameters are encoded into the query",
		[engine, item],
		(e, it) => {
			const s = engineSubmission(
				{ ...e, method: "GET", urlTemplate: "https://e.example/s?z=1", urlParams: { p: "{z:title?}", q: "lit&eral=1" } },
				it,
			);
			if (!s) return;
			const url = new URL(s.url);
			expect(url.searchParams.get("z")).toBe("1");
			expect(url.searchParams.get("q")).toBe("lit&eral=1");
			expect([...url.searchParams.keys()].filter((k) => k === "q").length).toBe(1);
		},
		{ normal: 200 },
	);

	fuzz(
		"parseZoteroEngine / coerceEngines never throw on arbitrary JSON",
		[junk],
		(v) => {
			parseZoteroEngine(v);
			coerceEngines(v);
			coerceEngines([v, v]);
		},
		{ normal: 400 },
	);

	fuzz("parseZoteroEngines throws only an Error, for any text", [messyText(120)], (s) => {
		try {
			parseZoteroEngines(s);
		} catch (e) {
			if (!(e instanceof Error)) throw e;
		}
	});

	const OS = `<?xml version="1.0"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:z="http://www.zotero.org/namespaces/openSearch#"><ShortName>S &amp; T</ShortName><Description>d</Description><Url type="text/html" method="get" template="https://e.example/?q={searchTerms}"><Param name="a" value="{z:year?}"/></Url><Image height="16" width="16">https://e.example/i.ico</Image></OpenSearchDescription>`;
	const editedOpenSearch: fc.Arbitrary<string> = fc
		.array(
			fc.tuple(
				fc.nat({ max: OS.length }),
				fc.constantFrom("&#99999999;", "&#x110000;", "&#xD800;", "<", ">", '"', "&", "<![CDATA[", "]]>", "<Url", "</Url>"),
			),
			{ minLength: 1, maxLength: 4 },
		)
		.map((edits) => edits.reduce((acc: string, [at, tok]) => acc.slice(0, at) + tok + acc.slice(at), OS));
	test("the OpenSearch seed parses", () => {
		expect(parseOpenSearch(OS).name).toBe("S & T");
	});
	fuzz(
		"parseOpenSearch throws only an Error (with a message), also for entity-laden documents",
		[fc.oneof(messyText(300), editedOpenSearch)],
		(xml) => {
			try {
				const e = parseOpenSearch(xml);
				expect(e.name.length).toBeGreaterThan(0);
				expect(e.urlTemplate.length).toBeGreaterThan(0);
			} catch (e) {
				if (!(e instanceof Error) || e instanceof RangeError || e instanceof TypeError)
					throw new Error(`parseOpenSearch threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
			}
		},
		{ normal: 500 },
	);

	fuzz(
		"list operations keep names unique and the list length consistent",
		[
			fc.array(engine, { maxLength: 5 }),
			fc.array(engine, { maxLength: 4 }),
			fc.integer({ min: -3, max: 8 }),
			fc.integer({ min: -9, max: 9 }),
		],
		(list, more, idx, delta) => {
			const unique = mergeEngines([], list).list;
			const names = (l: LocateEngine[]) => l.map((e) => e.name.toLowerCase());
			expect(new Set(names(unique)).size).toBe(unique.length);
			const merged = mergeEngines(unique, more);
			expect(new Set(names(merged.list)).size).toBe(merged.list.length);
			expect(merged.added + merged.replaced).toBe(more.length);
			const moved = moveEngine(merged.list, idx, delta);
			expect(moved.length).toBe(merged.list.length);
			expect(names(moved).sort()).toEqual(names(merged.list).sort());
			if (more[0]) expect(upsertEngine(unique, more[0]).length).toBeLessThanOrEqual(unique.length + 1);
		},
	);

	test("regression: a numeric entity above U+10FFFF in an OpenSearch document is an Error, not a RangeError", () => {
		expect(() => parseOpenSearch(OS.replace("S &amp; T", "S &#99999999; T"))).not.toThrow(RangeError);
		expect(parseOpenSearch(OS.replace("S &amp; T", "S &#99999999; T")).name).toContain("S ");
	});
});
