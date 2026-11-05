// MODS 3.x import and export (Library of Congress MODS, as Zotero's MODS translator reads and writes it).
import type { Creator, ZoteroItemData } from "../api-types";
import { getSchema } from "../schema-data";
import { creatorTypeFor, getBase, normalizeDate, setBase, setFirst, textToNoteHtml, type ParsedItem } from "./common";
import { children, descendants, local, parseXml, path, textOf, type XmlNode } from "./xml";
import type { ExportItem } from "./bibtex";

const KNOWN_TYPES = new Set(getSchema().itemTypes.map((t) => t.itemType));

const FROM_MARC_GENRE: Record<string, string> = {
	"art reproduction": "artwork", article: "journalArticle", autobiography: "book", bibliography: "book",
	biography: "book", book: "book", chart: "artwork", "comic or graphic novel": "book", comic: "book",
	"graphic novel": "book", "comic strip": "artwork", "conference publication": "conferencePaper",
	dictionary: "dictionaryEntry", diorama: "artwork", drama: "book", encyclopedia: "encyclopediaArticle",
	festschrift: "book", fiction: "book", filmstrip: "videoRecording", folktale: "book", graphic: "artwork",
	globe: "map", handbook: "book", history: "book", hymnal: "book", humor: "book", satire: "book",
	journal: "journalArticle", kit: "artwork", "law report or digest": "journalArticle", "law report": "journalArticle",
	digest: "journalArticle", "law digest": "journalArticle", "legal article": "journalArticle",
	"legal case and case notes": "case", "legal case": "case", "case notes": "case", legislation: "statute",
	"loose-leaf": "manuscript", map: "map", memoir: "book", "microscope slide": "artwork", model: "artwork",
	novel: "book", "online system or service": "webpage", "online system": "webpage", service: "webpage",
	"online service": "webpage", patent: "patent", periodical: "journalArticle", picture: "artwork",
	realia: "artwork", script: "book", slide: "artwork", sound: "audioRecording", speech: "audioRecording",
	"standard or specification": "report", standard: "report", "technical report": "report",
	newspaper: "newspaperArticle", theses: "thesis", thesis: "thesis", transparency: "artwork",
	videorecording: "videoRecording", letter: "letter", "motion picture": "film", "art original": "artwork",
	"web site": "webpage", yearbook: "book", "government publication": "report",
};

const TO_MARC_GENRE: Record<string, string> = {
	artwork: "art original", audioRecording: "sound", bill: "legislation", blogPost: "web site", book: "book",
	bookSection: "book", case: "legal case and case notes", conferencePaper: "conference publication",
	dictionaryEntry: "dictionary", email: "letter", encyclopediaArticle: "encyclopedia", film: "motion picture",
	forumPost: "web site", hearing: "government publication", instantMessage: "letter", interview: "interview",
	journalArticle: "journal", letter: "letter", magazineArticle: "periodical", map: "map",
	newspaperArticle: "newspaper", patent: "patent", podcast: "speech", radioBroadcast: "sound",
	report: "technical report", statute: "legislation", thesis: "thesis", videoRecording: "videorecording",
	webpage: "web site",
};

const FROM_DCT_GENRE: Record<string, string> = {
	image: "artwork", interactiveresource: "webpage", movingimage: "videoRecording", software: "computerProgram",
	sound: "audioRecording", stillimage: "artwork",
};

const FROM_TYPE_OF_RESOURCE: Record<string, string> = {
	cartographic: "map", "sound recording-musical": "audioRecording", "sound recording-nonmusical": "audioRecording",
	"sound recording": "audioRecording", "still image": "artwork", "moving image": "videoRecording",
	"software, multimedia": "computerProgram",
};

const TO_TYPE_OF_RESOURCE: Record<string, string> = {
	artwork: "still image", audioRecording: "sound recording", computerProgram: "software, multimedia",
	film: "moving image", map: "cartographic", podcast: "sound recording-nonmusical",
	radioBroadcast: "sound recording-nonmusical", videoRecording: "moving image", tvBroadcast: "moving image",
	webpage: "software, multimedia", blogPost: "software, multimedia", presentation: "mixed material",
};

const MARC_RELATORS: Record<string, string> = {
	aut: "author", edt: "editor", ctb: "contributor", pbd: "seriesEditor", trl: "translator", cmp: "composer",
	lyr: "wordsBy", prf: "performer", cre: "author", rcp: "recipient",
};

