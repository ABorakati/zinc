// A random Zotero-style note, as a small HTML tree (so the shrinker can delete nodes and attributes) plus its serializer. The grammar
// covers every node and mark of Zotero's note schema, their nesting, the legacy (Zotero 5 / TinyMCE) forms the editor normalises,
// and adversarial text (emoji sequences, combining marks, CJK, RTL, surrogate pairs, NBSP runs, entities) and markup (unknown
// tags and attributes, empty elements, deep mark nesting, attribute JSON with quotes and unicode).

export class Rng {
	private s: number;
	constructor(seed: number) {
		this.s = (seed ^ 0x9e3779b9) >>> 0 || 1;
		for (let i = 0; i < 4; i++) this.next();
	}
	/** mulberry32 */
	next(): number {
		this.s = (this.s + 0x6d2b79f5) >>> 0;
		let t = this.s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	below(n: number): number {
		return Math.floor(this.next() * n);
	}
	int(a: number, b: number): number {
		return a + this.below(b - a + 1);
	}
	chance(p: number): boolean {
		return this.next() < p;
	}
	pick<T>(xs: readonly T[]): T {
		return xs[this.below(xs.length)]!;
	}
	/** weighted choice: [weight, value] pairs */
	weighted<T>(xs: readonly (readonly [number, T])[]): T {
		let total = 0;
		for (const [w] of xs) total += w;
		let x = this.next() * total;
		for (const [w, v] of xs) if ((x -= w) < 0) return v;
		return xs[xs.length - 1]![1];
	}
}

/** `string` children are raw HTML text (already escaped); `!--` is a comment whose single child is its text. */
export interface HNode {
	tag: string;
	attrs?: Record<string, string>;
	kids?: HChild[];
}
export type HChild = HNode | string;

const VOID = new Set(["br", "hr", "img", "col", "input", "meta", "wbr"]);
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function render(c: HChild): string {
	if (typeof c === "string") return c;
	if (c.tag === "!--") return `<!--${(c.kids ?? []).map(render).join("")}-->`;
	const attrs = Object.entries(c.attrs ?? {})
		.map(([k, v]) => (v === "" && k.startsWith("data-x-") ? ` ${k}` : ` ${k}="${escAttr(v)}"`))
		.join("");
	if (VOID.has(c.tag)) return `<${c.tag}${attrs}>`;
	return `<${c.tag}${attrs}>${(c.kids ?? []).map(render).join("")}</${c.tag}>`;
}

// ---------------------------------------------------------------------------------------------------------------- vocabulary

const WORDS = ["alpha", "beta", "gamma", "Note", "the", "quick", "brown", "fox", "x", "42", "co-op", "e.g.", "Zotero", "a", "I", "end."];
/** Plain-text snippets: real text, to be HTML-escaped by `text()`. */
const ADVERSARIAL = [
	"👨‍👩‍👧‍👦 family", // ZWJ sequence
	"🇯🇵🇺🇸 flags",
	"👍🏽 skin tone",
	"🏳️‍🌈",
	"é combining acute", // decomposed (NFC changes it on save)
	"ǻ Ǻ",
	"한글", // decomposed Hangul jamo
	"日本語のテキスト、漢字",
	"中文 混合 English 한국어",
	"مرحبا بالعالم ‏(RTL)",
	"שלום עולם",
	"abc ‫رمز‬ def",
	"\u{1d4b3}\u{1d4b4} astral \u{10400}", // surrogate pairs
	"tab\there",
	"a b", // NBSP
	"a   b",
	"  leading and  trailing  ",
	"a   b    c", // runs of spaces
	"zero​width⁠join﻿",
	"line\nbreak in text",
	"cr\r\nlf",
	" para-sep ",
	"quote \"double\" 'single' “smart”",
	"1 < 2 && 3 > 2",
	"<b>not a tag</b>",
	"\\frac{1}{2} $ not math $",
	"\u0000ctrl\u0007bell\u0085nel",
	"ß İ ǆ ﬁ ligature",
	"é precomposed",
];
/** Raw HTML text with entities, to be used as is. */
// (no `&amp` without its semicolon, no raw-text elements such as <iframe>/<textarea>: how a non-spec parser such as linkedom reads those differs)
const ENTITIES = [
	"&amp;",
	"&lt;",
	"&gt;",
	"&nbsp;",
	"&nbsp;&nbsp;",
	"&#160;",
	"&#x1F600;",
	"&#128512;",
	"&copy;",
	"&eacute;",
	"&quot;",
	"&apos;",
	"&#0;",
	"&#x80;",
	"&bogus;",
	"&#xD800;",
	"&#38;&#60;",
	"x&nbsp;y",
];
const COLORS = [
	"#ff2020",
	"#4eb31c",
	"red",
	"rgb(1, 2, 3)",
	"rgba(10,20,30,0.5)",
	"#F1983780",
	"hsl(120, 50%, 50%)",
	"#abc",
	"transparent",
	"currentcolor",
	"var(--x)",
];
const HL_COLORS = ["#ff6666", "#ffd400", "#5fb236", "#a28ae5", "#aaaaaa", "#FFD400", "#2ea8e5", "#ffd40080", "pink"];
const URLS = [
	"https://example.com/a?b=1&c=2",
	"http://zotero.org/",
	"mailto:a@b.example",
	"zotero://select/library/items/ABCD1234",
	"#anchor",
	"/relative path/é",
	"javascript:void(0)",
	"  https://padded.example  ",
	"https://例え.jp/パス",
	"data:text/plain;base64,QQ==",
];
const URIS = [
	"http://zotero.org/users/local/synth001/items/AAAA1111",
	"http://zotero.org/groups/12345/items/BBBB2222",
	"http://zotero.org/users/987/items/CCCC3333",
	"https://example.org/item/δ",
];

// ---------------------------------------------------------------------------------------------------------------- JSON values

export const encode = (v: unknown) => encodeURIComponent(JSON.stringify(v));

class Ctx {
	/** the document's citation items (metadata): what citations and annotations point at */
	items: { uris: string[]; itemData?: unknown }[] = [];
	n = 0;
}

export class NoteGen {
	r: Rng;
	ctx = new Ctx();
	/** newlines between blocks, as Zotero's own HTML has them */
	nl: boolean;
	constructor(seed: number) {
		this.r = new Rng(seed);
		this.nl = this.r.chance(0.6);
	}

