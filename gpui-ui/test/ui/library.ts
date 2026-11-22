// The made-up library every UI scenario starts from. Nothing in it comes from a real library; the names say what each item is for.
import { join } from "node:path";
import * as repo from "../../../core/src/db";
import { addFile, hooks } from "../../../core/src/additems/files";
import { upsertGroupLibrary } from "../../../core/src/libraries";
import { rebuildSearchIndex } from "../../../core/src/search";

/** The titles scenarios look for. */
export const T = {
	article: "ZT00 Demo article with a PDF",
	authors: "ZT01 Three authors",
	neighbour: "ZT02 Neighbour",
	arabic: "ZT03 تأثير التدخل المبكر",
	hebrew: "ZT04 מחקר בדיקה",
	emoji: "ZT05 Emoji 🧪🫀🧬 in a long title",
	many: "ZT06 Twenty-four authors",
	empty: "ZT07 Nothing else",
	noted: "ZT08 With a note",
	trashed: "ZT09 In the trash",
	groupItem: "ZG01 In a read-only group",
} as const;

export const GROUP_NAME = "Read-only test group";

/**
 * Writes the library to <root>/library/library.sqlite and returns that path.
 *
 * Years are chosen so that the grouped list opens with two groups of one item (2026: the article, 2025: ZT01) above a long one
 * (2024): the shape in which rows under a header lose their clicks most easily.
 */
export function makeLibrary(root: string, items: number): string {
	const file = join(root, "library", "library.sqlite");
	const db = repo.openDb(file);
	const author = (lastName: string, firstName = "Test") => ({ creatorType: "author", lastName, firstName });
	// each item a minute older than the one before, so that the list's order (newest first within a year) is the same in every run
	let minute = 0;
	const add = (data: Record<string, unknown>, library?: number): string => {
		const at = new Date(Date.UTC(2026, 0, 20) - ++minute * 60_000).toISOString().replace(/[.][0-9]+Z$/, "Z");
		const { key } = repo.createItem(db, data as never, library).data;
		db.query("UPDATE items SET date_added = ?, data = json_set(data, '$.dateAdded', ?) WHERE key = ?").run(at, at, key);
		return key;
	};

	const methods = repo.createCollection(db, "Methods").key;
	const nested = repo.createCollection(db, "Nested methods", methods).key;
	repo.createCollection(db, "Empty collection");

	const article = add({
		itemType: "report",
		title: T.article,
		creators: [{ creatorType: "author", name: "Zinc demo" }],
		date: "2026",
		abstractNote: "A made-up article that has a PDF.",
	});
	// no text extraction here: it would still be running on this connection when the fixture closes it
	const { afterImport } = hooks;
	hooks.afterImport = () => {};
	addFile(db, {
		mode: "imported_file",
		path: join(import.meta.dir, "..", "..", "web", "demo-article.pdf"),
		name: "Demo review.pdf",
		contentType: "application/pdf",
		parentKey: article,
		keepName: true,
	});
	hooks.afterImport = afterImport;
	repo.addItemsToCollection(db, methods, [article]);

	const authors = add({
		itemType: "journalArticle",
		title: T.authors,
		creators: [author("Alpha", "Ann"), author("Bravo", "Ben"), author("Charlie", "Cat")],
		abstractNote: "Original abstract of the first item.",
		publicationTitle: "Journal of Testing",
		volume: "1",
		issue: "2",
		date: "2025-03-04",
		extra: "Original extra",
	});
	repo.addTags(db, authors, ["seminal"]);
	repo.setTagColors(db, [{ name: "seminal", color: "#FF6666" }]);
	repo.addItemsToCollection(db, nested, [authors]);

	add({ itemType: "journalArticle", title: T.neighbour, creators: [author("Delta", "Dee")], abstractNote: "Original abstract of the neighbour.", date: "2024" });
	add({ itemType: "journalArticle", title: T.arabic, language: "ar", creators: [author("الاختبار", "سامي")], date: "2024" });
	add({ itemType: "book", title: T.hebrew, language: "he", creators: [author("בדיקה", "דנה")], date: "2024" });
	add({ itemType: "report", title: T.emoji, date: "2024" });
	add({ itemType: "journalArticle", title: T.many, creators: Array.from({ length: 24 }, (_, i) => author(`Coauthor${i + 1}`)), date: "2020" });
	add({ itemType: "journalArticle", title: T.empty });
	const noted = add({ itemType: "journalArticle", title: T.noted, date: "2019" });
	add({ itemType: "note", parentItem: noted, note: "<p>Note body for the test.</p>" });
	const trashed = add({ itemType: "book", title: T.trashed });
	db.query("UPDATE items SET deleted = 1 WHERE key = ?").run(trashed);

	// made editable to be filled, then locked
	const group = upsertGroupLibrary(db, { groupId: 900001, name: GROUP_NAME, editable: true, filesEditable: true, version: 1 }).id;
	add({ itemType: "book", title: T.groupItem, creators: [author("Group")] }, group);
	db.query("UPDATE libraries SET editable = 0, files_editable = 0 WHERE id = ?").run(group);

	db.transaction(() => {
		for (let i = 1; i <= items; i++)
			add({
				itemType: "journalArticle",
				title: `Bulk ${String(i).padStart(4, "0")}`,
				creators: [author(`Surname${i % 97}`)],
				date: String(i <= 12 ? 2024 : 1950 + (i % 70)),
				publicationTitle: `Synthetic Journal ${i % 13}`,
			});
	})();

	rebuildSearchIndex(db);
	db.close();
	return file;
}
