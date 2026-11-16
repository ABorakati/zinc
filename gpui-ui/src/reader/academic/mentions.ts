// In-text mention detection: "Figure 2", "Fig. 3a", "Tables 1 and 2", "Supplementary Table S1", "eTable 2",
// "Appendix B", and author-year citations "(Smith et al., 2020)". Pure string functions.

export interface Mention {
	kind: "figure" | "table";
	number: string; // "2", "S1"
	panel?: string; // "a", "A", "a-c"
	label: string; // canonical "Figure 2"
	key: string; // "figure:2"
	supplementary: boolean;
	start: number;
	end: number;
}

const HEAD =
	/\b(Supplementary\s+|Supplemental\s+|Supp\.\s*|Extended\s+Data\s+|e)?(Figures?|Figs?\.?|Tables?|Tabs?\.)\s*(S?\d{1,3})(?:([A-Za-z](?:\s?[-–]\s?[A-Za-z])?)(?![A-Za-z]))?/gi;
const CONT = /^(?:\s*(?:,|and|&|–|-|to)\s*)(S?\d{1,3})(?:([A-Za-z])(?![A-Za-z]))?/i;

function canon(kind: "figure" | "table", num: string): { label: string; key: string } {
	const n = num.toUpperCase();
	return { label: (kind === "figure" ? "Figure " : "Table ") + n, key: kind + ":" + n };
}

/** Figure/table mentions in running text (one entry per number: "Figures 2 and 3" gives two). */
export function findFigureMentions(text: string): Mention[] {
	const out: Mention[] = [];
	HEAD.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = HEAD.exec(text))) {
		const prefix = m[1] ?? "";
		const word = m[2]!.toLowerCase();
		// "e" prefix only counts for eTable/eFigure (no space), else it is part of another word
		if (prefix === "e" || prefix === "E") {
			if (m.index > 0 && /[A-Za-z]/.test(text[m.index - 1]!)) continue;
		}
		const kind = word.startsWith("t") ? "table" : "figure";
		const supplementary = prefix !== "";
		const { label, key } = canon(kind, m[3]!);
		out.push({
			kind,
			number: m[3]!.toUpperCase(),
			panel: m[4]?.replace(/\s/g, ""),
			label,
			key,
			supplementary,
			start: m.index,
			end: m.index + m[0].length,
		});
		// continuation: "Figures 2 and 3", "Tables 1, 2"
		if (/^(figures|figs|tables)/i.test(m[2]!)) {
			let pos = m.index + m[0].length;
			for (;;) {
				const c = CONT.exec(text.slice(pos));
				if (!c) break;
				const s = pos + (c[0].length - c[0].replace(/^\s*(?:,|and|&|–|-|to)\s*/i, "").length);
				const c2 = canon(kind, c[1]!);
				out.push({
					kind,
					number: c[1]!.toUpperCase(),
					panel: c[2],
					label: c2.label,
					key: c2.key,
					supplementary,
					start: s,
					end: pos + c[0].length,
				});
				pos += c[0].length;
			}
		}
	}
	return out;
}

/** Parse the label of a figure/table ("Figure 2.", "Fig. S3", "Table 1") into its key. */
export function labelKey(label: string | undefined | null): string | null {
	if (!label) return null;
	const ms = findFigureMentions(label.trim().slice(0, 40));
	return ms[0]?.key ?? null;
}

