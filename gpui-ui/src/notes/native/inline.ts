// PROTOTYPE: a ProseMirror text block's inline content (Zotero note schema) as the source of a GPUIX <markdown> element, plus the
// ranges <markdown marks> paints: annotation highlights, underline annotations and background colours.
//
// Syntax marks (link, bold, italic, strikethrough, code) are written as Markdown with the open-marks bookkeeping ProseMirror's own
// Markdown serializer uses, so "**bold *and italic***" comes out balanced and whitespace stays outside the delimiters. Super- and
// subscripts become Unicode script characters (as the Reading view does: <markdown> has no raised text). Text colour has no
// <markdown> form yet and is dropped (a gap of this prototype). Citations are links to zn-citation:<n> with their display text.
import type { NoteNode } from "./parse";

export interface InlineMark {
	start: number;
	end: number;
	color: string;
	kind: "highlight" | "underline";
}
export interface InlineMarkdown {
	source: string;
	marks: InlineMark[];
	/** citations in order: the n of a zn-citation:<n> link */
	citations: Record<string, unknown>[];
}

// the private-use delimiters GPUIX's <markdown marks> reads (mark i opens at U+F0000 + i, closes at U+100000 + i)
const OPEN = 0xf0000;
const CLOSE = 0x100000;
const MAX_MARKS = 0xfffe;

const SUP: Record<string, string> = {
	...Object.fromEntries([..."0123456789"].map((d, i) => [d, "⁰¹²³⁴⁵⁶⁷⁸⁹"[i]!])),
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
};
const SUB: Record<string, string> = {
	...Object.fromEntries([..."0123456789"].map((d, i) => [d, "₀₁₂₃₄₅₆₇₈₉"[i]!])),
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
};