	// ------------------------------------------------------------ text

	text(): string {
		const r = this.r;
		return r.weighted<() => string>([
			[5, () => escText(this.r.pick(WORDS) + (this.r.chance(0.5) ? " " + this.r.pick(WORDS) : ""))],
			[3, () => escText(this.r.pick(WORDS) + " ")],
			[2, () => escText(" " + this.r.pick(WORDS))],
			[3, () => escText(this.r.pick(ADVERSARIAL))],
			[2, () => this.r.pick(ENTITIES)],
		])();
	}

	uri(): string {
		return this.r.pick(URIS);
	}

	item(withData: boolean) {
		const r = this.r;
		const uris = [this.uri()];
		if (r.chance(0.15)) uris.push(r.pick(URIS));
		const it: { uris: string[]; itemData?: unknown } = { uris };
		if (withData)
			it.itemData = {
				id: "i" + this.ctx.n++,
				type: r.pick(["book", "article-journal", "webpage", "chapter"]),
				title: r.pick([
					"A Synthetic Book",
					'Title with "quotes" & <angle>',
					"日本語のタイトル",
					"Ünïcödé — dash",
					"emoji 😀 title",
				]),
				author: r.chance(0.8)
					? Array.from({ length: r.int(1, 4) }, () => ({
							family: r.pick(["Smith", "Jones", "Wu", "Müller", "李", "O'Neil"]),
							given: r.pick(["Ada", "Bo", "Cy", "Zoë"]),
						}))
					: undefined,
				issued: r.chance(0.8) ? { "date-parts": [[String(r.int(1990, 2025))]] } : undefined,
			};
		return it;
	}

	citationItem() {
		const r = this.r;
		const base = this.ctx.items.length && r.chance(0.8) ? r.pick(this.ctx.items) : this.item(r.chance(0.3));
		const ci: Record<string, unknown> = { uris: [...base.uris] };
		if (r.chance(0.3)) ci.locator = r.pick(["12", "3-4", "ix", "第5頁"]);
		if (ci.locator) ci.label = r.pick(["page", "chapter", "section"]);
		if (r.chance(0.2)) ci.prefix = r.pick(["see", "cf.", "参照"]);
		if (r.chance(0.2)) ci.suffix = r.pick(["and more", "passim", "—etc"]);
		if (r.chance(0.15)) ci["suppress-author"] = true;
		if (r.chance(0.1) && base.itemData) ci.itemData = base.itemData; // item data inside the citation (older notes)
		return ci;
	}

