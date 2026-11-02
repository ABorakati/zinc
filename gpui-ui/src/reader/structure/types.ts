// Document structure types (copied from reader-next/src/contract.ts, the DOM-free part). PDF rects are
// [x1, y1, x2, y2] in PDF user space of one page: origin bottom-left, points.

export type PdfRect = [number, number, number, number];

export type BlockType =
	| "title" | "heading" | "paragraph" | "list" | "figure" | "table" | "caption"
	| "equation" | "footnote" | "reference" | "header" | "footer" | "other";

export interface Block {
	id: string;
	type: BlockType;
	page: number;
	rects: PdfRect[];
	text: string; // plain text ("" for pure images)
	html?: string; // inline formatting (italics, sub/superscript, links) when available
	level?: number; // heading level
	captionOf?: string; // caption block -> figure/table block id
}

export interface FigureOrTable {
	id: string;
	kind: "figure" | "table";
	label?: string; // "Figure 2", "Table 1"
	page: number;
	rect: PdfRect; // the image/table area
	captionBlockId?: string;
	caption?: string;
}

export interface ReferenceEntry {
	index: number; // 1-based order in the bibliography
	text: string;
	page: number;
	rects: PdfRect[];
}

export interface DocStructure {
	blocks: Block[]; // in reading order; headers/footers marked so reflow can skip them
	figures: FigureOrTable[];
	tables: FigureOrTable[];
	references: ReferenceEntry[];
	outline: { title: string; level: number; blockId: string }[];
}
