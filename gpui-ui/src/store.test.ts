// bun test src/store.test.ts -- the list store against a fake core (api.setDirect): failed pages, Retry, and selection that completes
// after the view changed. No window, no network: every /api request is answered by `core` below.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off"; // never touch the user's saved list preferences

type Handler = (url: URL) => Promise<Response> | Response | null;
let handler: Handler = () => null;
let indexHandler: Handler = () => null; // /api/items/index: where an item is in a listing
const allPaths: string[] = []; // every /api request the fake core got
const itemReqs: { offset: number; signal: AbortSignal }[] = []; // every GET /api/items, with the signal the store passed
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
		if (u.pathname === "/api/items" && req.method === "GET")
			itemReqs.push({ offset: Number(u.searchParams.get("offset") ?? 0), signal: req.signal });
		if (u.pathname === "/api/items" && req.method === "GET") return handler(u);
		if (u.pathname === "/api/items/index") return indexHandler(u);
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

describe("a range that takes a while to complete", () => {
	test("it still completes when the list refreshes in place meanwhile (a sync change, an edit)", async () => {
		handler = list(800);
		store.setView({ kind: "library" });
		await tick();
		store.setView({ kind: "trash" });
		await tick();
		const end = 5 * PAGE + 1;
		store.itemAt(end);
		await tick();
		store.selectOnly(store.peek(0)!.key, 0);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		handler = async (u) => {
			const off = Number(u.searchParams.get("offset"));
			if (off > 0 && off < 5 * PAGE) await gate;
			return list(800)(u);
		};
		store.selectClick(end, { shift: true, ctrl: false });
		await tick();
		store.refreshItems(["abstractNote"]); // same list, refetched in place
		await tick();
		release();
		await tick(80);
		expect(store.selected().size).toBe(end + 1);
	});

	test("extending a range longer than the page cache does not fetch all of it again for every row", async () => {
		handler = list(6000);
		store.setView({ kind: "unfiled" });
		await tick();
		const end = 40 * PAGE + 1;
		store.itemAt(end);
		await tick();
		store.setVisible?.(end, end + 2);
		await tick();
		store.selectOnly(`K${String(0).padStart(6, "0")}`, 0);
		store.selectClick(end, { shift: true, ctrl: false });
		await tick(150);
		expect(store.selected().size).toBe(end + 1);
		store.itemAt(end + 1);
		await tick();
		const before = itemReqs.length;
		expect(store.focusRow(end + 1, true)).toBe(true);
		await tick(150);
		expect(store.selected().size).toBe(end + 2);
		expect(itemReqs.length - before).toBeLessThanOrEqual(1);
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

describe("revealItem (Open in Zinc)", () => {
	test("an item missing from the tag-filtered list is found in My Library with the tag filter cleared", async () => {
		handler = list(30);
		store.setView({ kind: "library" });
		store.setTagFilter(["only-this"]);
		await tick();
		// the tagged list does not hold the item; the unfiltered library does, at row 7
		indexHandler = (u) => json({ index: u.searchParams.has("tag") ? -1 : 7 });
		const found = await store.revealItem("NOTINTAG");
		expect(store.tagFilter()).toEqual([]);
		expect(found).toBe(true);
		expect([...store.selected()]).toEqual(["NOTINTAG"]);
		expect(store.anchor()).toBe(7);
	});

	test("a request that a newer one replaced does not reset the list under it", async () => {
		handler = list(30);
		store.setView({ kind: "trash" });
		await tick();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// the older request's lookup is slow and finds nothing in this view; the newer one finds its item at once
		indexHandler = async (u) => {
			if (u.searchParams.get("key") === "OLDER") {
				await gate;
				return json({ index: -1 });
			}
			return json({ index: 3 });
		};
		const older = store.revealItem("OLDER");
		const newer = await store.revealItem("NEWER");
		expect(newer).toBe(true);
		release();
		expect(await older).toBe(false);
		await tick();
		expect(store.selected().has("NEWER")).toBe(true);
		expect(store.view().kind).toBe("trash"); // the older request did not send the list to My Library
	});
});

describe("a list that starts over while a fast scroll is settling", () => {
	test("the old list's settle step does not abort the new list's first page or ask for pages of the old position", async () => {
		handler = list(1000);
		store.setView({ kind: "publications" });
		await tick();
		store.setVisible(0, 10);
		store.setVisible(700, 710); // a big jump: the settle timer (90 ms) is armed with the range around row 700
		// a different list begins now; its first page is slow
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) === 0) await tick(250);
			return list(1000)(u);
		};
		itemReqs.length = 0;
		store.setView({ kind: "unfiled" });
		await tick(180); // past the old settle timer
		const first = itemReqs.find((r) => r.offset === 0);
		expect(first).toBeDefined();
		expect(first!.signal.aborted).toBe(false);
		expect(itemReqs.some((r) => r.offset >= 5 * PAGE)).toBe(false);
		await tick(200);
		expect(store.peek(0)?.title).toBe("T0");
	});
});

describe("a page that failed", () => {
	test("rows coming into view and scrolling do not ask for it again; Retry does", async () => {
		handler = (u) => (Number(u.searchParams.get("offset")) === PAGE ? json({ error: "core down" }, 500) : list(300)(u));
		store.setView({ kind: "trash" });
		await tick();
		store.itemAt(PAGE + 1);
		await tick();
		expect(store.failedPages()).toBe(1);
		const asked = () => itemReqs.filter((r) => r.offset === PAGE).length;
		const before = asked();
		for (let i = 0; i < 5; i++) {
			store.itemAt(PAGE + 2 + i); // another row of the failed page mounts
			store.setVisible(PAGE - 10 + i, PAGE + 10 + i); // a scroll event with the page in view
			await tick(5);
		}
		await tick();
		expect(asked()).toBe(before);
		handler = list(300);
		store.retryFailed();
		await tick();
		expect(store.failedPages()).toBe(0);
		expect(store.peek(PAGE + 1)?.title).toBe(`T${PAGE + 1}`);
	});
});

describe("Shift+click across pages that are not loaded yet", () => {
	const gate = () => {
		let release!: () => void;
		const p = new Promise<void>((r) => {
			release = r;
		});
		return { p, release };
	};
	/** A list of `total` rows with page 0 and the page of `last` loaded, ready for a Shift+click from row 0 to `last`. */
	async function setup(total: number, last: number, kind: "trash" | "unfiled") {
		handler = list(total);
		store.setView({ kind: "library" }); // a fresh list each time: the same view as before would keep the old rows and total
		await tick();
		store.setView({ kind });
		await tick();
		store.itemAt(last); // the page the click lands on
		await tick();
		store.selectOnly(store.peek(0)!.key, 0);
	}

	test("a page that is already being fetched is waited for, not skipped", async () => {
		await setup(1000, 5 * PAGE + 1, "trash");
		const g = gate();
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) === 2 * PAGE) await g.p; // page 2: a prefetch that has not come back yet
			return list(1000)(u);
		};
		store.itemAt(2 * PAGE + 1); // starts the page-2 request
		await tick();
		store.selectClick(5 * PAGE + 1, { shift: true, ctrl: false });
		await tick(50); // pages 1, 3 and 4 are in; page 2 is still out
		g.release();
		await tick(50);
		expect(store.selected().size).toBe(5 * PAGE + 2);
	});

	test("a range longer than the page cache still selects every row", async () => {
		const last = 29 * PAGE + 50; // 30 pages: more than the cache holds
		await setup(3000, last, "unfiled");
		store.selectClick(last, { shift: true, ctrl: false });
		await tick(200);
		expect(store.selected().size).toBe(last + 1);
		expect(store.selected().has(`K${String(last).padStart(6, "0")}`)).toBe(true);
		expect(store.selected().has(`K${String(1234).padStart(6, "0")}`)).toBe(true);
	});

	test("a click made while the pages load wins over the range that was waiting", async () => {
		await setup(1000, 5 * PAGE + 1, "trash");
		const g = gate();
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) >= PAGE) await g.p;
			return list(1000)(u);
		};
		store.selectClick(5 * PAGE + 1, { shift: true, ctrl: false });
		store.selectClick(3, { shift: false, ctrl: false }); // the user clicks another row before the range completes
		g.release();
		await tick(80);
		expect([...store.selected()]).toEqual([store.peek(3)!.key]);
	});

	test("the keys that are known now are selected at once, the rest follow", async () => {
		await setup(1000, 5 * PAGE + 1, "unfiled");
		const g = gate();
		handler = async (u) => {
			if (Number(u.searchParams.get("offset")) >= PAGE && Number(u.searchParams.get("offset")) < 5 * PAGE) await g.p;
			return list(1000)(u);
		};
		store.selectClick(5 * PAGE + 1, { shift: true, ctrl: false });
		expect(store.selected().size).toBeGreaterThan(0);
		expect(store.selected().size).toBeLessThan(5 * PAGE + 2);
		g.release();
		await tick(80);
		expect(store.selected().size).toBe(5 * PAGE + 2);
	});
});

