// bun test src/store.test.ts -- the list store against a fake core (api.setDirect): failed pages, Retry, and selection that completes
// after the view changed. No window, no network: every /api request is answered by `core` below.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off"; // never touch the user's saved list preferences

type Handler = (url: URL) => Promise<Response> | Response | null;
let handler: Handler = () => null;
const allPaths: string[] = []; // every /api request the fake core got
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const rows = (from: number, n: number) =>
	Array.from({ length: n }, (_, i) => ({
		key: `K${String(from + i).padStart(6, "0")}`,
		itemType: "journalArticle",
		title: `T${from + i}`,
		year: 2020,
		dateAdded: "",
		attachmentCount: 0,
		noteCount: 0,
		tags: [],
	}));
/** A list of `total` items: pages answered from the offset. */
const list = (total: number) => (u: URL) => {
	const off = Number(u.searchParams.get("offset") ?? 0),
		lim = Number(u.searchParams.get("limit") ?? 100);
	return json({ total, items: rows(off, Math.max(0, Math.min(lim, total - off))) });
};
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

let store: typeof import("./store").store;
let PAGE: number;

beforeAll(async () => {
	const api = await import("./api");
	api.setDirect(async (req) => {
		const u = new URL(req.url);
		allPaths.push(u.pathname);
		if (u.pathname === "/api/items" && req.method === "GET") return handler(u);
		if (u.pathname === "/api/items/groups") return json({ groups: [] });
		if (u.pathname === "/api/collections") return json([]);
		if (u.pathname === "/api/libraries")
			return json({ libraries: [{ id: 1, type: "user", name: "My Library", editable: true, filesEditable: true }] });
		if (u.pathname === "/api/ui/selection") return json({});
		return null;
	});
	({ store } = await import("./store"));
	({ PAGE } = await import("./store"));
});
afterAll(() => {
	handler = () => null;
});

describe("failed list pages", () => {
	test("a failed page is counted, shown as an error, and Retry loads it", async () => {
		let failPage1 = true;
		handler = (u) => (Number(u.searchParams.get("offset")) === 100 && failPage1 ? json({ error: "boom" }, 500) : list(250)(u));
		store.setView({ kind: "trash" }); // a different list: starts over, page 0 loads
		await tick();
		expect(store.total()).toBe(250);
		expect(store.failedPages()).toBe(0);

		store.itemAt(PAGE + 5); // a row of page 1 comes into view
		await tick();
		expect(store.failedPages()).toBe(1);
		expect(store.error()).toBe("boom");
		expect(store.peek(PAGE + 5)).toBeUndefined();

		failPage1 = false;
		store.retryFailed();
		await tick();
		expect(store.failedPages()).toBe(0);
		expect(store.error()).toBeNull();
		expect(store.peek(PAGE + 5)?.title).toBe(`T${PAGE + 5}`);
	});

	test("a new list forgets the failures of the old one", async () => {
		handler = (u) => (Number(u.searchParams.get("offset")) === 100 ? json({ error: "boom" }, 500) : list(250)(u));
		store.setView({ kind: "unfiled" });
		await tick();
		store.itemAt(PAGE + 1);
		await tick();
		expect(store.failedPages()).toBe(1);
		handler = list(10);
		store.setView({ kind: "library" });
		await tick();
		expect(store.failedPages()).toBe(0);
		expect(store.error()).toBeNull();
	});
});

describe("selection that completes after the view changed", () => {
	test("Select All of a big list is dropped when the list changed meanwhile", async () => {
		handler = list(150);
		store.setView({ kind: "trash" });
		await tick();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// the keys-only request (limit 1000) waits; the new list's page 0 does not
		handler = async (u) => {
			if (u.searchParams.get("limit") === "1000") {
				await gate;
				return list(150)(u);
			}
			return list(7)(u);
		};
		store.selectAll();
		store.setView({ kind: "unfiled" });
		await tick();
		release();
		await tick();
		expect(store.selected().size).toBe(0);
	});

	test("Select All of a small list (one page) is dropped the same way", async () => {
		handler = list(40);
		store.setView({ kind: "trash" });
		await tick();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// selectAll reloads the page through loadPage (the old generation): hold that request, change the list, then release it
		handler = async (u) => {
			if (u.searchParams.get("limit") === String(PAGE) && !u.searchParams.has("hold")) {
				await gate;
			}
			return list(40)(u);
		};
		store.selectAll();
		store.setView({ kind: "library" });
		await tick();
		release();
		await tick();
		expect(store.selected().size).toBe(0);
	});

	test("a Shift range across uncached pages does not select rows of the next list", async () => {
		handler = list(400);
		store.setView({ kind: "trash" });
		await tick();
		store.selectOnly(store.peek(0)!.key, 0);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) > 0) await gate;
			return list(400)(u);
		};
		store.selectClick(0, { shift: false, ctrl: false });
		store.itemAt(0);
		// the click the range ends at must be loaded to be clicked: load page 3, then hold the pages in between
		handler = list(400);
		store.itemAt(3 * PAGE + 1);
		await tick();
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) > 0) await gate;
			return list(400)(u);
		};
		store.selectClick(3 * PAGE + 1, { shift: true, ctrl: false });
		store.setView({ kind: "unfiled" });
		handler = () => new Promise<Response>(() => {}); // the new list never lands: its rows are the old ones, as far as the cache knows
		await tick();
		release();
		await tick();
		// only what the click itself selected before the list changed; the completion added nothing
		expect(store.selected().size).toBeLessThanOrEqual(1);
	});
});

describe("refreshItems (an edit in the item pane)", () => {
	test("duplicate-relevant fields are told apart from the rest", async () => {
		const { affectsDuplicates } = await import("./store");
		expect(affectsDuplicates(["title"])).toBe(true);
		expect(affectsDuplicates(["creators"])).toBe(true);
		expect(affectsDuplicates(["DOI"])).toBe(true);
		expect(affectsDuplicates(["abstractNote", "extra", "volume"])).toBe(false);
		expect(affectsDuplicates([])).toBe(false);
	});

	test("refetches the list and nothing else: no collection or library requests", async () => {
		handler = list(30);
		store.setView({ kind: "library" });
		await tick();
		const from = allPaths.length;
		store.refreshItems(["abstractNote"]);
		await tick();
		const seen = allPaths.slice(from);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((p) => p === "/api/items" || p === "/api/items/groups")).toBe(true);
	});
});