/** A caption-start line: "Figure 1. Foo", "Fig. 2: Foo", "Table 3 | Foo". */
export function captionStart(line: string): { kind: "figure" | "table"; number: string; key: string; label: string; end: number } | null {
	const m =
		/^\s*(Supplementary\s+|Supplemental\s+|Extended\s+Data\s+)?(Figure|FIGURE|Fig\.?|FIG\.?|Table|TABLE|Tab\.)\s*(S?\d{1,3})\s*(?:[.:|]|\s{1,2}[A-Z(])/.exec(
			line,
		);
	if (!m) return null;
	const kind = m[2]!.toLowerCase().startsWith("t") ? "table" : "figure";
	const { label, key } = canon(kind, m[3]!);
	return { kind, number: m[3]!.toUpperCase(), key, label, end: m[0].length };
}

// ---------------------------------------------------------------- supplementary mentions

export interface SuppMention {
	label: string; // as written, tidied: "Supplementary Table S1"
	kind: "table" | "figure" | "appendix" | "material" | "video" | "data" | "method";
	number?: string;
	start: number;
	end: number;
}

const SUPP_RE = new RegExp(
	[
		// Supplementary / Supplemental / Extended Data / online-only items
		String.raw`(?:Supplementary|Supplemental|Extended\s+Data|Online|Additional)\s+(?:File|Table|Figure|Fig\.?|Material|Materials|Information|Data|Methods?|Video|Movie|Appendix|Dataset)s?\s*(?:S?[A-Z]?\d{1,3}[A-Za-z]?)?`,
		// eTable 2, eFigure 1, eAppendix, eMethods
		String.raw`\be(?:Table|Figure|Fig|Appendix|Methods|Video)s?\s*\d{0,3}`,
		// Table S1, Figure S3, Fig. S2
		String.raw`\b(?:Table|Figure|Fig\.?)\s*S\d{1,3}[A-Za-z]?`,
		// Appendix B / Appendix 2 / Appendix
		String.raw`\bAppendi(?:x|ces)\s*(?:[A-Z]\d?|\d{1,2})?\b`,
		// Supporting Information
		String.raw`\bSupporting\s+(?:Information|Data|Material|File)s?(?:\s*S?\d{1,3})?`,
		// Movie S1 / Video 1
		String.raw`\b(?:Movie|Video)\s*S?\d{1,3}`,
	].join("|"),
	"g",
);

export function findSupplementaryMentions(text: string): SuppMention[] {
	const out: SuppMention[] = [];
	SUPP_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SUPP_RE.exec(text))) {
		const raw = m[0].replace(/\s+/g, " ").trim();
		if (raw.length < 3) continue;
		const low = raw.toLowerCase();
		let kind: SuppMention["kind"] = "material";
		if (/table/.test(low)) kind = "table";
		else if (/fig/.test(low)) kind = "figure";
		else if (/appendi/.test(low)) kind = "appendix";
		else if (/video|movie/.test(low)) kind = "video";
		else if (/method/.test(low)) kind = "method";
		else if (/data/.test(low)) kind = "data";
		const num = /(?:S?[A-Z]?\d{1,3}[A-Za-z]?|\b[A-Z])\s*$/
			.exec(raw.replace(/^(?:Supplementary|Supplemental|Extended Data|Online|Additional)/i, ""))?.[0]
			?.trim();
		out.push({
			label: raw,
			kind,
			number: kind === "appendix" ? /([A-Z]\d?|\d+)$/.exec(raw)?.[1] : num,
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return out;
}

// ---------------------------------------------------------------- author-year

export interface AuthorYear {
	surname: string;
	second?: string; // "Smith and Jones"
	etAl: boolean;
	year: number;
	suffix?: string;
	start: number;
	end: number;
}

const NAME = String.raw`[A-Z][\p{L}'’\-]{1,}(?:\s(?:de|van|von|der|la|le|del|da|di|dos)\s[A-Z][\p{L}'’\-]+)?`;
const AY_RE = new RegExp(String.raw`(${NAME})(?:(\s+et\s+al\.?)|\s+(?:and|&)\s+(${NAME}))?,?\s*\(?((?:19|20)\d{2})([a-z])?\)?`, "gu");

export function findAuthorYear(text: string): AuthorYear[] {
	const out: AuthorYear[] = [];
	AY_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = AY_RE.exec(text))) {
		out.push({
			surname: m[1]!,
			etAl: !!m[2],
			second: m[3],
			year: Number(m[4]),
			suffix: m[5],
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return out;
}
