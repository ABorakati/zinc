// Core API shapes used by academic/ (core/src/api-types.ts: Reference, ReferenceDetail, ReferenceList, ChildSummary, ItemDetail).
export interface Reference {
	index: number; // 1-based position in the bibliography
	raw?: string; // the reference string as printed, when parsed from the PDF
	doi?: string;
	title?: string;
	authors?: string[]; // "Family G" style, first few
	year?: number;
	venue?: string;
	url?: string; // landing page (doi.org link, PubMed, publisher)
	openAccessUrl?: string;
	citedByCount?: number;
	inLibraryKey?: string; // top-level item key when this work is already in the library
}
export interface ReferenceDetail extends Reference {
	abstract?: string;
	referenceCount?: number;
	type?: string; // Crossref/OpenAlex work type
}
export interface ReferenceList {
	itemKey: string;
	source: string; // e.g. "openalex", "crossref", "semanticscholar", "pdf"
	fetchedAt: string;
	references: Reference[];
}
export interface ChildSummary {
	key: string;
	itemType: "attachment" | "note";
	title: string;
	contentType: string | null;
	linkMode: string | null;
	hasFile: boolean;
	annotationCount: number;
}
export interface ItemDetail {
	data: Record<string, unknown> & { key: string };
	children: ChildSummary[];
}