	citationJson() {
		const r = this.r;
		const items = Array.from(
			{
				length: r.weighted([
					[6, 1],
					[3, 2],
					[1, 0],
					[1, 3],
				]),
			},
			() => this.citationItem(),
		);
		const properties: Record<string, unknown> = {};
		if (r.chance(0.3)) properties.noteIndex = r.int(0, 3);
		if (r.chance(0.4)) {
			properties.formattedCitation = r.pick(["(Smith 2020)", '(A "Page")', "（李 2021）"]);
			properties.plainCitation = properties.formattedCitation;
		}
		if (r.chance(0.1)) properties.unknownKey = { nested: [1, "two", null, true], é: "ü" };
		return r.chance(0.97) ? { citationItems: items, properties } : { citationItems: items, properties, extra: r.pick(["x", 1, null]) };
	}

	annotationJson(kind: "highlight" | "image" | "underline") {
		const r = this.r;
		const a: Record<string, unknown> = {};
		if (r.chance(0.9)) a.attachmentURI = this.uri() + "/att";
		if (r.chance(0.9)) a.annotationKey = r.pick(["ABCD1234", "EFGH5678", "9XYZ0000"]);
		if (r.chance(0.8)) a.color = r.pick(HL_COLORS);
		if (r.chance(0.7)) a.pageLabel = r.pick(["1", "iv", "12"]);
		if (r.chance(0.8))
			a.position = {
				pageIndex: r.int(0, 30),
				rects: Array.from({ length: r.int(1, 3) }, () => [
					r.int(0, 300) + 0.5,
					r.int(0, 700) + 0.25,
					r.int(300, 500),
					r.int(700, 800),
				]),
				...(r.chance(0.2) ? { nextPageRects: [[1, 2, 3, 4]] } : {}),
			};
		if (kind !== "image" && r.chance(0.6)) a.text = r.pick(['quoted “text” "q"', "日本語", "100% & more", "emoji 😀"]);
		if (r.chance(0.5))
			a.citationItem = {
				uris: [this.uri()],
				locator: r.chance(0.5) ? String(r.int(1, 99)) : undefined,
				...(r.chance(0.3) ? { itemData: this.item(true).itemData } : {}),
			};
		if (r.chance(0.08)) a.uri = this.uri(); // legacy
		return a;
	}

	// ------------------------------------------------------------ inline

	citation(): HNode {
		const j = this.citationJson();
		const attrs: Record<string, string> = { class: "citation" };
		if (this.r.chance(0.97)) attrs["data-citation"] = encode(j);
		else attrs["data-citation"] = this.r.pick(["not%20json", "", "%E0%A4%A", encode([1, 2])]);
		return {
			tag: "span",
			attrs,
			kids: [this.r.pick(["(Smith 2020)", '(<span class="citation-item">Jones et al., 2019</span>)', "(citation)", ""])],
		};
	}

	image(): HNode {
		const r = this.r;
		const attrs: Record<string, string> = {};
		if (r.chance(0.9))
			attrs.src = r.pick([
				"data:image/png;base64,iVBORw0KGgo=",
				"https://example.com/i.png?x=1&y=2",
				"attachments/AAAA1111.png",
				"",
				"file:///tmp/a.png",
			]);
		if (r.chance(0.5)) attrs.alt = r.pick(["", "alt text", "日本語 alt", 'a "q" b']);
		if (r.chance(0.2)) attrs.title = r.pick(["title", "t & t"]);
		if (r.chance(0.6)) attrs.width = r.pick(["120", "0", "12.7", "abc", "1e3", "-4"]);
		if (r.chance(0.6)) attrs.height = r.pick(["80", "7", "x"]);
		if (r.chance(0.6)) attrs["data-attachment-key"] = r.pick(["ABCD1234", "IMGKEY99"]);
		if (r.chance(0.2)) attrs["data-original-src"] = "https://example.com/orig.png";
		if (r.chance(0.3)) attrs["data-annotation"] = encode(this.annotationJson("image"));
		if (r.chance(0.05)) attrs["data-annotation"] = "%7Bbroken";
		if (r.chance(0.05)) attrs.style = "background-image: url('https://example.com/bg.png')";
		return { tag: "img", attrs };
	}

