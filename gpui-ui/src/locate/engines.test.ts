// bun test src/locate/engines.test.ts -- Zotero engines.json parsing, OpenSearch parsing (fetch mocked), template expansion and list ops.
import { describe, expect, test } from "bun:test";
import {
	coerceEngines,
	defaultEngines,
	engineSubmission,
	engineUrl,
	fetchOpenSearch,
	mergeEngines,
	moveEngine,
	parseOpenSearch,
	parseZoteroEngines,
	toZoteroJson,
	upsertEngine,
	type LocateEngine,
} from "./engines";
import { importFromZotero } from "./engines-store";
import type { LocateItem } from "./openurl";

// The shape of the user's real <Zotero>/locate/engines.json (only the default Google Scholar engine; _urlParams serialised as []).
const ZOTERO_JSON = `[
	{
		"_name": "Google Scholar",
		"_alias": "Untitled",
		"_description": "Google Scholar Search",
		"_icon": "file:///C:/Users/someone/Zotero/locate/Google%20Scholar.ico",
		"_hidden": false,
		"_urlTemplate": "https://scholar.google.com/scholar?as_q=&as_epq={z:title}&as_occt=title&as_sauthors={rft:aufirst?}+{rft:aulast?}&as_ylo={z:year?}&as_yhi={z:year?}&as_sdt=1.&as_sdtp=on&as_sdtf=&as_sdts=22&",
		"_urlParams": [],
		"_urlNamespaces": {
			"rft": "info:ofi/fmt:kev:mtx:journal",
			"z": "http://www.zotero.org/namespaces/openSearch#",
			"": "http://a9.com/-/spec/opensearch/1.1/"
		},
		"_iconSourceURI": "chrome://zotero/skin/logos/google-scholar.ico"
	}
]`;

const article: LocateItem = {
	itemType: "journalArticle",
	title: "Deep learning & AI",
	DOI: "10.1038/nature14539",
	date: "2015-05-28",
	publicationTitle: "Nature",
	creators: [{ creatorType: "author", firstName: "Yann", lastName: "LeCun" }],
};

const OPENSEARCH = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:z="http://www.zotero.org/namespaces/openSearch#" xmlns:rft="info:ofi/fmt:kev:mtx:journal">
  <ShortName>PubMed</ShortName>
  <LongName>PubMed Search</LongName>
  <Description>Search PubMed &amp; friends</Description>
  <Image height="16" width="16" type="image/x-icon">https://pubmed.example.org/favicon.ico</Image>
  <Image height="64" width="64" type="image/png">https://pubmed.example.org/big.png</Image>
  <Url type="application/rss+xml" template="https://pubmed.example.org/rss?q={searchTerms}"/>
  <Url type="text/html" method="get" template="https://pubmed.example.org/?term={searchTerms}&amp;from={z:year?}">
    <Param name="source" value="zotero"/>
    <Param name="issn" value="{rft:issn?}"/>
  </Url>
