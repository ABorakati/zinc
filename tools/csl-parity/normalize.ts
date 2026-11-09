// Output normalization for comparing engines. Two engines that differ only in whitespace, quote style, dash
// characters, HTML entity encoding or the csl-entry/csl-bib-body wrappers compare equal. Line structure is kept
// (one entry or citation per line); blank lines are dropped.

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
};

/** Decode &amp; &lt; &#38; &#x26; and the named entities above, in one pass (no double decoding). */
export function decodeEntities(s: string): string {
	return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
		if (body[0] === "#") {
			const hex = body[1] === "x" || body[1] === "X";
			const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[body] ?? match;
	});
}

/** Unify quote, dash and space characters, and drop zero-width characters. */
function unifyChars(s: string): string {
	return s
		.replace(/[‘’‚‛′]/g, "'")
		.replace(/[“”„‟″]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[  -  　]/g, " ")
		.replace(/[​﻿]/g, "");
}

/**
 * Normalize engine output for comparison: decode entities, unify characters, strip a wrapping
 * <div class="csl-bib-body"> and per-line <div class="csl-entry">, collapse runs of spaces, trim each line,
 * and drop empty lines. HTML tags are kept (use normalizeText to remove them).
 */
export function normalize(s: string): string {
	let t = unifyChars(decodeEntities((s ?? "").replace(/\r\n?/g, "\n")));
	// the bibliography wrappers: test suites indent them over several lines, engines may emit them on one line or not at all
	t = t.replace(/<div class="csl-bib-body"[^>]*>/g, "\n").replace(/<div class="csl-entry"[^>]*>/g, "\n");
	// drop the closing tag of each removed wrapper: a </div> that has no open <div> left before it
	let open = 0;
	t = t.replace(/<div\b[^>]*>|<\/div>/g, (tag) => {
		if (tag.startsWith("</")) {
			if (open === 0) return "\n";
			open--;
			return tag;
		}
		open++;
		return tag;
	});
	// whitespace between tags is layout, not content; then every run of whitespace (line breaks included) is one space,
	// since engines and suites differ in whether a citation's internal line breaks and entry separators are newlines
	return t.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

/** A test suite's expected output for an edit sequence marks each citation line "..[i] " (unchanged) or ">>[i] " (just
 * processed); engines output the final text of each citation, so the markers are dropped. */
export function stripCitationMarkers(s: string): string {
	return (s ?? "").replace(/^(?:>>|\.\.)\[\d+\] ?/gm, "");
}

/** For plain-text engines: remove all HTML tags first, then normalize. */
export function normalizeText(s: string): string {
	return normalize((s ?? "").replace(/<[^>]*>/g, ""));
}