export const escapeMd = (s: string): string => s.replace(/([\\`*_[\]<>~|#!])/g, "\\$1");

/** Syntax marks in nesting order (outermost first); the rest are drawn as <markdown> marks or dropped. */
const SYNTAX = ["link", "strong", "em", "strike"] as const;
type Syntax = { type: (typeof SYNTAX)[number]; href?: string };
const open = (m: Syntax): string => (m.type === "link" ? "[" : m.type === "strong" ? "**" : m.type === "em" ? "*" : "~~");
const close = (m: Syntax): string => (m.type === "link" ? `](${(m.href ?? "").replace(/[ ()<>]/g, encodeURIComponent)})` : open(m));
const same = (a: Syntax, b: Syntax) => a.type === b.type && a.href === b.href;

/** An annotation's colour with the transparency Zotero's editor draws highlights at. */
const wash = (c: unknown, alpha = "80"): string => {
	const s = typeof c === "string" ? c.trim() : "";
	if (/^#[0-9a-f]{6}$/i.test(s)) return s + alpha;
	return s || `#ffd400${alpha}`;
};

interface Piece {
	/** Markdown for this piece, its syntax marks not applied */
	md: string;
	syntax: Syntax[];
}

/** Inline content -> Markdown source and mark ranges. */
export function inlineMarkdown(content: NoteNode[] | undefined): InlineMarkdown {
	const pieces: Piece[] = [];
	const specs: { color: string; kind: "highlight" | "underline" }[] = [];
	const citations: Record<string, unknown>[] = [];
	/** wrap `md` in a new <markdown> mark's delimiters */
	const decorate = (md: string, color: string, kind: "highlight" | "underline"): string => {
		if (!md || specs.length >= MAX_MARKS) return md;
		const i = specs.length;
		specs.push({ color, kind });
		return String.fromCodePoint(OPEN + i) + md + String.fromCodePoint(CLOSE + i);
	};

	const walk = (nodes: NoteNode[] | undefined, outer: { color: string; kind: "highlight" | "underline" }[]) => {
		for (const n of nodes ?? []) {
			if (n.type === "text") {
				const marks = n.marks ?? [];
				const has = (t: string) => marks.find((m) => m.type === t);
				const sub = has("subsup");
				let text = n.text ?? "";
				let md: string;
				if (has("code")) md = text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
				else {
					if (sub) {
						const map = sub.attrs?.type === "sup" ? SUP : SUB;
						text = [...text].map((c) => map[c] ?? c).join("");
					}
					md = escapeMd(text).replace(/\n/g, "  \n");
				}
				const deco = [...outer];
				const u = has("underline");
				// a plain underline (no colour) is drawn in the text colour: "" here, the view fills it in
				if (u) deco.push({ color: u.attrs?.color ? wash(u.attrs.color, "ff") : "", kind: "underline" });
				const bg = has("backgroundColor");
				if (bg) deco.push({ color: wash(bg.attrs?.color), kind: "highlight" });
				// spaces stay outside the marks' delimiters, so the open-marks pass below can move them outside "**" too
				if (deco.length) {
					const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(md)!;
					let core = m[2]!;
					for (const d of deco) core = decorate(core, d.color, d.kind);
					md = m[1]! + core + m[3]!;
				}
				const syntax: Syntax[] = [];
				for (const s of SYNTAX) {
					const m = has(s);
					if (m) syntax.push({ type: s, href: s === "link" ? String(m.attrs?.href ?? "") : undefined });
				}
				pieces.push({ md, syntax });
			} else if (n.type === "hardBreak") pieces.push({ md: "  \n", syntax: [] });
			else if (n.type === "citation") {
				citations.push((n.attrs?.citation as Record<string, unknown>) ?? {});
				const label = escapeMd(String(n.attrs?.text ?? "(citation)"));
				pieces.push({ md: `[${label}](zn-citation:${citations.length - 1})`, syntax: [] });
			} else if (n.type === "math_inline") {
				const tex = (n.content ?? []).map((c) => c.text ?? "").join("");
				pieces.push({ md: tex.includes("`") ? `\`\` $${tex}$ \`\`` : `\`$${tex}$\``, syntax: [] });
			} else if (n.type === "highlight") {
				const a = n.attrs?.annotation as { color?: string } | undefined;
				walk(n.content, [...outer, { color: wash(a?.color), kind: "highlight" }]);
			} else if (n.type === "underline_annotation") {
				const a = n.attrs?.annotation as { color?: string } | undefined;
				walk(n.content, [...outer, { color: wash(a?.color, "ff"), kind: "underline" }]);
			} else if (n.type === "image") pieces.push({ md: "🖼", syntax: [] });
			else walk(n.content, outer);
		}
	};
	walk(content, []);

	// the open-marks pass: close what the next piece does not share, open what it adds; whitespace moves outside the delimiters
	let out = "";
	const stack: Syntax[] = [];
	const closeTo = (keep: number) => {
		const ws = /\s*$/.exec(out)![0];
		out = out.slice(0, out.length - ws.length);
		while (stack.length > keep) out += close(stack.pop()!);
		out += ws;
	};
	for (const p of pieces) {
		let keep = 0;
		while (keep < stack.length && keep < p.syntax.length && same(stack[keep]!, p.syntax[keep]!)) keep++;
		closeTo(keep);
		let md = p.md;
		if (p.syntax.length > keep) {
			const lead = /^\s*/.exec(md)![0];
			out += lead;
			md = md.slice(lead.length);
			for (const s of p.syntax.slice(keep)) {
				out += open(s);
				stack.push(s);
			}
		}
		out += md;
	}
	closeTo(0);

	// take the delimiters out: their positions in what is left are the marks
	const marks: [number, number][] = specs.map(() => [0, 0]);
	let source = "";
	for (const ch of out) {
		const cp = ch.codePointAt(0)!;
		if (cp >= OPEN && cp < OPEN + MAX_MARKS) marks[cp - OPEN]![0] = source.length;
		else if (cp >= CLOSE && cp < CLOSE + MAX_MARKS) marks[cp - CLOSE]![1] = source.length;
		else source += ch;
	}
	return {
		source,
		marks: marks.map(([start, end], i) => ({ start, end, ...specs[i]! })).filter((m) => m.end > m.start),
		citations,
	};
}
