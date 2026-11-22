// DOIs may contain characters that mean something in a URL (? # & + | ,). Every reference request must keep the DOI inside its
// own path segment or filter value, with "/" left alone (the APIs take it raw). No live requests: fetch is replaced.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { safeUrl } from "../../src/api";
import { net, setFetch } from "../../src/references/net";
import {
	crossrefWork,
	openAlexByDois,
	openAlexLookup,
	openAlexReferences,
	semanticScholarReferences,
} from "../../src/references/sources";

let calls: string[];
const retries = net.retries;
beforeEach(() => {
	calls = [];
	net.retries = 0;
	setFetch(async (input) => {
		calls.push(input);
		return new Response("nf", { status: 404 });
	});
});
afterEach(() => {
	setFetch();
	net.retries = retries;
});

const DOI = "10.1002/abc#def?x&y+z";

describe("DOI in a URL", () => {
	test("path APIs: ? and # are escaped, / is kept, mailto stays a query parameter", async () => {
		await openAlexReferences(DOI, "me@example.org");
		await openAlexLookup({ doi: DOI }, "me@example.org");
		await crossrefWork(DOI, "me@example.org");
		await semanticScholarReferences(DOI);
		expect(calls.length).toBe(4);
		for (const c of calls) {
			const u = new URL(c);
			expect(u.hash).toBe("");
			expect(u.pathname).toContain("10.1002/abc%23def%3Fx&y+z");
		}
		for (const c of calls.slice(0, 3)) {
			const u = new URL(c);
			expect(u.searchParams.get("mailto")).toBe("me@example.org");
			expect([...u.searchParams.keys()].filter((k) => k !== "mailto" && k !== "select")).toEqual([]);
		}
	});

	test("an ordinary DOI is requested exactly as before", async () => {
		await crossrefWork("10.1371/journal.pmed.1000097", null);
		expect(calls).toEqual(["https://api.crossref.org/works/10.1371/journal.pmed.1000097"]);
	});

	test("the OpenAlex filter keeps each DOI as one value", async () => {
		await openAlexByDois(["10.1/a#b", "10.1/c&d=e", "10.1/plain", "10.1/has,comma", "10.1/has|bar"], "me@example.org");
		expect(calls.length).toBe(1);
		const u = new URL(calls[0]!);
		expect(u.hash).toBe("");
		const filter = u.searchParams.get("filter")!;
		expect(filter).toBe("doi:https://doi.org/10.1/a#b|https://doi.org/10.1/c&d=e|https://doi.org/10.1/plain");
		expect(u.searchParams.get("per-page")).toBe("50");
		expect(u.searchParams.get("mailto")).toBe("me@example.org");
	});

	test("a doi: link opened in the browser keeps the whole DOI in the path", () => {
		expect(new URL(safeUrl("doi:" + DOI)).hash).toBe("");
		expect(safeUrl("doi:10.1371/journal.pmed.1000097")).toBe("https://doi.org/10.1371/journal.pmed.1000097");
	});
});
