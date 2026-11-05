// Item data -> the fields the Locate menu reads. Used from the item pane (full detail) and the context menu (the item's
// detail when it has loaded, else the list row's requested `fields`).
import type { ItemRow } from "../contracts";
import { fieldOf } from "../table/defs";
import type { LocateCreator, LocateItem } from "./openurl";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** Full item data (Zotero's item.data from /api/items/:key). */
export function locateItemOf(data: { itemType: string } & Record<string, unknown>): LocateItem {
	return {
		itemType: data.itemType,
		title: str(data.title),
		DOI: str(data.DOI),
		url: str(data.url),
		date: str(data.date),
		publicationTitle: str(data.publicationTitle),
		journalAbbreviation: str(data.journalAbbreviation),
		bookTitle: str(data.bookTitle),
		proceedingsTitle: str(data.proceedingsTitle),
		containerTitle: str(data.containerTitle),
		volume: str(data.volume),
		issue: str(data.issue),
		pages: str(data.pages),
		ISSN: str(data.ISSN),
		ISBN: str(data.ISBN),
		PMID: str(data.PMID),
		extra: str(data.extra),
		creators: Array.isArray(data.creators) ? (data.creators as LocateCreator[]) : undefined,
	};
}

/** The attachment to reveal in Explorer: the best child file, else the item itself when it is a stored attachment. */
export function locateFileKey(
	data: { itemType: string; key?: string; linkMode?: string } & Record<string, unknown>,
	children: { key: string; hasFile?: boolean; contentType?: string | null }[],
): string | null {
	const files = children.filter((c) => c.hasFile);
	const best = files.find((c) => /pdf/i.test(c.contentType ?? "")) ?? files[0];
	if (best) return best.key;
	// a standalone attachment row is its own file; a linked URL has nothing on disk
	if (data.itemType === "attachment" && data.linkMode !== "linked_url" && typeof data.key === "string" && data.key) return data.key;
	return null;
}

/** A list row: only `fields=DOI,url,...` values are present, and its creators are "Family I" strings (not author names). */
export function locateItemFromRow(it: ItemRow): LocateItem {
	const f = (name: string) => fieldOf(it, name) || undefined;
	return {
		itemType: it.itemType,
		title: it.title,
		DOI: f("DOI"),
		url: f("url"),
		date: f("date"),
		publicationTitle: f("publicationTitle") || it.publication,
		journalAbbreviation: f("journalAbbreviation"),
		bookTitle: f("bookTitle"),
		proceedingsTitle: f("proceedingsTitle"),
		volume: f("volume"),
		issue: f("issue"),
		pages: f("pages"),
		ISSN: f("ISSN"),
		ISBN: f("ISBN"),
	};
}