	/** `<span class="highlight|underline" data-annotation>`: text, marks and breaks inside (annotations hold only those) */
	annotation(depth: number): HNode {
		const kind = this.r.chance(0.7) ? "highlight" : "underline";
		const j = this.annotationJson(kind === "highlight" ? "highlight" : "underline");
		const attrs: Record<string, string> = { class: kind };
		if (this.r.chance(0.95)) attrs["data-annotation"] = encode(j);
		return { tag: "span", attrs, kids: this.inline(depth + 1, { leaf: true }) };
	}

	math(): HNode {
		const src = this.r.pick(["x^2", "\\int_0^1 f(x)\\,dx", "a<b & c>d", "", "日本", "\\text{ spaces  here }", "  padded  "]);
		return { tag: "span", attrs: { class: "math" }, kids: [this.r.chance(0.9) ? escText(`$${src}$`) : escText(src)] };
	}

	private wrapMark(kids: HChild[]): HNode {
		const r = this.r;
		const mk = r.weighted<() => HNode>([
			[4, () => ({ tag: r.pick(["strong", "b"]), kids })],
			[1, () => ({ tag: "b", attrs: { style: "font-weight: normal" }, kids })],
			[4, () => ({ tag: r.pick(["em", "i"]), kids })],
			[1, () => ({ tag: r.pick(["cite", "dfn", "q"]), kids })],
			[3, () => ({ tag: "u", ...(r.chance(0.3) ? { attrs: { style: `text-decoration-color: ${r.pick(COLORS)}` } } : {}), kids })],
			[3, () => ({ tag: r.pick(["s", "strike", "del"]), kids })],
			[2, () => ({ tag: r.pick(["sub", "sup"]), kids })],
			[3, () => ({ tag: r.pick(["code", "tt", "kbd", "samp", "var"]), kids })],
			[
				4,
				() => ({
					tag: "a",
					attrs: {
						href: r.pick(URLS),
						...(r.chance(0.3) ? { title: r.pick(["tip", 'a "q"', "日本"]) } : {}),
						...(r.chance(0.2) ? { target: "_blank", rel: "noopener" } : {}),
					},
					kids,
				}),
			],
			[3, () => ({ tag: "span", attrs: { style: `color: ${r.pick(COLORS)}` }, kids })],
			[3, () => ({ tag: "span", attrs: { style: `background-color: ${r.pick([...COLORS, ...HL_COLORS])}` }, kids })],
			// (not `background: <colour>`: Zotero's rule for it reads the shorthand's text, which Gecko, jsdom and linkedom each print differently)
			[1, () => ({ tag: "span", attrs: { style: "font-weight: bold" }, kids })],
			[1, () => ({ tag: "span", attrs: { style: "font-weight: 700" }, kids })],
			[1, () => ({ tag: "span", attrs: { style: "font-style: italic" }, kids })],
			[
				1,
				() => ({
					tag: "span",
					attrs: {
						style: r.pick([
							"text-decoration: underline",
							"text-decoration-line: underline",
							"text-decoration: line-through",
							"text-decoration-line: line-through",
							"text-decoration: underline line-through",
						]),
					},
					kids,
				}),
			],
			[1, () => ({ tag: "span", attrs: { style: r.pick(["vertical-align: sub", "vertical-align: super"]) }, kids })],
			[1, () => ({ tag: "span", attrs: { style: "font-family: monospace" }, kids })],
			[1, () => ({ tag: "span", attrs: { style: "white-space: pre" }, kids })],
			[
				1,
				() => ({
					tag: "span",
					attrs: { style: `color: ${r.pick(COLORS)}; background-color: ${r.pick(COLORS)}; font-weight: bold` },
					kids,
				}),
			],
			[
				2,
				() => ({
					tag: r.pick(["font", "mark", "small", "big", "abbr", "span", "label", "custom-el", "o:p", "ins", "bdi", "bdo", "time"]),
					...(r.chance(0.4) ? { attrs: { color: "red", class: "x", "data-unknown": "1", style: "font-size: 20pt" } } : {}),
					kids,
				}),
			],
		]);
		return mk();
	}

