// bun test src/sidebar/collectionStyle.test.ts -- the sidecar store, always on a temp dir (never the real %APPDATA% file).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectionStyleStore, parseStyleData } from "./collectionStyle";

const dir = mkdtempSync(join(tmpdir(), "zn-collection-style-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `s${n++}`, "collection-style.json"); // the store creates the directory

describe("persistence", () => {
	test("writes atomically after a debounce and reloads everything", async () => {
		const path = file();
		const s = createCollectionStyleStore({ path, debounceMs: 20 });
		s.setSort("items"); s.setGroup("section");
		s.setColor("K1", "rose"); s.setIcon("K1", "book"); s.addSection("Reading"); s.setSection("K1", "Reading");
		s.pin("K2"); s.pin("K1"); s.toggleCollapsed("sec:Reading");
		expect(existsSync(path)).toBe(false); // debounced
		await Bun.sleep(80);
		expect(readdirSync(join(path, ".."))).toEqual(["collection-style.json"]); // no temp file left behind
		const again = createCollectionStyleStore({ path }).get();
		expect(again).toMatchObject({ sort: "items", group: "section", sections: ["Reading"], pins: ["K2", "K1"], collapsed: ["sec:Reading"] });
		expect(again.styles.K1).toEqual({ color: "rose", icon: "book", section: "Reading" });
	});
	test("many changes make one write; flush writes at once", async () => {
		const path = file();
		const s = createCollectionStyleStore({ path, debounceMs: 30 });
		for (let i = 0; i < 20; i++) s.setColor(`K${i}`, "blue");
		s.flush();
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).styles)).toHaveLength(20);
	});
	test("path null keeps it in memory; a corrupt file loads defaults", () => {
		const s = createCollectionStyleStore({ path: null });
		s.setColor("K", "blue");
		s.flush();
		expect(s.styleOf("K")).toEqual({ color: "blue" });
		const bad = file();
		createCollectionStyleStore({ path: bad }).flush();
		writeFileSync(bad, "{ not json");
		expect(createCollectionStyleStore({ path: bad }).get().sort).toBe("name-asc");
	});
	test("parseStyleData drops wrong-shaped parts", () => {
		const d = parseStyleData({ prefs: { sort: "bogus", group: "colour" }, sections: [1], pins: ["a", "a"], styles: { x: { color: "nope", icon: 3 }, y: { color: "blue" } } });
		expect(d).toMatchObject({ sort: "name-asc", group: "colour", sections: [], pins: ["a"], styles: { y: { color: "blue" } } });
	});
});

describe("edits", () => {
	test("colour None and the default icon remove the entry", () => {
		const s = createCollectionStyleStore({ path: null });
		s.setColor("K", "blue"); s.setIcon("K", "star");
		s.setColor("K", undefined); s.setIcon("K", "folder");
		expect(s.get().styles.K).toBeUndefined();
		s.setColor("K", "not-a-colour");
		expect(s.get().styles.K).toBeUndefined();
	});
	test("sections: unique names, rename follows members, delete releases them", () => {
		const s = createCollectionStyleStore({ path: null });
		expect(s.addSection(" Reading ")).toBe(true);
		expect(s.addSection("Reading")).toBe(false);
		expect(s.addSection("  ")).toBe(false);
		s.setSection("K", "Reading"); s.toggleCollapsed("sec:Reading");
		expect(s.renameSection("Reading", "Papers")).toBe(true);
		expect(s.get().styles.K!.section).toBe("Papers");
		expect(s.get().collapsed).toEqual(["sec:Papers"]);
		s.deleteSection("Papers");
		expect(s.get()).toMatchObject({ sections: [], collapsed: [] });
		expect(s.get().styles.K).toBeUndefined();
	});
	test("pins keep pin order, unpin and forget remove", () => {
		const s = createCollectionStyleStore({ path: null });
		s.pin("B"); s.pin("A"); s.pin("B");
		expect(s.get().pins).toEqual(["B", "A"]);
		s.unpin("B");
		expect(s.isPinned("A") && !s.isPinned("B")).toBe(true);
		s.setColor("A", "blue"); s.forget("A");
		expect(s.get().pins).toEqual([]);
		expect(s.get().styles.A).toBeUndefined();
	});
	test("onChange fires on every real change only", () => {
		let n = 0;
		const s = createCollectionStyleStore({ path: null, onChange: () => n++ });
		s.setSort("name-asc"); s.setGroup("none"); s.unpin("x");
		expect(n).toBe(0);
		s.setSort("items");
		expect(n).toBe(1);
	});
});

describe("observe (first-seen times)", () => {
	const col = (key: string, name: string, itemCount = 0) => ({ key, name, parentKey: null, itemCount });
	test("the first call seeds existing collections with 0; later new / changed ones get the clock", () => {
		let clock = 1000;
		const s = createCollectionStyleStore({ path: null, now: () => clock });
		s.observe([]); // an empty list (not loaded yet) must not seed anything
		expect(s.get().stampsSeeded).toBe(false);
		s.observe([col("A", "a"), col("B", "b")]);
		expect(s.get().stamps.A).toMatchObject({ c: 0, m: 0 });
		clock = 2000;
		s.observe([col("A", "a"), col("B", "b", 3), col("C", "c")]);
		expect(s.get().stamps.A).toMatchObject({ c: 0, m: 0 });
		expect(s.get().stamps.B).toMatchObject({ c: 0, m: 2000 });
		expect(s.get().stamps.C).toMatchObject({ c: 2000, m: 2000 });
	});
});