const TO_MARC_RELATOR: Record<string, string> = {
	author: "aut", editor: "edt", contributor: "ctb", seriesEditor: "pbd", translator: "trl", composer: "cmp",
	wordsBy: "lyr", performer: "prf", recipient: "rcp",
};

const PARTIAL_TYPES = new Set([
	"blogPost", "bookSection", "conferencePaper", "dictionaryEntry", "encyclopediaArticle", "forumPost",
	"journalArticle", "magazineArticle", "newspaperArticle", "webpage",
]);

// ---------------------------------------------------------------- import

/** Title from a titleInfo: title + subTitle, with nonSort and partNumber/partName folded in. */
function titleOf(titleInfo: XmlNode | undefined): string {
	if (!titleInfo) return "";
	let title = textOf(children(titleInfo, "title")[0]);
	const subtitle = textOf(children(titleInfo, "subTitle")[0]);
	if (subtitle) title = `${title.replace(/:$/, "")}: ${subtitle}`;
	const nonSort = textOf(children(titleInfo, "nonSort")[0]);
	if (nonSort) title = `${nonSort} ${title}`;
	const partNumber = textOf(children(titleInfo, "partNumber")[0]);
	const partName = textOf(children(titleInfo, "partName")[0]);
	if (partNumber && partName) title = `${title.replace(/\.$/, "")}. ${partNumber}: ${partName}`;
	else if (partNumber) title = `${title.replace(/\.$/, "")}. ${partNumber}`;
	else if (partName) title = `${title.replace(/\.$/, "")}. ${partName}`;
	return title.trim();
}

function titleFrom(context: XmlNode): string {
	const infos = children(context, "titleInfo");
	const plain = infos.find((t) => !t.attrs.type && children(t, "title").length);
	if (plain) return titleOf(plain);
	const untyped = infos.find((t) => !t.attrs.type);
	if (untyped) return titleOf(untyped);
	return titleOf(infos[0]);
}

function genreType(context: XmlNode): string {
	const genre = children(context, "genre");
	for (const g of genre) {
		if (g.attrs.authority === "local" && KNOWN_TYPES.has(textOf(g))) return textOf(g);
	}
	for (const g of genre) {
		if (g.attrs.authority === "marcgt" || g.attrs.authority === "marc") {
			const mapped = FROM_MARC_GENRE[textOf(g).toLowerCase()];
			if (mapped) return mapped;
		}
	}
	for (const g of genre) {
		if (g.attrs.authority === "dct") {
			const mapped = FROM_DCT_GENRE[textOf(g).toLowerCase().replace(/\s+/g, "")];
			if (mapped) return mapped;
		}
	}
	for (const g of genre) {
		const raw = textOf(g);
		if (KNOWN_TYPES.has(raw)) return raw;
		const marc = FROM_MARC_GENRE[raw.toLowerCase()];
		if (marc) return marc;
		const dct = FROM_DCT_GENRE[raw.toLowerCase().replace(/\s+/g, "")];
		if (dct) return dct;
		if (/journal\s*article/i.test(raw)) return "journalArticle";
		if (/magazine\s*article/i.test(raw)) return "magazineArticle";
		if (/newspaper\s*article/i.test(raw)) return "newspaperArticle";
		if (/\bblog/i.test(raw)) return "blogPost";
	}
	return "";
}

function itemTypeOf(mods: XmlNode): string {
	const fromGenre = genreType(mods);
	if (fromGenre) return fromGenre;
	for (const r of children(mods, "typeOfResource")) {
		const mapped = FROM_TYPE_OF_RESOURCE[textOf(r).toLowerCase()];
		if (mapped) return mapped;
	}
	for (const host of children(mods, "relatedItem").filter((h) => h.attrs.type === "host")) {
		const fromHost = genreType(host);
		if (fromHost) return fromHost;
	}
	for (const media of descendants(mods, "internetMediaType")) {
		if (textOf(media).toLowerCase() === "text/html") return "webpage";
	}
	const hasHost = children(mods, "relatedItem").some((h) => h.attrs.type === "host");
	if (hasHost) {
		const continuing = descendants(mods, "issuance").some((i) => /^(continuing|serial)$/i.test(textOf(i)));
		return continuing ? "journalArticle" : "bookSection";
	}
	return "document";
}