	/** Inline content. `leaf`: inside an annotation, only text, marks and breaks. */
	inline(depth: number, o: { leaf?: boolean; pre?: boolean } = {}): HChild[] {
		const r = this.r;
		const n =
			depth > 3
				? r.int(0, 2)
				: r.weighted([
						[1, 0],
						[4, 1],
						[4, 2],
						[3, 3],
						[1, 5],
					]);
		const out: HChild[] = [];
		for (let i = 0; i < n; i++) {
			const pick = r.weighted<string>([
				[10, "text"],
				[o.leaf || depth > 5 ? 2 : 6, "mark"],
				[2, "br"],
				[o.leaf || o.pre ? 0 : 2, "citation"],
				[o.leaf || o.pre ? 0 : 1.5, "image"],
				[o.leaf || o.pre ? 0 : 1.2, "math"],
				[o.leaf || o.pre ? 0 : 2, "annotation"],
				[0.6, "comment"],
				[0.5, "empty"],
				[0.4, "nbsp"],
			]);
			switch (pick) {
				case "text":
					out.push(this.text());
					break;
				case "mark":
					out.push(this.wrapMark(this.inline(depth + 1, o)));
					break;
				case "br":
					out.push({ tag: "br" });
					break;
				case "citation":
					out.push(this.citation());
					break;
				case "image":
					out.push(this.image());
					break;
				case "math":
					out.push(this.math());
					break;
				case "annotation":
					out.push(this.annotation(depth));
					break;
				case "comment":
					out.push({ tag: "!--", kids: [" a comment "] });
					break;
				case "empty":
					out.push(this.wrapMark([]));
					break;
				case "nbsp":
					out.push(r.pick(["&nbsp;", " ", "&nbsp;&nbsp; ", " &nbsp;"]));
					break;
			}
		}
		// deep nesting on purpose now and then: one chain of marks around the lot
		if (!o.pre && r.chance(0.04)) {
			let kids: HChild[] = out;
			for (let i = r.int(4, 12); i > 0; i--) kids = [this.wrapMark(kids)];
			return kids;
		}
		return out;
	}

	// ------------------------------------------------------------ blocks

	/** attributes the text blocks understand (and a few they do not) */
	blockAttrs(heading = false): Record<string, string> {
		const r = this.r;
		const a: Record<string, string> = {};
		const styles: string[] = [];
		if (r.chance(0.12)) styles.push(`text-align: ${r.pick(["left", "right", "center", "justify", "CENTER", "start", "inherit"])}`);
		if (r.chance(0.12))
			styles.push(
				`${r.pick(["padding-left", "padding-right"])}: ${r.pick(["40px", "80px", "120px", "41px", "0px", "40", "280px", "3em"])}`,
			);
		if (r.chance(0.04)) styles.push("margin-left: 10px", "line-height: 1.5");
		if (styles.length) a.style = styles.join(r.pick([";", "; ", ";"]));
		if (r.chance(0.08)) a.dir = r.pick(["rtl", "ltr", "RTL", "auto", ""]);
		if (r.chance(0.07)) a["data-indent"] = r.pick(["1", "2", "7", "0", "x", "-1", "99"]);
		if (heading && r.chance(0.3)) a.id = r.pick(["h-1", "sec 2", "é"]);
		if (r.chance(0.03)) a.class = r.pick(["MsoNormal", "x y"]);
		return a;
	}

	paragraph(): HNode {
		return { tag: "p", attrs: this.blockAttrs(), kids: this.inline(0) };
	}

	codeBlock(): HNode {
		const r = this.r;
		const code = r.pick([
			'fn main() {\n    let s = "é";\n}',
			"a  b   c",
			"tab\there",
			"line1\n\nline3",
			"  indented",
			"trailing  ",
			"🙂 emoji\n日本",
			"x &lt; y &amp;&amp; z",
			"",
			"\n",
		]);
		const kids: HChild[] = r.chance(0.7) ? [code.startsWith("x &") ? code : escText(code)] : this.inline(2, { pre: true });
		if (r.chance(0.2)) kids.push({ tag: "br" });
		if (r.chance(0.1)) kids.unshift("\n"); // a newline right after <pre> is dropped by the parser
		return { tag: "pre", attrs: r.chance(0.2) ? this.blockAttrs() : {}, kids };
	}

	mathBlock(): HNode {
		const r = this.r;
		const src = r.pick(["\\sum_{i=0}^n i", "a<b", "", "x\ny", "日本"]);
		return { tag: "pre", attrs: { class: "math" }, kids: [r.chance(0.9) ? escText(`$$${src}$$`) : escText(src)] };
	}

