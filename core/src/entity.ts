// Character for a numeric HTML/XML entity (&#123; / &#x1F600;). String.fromCodePoint throws a RangeError for anything
// above U+10FFFF, and entity text comes from untrusted metadata (titles, notes, web pages), so decoders must not call it bare.

/** The character for code point `n`, or `fallback` (U+FFFD by default) when `n` is not a valid code point. */
export function codePointChar(n: number, fallback = "�"): string {
	return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}