function creatorOf(name: XmlNode, itemType: string, fallback: string): Creator | null {
	const family = textOf(children(name, "namePart").find((p) => p.attrs.type === "family"));
	const given = textOf(children(name, "namePart").find((p) => p.attrs.type === "given"));
	let creator: Creator | null = null;
	if (family) {
		creator = { creatorType: fallback, lastName: family };
		if (given) creator.firstName = given;
	} else {
		const parts = children(name, "namePart").filter((p) => p.attrs.type !== "date" && p.attrs.type !== "termsOfAddress");
		const whole = parts.map((p) => textOf(p)).filter(Boolean).join(" ");
		if (!whole) return null;
		if (name.attrs.type === "personal") {
			const cleaned = whole.replace(/[[(][^A-Za-z]*[\])]/g, "");
			if (cleaned.includes(",")) {
				const [last, ...rest] = cleaned.split(",");
				creator = { creatorType: fallback, lastName: (last ?? "").trim() };
				const first = rest.join(",").trim();
				if (first) creator.firstName = first;
			} else {
				creator = { creatorType: fallback, name: cleaned.trim() };
			}
		} else {
			creator = { creatorType: fallback, name: whole.replace(/\s+/g, " ").trim() };
		}
	}
	if (!creator) return null;

	// role terms: text roles name a Zotero creator type, MARC codes map to one
	for (const role of children(name, "role")) {
		for (const term of children(role, "roleTerm")) {
			const text = textOf(term);
			if (term.attrs.type === "text" || !term.attrs.type) {
				const lower = text.toLowerCase();
				const allowed = getSchema().itemTypes.find((t) => t.itemType === itemType)?.creatorTypes ?? [];
				if (allowed.some((c) => c.creatorType === lower)) creator.creatorType = lower;
				else if (lower) creator.creatorType = creatorTypeFor(itemType, lower, creator.creatorType);
			}
		}
	}
	if (creator.creatorType === fallback) {
		for (const role of children(name, "role")) {
			for (const term of children(role, "roleTerm")) {
				if (term.attrs.type !== "code") continue;
				const authority = (term.attrs.authority ?? "").toLowerCase();
				const code = textOf(term).toLowerCase();
				if (!authority.includes("marc")) continue;
				if (code === "pbl" || code === "dst") continue;
				const mapped = MARC_RELATORS[code];
				if (mapped) creator.creatorType = creatorTypeFor(itemType, mapped, creator.creatorType);
			}
		}
	}
	if (itemType === "bill" && name.attrs.type === "corporate") creator.creatorType = "contributor";
	return creator;
}

function creatorsFrom(context: XmlNode, itemType: string, fallback: string): Creator[] {
	const out: Creator[] = [];
	for (const name of children(context, "name")) {
		// a name that only publishes or distributes is not a creator
		const codes = children(name, "role").flatMap((r) => children(r, "roleTerm")).filter((t) => t.attrs.type === "code");
		if (codes.length && codes.every((t) => ["pbl", "dst"].includes(textOf(t).toLowerCase()))) continue;
		const c = creatorOf(name, itemType, fallback);
		if (c) out.push(c);
	}
	return out;
}

function identifiersFrom(context: XmlNode, data: Record<string, unknown>): void {
	const isbns: string[] = [];
	for (const n of descendants(context, "identifier")) {
		if (n.attrs.type !== "isbn") continue;
		const m = textOf(n).replace(/\s*-\s*/g, "").match(/(?:\d{13}|[\dX]{10})/i);
		if (m) isbns.push(m[0]!);
	}
	if (isbns.length) setBase(data, "ISBN", isbns.join(", "));
	const issns: string[] = [];
	for (const n of descendants(context, "identifier")) {
		if (n.attrs.type !== "issn") continue;
		const m = /\b\d{4}\s*-?\s*\d{4}\b/i.exec(textOf(n));
		if (m) issns.push(m[0]);
	}
	if (issns.length) setBase(data, "ISSN", issns.join(", "));
	for (const n of descendants(context, "identifier")) if (n.attrs.type === "doi") setBase(data, "DOI", textOf(n));
}

