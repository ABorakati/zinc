// Base text direction for strings that come from the library (titles, creators, abstracts, tags, notes). Mirrors Zotero's `dir="auto"` on
// item tree cells, item box values and collection labels: the first strong character decides, the UI layout itself stays left-to-right.

export type Dir = "ltr" | "rtl";

// Strong RTL: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic Extended, Hebrew/Arabic presentation forms, and the RTL
// supplementary scripts (Phoenician .. Adlam), plus the RTL marks (RLM, ALM, RLE, RLO, RLI).
const RTL_CHAR = /[֐-ࣿ‏؜‫‮⁧יִ-﷿ﹰ-﻿]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
// Strong LTR: any other letter (or number-less letter-like mark), plus LRM / LRE / LRO / LRI.
const LTR_CHAR = /[\p{L}‎‪‭⁦]/u;

/** First-strong-character direction of `text` (HTML `dir="auto"`); `fallback` when it has none (empty, digits, punctuation, emoji). */
export function baseDir(text: string | null | undefined, fallback: Dir = "ltr"): Dir {
	if (!text) return fallback;
	for (const ch of text) {
		if (RTL_CHAR.test(ch)) return "rtl";
		if (LTR_CHAR.test(ch)) return "ltr";
	}
	return fallback;
}

export const isRtl = (text: string | null | undefined): boolean => baseDir(text) === "rtl";

/** Zotero's ItemFields.getDirection: IDs, numbers, URLs and Extra are always LTR; everything else follows its text (`dir="auto"`). */
const LTR_FIELDS = new Set([
	"ISBN",
	"ISSN",
	"DOI",
	"url",
	"callNumber",
	"volume",
	"numberOfVolumes",
	"issue",
	"runningTime",
	"number",
	"versionNumber",
	"applicationNumber",
	"priorityNumbers",
	"codeNumber",
	"pages",
	"numPages",
	"seriesNumber",
	"edition",
	"citationKey",
	"language",
	"extra",
	"dateAdded",
	"dateModified",
	"accessDate",
]);
export function fieldDir(field: string): "ltr" | "auto" {
	return LTR_FIELDS.has(field) ? "ltr" : "auto";
}

const RTL_SCRIPTS = new Set(["Adlm", "Arab", "Aran", "Rohg", "Hebr", "Mand", "Mend", "Nkoo", "Hung", "Samr", "Syrc", "Thaa", "Yezi"]);
/** Zotero's item `language` field (e.g. "ar", "he-IL", "fa") decides direction when set; undefined when unknown. */
export function languageDir(language: string | null | undefined): Dir | undefined {
	const code = (language ?? "")
		.trim()
		.split(/[\s,;]/)[0]
		?.replace(/_/g, "-");
	if (!code) return undefined;
	try {
		const script = new Intl.Locale(code).maximize().script;
		return script && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
	} catch {
		return undefined;
	}
}

/** Paragraph direction and alignment of a note block (ProseMirror attrs `dir` / `align`). Unset dir follows the text, as `dir="auto"`. */
export function blockDir(attrs: { dir?: unknown; align?: unknown } | undefined, text: string): Dir {
	return attrs?.dir === "rtl" || attrs?.dir === "ltr" ? attrs.dir : baseDir(text);
}
export function blockAlign(attrs: { dir?: unknown; align?: unknown } | undefined, dir: Dir): "left" | "right" | "center" {
	const a = attrs?.align;
	if (a === "center") return "center";
	if (a === "left" || a === "right") return a;
	if (a === "justify") return dir === "rtl" ? "right" : "left";
	return dir === "rtl" ? "right" : "left";
}
