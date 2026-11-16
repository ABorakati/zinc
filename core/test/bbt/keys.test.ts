// Citation keys: generation, duplicate disambiguation, pins (citationKey field and Extra), regeneration on edit,
// and survival of changes made behind the API's back (sync writes raw SQL).
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createItem, listItems, openDb, patchItem } from "../../src/db";
import {
	backfillKeys,
	checkFormula,
	flushDirty,
	getKeyInfo,
	getKeyInfos,
	getSettings,
	itemsForCitekey,
	pinKey,
	previewFormula,
	refreshKeys,
	setSettings,
	staleKeyCount,
	unpinKey,
} from "../../src/bbt";
import { insertItem, tempDir } from "../fixture";

let db: Database;
beforeEach(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
});

const smith = (extra: Record<string, unknown> = {}) => ({
	itemType: "journalArticle",
	title: "Deep learning for radiology",
	creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
	date: "2020-05-01",
	...extra,
});
let seq = 0;
const add = (data: Record<string, unknown>) => {
	const k = `ITM${String(++seq).padStart(5, "0")}`;
	insertItem(db, { key: k, ...data } as never);
	return k;
};
const key = (k: string) => getKeyInfo(db, k)?.key;

describe("generation", () => {
	test("each regular item gets a key from the default formula; notes and attachments do not", () => {
		const a = createItem(db, smith()).data.key;
		const note = createItem(db, { itemType: "note", note: "<p>x</p>", parentItem: a }).data.key;
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		expect(getKeyInfo(db, note)).toBeNull();
		expect(getKeyInfo(db, a)).toEqual({ key: "smithDeepLearningRadiology2020", pinned: false });
	});

	test("keys are stored in a table with the formula version", () => {
		const a = createItem(db, smith()).data.key;
		key(a);
		const row = db.query("SELECT key, pinned, formula FROM bbt_keys WHERE item_key = ?").get(a) as {
			key: string;
			pinned: number;
			formula: string;
		};
		expect(row.key).toBe("smithDeepLearningRadiology2020");
		expect(row.pinned).toBe(0);
		expect(row.formula.length).toBeGreaterThan(0);
	});

	test("duplicates are disambiguated a, b, c in the order items were added", () => {
		const keys = [1, 2, 3, 4].map((i) => add(smith({ dateAdded: `2024-01-0${i}T00:00:00Z` })));
		expect(keys.map(key)).toEqual([
			"smithDeepLearningRadiology2020",
			"smithDeepLearningRadiology2020a",
			"smithDeepLearningRadiology2020b",
			"smithDeepLearningRadiology2020c",
		]);
	});

	test("duplicate checking ignores case by default and can be case sensitive", () => {
		const a = createItem(db, smith({ title: "alpha beta gamma" })).data.key;
		const b = createItem(db, smith({ title: "Alpha Beta Gamma", creators: [{ creatorType: "author", lastName: "SMITH" }] })).data.key;
		// "smithalphabetagamma2020" vs "SMITH..." do not collide as generated (lower filter only on auth): force a collision
		pinKey(db, a, "Smith2020");
		const c = createItem(db, smith({ title: "zeta" })).data.key;
		pinKey(db, c, "smith2020"); // two pinned keys that differ only in case stay as pinned
		expect(key(a)).toBe("Smith2020");
		expect(key(c)).toBe("smith2020");
		expect(key(b)).toBeTruthy();
		setSettings(db, { citekeyFormat: "'smith2020'" });
		const d = createItem(db, smith({ title: "other" })).data.key;
		expect(key(d)).toBe("smith2020a"); // ignores case: smith2020 / Smith2020 are taken
		setSettings(db, { keyCaseInsensitive: false });
		refreshKeys(db, [d]);
		expect(key(d)).toBe("smith2020a".replace("a", "a")); // still a: smith2020 itself exists exactly (pinned c)
	});

	test("the postfix can be changed (numeric, uppercase)", () => {
		setSettings(db, { postfix: "-%(n)s" });
		const a = createItem(db, smith()).data.key;
		const b = add(smith({ dateAdded: "2030-01-01T00:00:00Z" }));
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		expect(key(b)).toBe("smithDeepLearningRadiology2020-1");
	});

	test("a formula with an alternative falls back when the first part is empty", () => {
		setSettings(db, { citekeyFormat: "auth.len + year; title.lower.select(1,1) + year" });
		const a = createItem(db, { itemType: "book", title: "Anonymous Works", date: "1999" }).data.key;
		expect(key(a)).toBe("anonymous1999");
	});

	test("an item that yields no text gets its item key", () => {
		setSettings(db, { citekeyFormat: "auth" });
		const a = createItem(db, { itemType: "book", title: "x" }).data.key;
		expect(key(a)).toBe(a.toLowerCase());
	});

	test("formula validation and preview", () => {
		expect(checkFormula("auth.lower + year")).toBeNull();
		expect(checkFormula("auth.bogus")?.error).toContain("unknown filter");
		const a = createItem(db, smith()).data.key;
		expect(previewFormula(db, "auth.upper + year", a)).toEqual({ ok: true, preview: "SMITH2020" });
		expect(previewFormula(db, "nope", a).ok).toBe(false);
		expect(previewFormula(db, "auth.lower + year").preview).toBe("smith2020"); // sample item
	});
});

