// A small synthetic Zinc library for the LibreOffice GUI check (gui-check.ps1), made by core's own code.
//   bun libreoffice/test/make-library.ts <path.sqlite>
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: bun make-library.ts <path.sqlite>");
const CORE = join(import.meta.dir, "..", "..", "core");
const { openDb } = await import(join(CORE, "src", "db.ts"));
const { rebuildSearchIndex } = await import(join(CORE, "src", "search.ts"));
const { insertItem } = await import(join(CORE, "test", "fixture.ts"));
const db = openDb(out);
const items = [
	["Outcomes after liver transplantation in the United Kingdom", "Smith", "2021", "Transplantation"],
	["Machine perfusion for donor liver preservation: a systematic review", "Chen", "2019", "Journal of Hepatology"],
	["Normothermic regional perfusion in donation after circulatory death", "Rossi", "2022", "American Journal of Transplantation"],
	["Living donor liver transplantation for hepatocellular carcinoma", "Kovacs", "2018", "Hepatology"],
];
items.forEach(([title, last, date, journal], i) =>
	insertItem(db, {
		key: "GUIT" + String(i + 1).padStart(4, "0"),
		itemType: "journalArticle",
		title,
		creators: [{ creatorType: "author", firstName: "Ann", lastName: last }],
		date,
		publicationTitle: journal,
	}),
);
rebuildSearchIndex(db);
db.close();
console.log("library: " + out);
