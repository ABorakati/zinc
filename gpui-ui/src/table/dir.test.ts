import { describe, expect, test } from "bun:test";
import type { ItemRow } from "../contracts";
import { metaDir } from "../cards/logic";
import { cellDir, itemFieldDir } from "./defs";

const row = (language?: string, itemType = "journalArticle"): ItemRow => ({
	key: "AAAA1111",
	itemType,
	title: "Introduction to Machine Learning مقدمة",
	fields: language ? { language } : {},
});

describe("the item list takes each cell's direction from the item's language, as Zotero's item tree does", () => {
	test("an Arabic-language item is rtl even when its title opens with a Latin word", () => {
		const it = row("ar");
		expect(itemFieldDir(it, "title")).toBe("rtl");
		expect(cellDir({ id: "title" }, it)).toBe("rtl");
		expect(cellDir({ id: "creator" }, it)).toBe("rtl");
		expect(cellDir({ id: "publicationTitle" }, it)).toBe("rtl");
		expect(cellDir({ id: "year" }, it)).toBe("rtl");
	});
	test("a Latin-language item is ltr even when its title is Arabic", () => {
		expect(cellDir({ id: "title" }, row("en"))).toBe("ltr");
		expect(cellDir({ id: "creator" }, row("English"))).toBe("ltr");
	});
	test("language names and codes both count", () => {
		expect(itemFieldDir(row("Arabic"), "title")).toBe("rtl");
		expect(itemFieldDir(row("العربية"), "title")).toBe("rtl");
		expect(itemFieldDir(row("he"), "title")).toBe("rtl");
		expect(itemFieldDir(row("fa_IR"), "title")).toBe("rtl");
	});
	test("an item with no language follows its text", () => {
		expect(cellDir({ id: "title" }, row())).toBe("auto");
		expect(cellDir({ id: "creator" }, row())).toBe("auto");
	});
	test("IDs, numbers and dates stay ltr whatever the language", () => {
		const it = row("ar");
		for (const id of ["DOI", "pages", "volume", "issue", "ISBN", "url", "language", "dateAdded", "dateModified", "accessDate"])
			expect(cellDir({ id }, it)).toBe("ltr");
	});
	test("interface text (item type, counts) stays ltr; plugin columns follow their text", () => {
		const it = row("ar");
		expect(cellDir({ id: "itemType" }, it)).toBe("ltr");
		expect(cellDir({ id: "attachments" }, it)).toBe("ltr");
		expect(cellDir({ id: "notes" }, it)).toBe("ltr");
	});
	test("card meta line fields use the same rules", () => {
		const it = row("ar");
		expect(metaDir("publication", it)).toBe("rtl");
		expect(metaDir("year", it)).toBe("rtl");
		expect(metaDir("itemType", it)).toBe("ltr");
		expect(metaDir("dateAdded", it)).toBe("ltr");
		expect(metaDir("DOI", it)).toBe("ltr");
		expect(metaDir("volIssuePages", it)).toBe("ltr");
		expect(metaDir("publication", row())).toBe("auto");
	});
});