describe("pins", () => {
	test("the citationKey field pins a key, and it overrides generation", () => {
		const a = createItem(db, smith({ citationKey: "my-key" })).data.key;
		expect(getKeyInfo(db, a)).toEqual({ key: "my-key", pinned: true });
	});

	test("a `Citation Key:` line in Extra pins too; the field wins when both exist", () => {
		const a = createItem(db, smith({ extra: "Citation Key: fromExtra\nother: line" })).data.key;
		expect(getKeyInfo(db, a)).toEqual({ key: "fromExtra", pinned: true });
		patchItem(db, a, { citationKey: "fromField" });
		flushDirty(db);
		expect(getKeyInfo(db, a)).toEqual({ key: "fromField", pinned: true });
	});

	test("pin stores the key in the citationKey field (which syncs) and keeps it when the item changes", () => {
		const a = createItem(db, smith()).data.key;
		expect(pinKey(db, a)).toEqual({ key: "smithDeepLearningRadiology2020", pinned: true });
		const data = JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(a) as { data: string }).data);
		expect(data.citationKey).toBe("smithDeepLearningRadiology2020");
		patchItem(db, a, { title: "A completely different title" });
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
	});

	test("pin with an explicit key, and Extra lines are cleaned so the field is the single source", () => {
		const a = createItem(db, smith({ extra: "Citation Key: old\nkeep: me" })).data.key;
		expect(pinKey(db, a, "custom2020")).toEqual({ key: "custom2020", pinned: true });
		const data = JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(a) as { data: string }).data);
		expect(data.extra).toBe("keep: me");
		expect(() => pinKey(db, a, "bad key{")).toThrow();
	});

	test("unpin removes the pin and generates a fresh key", () => {
		const a = createItem(db, smith({ citationKey: "pinned1" })).data.key;
		expect(key(a)).toBe("pinned1");
		expect(unpinKey(db, a)).toEqual({ key: "smithDeepLearningRadiology2020", pinned: false });
		const data = JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(a) as { data: string }).data);
		expect(data.citationKey ?? "").toBe("");
	});

	test("a generated key that collides with a pinned key moves aside", () => {
		const a = createItem(db, smith({ citationKey: "smithDeepLearningRadiology2020" })).data.key;
		const b = createItem(db, smith()).data.key;
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		expect(key(b)).toBe("smithDeepLearningRadiology2020a");
	});
});