describe("Select All and a click that comes after it", () => {
	test("the click wins when the keys arrive later", async () => {
		handler = list(40);
		store.setView({ kind: "library" });
		await tick();
		store.setView({ kind: "trash" });
		await tick();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		handler = async (u) => {
			if (u.searchParams.get("limit") === "1000") await gate;
			return list(150)(u);
		};
		store.setView({ kind: "unfiled" });
		await tick();
		handler = async (u) => {
			if (u.searchParams.get("limit") === "1000") await gate;
			return list(150)(u);
		};
		store.selectAll(); // 150 rows: the keys-only request is held
		store.selectOnly(store.peek(2)!.key, 2); // the user picks one row meanwhile
		release();
		await tick(50);
		expect([...store.selected()]).toEqual([store.peek(2)!.key]);
	});
});

describe("isSelected, drag scroll, and visible-page priority", () => {
	test("isSelected matches selected() keys", async () => {
		handler = list(30);
		store.setView({ kind: "trash" });
		await tick();
		const k0 = store.peek(0)!.key;
		const k1 = store.peek(1)!.key;
		store.selectOnly(k0, 0);
		expect(store.isSelected(k0)).toBe(true);
		expect(store.isSelected(k1)).toBe(false);
		store.selectOnly(k1, 1);
		expect(store.isSelected(k0)).toBe(false);
		expect(store.isSelected(k1)).toBe(true);
	});

	test("beginDragScroll defers fetches while dragging and endDragScroll fetches immediately", async () => {
		const offsets: number[] = [];
		handler = (u) => {
			offsets.push(Number(u.searchParams.get("offset") ?? 0));
			return list(2000)(u);
		};
		store.setView({ kind: "unfiled" });
		await tick();
		store.setVisible(0, 10);
		await tick(40);

		const beforeDrag = offsets.length;
		store.beginDragScroll();
		store.setVisible(500, 510);
		store.setVisible(1000, 1010);
		store.setVisible(1500, 1510);
		await tick(5);
		expect(offsets.length).toBe(beforeDrag);

		store.endDragScroll();
		await tick(10);
		// Visible page 15 (offset 1500) must start immediately without waiting for SETTLE_MS, before any prefetch
		expect(offsets[beforeDrag]).toBe(1500);
	});

	test("visible pages fetch before prefetch pages", async () => {
		const offsets: number[] = [];
		let releaseVisible!: () => void;
		const gate = new Promise<void>((r) => {
			releaseVisible = r;
		});
		handler = async (u) => {
			const off = Number(u.searchParams.get("offset") ?? 0);
			offsets.push(off);
			if (off === 800) await gate;
			return list(2000)(u);
		};
		store.setView({ kind: "publications" });
		await tick(40);
		const mark = offsets.length;
		store.setVisible(800, 810);
		await tick(5);
		// Only visible page 8 (offset 800) is requested while it is in flight; prefetch waits until it resolves
		expect(offsets.slice(mark)).toEqual([800]);
		releaseVisible();
		await tick(40);
		expect(offsets.slice(mark)).toContain(900);
	});
});