	listItem(depth: number): HNode {
		const r = this.r;
		const kids: HChild[] = [];
		const shape = r.weighted<string>([
			[5, "inline"],
			[4, "p"],
			[2, "p+list"],
			[1, "block"],
			[1, "empty"],
			[1, "inline+list"],
		]);
		if (shape === "inline" || shape === "inline+list") kids.push(...this.inline(1));
		if (shape === "p" || shape === "p+list") for (let i = r.int(1, 2); i > 0; i--) kids.push(this.paragraph());
		if (shape === "p+list" || shape === "inline+list") kids.push(this.list(depth + 1));
		if (shape === "block") kids.push(...this.blocks(depth + 1, 2));
		return { tag: "li", kids };
	}

	list(depth: number): HNode {
		const r = this.r;
		const ordered = r.chance(0.45);
		const attrs: Record<string, string> = {};
		if (ordered && r.chance(0.3)) attrs.start = r.pick(["3", "0", "-2", "10", "x", "1"]);
		if (r.chance(0.06)) attrs.dir = r.pick(["rtl", "ltr"]);
		const n =
			depth > 3
				? 1
				: r.weighted([
						[1, 0],
						[4, 1],
						[4, 2],
						[2, 3],
					]);
		const kids: HChild[] = Array.from({ length: n }, () => this.listItem(depth));
		if (r.chance(0.05)) kids.push(this.text()); // stray text in a list
		return { tag: ordered ? "ol" : "ul", attrs, kids };
	}

	cell(depth: number, span?: { colspan?: number; rowspan?: number }): HNode {
		const r = this.r;
		const attrs: Record<string, string> = {};
		if (span?.colspan && span.colspan > 1) attrs.colspan = String(span.colspan);
		else if (r.chance(0.05)) attrs.colspan = "1";
		if (span?.rowspan && span.rowspan > 1) attrs.rowspan = String(span.rowspan);
		if (r.chance(0.2)) attrs["data-colwidth"] = r.pick(["120", "80,100", "0", "50,50,50", "7"]);
		if (r.chance(0.2)) attrs.style = r.pick([`background-color: ${r.pick(COLORS)}`, "background-color: #e6f0ff;", "color: red"]);
		const kids: HChild[] = r.weighted<() => HChild[]>([
			[4, () => this.inline(2)],
			[4, () => [this.paragraph()]],
			[1, () => [this.paragraph(), this.paragraph()]],
			[1, () => [this.list(depth + 1)]],
			[1, () => []],
			[1, () => [this.codeBlock()]],
			[0.3, () => [this.table(depth + 1)]],
		])();
		return { tag: r.chance(0.2) ? "th" : "td", attrs, kids };
	}

	/**
	 * A table: a grid whose rowspans and colspans fit (what Word, TinyMCE and Zotero write), or, now and then, rows of different
	 * lengths (which prosemirror-tables' fixTables pads). Spans that run past the grid or overlap are not generated: the
	 * oracle keeps some of those as they are, and no table model can hold them.
	 */
	table(depth: number): HNode {
		const r = this.r;
		const nr = r.int(1, 4);
		const nc = r.int(1, 4);
		const ragged = r.chance(0.12);
		const taken = Array.from({ length: nr }, () => Array<boolean>(nc).fill(false));
		const rows: HNode[] = [];
		for (let i = 0; i < nr; i++) {
			const cells: HNode[] = [];
			let width = ragged ? r.int(0, nc) : nc;
			for (let j = 0; j < width; j++) {
				if (taken[i]![j]) continue;
				let colspan = 1;
				let rowspan = 1;
				if (!ragged && r.chance(0.25)) {
					while (j + colspan < nc && colspan < 3 && !taken[i]![j + colspan] && r.chance(0.5)) colspan++;
					while (
						i + rowspan < nr &&
						rowspan < 3 &&
						r.chance(0.5) &&
						Array.from({ length: colspan }, (_, k) => !taken[i + rowspan]![j + k]).every(Boolean)
					)
						rowspan++;
				}
				for (let a = 0; a < rowspan; a++) for (let b = 0; b < colspan; b++) taken[i + a]![j + b] = true;
				cells.push(this.cell(depth, { colspan, rowspan }));
				j += colspan - 1;
			}
			rows.push({ tag: "tr", kids: cells });
		}
		const kids: HChild[] = r.weighted<() => HChild[]>([
			[5, () => rows],
			[3, () => [{ tag: "tbody", kids: rows }]],
			[
				2,
				() => [
					{ tag: "thead", kids: rows.slice(0, 1) },
					{ tag: "tbody", kids: rows.slice(1) },
				],
			],
			[
				1,
				() => [
					{ tag: "colgroup", kids: [{ tag: "col" }, { tag: "col", attrs: { width: "50" } }] },
					{ tag: "tbody", kids: rows },
				],
			],
			[1, () => [{ tag: "caption", kids: ["cap"] }, ...rows]],
		])();
		return { tag: "table", attrs: r.chance(0.2) ? { border: "1", style: "width: 100%" } : {}, kids };
	}