describe("regeneration", () => {
	test("editing a field that matters regenerates an unpinned key (hooked through the item update path)", () => {
		const a = createItem(db, smith()).data.key;
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		patchItem(db, a, { date: "2021" });
		expect(key(a)).toBe("smithDeepLearningRadiology2021");
		patchItem(db, a, { title: "Neural networks" });
		expect(key(a)).toBe("smithNeuralNetworks2021");
	});

	test("changes that do not touch the key inputs keep the key, even if a later item would have the plain key", () => {
		const a = createItem(db, smith()).data.key;
		const b = add(smith({ dateAdded: "2030-01-01T00:00:00Z" }));
		expect(key(b)).toBe("smithDeepLearningRadiology2020a");
		patchItem(db, b, { tags: [{ tag: "x" }] });
		expect(key(b)).toBe("smithDeepLearningRadiology2020a");
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
	});

	test("writes that bypass the API (sync) are picked up too", () => {
		const a = createItem(db, smith()).data.key;
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		db.query("UPDATE items SET data = json_set(data, '$.date', '2019') WHERE key = ?").run(a);
		expect(key(a)).toBe("smithDeepLearningRadiology2019");
		// a row inserted by raw SQL (as the Zotero sync does)
		insertItem(db, {
			key: "SYNCED01",
			itemType: "book",
			title: "Synced Book",
			creators: [{ creatorType: "author", lastName: "Wu" }],
			date: "2001",
		});
		expect(key("SYNCED01")).toBe("wuSyncedBook2001");
		// and a pinned key arriving through sync
		db.query("UPDATE items SET data = json_set(data, '$.citationKey', 'synced-pin') WHERE key = 'SYNCED01'").run();
		expect(getKeyInfo(db, "SYNCED01")).toEqual({ key: "synced-pin", pinned: true });
	});

	test("changing the formula leaves keys alone until Refresh; staleKeyCount says how many are old", () => {
		const a = createItem(db, smith()).data.key;
		const b = createItem(db, smith({ title: "Other thing", citationKey: "pinnedB" })).data.key;
		expect(key(a)).toBe("smithDeepLearningRadiology2020");
		setSettings(db, { citekeyFormat: "auth.lower + year" });
		expect(key(a)).toBe("smithDeepLearningRadiology2020"); // untouched
		expect(staleKeyCount(db)).toBe(1);
		expect(refreshKeys(db)).toBeGreaterThan(0);
		expect(key(a)).toBe("smith2020");
		expect(key(b)).toBe("pinnedB"); // pinned keys are never touched
		expect(staleKeyCount(db)).toBe(0);
	});

	test("bulk refresh is deterministic: the earliest item keeps the plain key", () => {
		const first = add(smith({ dateAdded: "2020-01-01T00:00:00Z" }));
		const second = add(smith({ dateAdded: "2021-01-01T00:00:00Z" }));
		key(first);
		key(second);
		refreshKeys(db);
		expect(key(first)).toBe("smithDeepLearningRadiology2020");
		expect(key(second)).toBe("smithDeepLearningRadiology2020a");
	});

	test("trashing a duplicate frees its key, restoring it does not create a clash", () => {
		const a = add(smith({ dateAdded: "2020-01-01T00:00:00Z" }));
		const b = add(smith({ dateAdded: "2021-01-01T00:00:00Z" }));
		expect(key(b)).toBe("smithDeepLearningRadiology2020a");
		patchItem(db, a, { deleted: 1 });
		const c = add(smith({ dateAdded: "2022-01-01T00:00:00Z" }));
		expect(key(c)).toBe("smithDeepLearningRadiology2020"); // a is in the trash: its key is free
		patchItem(db, a, { deleted: 0 });
		expect(key(a)).not.toBe(key(c));
	});

	test("deleting an item removes its key row", () => {
		const a = createItem(db, smith()).data.key;
		key(a);
		db.query("DELETE FROM items WHERE key = ?").run(a);
		expect(db.query("SELECT count(*) AS n FROM bbt_keys").get()).toEqual({ n: 0 });
	});
});

describe("lookups, listing and search", () => {
	test("itemsForCitekey finds by key, case-insensitively", () => {
		const a = createItem(db, smith()).data.key;
		expect(itemsForCitekey(db, "SMITHdeeplearningradiology2020")).toEqual([a]);
		expect(itemsForCitekey(db, "nope")).toEqual([]);
	});

	test("the Citation Key column (fields=citationKey) and sort see generated and pinned keys", () => {
		const a = createItem(db, smith()).data.key;
		const b = createItem(db, smith({ title: "Zebras", citationKey: "pinned-b" })).data.key;
		const list = listItems(db, { fields: ["citationKey"], sort: "citationKey", dir: "asc", limit: 10 });
		const byKey = Object.fromEntries(list.items.map((i) => [i.key, i.fields?.citationKey]));
		expect(byKey[a]).toBe("smithDeepLearningRadiology2020");
		expect(byKey[b]).toBe("pinned-b");
		expect(list.items.map((i) => i.key)).toEqual([b, a].sort((x, y) => (byKey[x]! < byKey[y]! ? -1 : 1)));
	});

	test("quick search matches citekeys", () => {
		const a = createItem(db, smith({ title: "Quiet topic", date: "1999" })).data.key;
		createItem(db, smith({ title: "Another", creators: [{ creatorType: "author", lastName: "Other" }] }));
		patchItem(db, a, { citationKey: "zzmarker2" });
		flushDirty(db); // the app's scheduler does this every second; search itself never pays for it
		const r = listItems(db, { q: "zzmarker" });
		expect(r.items.map((i) => i.key)).toEqual([a]);
	});

	test("backfill generates keys for items that never had one", () => {
		insertItem(db, {
			key: "OLDITEM1",
			itemType: "book",
			title: "Old Book",
			creators: [{ creatorType: "author", lastName: "Li" }],
			date: "1990",
		});
		db.query("DELETE FROM bbt_dirty").run();
		db.query("DELETE FROM bbt_keys").run();
		expect(backfillKeys(db)).toBe(1);
		expect(getKeyInfos(db, ["OLDITEM1"]).OLDITEM1?.key).toBe("liOldBook1990");
	});

	test("settings round trip and validation", () => {
		expect(getSettings(db).citekeyFormat).toBe("auth.lower + shorttitle(3,3) + year");
		expect(setSettings(db, { quickCopy: "pandoc", autoExportDelay: 2 }).quickCopy).toBe("pandoc");
		expect(() => setSettings(db, { nope: 1 } as never)).toThrow("unknown setting");
		expect(() => setSettings(db, { citekeyFold: "yes" } as never)).toThrow("must be a boolean");
	});
});
