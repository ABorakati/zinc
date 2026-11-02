// The inline HTML the structure converter produces (<i>, <b>, <code>, <sup>, <sub>, <a>, lists) as Markdown for GPUIX's
// <markdown> element (GPUIX has no web view and no inline spans in <text>). Citation links become
// [text](zn-cite:<kind>:<page>:<top>) so the reading view can intercept their clicks.
import { stripTags } from "./build";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
	s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) =>
		dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[String(name).toLowerCase()] ?? m));

const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎" };
/** Escape what Markdown would read as syntax inside running text. */
export function escapeMd(s: string): string {
	return s.replace(/([\\`*_[\]<>~|])/g, "\\$1");
}

/** What has a script form is mapped; the rest stays as it is (the reading font may have little more than the digits). */
function script(text: string, map: Record<string, string>): string {
	return [...text.trim()].map((c) => map[c] ?? escapeMd(c)).join("");
}

interface Frame { tag: string; buf: string; attrs: string; n: number }

/** Text of an already converted fragment: no code ticks (a <code> inside <sup> is only a glyph font), no escapes, no entities. */
const plainOf = (md: string) => decode(md.replace(/(?<!\\)`/g, "").replace(/\\([\\`*_[\]<>~|])/g, "$1"));

const attr = (attrs: string, name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(attrs)?.[1];

export function htmlToMarkdown(html: string): string {
	const root: Frame = { tag: "", buf: "", attrs: "", n: 0 };
	const stack: Frame[] = [root];
	const top = () => stack[stack.length - 1]!;
	const emit = (s: string) => { top().buf += s; };
	const wrap = (mark: string, inner: string) => {
		const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
		return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
	};
	const tokens = html.match(/<\/?[a-z][^>]*>|[^<]+|</gi) ?? [];
	for (const tok of tokens) {
		if (tok[0] !== "<" || tok.length === 1) { emit(escapeMd(decode(tok))); continue; }
		const close = tok[1] === "/";
		const m = /^<\/?([a-z0-9]+)([^>]*?)\/?>$/i.exec(tok);
		if (!m) continue;
		const tag = m[1]!.toLowerCase(), attrs = m[2] ?? "";
		if (tag === "br") { emit("  \n"); continue; }
		if (!close) {
			const n = tag === "ol" ? Number(attr(attrs, "start") ?? 1) : 0;
			stack.push({ tag, buf: "", attrs, n });
			continue;
		}
		// closing: find the matching open frame (tolerate stray closers)
		let at = stack.length - 1;
		while (at > 0 && stack[at]!.tag !== tag) at--;
		if (at === 0) continue;
		while (stack.length - 1 > at) { const f = stack.pop()!; emit(f.buf); }
		const f = stack.pop()!;
		switch (tag) {
			case "i": case "em": emit(wrap("*", f.buf)); break;
			case "b": case "strong": emit(wrap("**", f.buf)); break;
			case "code": {
				const raw = decode(f.buf.replace(/\\([\\`*_[\]<>~|])/g, "$1"));
				emit(raw.trim() ? (raw.includes("`") ? `\`\` ${raw} \`\`` : `\`${raw}\``) : "");
				break;
			}
			case "sup": emit(script(plainOf(f.buf), SUP)); break;
			case "sub": emit(script(plainOf(f.buf), SUB)); break;
			case "a": {
				const text = f.buf.trim();
				if (!text) { emit(f.buf); break; }
				// a bare "," or dash link of a citation group is plain text (its neighbours carry the numbers)
				if (/\brx-cite\b/.test(f.attrs) && /^[\s,;‐-―−-]+$/.test(plainOf(f.buf))) { emit(f.buf); break; }
				const lead = /^\s*/.exec(f.buf)![0], trail = /\s*$/.exec(f.buf)![0];
				emit(lead);
				if (/\brx-cite\b/.test(f.attrs)) {
					const kind = attr(f.attrs, "data-kind") ?? "other", page = attr(f.attrs, "data-page") ?? "0", t = attr(f.attrs, "data-top") ?? "";
					emit(`[${text}](zn-cite:${kind}:${page}:${t}:${encodeURIComponent(plainOf(f.buf))})`);
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
			case "ul": case "ol": emit(`\n${f.buf}\n`); break;
			case "p": emit(`${f.buf}\n\n`); break;
			default: emit(f.buf);
		}
	}
	while (stack.length > 1) { const f = stack.pop()!; emit(f.buf); }
	let out = root.buf.trim();
	// text that starts like a block (a "1. " label, "- ", "# ") must stay a paragraph
	if (!/^<(?:ul|ol)\b/i.test(html.trim())) out = out.replace(/^(\d+)([.)])(\s)/, "$1\\$2$3").replace(/^([-+#>])(\s|#)/, "\\$1$2");
	return out;
}

export const htmlToPlain = (html: string): string => decode(stripTags(html)).replace(/\s+/g, " ").trim();
