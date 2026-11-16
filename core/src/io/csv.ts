// CSV export with Zotero's column names.
import { parseYear } from "../db";
import type { ExportItem } from "./bibtex";
import { creatorFamilyGiven, getBase, isSingleField } from "./common";

// Columns that map to a Zotero field (matched by base name for the item type: "Publication Title" -> bookTitle for a chapter).
const FIELD_COLUMNS = [
	"Publication Title",
	"ISBN",
	"ISSN",
	"DOI",
	"Url",
	"Abstract Note",
	"Date",
	"Date Added",
	"Date Modified",
	"Access Date",
	"Pages",
	"Num Pages",
	"Issue",
	"Volume",
	"Number Of Volumes",
	"Journal Abbreviation",
	"Short Title",
	"Series",
	"Series Number",
	"Series Text",
	"Series Title",
	"Publisher",
	"Place",
	"Language",
	"Rights",
	"Type",
	"Archive",
	"Archive Location",
	"Library Catalog",
	"Call Number",
	"Extra",
];
const LATE_FIELD_COLUMNS = [
	"Number",
	"Edition",
	"Running Time",
	"Scale",
	"Medium",
	"Artwork Size",
	"Filing Date",
	"Application Number",
	"Assignee",
	"Issuing Authority",
	"Country",
	"Meeting Name",
	"Conference Name",
	"Court",
	"References",
	"Reporter",
	"Legal Status",
	"Priority Numbers",
	"Programming Language",
	"Version",
	"System",
	"Code",
	"Code Number",
	"Section",
	"Session",
	"Committee",
	"History",
	"Legislative Body",
];
// Column -> creator type
const CREATOR_COLUMNS = [
	"Editor",
	"Series Editor",
	"Translator",
	"Contributor",
	"Attorney Agent",
	"Book Author",
	"Cast Member",
	"Commenter",
	"Composer",
	"Cosponsor",
	"Counsel",
	"Interviewer",
	"Producer",
	"Recipient",
	"Reviewed Author",
	"Scriptwriter",
	"Words By",
	"Guest",
];

export const CSV_COLUMNS = [
	"Key",
	"Item Type",
	"Publication Year",
	"Author",
	"Title",
	...FIELD_COLUMNS.slice(0, FIELD_COLUMNS.length - 1),
	"Extra",
	"Notes",
	"File Attachments",
	"Link Attachments",
	"Manual Tags",
	"Automatic Tags",
	...CREATOR_COLUMNS,
	...LATE_FIELD_COLUMNS,
];

const camel = (col: string) => {
	const w = col.split(" ");
	return w[0]!.toLowerCase() + w.slice(1).join("");
};
const FIELD_NAMES: Record<string, string> = { ISBN: "ISBN", ISSN: "ISSN", DOI: "DOI", Url: "url" };

function esc(v: string): string {
	return `"${v.replace(/"/g, '""')}"`;
}

export function exportCsv(items: (ExportItem & { files?: string[]; links?: string[]; autoTags?: string[] })[]): string {
	const rows: string[] = [CSV_COLUMNS.map(esc).join(",")];
	for (const it of items) {
		const d = it.data as Record<string, any>;
		const creatorsOf = (types: string[]) =>
			(it.data.creators ?? [])
				.filter((c) => types.includes(c.creatorType))
				.map((c) => (isSingleField(c) ? c.name!.trim() : creatorFamilyGiven(c)))
				.join("; ");
		const authorTypes = (it.data.creators ?? []).some((c) => c.creatorType === "author")
			? ["author"]
			: (it.data.creators ?? [])
					.filter((c) => !["editor", "seriesEditor", "translator", "bookAuthor", "reviewedAuthor"].includes(c.creatorType))
					.map((c) => c.creatorType);
		const manual = it.tags.filter((t) => !(it.autoTags ?? []).includes(t));
		const row = CSV_COLUMNS.map((col) => {
			switch (col) {
				case "Key":
					return it.data.key;
				case "Item Type":
					return it.data.itemType;
				case "Publication Year":
					return String(parseYear(it.data.date) ?? "");
				case "Author":
					return creatorsOf(authorTypes);
				case "Title":
					return String(it.data.title ?? "");
				case "Notes":
					return it.notes.join("\n---\n");
				case "File Attachments":
					return (it.files ?? []).join("; ");
				case "Link Attachments":
					return (it.links ?? []).join("; ");
				case "Manual Tags":
					return manual.join("; ");
				case "Automatic Tags":
					return (it.autoTags ?? []).join("; ");
				case "Date Added":
					return String(it.data.dateAdded ?? "");
				case "Date Modified":
					return String(it.data.dateModified ?? "");
			}
			if (CREATOR_COLUMNS.includes(col)) return creatorsOf([camel(col)]);
			const field = FIELD_NAMES[col] ?? camel(col);
			const direct = d[field];
			if (typeof direct === "string" || typeof direct === "number") return String(direct);
			return getBase(d, field);
		});
		rows.push(row.map(esc).join(","));
	}
	return rows.join("\r\n") + "\r\n";
}