	blocks(depth: number, max = 5): HChild[] {
		const r = this.r;
		const n = depth > 3 ? r.int(0, 1) : r.int(1, max);
		const out: HChild[] = [];
		for (let i = 0; i < n; i++) {
			out.push(this.block(depth));
			if (this.nl && this.r.chance(0.8)) out.push("\n"); // Zotero writes a newline after every block
		}
		return out;
	}

	block(depth: number): HChild {
		const r = this.r;
		const nest = depth > 3 ? 0 : 1;
		const kind = r.weighted<string>([
			[14, "p"],
			[5, "h"],
			[4 * nest, "list"],
			[2 * nest, "quote"],
			[2, "pre"],
			[1.2, "mathblock"],
			[1.5, "hr"],
			[2 * nest, "table"],
			[1.5 * nest, "div"],
			[0.8, "legacy"],
			[0.6, "strayinline"],
			[0.4 * nest, "dl"],
			[0.3, "empty"],
			[0.3, "comment"],
			[0.5 * nest, "unknownblock"],
			[0.2, "ws"],
		]);
		switch (kind) {
			case "p":
				return this.paragraph();
			case "h":
				return { tag: "h" + r.int(1, 6), attrs: this.blockAttrs(true), kids: this.inline(1) };
			case "list":
				return this.list(depth);
			case "quote":
				return { tag: "blockquote", kids: r.chance(0.8) ? this.blocks(depth + 1, 3) : this.inline(2) };
			case "pre":
				return this.codeBlock();
			case "mathblock":
				return this.mathBlock();
			case "hr":
				return { tag: "hr", attrs: r.chance(0.2) ? { class: "x" } : {} };
			case "table":
				return this.table(depth);
			case "div":
				return {
					tag: "div",
					attrs: r.chance(0.3) ? { class: "wrapper", style: "color: red" } : {},
					kids: r.chance(0.7) ? this.blocks(depth + 1, 3) : this.inline(1),
				};
			case "legacy": // TinyMCE-era markup
				return r.pick<HChild>([
					{ tag: "p", attrs: { style: "padding-left: 40px" }, kids: this.inline(1) },
					{
						tag: "p",
						attrs: { style: "text-align: center" },
						kids: [{ tag: "span", attrs: { style: "font-size: 14pt; font-family: Arial" }, kids: this.inline(1) }],
					},
					{ tag: "div", kids: [...this.inline(1), { tag: "br" }, ...this.inline(1)] },
					{ tag: "p", kids: [{ tag: "font", attrs: { face: "Arial", size: "3" }, kids: this.inline(2) }] },
					{ tag: "p", kids: ["&nbsp;"] },
					{ tag: "p", kids: [{ tag: "br" }] },
					{ tag: "center", kids: this.inline(1) },
				]);
			case "strayinline":
				return r.pick<HChild>([
					this.text(),
					{ tag: "br" },
					this.citation(),
					this.image(),
					this.annotation(0),
					this.math(),
					this.wrapMark(this.inline(2)),
				]);
			case "dl":
				return {
					tag: "dl",
					kids: [
						{ tag: "dt", kids: this.inline(2) },
						{ tag: "dd", kids: this.inline(2) },
					],
				};
			case "empty":
				return r.pick<HChild>([
					{ tag: "p" },
					{ tag: "div" },
					{ tag: "ul" },
					{ tag: "li" },
					{ tag: "blockquote" },
					{ tag: "table" },
					{ tag: "span" },
					{ tag: "h2" },
					{ tag: "pre" },
				]);
			case "comment":
				return { tag: "!--", kids: ["x"] };
			case "unknownblock":
				return {
					tag: r.pick(["section", "article", "figure", "aside", "details", "main", "form", "style", "script", "object"]),
					attrs: { class: "u", "data-x": "1" },
					kids: r.chance(0.6) ? this.blocks(depth + 1, 2) : this.inline(2),
				};
			default:
				return r.pick(["\n", "  ", "\n  \n"]);
		}
	}

