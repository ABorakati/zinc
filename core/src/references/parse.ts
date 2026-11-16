// Heuristic bibliography extraction from a PDF's plain text.
import { normalizeDoi } from "./ids";

export interface ParsedEntry {
	raw: string;
	doi?: string;
	year?: number;
	title?: string;
	authors?: string[];
}

const HEADING =
	/^[ \t]*(?:\d{1,2}[.)]?[ \t]+)?(?:references?(?: list)?|bibliography|literature cited|works cited|reference list|references and notes)[ \t]*:?[ \t]*$/gim;
const END_HEADING =
	/^[ \t]*(?:appendix|appendices|supplementary (?:material|information|data)|supporting information|acknowledg(?:e)?ments?|author contributions?|conflicts? of interest|funding|figure legends|tables?)\b.{0,40}$/im;

/** The text after the last References/Bibliography heading, or null when none is found. */
export function findReferencesSection(text: string): string | null {
	let last = -1;
	let lastLen = 0;
	for (const m of text.matchAll(HEADING)) {
		const rest = text.length - (m.index! + m[0].length);
		if (rest > 60) {
			last = m.index!;
			lastLen = m[0].length;
		}
	}
	if (last < 0) return null;
	// Prefer the last heading that is followed by a plausible list; an earlier one wins only if the last is tiny.
	let section = text.slice(last + lastLen);
	const end = section.search(END_HEADING);
	// Only cut at a trailing section when we already have a decent amount of references before it.
	if (end > 800) section = section.slice(0, end);
	return section.trim() || null;
}

const NUM_START = /^[ \t]*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})[.)])[ \t]*(?=\S)/;

function joinLines(lines: string[]): string {
	let out = "";
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (!out) out = line;
		else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
		else out += " " + line;
	}
	return out.replace(/\s+/g, " ").trim();
}

function splitNumbered(lines: string[]): string[] | null {
	const starts: { i: number; n: number }[] = [];
	let expect = 1;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(NUM_START);
		if (!m) continue;
		const n = Number(m[1] ?? m[2] ?? m[3]);
		// accept the expected next number (tolerating a skipped one), so years or page numbers do not split entries
		if (n === expect || (n > expect && n <= expect + 2 && starts.length > 0)) {
			starts.push({ i, n });
			expect = n + 1;
		}
	}
	if (starts.length < 3) return null;
	const out: string[] = [];
	for (let s = 0; s < starts.length; s++) {
		const from = starts[s].i;
		const to = s + 1 < starts.length ? starts[s + 1].i : lines.length;
		const chunk = lines.slice(from, to);
		chunk[0] = chunk[0].replace(NUM_START, "");
		const text = joinLines(chunk);
		if (text.length > 15) out.push(text);
	}
	return out;
}

const YEAR = /\b(?:19|20)\d{2}[a-z]?\b/;
// "Smith J, ..." / "Smith, J." / "Smith, John" / "van der Berg A" / "World Health Organization."
const AUTHOR_START =
	/^(?:[\p{Lu}][\p{L}'’\-]+(?:\s+(?:van|von|de|der|den|di|da|del|la|le|bin|al)\b)*(?:\s+[\p{Lu}][\p{L}'’\-]+)?)(?:,\s*(?:[\p{Lu}]\.|[\p{Lu}]{1,3}\b|[\p{Lu}][\p{L}]+)|\s+[\p{Lu}]{1,3}(?:[,.]|\s|$))/u;

function splitAuthorYear(lines: string[]): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	const flush = () => {
		const t = joinLines(cur);
		if (t.length > 15) out.push(t);
		cur = [];
	};
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const prev = joinLines(cur);
		// a new entry starts on an author-looking line once the previous one carries a year and reads as complete
		const prevDone = prev.length > 25 && YEAR.test(prev) && /[.)\d\]]$|doi\.org\S*$/i.test(prev);
		if (cur.length > 0 && prevDone && AUTHOR_START.test(line)) flush();
		cur.push(line);
	}
	flush();
	return out;
}

/** Numbered entries running on in one paragraph ("1. Foo ... 2. Bar ..."): scan for the next number in sequence. */
function splitNumberedInline(section: string): string[] | null {
	const text = joinLines(section.split(/\r?\n/));
	const starts: number[] = []; // index where each entry's body begins
	const marks: number[] = []; // index where each entry's number begins
	let from = 0;
	for (let n = 1; n < 1000; n++) {
		const re = new RegExp(`(?:^|\\s)(?:\\[${n}\\]|${n}[.)])\\s*(?=[\\p{Lu}\\[("“]|\\p{N})`, "gu");
		re.lastIndex = from;
		let m: RegExpExecArray | null = null;
		// the first candidate that leaves room for a real entry
		while ((m = re.exec(text))) {
			if (n === 1 || m.index - from >= 20) break;
		}
		if (!m) break;
		marks.push(m.index);
		starts.push(m.index + m[0].length);
		from = m.index + m[0].length;
	}
	if (starts.length < 3) return null;
	const out: string[] = [];
	for (let i = 0; i < starts.length; i++) {
		const body = text.slice(starts[i], i + 1 < marks.length ? marks[i + 1] : text.length).trim();
		if (body.length > 15) out.push(body);
	}
	return out;
}

