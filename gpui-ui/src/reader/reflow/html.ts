// The inline HTML the structure converter produces (<i>, <b>, <code>, <sup>, <sub>, <a>, lists) as Markdown for GPUIX's
// <markdown> element (GPUIX has no web view and no inline spans in <text>). Citation links become
// [text](zn-cite:<kind>:<page>:<top>) so the reading view can intercept their clicks.
import { stripTags } from "./build";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** The character for a numeric entity; a number that is not a code point (`&#99999999;`) stays as the text it was: fromCodePoint throws on it. */
const fromCode = (cp: number, whole: string) => (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole);
const decode = (s: string) =>
	s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) =>
		dec ? fromCode(Number(dec), m) : hex ? fromCode(parseInt(hex, 16), m) : (ENTITIES[String(name).toLowerCase()] ?? m),
	);

const SUP: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
};
const SUB: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
};
/** Escape what Markdown would read as syntax inside running text. */
export function escapeMd(s: string): string {
	return s.replace(/([\\`*_[\]<>~|])/g, "\\$1");
}

/** What has a script form is mapped; the rest stays as it is (the reading font may have little more than the digits). */
function script(text: string, map: Record<string, string>): string {
	return [...text.trim()].map((c) => map[c] ?? escapeMd(c)).join("");
}

interface Frame {
	tag: string;
	buf: string;
	attrs: string;
	n: number;
}

/** Text of an already converted fragment: no code ticks (a <code> inside <sup> is only a glyph font), no escapes, no entities. */
const plainOf = (md: string) => decode(md.replace(/(?<!\\)`/g, "").replace(/\\([\\`*_[\]<>~|])/g, "$1"));

const attr = (attrs: string, name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(attrs)?.[1];

// ---- marks: annotation ranges carried through the conversion
// A mark is a range of the html's TEXT (htmlText below). Its ends travel through the conversion as invisible delimiters, the same
// ones GPUIX's <markdown marks> uses (mark i opens at U+F0000 + i, closes at U+100000 + i): they stay next to the characters they
// were put beside through emphasis, links, sub/superscripts and escapes, and are taken out at the end, where their offsets in the
// Markdown are the `marks` prop.
const OPEN = 0xf0000,
	CLOSE = 0x100000,
	MAX_MARKS = 0xfffe;
const MK = /[\u{F0000}-\u{10FFFF}]/gu;
const unmark = (s: string) => s.replace(MK, "");

/** The text of the converter's html, entities decoded, tags dropped (no whitespace collapsing): what mark offsets index. */
export function htmlText(html: string): string {
	return (html.match(/<\/?[a-z][^>]*>|[^<]+|</gi) ?? [])
		.filter((t) => t[0] !== "<" || t.length === 1)
		.map(decode)
		.join("");
}

export interface MarkedMarkdown {
	source: string;
	marks: [number, number][];
}

/**
 * htmlToMarkdown plus the Markdown ranges of `ranges` ([start, end) in htmlText(html) UTF-16 units; mark i is ranges[i]).
 * A range that comes out empty (its text was dropped, e.g. a lone link comma) is [0, 0].
 */
export function htmlToMarkedMarkdown(html: string, ranges: [number, number][]): MarkedMarkdown {
	const cuts: { at: number; ch: string; order: number }[] = [];
	ranges.slice(0, MAX_MARKS).forEach(([a, b], i) => {
		if (b <= a) return;
		cuts.push({ at: a, ch: String.fromCodePoint(OPEN + i), order: 1 }, { at: b, ch: String.fromCodePoint(CLOSE + i), order: 0 });
	});
	cuts.sort((x, y) => x.at - y.at || x.order - y.order);
	const marked = convert(html, cuts);
	const marks: [number, number][] = ranges.map(() => [0, 0]);
	let source = "";
	for (const ch of marked) {
		const cp = ch.codePointAt(0)!;
		if (cp >= OPEN && cp < OPEN + MAX_MARKS) marks[cp - OPEN]![0] = source.length;
		else if (cp >= CLOSE && cp < CLOSE + MAX_MARKS) marks[cp - CLOSE]![1] = source.length;
		else source += ch;
	}
	return { source, marks: marks.map(([a, b]) => (b > a ? [a, b] : [0, 0])) };
}

export function htmlToMarkdown(html: string): string {
	return convert(html, []);
}

function convert(html: string, cuts: { at: number; ch: string }[]): string {
	let hPos = 0,
		ci = 0;
	/** the decoded text token with the delimiters of the cuts that fall inside it */
	const cut = (d: string): string => {
		if (ci >= cuts.length) {
			hPos += d.length;
			return d;
		}
		let out = "",
			from = 0;
		while (ci < cuts.length && cuts[ci]!.at < hPos + d.length) {
			const at = Math.max(cuts[ci]!.at - hPos, 0);
			out += d.slice(from, at) + cuts[ci]!.ch;
			from = at;
			ci++;
		}
		hPos += d.length;
		return out + d.slice(from);
	};
	const root: Frame = { tag: "", buf: "", attrs: "", n: 0 };
	const stack: Frame[] = [root];
	const top = () => stack[stack.length - 1]!;
	const emit = (s: string) => {
		top().buf += s;
	};
	const wrap = (mark: string, inner: string) => {
		const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
		return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
	};
	const tokens = html.match(/<\/?[a-z][^>]*>|[^<]+|</gi) ?? [];
	for (const tok of tokens) {
		if (tok[0] !== "<" || tok.length === 1) {
			emit(escapeMd(cut(decode(tok))));
			continue;
		}
		const close = tok[1] === "/";
		const m = /^<\/?([a-z0-9]+)([^>]*?)\/?>$/i.exec(tok);
		if (!m) continue;
		const tag = m[1]!.toLowerCase(),
			attrs = m[2] ?? "";
		if (tag === "br") {
			emit("  \n");
			continue;
		}
		if (!close) {
			const n = tag === "ol" ? Number(attr(attrs, "start") ?? 1) : 0;
			stack.push({ tag, buf: "", attrs, n });
			continue;
		}
		// closing: find the matching open frame (tolerate stray closers)
		let at = stack.length - 1;
		while (at > 0 && stack[at]!.tag !== tag) at--;
		if (at === 0) continue;
		while (stack.length - 1 > at) {
			const f = stack.pop()!;
			emit(f.buf);
		}
		const f = stack.pop()!;
		switch (tag) {
			case "i":
			case "em":
				emit(wrap("*", f.buf));
				break;
			case "b":
			case "strong":
				emit(wrap("**", f.buf));
				break;
			case "code": {
				const raw = decode(f.buf.replace(/\\([\\`*_[\]<>~|])/g, "$1"));
				// The structure converter marks a run drawn in another font as <code>. PDFs draw ligatures ("fi", "fl", "ffi") and odd
				// glyphs in a font of their own, so a few letters inside a word arrive as code: keep those as plain text (a code box
				// mid-word, in a monospace font, is what the user saw). Real code (longer, or with spaces/symbols) stays code.
				if (/^[\p{L}\p{N}]{1,4}$/u.test(unmark(raw).trim())) {
					emit(escapeMd(raw));
					break;
				}
				emit(raw.trim() ? (raw.includes("`") ? `\`\` ${raw} \`\`` : `\`${raw}\``) : "");
				break;
			}
			case "sup":
				emit(script(plainOf(f.buf), SUP));
				break;
			case "sub":
				emit(script(plainOf(f.buf), SUB));
				break;
			case "a": {
				const text = f.buf.trim();
				if (!text) {
					emit(f.buf);
					break;
				}
				// a bare "," or dash link of a citation group is plain text (its neighbours carry the numbers)
				if (/\brx-cite\b/.test(f.attrs) && /^[\s,;‐-―−-]+$/.test(unmark(plainOf(f.buf)))) {
					emit(f.buf);
					break;
				}
				const lead = /^\s*/.exec(f.buf)![0],
					trail = /\s*$/.exec(f.buf)![0];
				emit(lead);
				if (/\brx-cite\b/.test(f.attrs)) {
					const kind = attr(f.attrs, "data-kind") ?? "other",
						page = attr(f.attrs, "data-page") ?? "0",
						t = attr(f.attrs, "data-top") ?? "";
					emit(`[${text}](zn-cite:${kind}:${page}:${t}:${encodeURIComponent(unmark(plainOf(f.buf)))})`);
				} else {
					const href = decode(attr(f.attrs, "href") ?? "");
					emit(href ? `[${text}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : text);
				}
				emit(trail);
				break;
			}
			case "li": {
				const parent = stack[stack.length - 1]!;
				const marker = parent.tag === "ol" ? `${parent.n++}. ` : "- ";
				emit(`${marker}${f.buf.trim()}\n`);
				break;
			}
			case "ul":
			case "ol":
				emit(`\n${f.buf}\n`);
				break;
			case "p":
				emit(`${f.buf}\n\n`);
				break;
			default:
				emit(f.buf);
		}
	}
	while (stack.length > 1) {
		const f = stack.pop()!;
		emit(f.buf);
	}
	let out =
		root.buf.trim() +
		cuts
			.slice(ci)
			.map((c) => c.ch)
			.join("");
	// text that starts like a block (a "1. " label, "- ", "# ") must stay a paragraph
	// (leading delimiters do not count: without marks GPUIX parses the text without them)
	if (!/^<(?:ul|ol)\b/i.test(html.trim())) {
		out = out
			.replace(/^([\u{F0000}-\u{10FFFF}]*\d+[\u{F0000}-\u{10FFFF}]*)([.)])([\u{F0000}-\u{10FFFF}]*\s)/u, "$1\\$2$3")
			.replace(/^([\u{F0000}-\u{10FFFF}]*)([-+#>])([\u{F0000}-\u{10FFFF}]*(?:\s|#))/u, "$1\\$2$3");
	}
	return out;
}

export const htmlToPlain = (html: string): string => decode(stripTags(html)).replace(/\s+/g, " ").trim();
