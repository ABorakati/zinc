// Supplementary-material helpers: classify the item's other attachments and match in-text mentions to them. Pure.
import type { ChildSummary } from "./types";
import { normalizeText } from "./match";
import type { SuppMention } from "./mentions";

export type SuppKind =
	"pdf" | "epub" | "doc" | "sheet" | "slides" | "image" | "video" | "audio" | "archive" | "text" | "link" | "snapshot" | "other";

export interface SuppItem {
	key: string;
	title: string;
	contentType: string | null;
	linkMode: string | null;
	hasFile: boolean;
	kind: SuppKind;
}

export function classifyAttachment(c: Pick<ChildSummary, "title" | "contentType" | "linkMode">): SuppKind {
	const ct = (c.contentType ?? "").toLowerCase();
	const name = c.title.toLowerCase();
	const ext = /\.([a-z0-9]{1,5})$/.exec(name)?.[1] ?? "";
	if (c.linkMode === "linked_url") return "link";
	if (ct === "application/pdf" || ext === "pdf") return "pdf";
	if (ct === "application/epub+zip" || ext === "epub") return "epub";
	if (ct === "text/html" && c.linkMode === "imported_url") return "snapshot";
	if (ct.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "tif", "tiff", "bmp"].includes(ext)) return "image";
	if (ct.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(ext)) return "video";
	if (ct.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
	if (/spreadsheet|excel|csv|tab-separated/.test(ct) || ["xls", "xlsx", "xlsm", "csv", "tsv", "ods"].includes(ext)) return "sheet";
	if (/presentation|powerpoint/.test(ct) || ["ppt", "pptx", "odp", "key"].includes(ext)) return "slides";
	if (/wordprocessing|msword|rtf|opendocument\.text/.test(ct) || ["doc", "docx", "odt", "rtf"].includes(ext)) return "doc";
	if (/zip|compressed|x-tar|gzip|7z|rar/.test(ct) || ["zip", "7z", "rar", "tar", "gz", "tgz"].includes(ext)) return "archive";
	if (ct.startsWith("text/") || ["txt", "md", "json", "xml", "tex", "bib"].includes(ext)) return "text";
	return "other";
}

/** Other attachments of the item (not notes, not the open PDF). */
export function supplementaryItems(children: ChildSummary[], openKey: string): SuppItem[] {
	return children
		.filter((c) => c.itemType === "attachment" && c.key !== openKey)
		.map((c) => ({
			key: c.key,
			title: c.title || "(untitled)",
			contentType: c.contentType,
			linkMode: c.linkMode,
			hasFile: c.hasFile,
			kind: classifyAttachment(c),
		}));
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
	return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

const GENERIC = new Set([
	"supplementary",
	"supplemental",
	"supporting",
	"information",
	"material",
	"materials",
	"file",
	"files",
	"data",
	"online",
	"additional",
	"the",
	"of",
	"and",
	"for",
]);

function toks(s: string): string[] {
	return normalizeText(
		s
			.replace(/\.[a-z0-9]{1,5}$/i, "")
			.replace(/([a-z])([A-Z0-9])/g, "$1 $2")
			.replace(/[_-]/g, " "),
	)
		.split(" ")
		.filter(Boolean);
}

const KIND_WORDS: Record<SuppMention["kind"], string[]> = {
	table: ["table", "tables", "tab", "etable"],
	figure: ["figure", "figures", "fig", "efigure"],
	appendix: ["appendix", "appendices", "eappendix"],
	video: ["video", "movie", "videos"],
	method: ["method", "methods", "emethods"],
	data: ["data", "dataset"],
	material: [],
};

const PREFERRED_TYPES: Partial<Record<SuppMention["kind"], SuppKind[]>> = {
	table: ["sheet", "doc", "pdf"],
	figure: ["image", "pdf", "doc"],
	video: ["video"],
	data: ["sheet", "archive", "text"],
	appendix: ["pdf", "doc"],
	method: ["pdf", "doc"],
};

/** Rank supplementary items for a mention; items with score 0 are not returned. */
export function matchSupplement(m: SuppMention, items: SuppItem[]): { item: SuppItem; score: number }[] {
	const wanted = KIND_WORDS[m.kind];
	const num = m.number ? m.number.toLowerCase() : undefined;
	const out: { item: SuppItem; score: number }[] = [];
	for (const item of items) {
		const t = toks(item.title);
		const tset = new Set(t);
		let score = 0;
		if (wanted.some((w) => tset.has(w))) score += 2;
		if (num) {
			const compact = t.join("");
			if (tset.has(num) || (tset.has("s" + num.replace(/^s/, "")) && /^s?\d/.test(num))) score += 3;
			else if (compact.includes((wanted[0] ?? "") + num)) score += 3;
		}
		if (PREFERRED_TYPES[m.kind]?.includes(item.kind)) score += 1;
		if (t.some((w) => w.startsWith("supp") || w === "esm" || w === "moesm" || w === "si" || w === "appendix")) score += 1;
		if (m.kind === "material" && score === 0 && items.length === 1) score = 1;
		// numbered mention but the item names a different number -> not a match
		if (
			num &&
			t.some((w) => /^s?\d+$/.test(w)) &&
			!tset.has(num) &&
			!tset.has(num.replace(/^s/, "")) &&
			!tset.has("s" + num.replace(/^s/, ""))
		)
			score -= 2;
		if (score > 0) out.push({ item, score });
	}
	return out.sort((a, b) => b.score - a.score);
}

/** Tokens of a title that are not generic (exposed for tests). */
export function specificTokens(title: string): string[] {
	return toks(title).filter((t) => !GENERIC.has(t));
}
