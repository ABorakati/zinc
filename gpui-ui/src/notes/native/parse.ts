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

function create(): NoteParser {
	const t0 = performance.now();
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const pm = DOMParser.fromSchema(schema);
	const parse = (html: string): NoteNode => {
		const box = document.createElement("div");
		box.innerHTML = html;
		// Zotero's root <div data-schema-version data-citation-items>: the metadata the citations' text comes from
		const first = box.firstElementChild;
		const root = first && first.tagName === "DIV" && box.childElementCount === 1 ? first : box;
		const metadata = new Metadata();
		const attrs: Record<string, string> = {};
		for (const a of Array.from(root.attributes as ArrayLike<{ name: string; value: string }>)) attrs[a.name] = a.value;
		metadata.parseAttributes(attrs);
		try {
			const node = pm.parse(root).toJSON() as NoteNode;
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
		const citation = JSON.parse(JSON.stringify(n.attrs?.citation ?? { citationItems: [] })) as { citationItems: unknown[] };
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