	// ------------------------------------------------------------ note

	/** `<a>` in `<a>` is not HTML: a parser closes the outer one, linkedom's does not. The inner one becomes a `<span>`. */
	private unNestLinks(c: HChild, inLink = false): void {
		if (typeof c === "string") return;
		const link = c.tag === "a";
		if (link && inLink) c.tag = "span";
		for (const k of c.kids ?? []) this.unNestLinks(k, inLink || link);
	}

	/** The note's HTML, and its description (which wrapper form it took). */
	note(): { html: string; tree: HChild[]; sep: string; kind: string } {
		const out = this.noteOf();
		for (const c of out.tree) this.unNestLinks(c);
		if (out.tree.length) out.html = out.tree.map(render).join(out.sep);
		return out;
	}

	private noteOf(): { html: string; tree: HChild[]; sep: string; kind: string } {
		const r = this.r;
		const kind = r.weighted<string>([
			[62, "modern"],
			[14, "legacy"],
			[10, "bare"],
			[8, "versioned-div"],
			[3, "degenerate"],
			[3, "newer"],
		]);
		// metadata: items that citations can use (some never used, some without data)
		const nItems = r.weighted([
			[3, 0],
			[4, 1],
			[3, 2],
			[1, 4],
		]);
		this.ctx.items = Array.from({ length: nItems }, () => this.item(r.chance(0.85)));
		if (kind === "degenerate")
			return {
				kind,
				tree: [],
				sep: "",
				html: r.pick([
					"",
					" ",
					"\n",
					"plain text",
					"<div></div>",
					"<p></p>",
					'<div data-schema-version="10"></div>',
					"<br>",
					"&nbsp;",
					"<!-- c -->",
					"<p>&nbsp;</p>",
				]),
			};
		const body = this.blocks(0, 7);
		if (kind === "bare") {
			const sep = r.pick(["", "\n"]);
			return { kind, tree: body, sep, html: body.map(render).join(sep) };
		}
		if (kind === "legacy") {
			// Zotero 5 notes: no data-schema-version, loose inline content and breaks at the top, div wrappers
			const mixed: HChild[] = [];
			for (const b of body) {
				mixed.push(b);
				if (r.chance(0.3)) mixed.push(...this.inline(1));
			}
			const tree: HChild[] = r.chance(0.5)
				? [{ tag: "div", attrs: r.chance(0.5) ? { class: "zotero-note znv1" } : {}, kids: mixed }]
				: mixed;
			return { kind, tree, sep: "\n", html: tree.map(render).join("\n") };
		}
		const attrs: Record<string, string> = {};
		const version =
			kind === "newer"
				? "11"
				: kind === "versioned-div"
					? r.pick(["", "x", "0", "7", "8", "9"])
					: r.pick(["10", "10", "10", "9", "8", "7", "10.5", "010"]);
		attrs["data-schema-version"] = version;
		if (this.ctx.items.length && r.chance(0.9)) {
			const items = this.ctx.items;
			attrs["data-citation-items"] = r.chance(0.95)
				? encode(items)
				: r.pick(["not%20json", encode({ a: 1 }), encodeURIComponent('[{"uris":"x"}]'), JSON.stringify(items)]);
		}
		if (r.chance(0.1)) attrs.class = "zotero-note znv1";
		if (r.chance(0.02)) attrs.style = "font-family: Arial";
		// attribute order as written by Zotero is sorted; sometimes it is not
		const keys = Object.keys(attrs);
		const ordered = r.chance(0.8) ? keys.sort() : keys.reverse();
		const root: HNode = { tag: "div", attrs: Object.fromEntries(ordered.map((k) => [k, attrs[k]!])), kids: body };
		if (kind === "versioned-div") delete root.attrs!["data-schema-version"];
		const tree: HChild[] = [root];
		// Zotero writes a newline between blocks
		return { kind, tree, sep: "", html: render(root) };
	}
}
