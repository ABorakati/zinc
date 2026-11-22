// bun test src/cards/SearchResults.test.tsx -- the snippet parser and the full-text search request. No window, no network: /api/search is
// answered by a fake core (api.setDirect).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

process.env.ZN_UI_STATE = "off"; // never touch the user's saved list preferences

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const searches: { q: string; signal: AbortSignal }[] = [];

let parseSnippet: typeof import("./SearchResults").parseSnippet;
let SearchResults: typeof import("./SearchResults").SearchResults;
let store: typeof import("../store").store;

/** The marked parts of a parsed snippet, as the text the renderer would highlight. */
const marked = (html: string) => {
	const { text, ranges } = parseSnippet(html);
	return ranges.map(([a, b]) => text.slice(a, b));
};

beforeAll(async () => {
	const api = await import("../api");
	api.setDirect(async (req) => {
		const u = new URL(req.url);
		if (u.pathname === "/api/search") {
			searches.push({ q: u.searchParams.get("q") ?? "", signal: req.signal });
			return new Promise<Response>(() => {}); // never answers: the request stays in flight until it is aborted
		}
		if (u.pathname === "/api/items") return json({ total: 0, items: [] });
		if (u.pathname === "/api/items/groups") return json({ groups: [] });
		if (u.pathname === "/api/collections") return json([]);
		if (u.pathname === "/api/libraries") return json({ libraries: [] });
		return null;
	});
	({ parseSnippet, SearchResults } = await import("./SearchResults"));
	({ store } = await import("../store"));
});
afterAll(() => {
	store.setFilter("");
});

describe("snippet highlight ranges", () => {
	test("a plain snippet", () => {
		expect(marked("a <mark>needle</mark> b")).toEqual(["needle"]);
	});
	test("line breaks before the match shrink the text but not the highlight", () => {
		expect(parseSnippet("a\r\nb <mark>needle</mark> c").text).toBe("a b needle c");
		expect(marked("a\r\nb <mark>needle</mark> c")).toEqual(["needle"]);
		expect(marked("a\n\nb <mark>needle</mark> c")).toEqual(["needle"]);
		expect(marked("a\n   b <mark>needle</mark> c")).toEqual(["needle"]);
		expect(marked("<mark>x</mark>\r\n\r\n  <mark>needle</mark>\n")).toEqual(["x", "needle"]);
	});
	test("a match that contains a line break keeps its words", () => {
		expect(marked("a <mark>two\r\nwords</mark> c")).toEqual(["two words"]);
	});
	test("spaces without a line break are left alone", () => {
		expect(parseSnippet("a  b <mark>n</mark>").text).toBe("a  b n");
		expect(marked("a  b <mark>n</mark>")).toEqual(["n"]);
	});
});

describe("the full-text search request", () => {
	test("a newer search aborts the older request, and leaving the view aborts the last", async () => {
		searches.length = 0;
		let dispose!: () => void;
		createRoot((d) => {
			dispose = d;
			SearchResults();
		});
		store.setFilter("first");
		await sleep(400);
		expect(searches.map((s) => s.q)).toEqual(["first"]);
		expect(searches[0]!.signal.aborted).toBe(false);
		store.setFilter("second");
		await sleep(400);
		expect(searches.map((s) => s.q)).toEqual(["first", "second"]);
		expect(searches[0]!.signal.aborted).toBe(true);
		expect(searches[1]!.signal.aborted).toBe(false);
		dispose();
		expect(searches[1]!.signal.aborted).toBe(true);
	});
});
