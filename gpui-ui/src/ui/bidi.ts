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

/** Fields that hold IDs, numbers and data: always left to right (Zotero's ItemFields.getDirection). */
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
]);
/** Date fields follow the interface's direction, which is left to right (the interface is English only). */
const DATE_FIELDS = new Set(["dateAdded", "dateModified", "accessDate"]);

/**
 * Zotero's `ItemFields.getDirection` (chrome/content/zotero/xpcom/data/itemFields.js): the base direction of an item field's value.
 * A type-specific field is judged by its base field (`reportNumber` is a `number`, `firstPage` is `pages`). ID-like fields are LTR;
 * any other field follows the item's `language` when it has one (an RTL script gives "rtl", any other language "ltr", even one Intl
 * cannot read), and otherwise its text ("auto").
 */
export function fieldDirection(field: string, baseField: string | undefined, itemLanguage: string | null | undefined): Dir | "auto" {
	if (DATE_FIELDS.has(field)) return "ltr";
	if (LTR_FIELDS.has(baseField ?? field)) return "ltr";
	if (!itemLanguage) return "auto";
	try {
		const script = new Intl.Locale(languageToISO6391(itemLanguage)).maximize().script;
		if (script && RTL_SCRIPTS.has(script)) return "rtl";
	} catch {
		// Zotero logs the error and falls through to "ltr"
	}
	return "ltr";
}

/** Scripts written right to left (https://www.w3.org/International/questions/qa-scripts#directions), as Zotero lists them. */
const RTL_SCRIPTS = new Set(["Adlm", "Arab", "Aran", "Rohg", "Hebr", "Mand", "Mend", "Nkoo", "Hung", "Samr", "Syrc", "Thaa", "Yezi"]);

// ISO 639-1 codes Zotero maps language names from (zotero/utilities, utilities_item.js `languageToISO6391`, AGPL-3.0 like Zinc).
// prettier-ignore
const ISO6391 = ["ab", "aa", "af", "ak", "sq", "am", "ar", "an", "hy", "as", "av", "ae", "ay", "az", "bm", "ba", "eu", "be", "bn", "bi", "bs", "br", "bg", "my", "ca", "ch", "ce", "ny", "zh", "cu", "cv", "kw", "co", "cr", "hr", "cs", "da", "dv", "nl", "dz", "en", "eo", "et", "ee", "fo", "fj", "fi", "fr", "fy", "ff", "gd", "gl", "lg", "ka", "de", "el", "kl", "gn", "gu", "ht", "ha", "he", "hz", "hi", "ho", "hu", "is", "io", "ig", "id", "ia", "ie", "iu", "ik", "ga", "it", "ja", "jv", "kn", "kr", "ks", "kk", "km", "ki", "rw", "ky", "kv", "kg", "ko", "kj", "ku", "lo", "la", "lv", "li", "ln", "lt", "lu", "lb", "mk", "mg", "ms", "ml", "mt", "gv", "mi", "mr", "mh", "mn", "na", "nv", "nd", "nr", "ng", "ne", "no", "nb", "nn", "ii", "oc", "oj", "or", "om", "os", "pi", "ps", "fa", "pl", "pt", "pa", "qu", "ro", "rm", "rn", "ru", "se", "sm", "sg", "sa", "sc", "sr", "sn", "sd", "si", "sk", "sl", "so", "st", "es", "su", "sw", "ss", "sv", "tl", "ty", "tg", "ta", "tt", "te", "th", "bo", "ti", "to", "ts", "tn", "tr", "tk", "tw", "ug", "uk", "ur", "uz", "ve", "vi", "vo", "wa", "cy", "wo", "xh", "yi", "yo", "za", "zu"];
let languageMap: Map<string, string> | undefined;
const normalizeName = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");

/**
 * Zotero's `Utilities.Item.languageToISO6391`: a language name in English or in itself ("Arabic", "العربية", "Hebrew") becomes its
 * code ("ar", "he"); `en_US` becomes `en-US`; anything else is returned as given. (Zotero also accepts names in the interface
 * language, which here is English.)
 */
export function languageToISO6391(language: string): string {
	if (!language) return "";
	if (!languageMap) {
		languageMap = new Map();
		const english = new Intl.DisplayNames("en", { type: "language" });
		for (const locale of Intl.DisplayNames.supportedLocalesOf(ISO6391)) {
			const inEnglish = english.of(locale);
			if (inEnglish) languageMap.set(normalizeName(inEnglish), locale);
			const inSelf = new Intl.DisplayNames(locale, { type: "language" }).of(locale);
			if (inSelf) languageMap.set(normalizeName(inSelf), locale);
		}
	}
	const named = languageMap.get(normalizeName(language));
	if (named) return named;
	try {
		new Intl.Locale(language);
	} catch {
		try {
			new Intl.Locale(language.replace(/_/g, "-"));
			return language.replace(/_/g, "-");
		} catch {
			// not a locale code either: returned as given
		}
	}
	return language;
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
