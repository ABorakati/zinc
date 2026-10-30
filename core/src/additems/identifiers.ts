// Parses free text (one or several identifiers, newline / comma / space separated) into typed identifiers.
import { normalizeDoi } from "../references/ids";

export type IdKind = "doi" | "pmid" | "pmcid" | "arxiv" | "isbn";

export interface ParsedId {
	kind: IdKind;
	/** canonical form: lower-case DOI, digits for PMID, "PMC123", "2101.01234" / "hep-th/9901001", ISBN-13 digits */
	id: string;
	/** the token as the user typed it (for error messages) */
	raw: string;
}

export function isbnValid(s: string): boolean {
	if (/^\d{13}$/.test(s)) {
		let sum = 0;
		for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
		return sum % 10 === 0;
	}
	if (/^\d{9}[\dXx]$/.test(s)) {
		let sum = 0;
		for (let i = 0; i < 10; i++) sum += (s[i].toUpperCase() === "X" ? 10 : Number(s[i])) * (10 - i);
		return sum % 11 === 0;
	}
	return false;
}

/** ISBN-10 or ISBN-13 (hyphens / spaces allowed) -> ISBN-13 digits, or null. */
export function normalizeIsbn(s: string): string | null {
	const d = s.replace(/[\s-]/g, "");
	if (!isbnValid(d)) return null;
	if (d.length === 13) return d;
	const core = "978" + d.slice(0, 9);
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
	return core + String((10 - (sum % 10)) % 10);
}

const ARXIV_NEW = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i;
const ARXIV_OLD = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i;

export function findArxivId(text: string): string | null {
	const labelled = text.match(/arxiv\s*:\s*(\d{4}\.\d{4,5})(?:v\d+)?/i) ?? text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i);
	if (labelled) return labelled[1];
	const old = text.match(ARXIV_OLD);
	return old ? old[1] : null;
}

function classify(tok: string): ParsedId | null {
	const t = tok.trim().replace(/^[<"']+/, "").replace(/[>"',;]+$/, "");
	if (!t) return null;
	const raw = tok.trim();

	const doi = /10\.\d{4,9}\//.test(t) ? normalizeDoi(t) : null;
	if (doi) return { kind: "doi", id: doi, raw };

	const pmc = t.match(/\b(PMC\d+)\b/i);
	if (pmc) return { kind: "pmcid", id: pmc[1].toUpperCase(), raw };

	if (/arxiv/i.test(t)) {
		const a = findArxivId(t);
		if (a) return { kind: "arxiv", id: a, raw };
	}
	const bareOld = t.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i);
	if (bareOld) return { kind: "arxiv", id: bareOld[1], raw };
	if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(t)) {
		const m = t.match(ARXIV_NEW);
		if (m) return { kind: "arxiv", id: m[1], raw };
	}

	const pm = t.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i) ?? t.match(/^(?:pmid|pubmed)\s*:?\s*(\d+)$/i);
	if (pm) return { kind: "pmid", id: pm[1], raw };

	const isbnTok = t.replace(/^isbn(?:-1[03])?\s*:?\s*/i, "");
	if (/^[\d-]{10,17}[Xx]?$/.test(isbnTok)) {
		const isbn = normalizeIsbn(isbnTok);
		if (isbn) return { kind: "isbn", id: isbn, raw };
	}
	if (/^\d{1,9}$/.test(t)) return { kind: "pmid", id: String(Number(t)), raw };
	return null;
}

/**
 * Split text into identifiers. Tokens are separated by newlines, commas, semicolons and whitespace
 * ("PMID: 123" and "ISBN 978-..." with a space after the label are rejoined).
 */
export function parseIdentifiers(text: string): { ids: ParsedId[]; unknown: string[] } {
	const ids: ParsedId[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	const lines = String(text ?? "").split(/\r?\n/);
	for (const line of lines) {
		// glue "PMID: 123", "ISBN 978...", "arXiv: 2101.1" into single tokens
		const glued = line.replace(/\b(pmid|pubmed|isbn(?:-1[03])?|arxiv|doi|pmcid)\s*:?\s+(?=\S)/gi, (_m, l) => `${String(l).toLowerCase()}:`);
		for (const tok of glued.split(/[\s,;]+/)) {
			if (!tok) continue;
			let p = classify(tok.replace(/^(doi|pmcid):/i, ""));
			if (!p && /^(pmid|pubmed|isbn|arxiv)[-\d]*:/i.test(tok)) p = classify(tok);
			if (!p) {
				if (/\d/.test(tok) || tok.length > 3) unknown.push(tok);
				continue;
			}
			const k = `${p.kind}:${p.id}`;
			if (seen.has(k)) continue;
			seen.add(k);
			ids.push(p);
		}
	}
	return { ids, unknown };
}