export function splitEntries(section: string): string[] {
	// page numbers / running headers alone on a line are noise
	const lines = section.split(/\r?\n/).filter((l) => !/^\s*(?:page\s+)?\d{1,4}\s*$/i.test(l));
	const numbered = splitNumbered(lines);
	const inline = !numbered || numbered.length < lines.length / 4 ? splitNumberedInline(section) : null;
	if (inline && inline.length > (numbered?.length ?? 0)) return inline;
	if (numbered) return numbered;
	return splitAuthorYear(lines);
}

function authorList(s: string): string[] {
	const out: string[] = [];
	// "Smith J, Jones AB, Lee K" (Vancouver) or "Smith, J., & Jones, A."
	const cleaned = s.replace(/\bet al\.?/i, "").replace(/,?\s*(?:&|\band\b)\s*/g, ", ");
	if (/[\p{Lu}]\.,/u.test(cleaned) || /,\s*[\p{Lu}]\.\s*(?:[\p{Lu}]\.)?\s*(?:,|$)/u.test(cleaned)) {
		const parts = cleaned.split(/(?<=\.)\s*,\s*(?=[\p{Lu}])/u);
		for (const p of parts) {
			const m = p.trim().match(/^([^,]+),\s*(.+)$/);
			if (m) out.push(`${m[1].trim()} ${m[2].replace(/[^\p{Lu}]/gu, "")}`);
		}
	}
	if (out.length === 0) {
		for (const p of cleaned.split(",")) {
			const t = p.trim().replace(/\.$/, "");
			if (/^[\p{Lu}][\p{L}'’\- ]+\s[\p{Lu}]{1,3}$/u.test(t)) out.push(t);
		}
	}
	return out.slice(0, 6);
}

/** Pull DOI / year / title / authors out of one printed reference using layout heuristics. */
export function parseEntry(raw: string): ParsedEntry {
	const entry: ParsedEntry = { raw };
	const doi = normalizeDoi(raw.match(/10\.\d{4,9}\/[^\s"<>]+/)?.[0]);
	if (doi) entry.doi = doi;
	// remove DOI/URL so they do not confuse title splitting
	const text = raw
		.replace(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\/\S+/gi, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const paren = text.match(/\(((?:19|20)\d{2})[a-z]?\)\.?/);
	let title: string | undefined;
	let authorPart = "";
	if (paren) {
		entry.year = Number(paren[1]);
		authorPart = text.slice(0, paren.index).trim();
		const rest = text.slice(paren.index! + paren[0].length).trim();
		title = firstSentence(rest);
	} else {
		const segs = text.split(/\.\s+(?=[\p{Lu}\d])/u);
		const looksAuthors = (s: string) => /,/.test(s) || /\b[\p{Lu}]{1,3}\b/u.test(s) || /\bet al\b/i.test(s);
		if (segs.length > 1 && looksAuthors(segs[0])) {
			authorPart = segs[0];
			title = segs[1];
		} else {
			title = segs[0];
		}
		// year: the one that follows the journal name ("J Hepatol. 2020;73:1-9") else the first plausible year
		const y = text.match(/[.;,]\s*((?:19|20)\d{2})[a-z]?\s*[;:,.)]/) ?? text.match(YEAR);
		if (y) entry.year = Number(String(y[1] ?? y[0]).slice(0, 4));
	}
	if (title) {
		title = title.replace(/^["“”']+|["“”']+$/g, "").trim();
		if (title.length >= 12 && title.length <= 400) entry.title = title;
	}
	const authors = authorList(authorPart);
	if (authors.length) entry.authors = authors;
	return entry;
}

function firstSentence(s: string): string {
	// first sentence, but do not split on initials ("J. Hepatol")
	const m = s.match(/^(.+?[a-z0-9)?'’"”])\.(?:\s|$)/u);
	return (m ? m[1] : s).trim();
}

/** Full pipeline: text -> list of parsed entries (empty when no references section is found). */
export function parseBibliography(text: string): ParsedEntry[] {
	const section = findReferencesSection(text);
	if (!section) return [];
	return splitEntries(section).map(parseEntry);
}