</OpenSearchDescription>`;

describe("Zotero engines.json", () => {
	test("the real default file parses into the Google Scholar engine", () => {
		const [e, ...rest] = parseZoteroEngines(ZOTERO_JSON);
		expect(rest).toHaveLength(0);
		expect(e!.name).toBe("Google Scholar");
		expect(e!.alias).toBe("Untitled");
		expect(e!.enabled).toBe(true);
		expect(e!.urlParams).toEqual({});
		expect(e!.urlNamespaces["z"]).toBe("http://www.zotero.org/namespaces/openSearch#");
		expect(e!.urlNamespaces[""]).toBe("http://a9.com/-/spec/opensearch/1.1/");
		expect(e!.icon).toContain("Google%20Scholar.ico");
	});

	test("the built-in default equals what Zotero ships", () => {
		const shipped = parseZoteroEngines(ZOTERO_JSON)[0]!;
		const d = defaultEngines()[0]!;
		expect(d.urlTemplate).toBe(shipped.urlTemplate);
		expect(d.urlNamespaces).toEqual(shipped.urlNamespaces);
		expect(d.name).toBe(shipped.name);
	});

	test("_hidden maps to enabled=false; junk entries are dropped; a non-list throws", () => {
		const list = parseZoteroEngines(
			JSON.stringify([{ _name: "A", _urlTemplate: "https://a/{searchTerms}", _hidden: true }, { _name: "no template" }, 5]),
		);
		expect(list).toHaveLength(1);
		expect(list[0]!.enabled).toBe(false);
		expect(() => parseZoteroEngines("{}")).toThrow();
	});

	test("round trip keeps Zotero's keys", () => {
		const back = parseZoteroEngines(JSON.stringify(toZoteroJson(parseZoteroEngines(ZOTERO_JSON))));
		expect(back).toEqual(parseZoteroEngines(ZOTERO_JSON));
	});
});

describe("OpenSearch", () => {
	test("parses names, the html Url, namespaces, params and the 16px icon", () => {
		const e = parseOpenSearch(OPENSEARCH);
		expect(e.name).toBe("PubMed Search");
		expect(e.alias).toBe("PubMed");
		expect(e.description).toBe("Search PubMed & friends");
		expect(e.urlTemplate).toBe("https://pubmed.example.org/?term={searchTerms}&from={z:year?}");
		expect(e.method).toBe("GET");
		expect(e.urlParams).toEqual({ source: "zotero", issn: "{rft:issn?}" });
		expect(e.urlNamespaces).toMatchObject({
			"": "http://a9.com/-/spec/opensearch/1.1/",
			z: "http://www.zotero.org/namespaces/openSearch#",
			rft: "info:ofi/fmt:kev:mtx:journal",
		});
		expect(e.iconSourceUri).toBe("https://pubmed.example.org/favicon.ico");
	});

	test("rejects a foreign namespace and a description with no html Url", () => {
		expect(() => parseOpenSearch('<feed xmlns="http://www.w3.org/2005/Atom"/>')).toThrow(/namespace/i);
		expect(() =>
			parseOpenSearch(
				'<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>x</ShortName><Url type="application/json" template="https://x/{searchTerms}"/></OpenSearchDescription>',
			),
		).toThrow(/Url/);
	});

	test("POST method is kept", () => {
		const e = parseOpenSearch(
			'<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>P</ShortName><Url type="text/html" method="POST" template="https://p/"><Param name="q" value="{searchTerms}"/></Url></OpenSearchDescription>',
		);
		expect(e.method).toBe("POST");
		expect(engineUrl(e, article)).toBeNull();
		expect(engineSubmission(e, article)).toEqual({ url: "https://p/", postData: "q=Deep%20learning%20%26%20AI" });
	});

	test("fetchOpenSearch uses the injected fetch (no network) and resolves a relative icon", async () => {
		const seen: string[] = [];
		const xml = OPENSEARCH.replace("https://pubmed.example.org/favicon.ico", "/fav.ico");
		const e = await fetchOpenSearch("https://pubmed.example.org/os.xml", async (u) => {
			seen.push(u);
			return new Response(xml);
		});
		expect(seen).toEqual(["https://pubmed.example.org/os.xml"]);
		expect(e.iconSourceUri).toBe("https://pubmed.example.org/fav.ico");
		await expect(fetchOpenSearch("ftp://x", async () => new Response(""))).rejects.toThrow(/http/);
		await expect(fetchOpenSearch("https://x/y", async () => new Response("no", { status: 404 }))).rejects.toThrow(/404/);
	});
});

describe("template expansion", () => {
	const scholar = defaultEngines()[0]!;

	test("Google Scholar: title, author and year filled in", () => {
		const url = engineUrl(scholar, article)!;
		expect(url).toContain("as_epq=Deep%20learning%20%26%20AI&");
		expect(url).toContain("as_sauthors=Yann+LeCun&");
		expect(url).toContain("as_ylo=2015&as_yhi=2015&");
	});

	test("optional params become empty, a missing required one gives no link", () => {
		const url = engineUrl(scholar, { itemType: "book", title: "Dune" })!;
		expect(url).toContain("as_sauthors=+&");
		expect(url).toContain("as_ylo=&as_yhi=&");
		expect(engineUrl(scholar, { itemType: "book" })).toBeNull();
	});

	test("{searchTerms} is the title; z:field reads any item field; rft maps to OpenURL values", () => {
		const e: LocateEngine = {
			...scholar,
			urlTemplate: "https://x/?q={searchTerms}&d={z:DOI}&j={rft:jtitle}&t={rft:title}",
			urlParams: {},
		};
		expect(engineUrl(e, article)).toBe(
			"https://x/?q=Deep%20learning%20%26%20AI&d=10.1038%2Fnature14539&j=Nature&t=Deep%20learning%20%26%20AI",
		);
		expect(engineUrl(e, { ...article, DOI: undefined })).toBeNull();
	});

	test("an unknown namespace prefix counts as no value", () => {
		const e: LocateEngine = { ...scholar, urlTemplate: "https://x/?a={nope:title}" };
		expect(engineUrl(e, article)).toBeNull();
		expect(engineUrl({ ...e, urlTemplate: "https://x/?a={nope:title?}" }, article)).toBe("https://x/?a=");
	});

	test("z:openURL is the item's OpenURL query", () => {
		const e: LocateEngine = { ...scholar, urlTemplate: "https://x/?{z:openURL}" };
		const url = engineUrl(e, article)!;
		expect(decodeURIComponent(url.slice("https://x/?".length))).toContain("rft.jtitle=Nature");
	});

	test("urlParams: literals, {refs}, and the ? rule; appended with ? or &", () => {
		const e: LocateEngine = {
			...scholar,
			urlTemplate: "https://x/search",
			urlParams: { source: "zotero", issn: "{rft:issn?}", yr: "{z:year}" },
		};
		expect(engineUrl(e, article)).toBe("https://x/search?source=zotero&yr=2015");
		expect(engineUrl({ ...e, urlTemplate: "https://x/search?a=1" }, article)).toBe("https://x/search?a=1&source=zotero&yr=2015");
		expect(engineUrl(e, { ...article, date: undefined })).toBeNull();
	});

	test("the parsed OpenSearch engine expands", () => {
		const e = parseOpenSearch(OPENSEARCH);
		expect(engineUrl(e, article)).toBe("https://pubmed.example.org/?term=Deep%20learning%20%26%20AI&from=2015&source=zotero");
	});

	test("non-http results are refused", () => {
		expect(engineUrl({ ...scholar, urlTemplate: "javascript:alert({z:title})" }, article)).toBeNull();
	});
});

describe("list operations", () => {
	const mk = (name: string): LocateEngine => ({ ...defaultEngines()[0]!, name });

	test("upsert replaces by name in place, otherwise appends", () => {
		const l = [mk("A"), mk("B")];
		expect(upsertEngine(l, { ...mk("a"), urlTemplate: "https://new/" }).map((e) => e.urlTemplate)[0]).toBe("https://new/");
		expect(upsertEngine(l, mk("C")).map((e) => e.name)).toEqual(["A", "B", "C"]);
	});

	test("move clamps and no-ops at the ends", () => {
		const l = [mk("A"), mk("B"), mk("C")];
		expect(moveEngine(l, 2, -1).map((e) => e.name)).toEqual(["A", "C", "B"]);
		expect(moveEngine(l, 0, -1)).toBe(l);
		expect(moveEngine(l, 2, 1)).toBe(l);
	});

	test("merge counts added and replaced", () => {
		const r = mergeEngines([mk("A")], [mk("A"), mk("B")]);
		expect(r).toMatchObject({ added: 1, replaced: 1 });
		expect(r.list.map((e) => e.name)).toEqual(["A", "B"]);
	});

	test("coerceEngines repairs and drops", () => {
		expect(coerceEngines("x")).toBeUndefined();
		const l = coerceEngines([{ name: "A", urlTemplate: "https://a/", enabled: false }, { name: "" }, null])!;
		expect(l).toHaveLength(1);
		expect(l[0]).toMatchObject({ name: "A", enabled: false, method: "GET", urlParams: {} });
	});
});

describe("importFromZotero (read-only, injected reader)", () => {
	test("reads <dir>/locate/engines.json and merges", () => {
		const paths: string[] = [];
		const r = importFromZotero("C:/Z", (p) => {
			paths.push(p);
			return ZOTERO_JSON;
		});
		expect(paths[0]!.replace(/\\/g, "/")).toBe("C:/Z/locate/engines.json");
		expect(r.added + r.replaced).toBe(1);
	});

	test("missing or malformed files give a clear error", () => {
		expect(() =>
			importFromZotero("C:/Z", () => {
				throw new Error("ENOENT");
			}),
		).toThrow(/No Zotero engines/);
		expect(() => importFromZotero("C:/Z", () => "[]")).toThrow(/no usable/);
	});
});
