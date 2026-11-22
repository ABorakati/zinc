// Native note view: Zotero note HTML -> a ProseMirror document, parsed with Zotero's own note schema (zotero-schema.gen.js, bundled
// from vendor/note-editor's src/core/schema: the same nodes, marks and parse rules Zotero's editor uses), so what the native view
// draws is what the editor would load. The schema's parse rules read DOM nodes; linkedom supplies them, as a document of its own
// (no browser globals are set). Both are packed into the app, so this works in a packaged build as well as from source.
import { parseHTML } from "linkedom";
import { DOMParser, formatCitationItem, Metadata, schema } from "./zotero-schema.gen.js";

/** A ProseMirror node as JSON (`Node.toJSON()`), with each citation's display text added as `attrs.text`. */
export interface NoteNode {
	type: string;
	attrs?: Record<string, unknown>;
	content?: NoteNode[];
	text?: string;
	marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface NoteParser {
	/** The note as a document; never throws (a note the schema cannot read becomes one paragraph of its text). */
	parse(html: string): NoteNode;
	/** ms spent setting the parser up */
	loadMs: number;
}

let parser: NoteParser | undefined;

/** The note parser, set up on first use (a few ms). Kept async so callers need not change if loading moves off the UI thread. */
export function loadNoteParser(): Promise<NoteParser | null> {
	try {
		parser ??= create();
		return Promise.resolve(parser);
	} catch (e) {
		console.warn("native notes: parser unavailable:", e instanceof Error ? e.message : e);
		return Promise.resolve(null);
	}
}

/**
 * The note's metadata as Zotero's editor reads it (`preprocessHTML`): the `data-*` attributes of the first top-level
 * `<div data-schema-version>`. A root div without data-schema-version carries none.
 */
export function noteMetadata(box: Element): Metadata {
	const metadata = new Metadata();
	const attrs: Record<string, string> = {};
	for (const el of Array.from(box.children)) {
		if (el.tagName !== "DIV" || !el.hasAttribute("data-schema-version")) continue;
		for (const a of Array.from(el.attributes as ArrayLike<{ name: string; value: string }>))
			if (a.name.startsWith("data-")) attrs[a.name] = a.value;
		break;
	}
	metadata.parseAttributes(attrs);
	return metadata;
}

/**
 * The rest of Zotero's `preprocessHTML`: an element with a `background-image: url(http(s)/data)` gets an `<img>` of it before it, and
 * a non-`<img>` element with a `src` gets a link to the source before it.
 */
function preprocess(box: Element, document: Document): void {
	const walk = (parent: Element) => {
		for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
			const style = node.getAttribute("style");
			if (style) {
				const canon = cssomColors(style);
				if (canon !== style) node.setAttribute("style", canon);
			}
			const bg = /(?:^|;)\s*background(?:-image)?\s*:[^;]*?url\(\s*(["']?)([^"')]*)\1\s*\)/i.exec(node.getAttribute("style") ?? "");
			if (bg && /^(https?|data):/.test(bg[2]!)) {
				const img = document.createElement("img");
				img.setAttribute("src", bg[2]!);
				parent.insertBefore(img, node);
			}
			const src = node.getAttribute("src");
			if (node.tagName !== "IMG" && src) {
				const a = document.createElement("a");
				a.setAttribute("href", src);
				a.appendChild(document.createTextNode(src));
				parent.insertBefore(a, node);
			}
			walk(node);
		}
	};
	walk(box);
}

/**
 * Colour declarations of a `style` attribute as the browser's CSSOM prints them (`#ffd400` -> `rgb(255, 212, 0)`). Zotero's parse rules
 * read styles through `dom.style.getPropertyValue`, so in Firefox they never see hex; linkedom has no CSSOM and hands over the raw text.
 * Without this, Zotero's backgroundColor rule (which adds 50% alpha to a palette colour written in hex) fires in Zinc and not in Zotero,
 * and a highlight saved opaque by Zotero comes back half transparent.
 */
export function cssomColors(style: string): string {
	return style.replace(
		/(^|;)(\s*)(color|background-color|text-decoration-color|background)(\s*:\s*)([^;]*)/gi,
		(all, sep: string, ws: string, name: string, colon: string, value: string) => {
			const v = value.trim();
			// `background` only when it is one value: Zotero's rule takes a one-token shorthand as a colour
			if (name.toLowerCase() === "background" && /\s/.test(v)) return all;
			const c = cssomColor(v);
			return c === null ? all : `${sep}${ws}${name}${colon}${c}${value.slice(value.trimEnd().length)}`;
		},
	);
}

/** One CSS colour as the CSSOM serializes a specified value (CSS Color 4 §15), or null when it is not one this handles. */
export function cssomColor(input: string): string | null {
	const v = input.trim().toLowerCase();
	const out = (r: number, g: number, b: number, a = 1): string => {
		const c = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
		if (a >= 1) return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
		return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${alpha(Math.max(0, a))})`;
	};
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
	if (hex) {
		let h = hex[1]!;
		if (h.length <= 4) h = [...h].map((x) => x + x).join("");
		const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
		return out(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1);
	}
	const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(v);
	if (!fn) return null;
	// both syntaxes: `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`
	const parts = fn[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
	if (parts.length < 3 || parts.length > 4) return null;
	const num = (s: string, pct: number): number | null => {
		const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(%|deg)?$/.exec(s);
		if (!m) return null;
		return m[2] === "%" ? (Number(m[1]) / 100) * pct : Number(m[1]);
	};
	const a = parts[3] === undefined ? 1 : num(parts[3], 1);
	if (a === null) return null;
	if (fn[1]!.startsWith("rgb")) {
		const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
		return r == null || g == null || b == null ? null : out(r, g, b, a);
	}
	const h = num(parts[0]!, 360);
	const s = num(parts[1]!, 1);
	const l = num(parts[2]!, 1);
	if (h === null || s === null || l === null || !parts[1]!.endsWith("%") || !parts[2]!.endsWith("%")) return null;
	// CSS Color 4 hsl -> rgb
	const f = (k: number) => {
		const t = (k + (((h % 360) + 360) % 360) / 30) % 12;
		return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(t - 3, 9 - t, 1));
	};
	return out(f(0) * 255, f(8) * 255, f(4) * 255, a);
}

/** Alpha as browsers print it: the fewest decimals (2, else 3) that still round to the same 8-bit value. */
function alpha(a: number): string {
	const byte = Math.round(a * 255);
	for (const places of [2, 3]) {
		const s = Number(a.toFixed(places));
		if (Math.round(s * 255) === byte) return String(s);
	}
	return String(Number(a.toFixed(3)));
}

/**
 * Zotero's `schemaTransform` (what EditorCore runs on every note it opens): an image keeps no marks, and no other node keeps the
 * `code` mark (inline code holds plain text only).
 */
function schemaTransform(n: NoteNode): void {
	if (n.marks) {
		const marks = n.type === "image" ? [] : n.type === "text" ? n.marks : n.marks.filter((m) => m.type !== "code");
		if (marks.length) n.marks = marks;
		else delete n.marks;
	}
	for (const c of n.content ?? []) schemaTransform(c);
}

/** `loadNoteParser().parse`, for callers that cannot await (the parser is built on first use, a few ms). */
export function parseNoteSync(html: string): NoteNode {
	parser ??= create();
	return parser.parse(html);
}

function create(): NoteParser {
	const t0 = performance.now();
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const pm = DOMParser.fromSchema(schema);
	const parse = (html: string): NoteNode => {
		const box = document.createElement("div");
		// What an HTML parser does and linkedom's does not: NUL is dropped, and the newline right after <pre> is not content (two of them
		// are not: the editor's preprocessHTML parses the note, serializes it and parses it again)
		box.innerHTML = html.replace(/\0/g, "").replace(/(<pre(?:\s[^>]*)?>)(?:\r\n|\n|\r){1,2}/gi, "$1");
		// Zotero's editor parses the whole body, so a style on the root <div> reaches the text too
		const root = box;
		// linkedom's parser leaves text next to an entity in separate nodes (`a&amp;b` is three), and ProseMirror trims white space per node
		box.normalize();
		preprocess(box, document);
		const metadata = noteMetadata(box);
		try {
			const node = pm.parse(root).toJSON() as NoteNode;
			schemaTransform(node);
			labelCitations(node, metadata);
			return node;
		} catch (e) {
			console.warn("native notes: parse failed:", e instanceof Error ? e.message : e);
			return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: root.textContent ?? "" }] }] };
		}
	};
	return { parse, loadMs: performance.now() - t0 };
}

/** Give every citation node its display text, "(Smith 2020; Jones et al. 2019)", as Zotero's editor draws it. */
function labelCitations(n: NoteNode, metadata: Metadata): void {
	if (n.type === "citation") {
		// (a data-citation that is JSON of another shape, `[1,2]` or `{}`, has no items to show)
		const raw = JSON.parse(JSON.stringify(n.attrs?.citation ?? null)) as { citationItems?: unknown } | null;
		const citation = { citationItems: Array.isArray(raw?.citationItems) ? raw.citationItems : [] } as { citationItems: unknown[] };
		try {
			metadata.fillCitationItemsWithData(citation.citationItems);
		} catch {
			/* items without data stay unlabelled */
		}
		// Zotero's localiser answers a missing string with its key ("general-et-al"), so its own "et al." fallback never runs here;
		// it also logs every miss: quiet while formatting
		const warn = console.warn;
		console.warn = () => {};
		let parts: string[];
		try {
			parts = citation.citationItems
				.map(formatCitationItem)
				.filter(Boolean)
				.map((s) => s.replace(/\bgeneral-et-al\b/g, "et al.").replace(/\bgeneral-and\b/g, "and"));
		} finally {
			console.warn = warn;
		}
		n.attrs = { ...n.attrs, text: parts.length ? `(${parts.join("; ")})` : "(citation)" };
	}
	for (const c of n.content ?? []) labelCitations(c, metadata);
}