/** Volume, issue and section from part/detail, pages from part/extent (the MODS way of saying 12(3):45-67). */
function applyPart(part: XmlNode, data: Record<string, unknown>): void {
	for (const detail of children(part, "detail")) {
		const type = detail.attrs.type ?? "";
		const value = textOf(children(detail, "number")[0]) || textOf(detail);
		if (type === "volume") setFirst(data, ["volume", "seriesNumber"], value);
		else if (type === "issue") setFirst(data, ["issue", "number"], value);
		else if (type === "section") setBase(data, "section", value);
	}
	for (const extent of children(part, "extent")) {
		const unit = extent.attrs.unit ?? "";
		if (unit === "pages" || unit === "page") {
			const start = textOf(children(extent, "start")[0]);
			const end = textOf(children(extent, "end")[0]);
			const list = textOf(children(extent, "list")[0]);
			const pages = start || end ? (start && end ? `${start}–${end}` : `${start}${end}`) : list.replace(/\s*-\s*/g, "–");
			setBase(data, "pages", pages);
		} else {
			applyExtentText(textOf(extent), data);
		}
	}
}

/** "320 p.", "vol. 3", "no. 4", "26 cm." in a free-text extent. */
function applyExtentText(text: string, data: Record<string, unknown>): void {
	if (!text) return;
	const pages = /\bp(?:ages?)?\.?\s+([a-z]?\d+(?:\s*-\s*[a-z]?\d+))/i.exec(text);
	if (pages) setBase(data, "pages", pages[1]!.replace(/\s+/, "").replace("-", "–"));
	const volume = /\bv(?:ol(?:ume)?)?\.?\s+(\d+)/i.exec(text);
	if (volume) setFirst(data, ["volume", "seriesNumber"], volume[1]!);
	const issue = /\b(?:no?|iss(?:ue)?)\.?\s+(\d+)/i.exec(text);
	if (issue) setFirst(data, ["issue", "number"], issue[1]!);
	const numPages = /(\d+)\s*p(?:ages?)?\b/i.exec(text);
	if (numPages) setBase(data, "numPages", numPages[1]!);
	const volumes = /(\d+)\s+(?:v(?:olumes?)?|scores?|sound|video)\b/i.exec(text);
	if (volumes) setBase(data, "numberOfVolumes", volumes[1]!);
	const size = /(?:(?:(?:\d+\s+)?\d+\/)?\d+\s*x\s*)?(?:(?:\d+\s+)?\d+\/)?\d+\s*(?:cm|mm|m|in|ft)\./i.exec(text);
	if (size) setBase(data, "artworkSize", size[0]);
}

