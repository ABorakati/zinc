// Ported from zotero/zotero test/tests/itemFieldsTest.js and itemTest.js (#setType) @ a14e76b358c88779e293f03e56e7900a5b6c4ad6
// (AGPL-3.0, see README.md). Subject: zotero-next's item schema data (core/src/schema-data) and convertItemType, which is
// what Item.setType does. Zotero.ItemFields has no counterpart in zotero-next; the same questions are answered from the
// schema JSON the app ships, so the helpers below read getSchema().
import { describe, expect, test } from "bun:test";
import vendored from "../../vendor/zotero/zotero-schema/schema.json";
import shipped from "../../src/schema-data/schema.json";
import { canonicalField, convertItemType, getSchema, hasItemType } from "../../src/schema-data";
import { resolveField } from "../../src/searches/compile";

const types = getSchema().itemTypes;
const typeOf = (name: string) => types.find((t) => t.itemType === name);
/** Zotero.ItemFields.getBaseIDFromTypeAndField: the base field of a type's field (a base field is its own base), or false */
const baseFor = (itemType: string, field: string): string | false => {
	const t = typeOf(itemType);
	const f = t?.fields.find((x) => x.field === field);
	if (f?.baseField) return f.baseField;
	// a base field: some type maps a field onto it, and this type has the field itself or a field mapped onto it
	const isBase = types.some((x) => x.fields.some((y) => y.baseField === field));
	if (isBase && t && (f || t.fields.some((y) => y.baseField === field))) return field;
	return false;
};
const dateFields = new Set(
	Object.entries((shipped.meta as any).fields)
		.filter(([, v]) => (v as any).type === "date")
		.map(([k]) => k),
);
const isDate = (field: string): boolean => {
	if (dateFields.has(field)) return true;
	for (const t of types) for (const f of t.fields) if (f.field === field && f.baseField && dateFields.has(f.baseField)) return true;
	return false;
};

describe("zotero-schema (the vendored copy and the one the app ships)", () => {
	test("src/schema-data/schema.json has the same content as vendor/zotero/zotero-schema/schema.json", () => {
		expect(shipped.version).toBe(vendored.version);
		expect(shipped.itemTypes).toEqual(vendored.itemTypes as any);
		expect(shipped.csl).toEqual(vendored.csl as any);
		expect(shipped.meta).toEqual(vendored.meta as any);
		expect(shipped.locales["en-US"]).toEqual(vendored.locales["en-US"] as any);
	});

	test("every item type has a CSL type", () => {
		const cslTypes = new Set(Object.values((shipped.csl as any).types).flat() as string[]);
		for (const t of types) expect(cslTypes.has(t.itemType)).toBe(true);
	});
});

describe("Zotero.ItemFields", () => {
	describe("#getBaseIDFromTypeAndField()", () => {
		test("should return the base field id for an item type and base-mapped field", () => {
			expect(baseFor("audioRecording", "label")).toBe("publisher");
		});

		test("should return the base field id for an item type and base field", () => {
			expect(baseFor("book", "publisher")).toBe("publisher");
		});

		test("should return the base field id for an item type and base field when type has a base-mapped field", () => {
			expect(baseFor("hearing", "number")).toBe("number");
		});

		test("should return false for an item type and non-base-mapped field", () => {
			expect(baseFor("audioRecording", "runningTime")).toBe(false);
		});

		test("should return false for invalid type-field combination", () => {
			expect(baseFor("note", "runningTime")).toBe(false);
		});
	});

	describe("#isDate()", () => {
		test("should treat base and mapped date-type fields as dates", () => {
			expect(isDate("date")).toBe(true);
			expect(isDate("dateDecided")).toBe(true);
			expect(isDate("originalDate")).toBe(true);
			expect(isDate("priorityDate")).toBe(true);
			expect(isDate("title")).toBe(false);
		});

		test("zotero-next search treats those fields as dates", () => {
			for (const f of ["date", "dateDecided", "originalDate", "priorityDate", "filingDate"])
				expect(resolveField(f).kind).toMatch(/^date/);
			expect(resolveField("title").kind).toBe("text");
		});
	});

	describe("#getDirection()", () => {
		test.todo("should follow app locale for primary field / use item language for non-field: text direction is a UI concern");
	});

	describe("field names", () => {
		test("canonicalField resolves any field case-insensitively, including base-mapped ones", () => {
			expect(canonicalField("PUBLICATIONTITLE")).toBe("publicationTitle");
			expect(canonicalField("caseName")).toBe("caseName");
			expect(canonicalField("nosuchfield")).toBeNull();
		});
	});
});

describe("Zotero.Item", () => {
	describe("#setType", () => {
		test("should allow changing between regular item types", () => {
			const { data } = convertItemType({ itemType: "book", title: "T" }, "journalArticle");
			expect(data.itemType).toBe("journalArticle");
			expect(data.title).toBe("T");
		});

		test("should throw when converting a regular item to an attachment", () => {
			expect(() => convertItemType({ itemType: "book" }, "attachment")).toThrow(/cannot change item type from book to attachment/);
		});

		test("moves a type-specific field to the new type's field with the same base field", () => {
			const { data, dropped } = convertItemType<Record<string, unknown>>(
				{ itemType: "audioRecording", label: "Blue Note", runningTime: "3:00" },
				"book",
			);
			expect(data.publisher).toBe("Blue Note"); // label -> publisher
			expect(data.label).toBeUndefined();
			expect(dropped).toContain("runningTime"); // book has no running time
		});

		test("maps a creator type the new type lacks to its primary creator type", () => {
			const { data } = convertItemType(
				{
					itemType: "book",
					creators: [
						{ creatorType: "bookAuthor", name: "X" },
						{ creatorType: "author", name: "Y" },
					],
				},
				"film",
			);
			expect((data.creators as any[]).map((c) => c.creatorType)).toEqual(["director", "director"]);
		});

		test("is only defined for item types that exist", () => {
			expect(hasItemType("book")).toBe(true);
			expect(hasItemType("nosuchtype")).toBe(false);
		});
	});
});
