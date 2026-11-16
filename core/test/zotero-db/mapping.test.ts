import { expect, test } from "bun:test";
import {
	cleanNote,
	dateForApi,
	dateToMultipart,
	noteToTitle,
	normalizeForSearchStorage,
	validFileName,
	wrapNote,
} from "../../src/zotero-db/mapping";

test("dateToMultipart mirrors Zotero's 'YYYY-MM-DD original' storage and round-trips with dateForApi", () => {
	const cases: [string, string][] = [
		["2024-04-16", "2024-04-16 2024-04-16"],
		["2024/04/16", "2024-04-16 2024/04/16"],
		["April 2024", "2024-04-00 April 2024"],
		["16 April 2024", "2024-04-16 16 April 2024"],
		["Apr 3, 2020", "2020-04-03 Apr 3, 2020"],
		["2019", "2019-00-00 2019"],
		["in press", "0000-00-00 in press"],
	];
	for (const [raw, stored] of cases) {
		expect(dateToMultipart(raw)).toBe(stored);
		expect(dateForApi(stored)).toBe(raw);
	}
});

test("noteToTitle strips tags/entities and keeps the first line", () => {
	expect(noteToTitle('<div class="zotero-note znv1"><p>Hello &amp; welcome</p><p>second</p></div>')).toBe("Hello & welcome");
	expect(noteToTitle("<p>a<br/>b</p>")).toBe("a b");
	expect(noteToTitle(`<p>${"x".repeat(300)}</p>`).length).toBe(120);
});

test("wrapNote adds the znv1 wrapper once and cleanNote strips control characters", () => {
	expect(wrapNote("<p>x</p>")).toBe('<div class="zotero-note znv1"><p>x</p></div>');
	expect(wrapNote(wrapNote("<p>x</p>"))).toBe('<div class="zotero-note znv1"><p>x</p></div>');
	expect(cleanNote("  a\u0001b ")).toBe("ab");
});

test("normalizeForSearchStorage returns null for plain ASCII and the folded form otherwise", () => {
	expect(normalizeForSearchStorage("Plain Title")).toBeNull();
	expect(normalizeForSearchStorage("Séance")).toBe("seance");
	expect(normalizeForSearchStorage("Straße")).toBe("strasse");
});

test("validFileName follows Zotero.File.getValidFileName", () => {
	expect(validFileName("a/b:c*d?.pdf")).toBe("abcd.pdf");
	expect(validFileName(".hidden")).toBe("hidden");
	expect(validFileName("..")).toBe("_");
});