function modsToItem(mods: XmlNode): ParsedItem | null {
	const itemType = itemTypeOf(mods);
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];
	const attachments: { title?: string; url?: string }[] = [];

	setBase(data, "title", titleFrom(mods));
	setBase(data, "shortTitle", titleOf(children(mods, "titleInfo").find((t) => t.attrs.type === "abbreviated")));

	const creators = creatorsFrom(mods, itemType, creatorTypeFor(itemType, "author", "contributor", "editor"));
	if (creators.length) data.creators = creators;

	setBase(data, "libraryCatalog", textOf(children(children(mods, "recordInfo")[0], "recordContentSource")[0]));
	setBase(data, "rights", textOf(children(mods, "accessCondition")[0]));
	setBase(data, "abstractNote", descendants(mods, "abstract").map((a) => textOf(a)).filter(Boolean).join("\n\n"));
	setBase(data, "callNumber", textOf(children(mods, "classification")[0]));
	setBase(data, "archiveLocation", descendants(mods, "physicalLocation").map((a) => textOf(a)).filter(Boolean).join("; "));
	setBase(data, "edition", textOf(descendants(mods, "edition")[0]));

	// host: publication title, its abbreviation, creators and volume/issue/pages
	for (const host of children(mods, "relatedItem").filter((h) => h.attrs.type === "host")) {
		setBase(data, "publicationTitle", titleFrom(host));
		const abbreviated = children(host, "titleInfo").find((t) => t.attrs.type === "abbreviated");
		if (abbreviated) setBase(data, "journalAbbreviation", titleOf(abbreviated));
		for (const c of creatorsFrom(host, itemType, "contributor")) data.creators = [...(data.creators ?? []), c];
		identifiersFrom(host, data);
		for (const part of children(host, "part")) applyPart(part, data);
		for (const origin of children(host, "originInfo")) applyOrigin(origin, data, itemType);
	}
	if (!getBase(data, "publicationTitle")) setBase(data, "publicationTitle", String(data.journalAbbreviation ?? ""));

	// series
	for (const series of descendants(mods, "relatedItem").filter((r) => r.attrs.type === "series")) {
		const name = textOf(path(series, "titleInfo", "title")[0]);
		if (name) setFirst(data, ["series", "seriesTitle"], name);
		if (!data.seriesText) setBase(data, "seriesText", textOf(path(series, "titleInfo", "subTitle")[0]));
		if (!data.seriesNumber) setFirst(data, ["seriesNumber"], textOf(path(series, "part", "detail", "number")[0]) || textOf(path(series, "titleInfo", "partNumber")[0]));
		for (const c of creatorsFrom(series, itemType, "seriesEditor")) data.creators = [...(data.creators ?? []), c];
	}

	for (const part of children(mods, "part")) applyPart(part, data);
	for (const extent of path(mods, "physicalDescription", "extent")) applyExtentText(textOf(extent), data);
	identifiersFrom(mods, data);
	for (const origin of children(mods, "originInfo")) applyOrigin(origin, data, itemType);

	// urls: one primary link plus raw-object attachments
	for (const url of path(mods, "location", "url")) {
		const value = textOf(url);
		if (!value) continue;
		if (url.attrs.access === "raw object") {
			attachments.push({ title: url.attrs.displayLabel || "Attachment", url: value });
			continue;
		}
		if (url.attrs.access === "preview") continue;
		if (!data.url || url.attrs.usage === "primary" || url.attrs.usage === "primary display") data.url = value;
		if (!data.accessDate && url.attrs.dateLastAccessed) setBase(data, "accessDate", url.attrs.dateLastAccessed);
	}

	for (const note of children(mods, "note")) {
		const value = textOf(note);
		if (!value) continue;
		const prefix = note.attrs.type ? `${note.attrs.type}: ` : "";
		notes.push(textToNoteHtml(prefix + value));
	}
	for (const toc of children(mods, "tableOfContents")) {
		const value = textOf(toc);
		if (value) notes.push(textToNoteHtml(`Table of Contents: ${value}`));
	}

	const tags = path(mods, "subject", "topic").map((t) => textOf(t)).filter(Boolean);
	if (tags.length) data.tags = [...new Set(tags)].map((tag) => ({ tag }));

	// language: codes preferred over names, like Zotero
	const codes: string[] = [];
	const names: string[] = [];
	for (const lang of children(mods, "language")) {
		const terms = children(lang, "languageTerm");
		if (!terms.length && lang.own.trim()) {
			codes.push(lang.own.trim());
			continue;
		}
		for (const term of terms) {
			if (term.attrs.type === "text") names.push(textOf(term));
			else if (term.attrs.type === "code" || term.attrs.authority) codes.push(textOf(term));
		}
	}
	const languages = (codes.length ? codes : names).filter(Boolean);
	if (languages.length) setBase(data, "language", languages.join("; "));

	if (!data.title) return null;
	return { data, notes, attachments: attachments.length ? attachments : undefined };
}

function applyOrigin(origin: XmlNode, data: Record<string, unknown>, itemType: string): void {
	setBase(data, "edition", textOf(children(origin, "edition")[0]));
	const place = children(children(origin, "place")[0], "placeTerm").find((t) => !t.attrs.type || t.attrs.type === "text");
	setBase(data, "place", textOf(place));
	setBase(data, "publisher", textOf(children(origin, "publisher")[0]));
	if (itemType === "webpage" && !getBase(data, "publicationTitle")) setBase(data, "publicationTitle", String(data.publisher ?? ""));
	const dates = [
		...children(origin, "copyrightDate"),
		...children(origin, "dateIssued"),
		...children(origin, "dateCreated"),
		...children(origin, "date"),
	];
	const issued = dates.map((d) => textOf(d)).filter(Boolean);
	if (issued.length) setBase(data, "date", normalizeDate(issued[0]!));
	const captured = textOf(children(origin, "dateCaptured")[0]) || textOf(children(origin, "dateModified")[0]);
	if (captured) setBase(data, "accessDate", captured.slice(0, 10));
}

export function parseMods(xml: string): { items: ParsedItem[]; errors: string[] } {
	const items: ParsedItem[] = [];
	const errors: string[] = [];
	let root: XmlNode;
	try {
		root = parseXml(xml.replace(/^\uFEFF/, ""));
	} catch (e) {
		return { items, errors: [`invalid XML: ${e instanceof Error ? e.message : e}`] };
	}
	const records = root.children.filter((c) => local(c.name) === "mods");
	for (const collection of root.children.filter((c) => local(c.name) === "modsCollection")) {
		records.push(...children(collection, "mods"));
	}
	if (!records.length) return { items, errors: ["no mods or modsCollection element"] };
	records.forEach((mods, i) => {
		try {
			const item = modsToItem(mods);
			if (item) items.push(item);
			else errors.push(`record ${i + 1} has no title`);
		} catch (e) {
			errors.push(`record ${i + 1}: ${e instanceof Error ? e.message : e}`);
		}
	});
	return { items, errors };
}

// ---------------------------------------------------------------- export

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attrsOf = (attrs: Record<string, string>): string =>
	Object.entries(attrs)
		.filter(([, v]) => v !== "")
		.map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
		.join("");

/** `<name attrs>value</name>`, or "" when the value is empty. Lines are emitted relative: the caller indents. */
const tag = (name: string, value: unknown, attrs: Record<string, string> = {}): string => {
	const v = String(value ?? "").trim();
	return v ? `<${name}${attrsOf(attrs)}>${xmlEscape(v)}</${name}>` : "";
};

/** A block whose inner lines are indented one level. */
const wrap = (name: string, attrs: Record<string, string>, inner: string[]): string[] => [
	`<${name}${attrsOf(attrs)}>`,
	...inner.filter(Boolean).map((l) => `  ${l}`),
	`</${name}>`,
];

/** MODS 3.x for a set of items (the shape Zotero's MODS exporter writes). */
export function exportMods(items: ExportItem[]): string {
	const out: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<modsCollection xmlns="http://www.loc.gov/mods/v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.loc.gov/mods/v3 http://www.loc.gov/standards/mods/v3/mods-3-2.xsd">',
	];
	for (const item of items) {
		const d = item.data;
		const partial = PARTIAL_TYPES.has(d.itemType);
		const body: string[] = []; // children of <mods>, unindented
		const host: string[] = []; // children of <relatedItem type="host">
		const series: string[] = [];

		const titleInfo = (value: unknown, attrs: Record<string, string> = {}) => wrap("titleInfo", attrs, [tag("title", value)]);
		if (d.title) body.push(...titleInfo(d.title));
		if (d.shortTitle) body.push(...titleInfo(d.shortTitle, { type: "abbreviated" }));
		body.push(tag("typeOfResource", TO_TYPE_OF_RESOURCE[d.itemType]));
		body.push(tag("genre", d.itemType, { authority: "local" }));
		body.push(tag("genre", TO_MARC_GENRE[d.itemType], { authority: "marcgt" }));
		body.push(tag("genre", d.thesisType ?? d.type));

		for (const creator of d.creators ?? []) {
			const code = TO_MARC_RELATOR[creator.creatorType] ?? "ctb";
			const family = creator.name ?? creator.lastName ?? "";
			const given = creator.name ? "" : creator.firstName ?? "";
			const name = wrap("name", { type: creator.name ? "corporate" : "personal" }, [
				tag("namePart", family, creator.name ? {} : { type: "family" }),
				tag("namePart", given, { type: "given" }),
				...wrap("role", {}, [tag("roleTerm", code, { type: "code", authority: "marcrelator" })]),
			]);
			if (creator.creatorType === "editor" && partial) host.push(...name);
			else if (creator.creatorType === "seriesEditor") series.push(...name);
			else body.push(...name);
		}

		body.push(tag("accessCondition", d.rights));

		// volume/issue/section and pages, on the host for parts of a larger work
		const part: string[] = [];
		for (const [type, value] of [["volume", d.volume], ["issue", d.issue], ["section", d.section]] as [string, unknown][]) {
			const v = String(value ?? "").trim();
			if (v) part.push(...wrap("detail", { type }, [tag("number", v)]));
		}
		const pages = String(d.pages ?? "").trim();
		if (pages) {
			const range = /^\s*([^\s–—-]+)\s*[-–—]+\s*([^\s–—-]+)\s*$/.exec(pages);
			part.push(...wrap("extent", { unit: "pages" }, range ? [tag("start", range[1]), tag("end", range[2])] : [tag("list", pages)]));
		}
		const partBlock = part.length ? wrap("part", {}, part) : [];

		const origin: string[] = [];
		origin.push(tag("edition", d.edition));
		const place = String(d.place ?? "").trim();
		if (place) origin.push(...wrap("place", {}, [tag("placeTerm", place, { type: "text" })]));
		const publisher = getBase(d, "publisher");
		origin.push(tag("publisher", publisher));
		const dateField = ["book", "bookSection"].includes(d.itemType) ? "copyrightDate"
			: ["journalArticle", "magazineArticle", "newspaperArticle"].includes(d.itemType) ? "dateIssued"
			: "dateCreated";
		origin.push(tag(dateField, d.date));
		origin.push(tag("issuance", partial && ["journalArticle", "magazineArticle", "newspaperArticle"].includes(d.itemType) ? "continuing" : "monographic"));
		const originBlock = wrap("originInfo", {}, origin);

		if (partial) host.push(...partBlock, ...originBlock);
		else body.push(...partBlock, ...originBlock);

		if (d.numPages) body.push(...wrap("physicalDescription", {}, [tag("extent", `${String(d.numPages)} p.`)]));
		// ISBN and ISSN identify the host work; a whole item carries its own
		const isbn = tag("identifier", d.ISBN, { type: "isbn" });
		const issn = tag("identifier", d.ISSN, { type: "issn" });
		if (partial) host.push(isbn, issn);
		else body.push(isbn, issn);
		body.push(tag("identifier", d.DOI, { type: "doi" }));
		body.push(tag("classification", d.callNumber));
		if (d.url) {
			body.push(...wrap("location", {}, [tag("url", d.url, { usage: "primary display", ...(d.accessDate ? { dateLastAccessed: String(d.accessDate).slice(0, 10) } : {}) })]));
		}
		if (d.archiveLocation) body.push(...wrap("location", {}, [tag("physicalLocation", d.archiveLocation)]));
		body.push(tag("abstract", d.abstractNote));

		if (d.series || d.seriesTitle || d.seriesText) {
			series.push(...wrap("titleInfo", {}, [tag("title", d.series), tag("title", d.seriesTitle), tag("subTitle", d.seriesText)]));
		}
		if (d.seriesNumber) {
			series.push(...wrap("part", {}, wrap("detail", { type: "volume" }, [tag("number", d.seriesNumber)])));
		}

		for (const note of item.notes) body.push(tag("note", note.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));
		for (const t of item.tags) body.push(...wrap("subject", {}, [tag("topic", t)]));
		if (d.language) body.push(...wrap("language", {}, [tag("languageTerm", d.language, { type: "text" })]));
		body.push(tag("note", d.extra));
		if (d.libraryCatalog) body.push(...wrap("recordInfo", {}, [tag("recordContentSource", d.libraryCatalog)]));

		if (["webpage", "blogPost", "forumPost"].includes(d.itemType)) {
			// the site name is the host title
			const site = getBase(d, "publicationTitle");
			if (site) host.push(...wrap("titleInfo", {}, [tag("title", site)]));
		} else if (["journalArticle", "magazineArticle", "newspaperArticle", "bookSection", "conferencePaper", "encyclopediaArticle", "dictionaryEntry"].includes(d.itemType)) {
			const container = getBase(d, "publicationTitle");
			if (container) host.push(...wrap("titleInfo", {}, [tag("title", container)]));
			if (d.journalAbbreviation) host.push(...wrap("titleInfo", { type: "abbreviated" }, [tag("title", d.journalAbbreviation)]));
		}

		out.push("  <mods>");
		for (const line of body) if (line) out.push(`    ${line}`);
		const hostLines = host.filter(Boolean);
		if (hostLines.length) out.push('    <relatedItem type="host">', ...hostLines.map((l) => `      ${l}`), "    </relatedItem>");
		const seriesLines = series.filter(Boolean);
		if (seriesLines.length) out.push('    <relatedItem type="series">', ...seriesLines.map((l) => `      ${l}`), "    </relatedItem>");
		out.push("  </mods>");
	}
	out.push("</modsCollection>");
	return out.join("\n") + "\n";
}
