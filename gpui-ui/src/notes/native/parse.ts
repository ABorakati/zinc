// PROTOTYPE (read-only native note view): Zotero note HTML -> a ProseMirror document, parsed with Zotero's own note schema
// (vendor/note-editor/src/core/schema: the same nodes, marks and parse rules Zotero's editor uses), so what the native view
// draws is what the editor would load. The schema's parse rules need DOM nodes; jsdom (core's dependency, as the translators
// use it) supplies them. No browser globals are set: the parse runs against a jsdom document of its own.
//
// Both come from the source tree (vendor/note-editor is a checkout of its own, jsdom sits in core/node_modules), so this only
// works when Zinc runs from source: `loadNoteParser()` resolves to null in a packaged build and callers keep the web editor.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
	/** ms spent loading jsdom and the schema */
	loadMs: number;
}

const SCHEMA = new URL("../../../../vendor/note-editor/src/core/schema/", import.meta.url);
const CORE_PKG = new URL("../../../../core/package.json", import.meta.url);

let loading: Promise<NoteParser | null> | undefined;

/** Load jsdom and Zotero's schema once (about 0.8 s the first time); null when they are not on disk (a packaged build). */
export function loadNoteParser(): Promise<NoteParser | null> {
	loading ??= load().catch((e) => {
		console.warn("native notes: parser unavailable:", e instanceof Error ? e.message : e);
		return null;
	});
	return loading;
}

async function load(): Promise<NoteParser | null> {
	const schemaIndex = new URL("index.js", SCHEMA);
	if (!existsSync(fileURLToPath(schemaIndex)) || !existsSync(fileURLToPath(CORE_PKG))) return null;
	const t0 = performance.now();
	// the note-editor's sources read a build constant at import time (webpack defines it there)
	const g = globalThis as { __BUILD__?: string };
	g.__BUILD__ ??= "web";
	const { JSDOM } = createRequire(fileURLToPath(CORE_PKG))("jsdom") as {
		JSDOM: new (html: string) => { window: { document: Document } };
	};
	const doc = new JSDOM("<!doctype html><html><body></body></html>").window.document;
	// computed paths: the bundler must not pull the note-editor sources into a build
	const schemaMod = (await import(schemaIndex.href)) as { schema: PmSchema };
	const { default: Metadata } = (await import(new URL("metadata.js", SCHEMA).href)) as { default: new () => PmMetadata };
	const { formatCitationItem } = (await import(new URL("../utils.js", SCHEMA).href)) as {
		formatCitationItem: (item: unknown) => string;
	};
	// the prosemirror-model the schema itself imports (a second copy would fail its instanceof checks)
	const pmModel = Bun.resolveSync("prosemirror-model", fileURLToPath(SCHEMA));
	const { DOMParser } = (await import(pmModel)) as {
		DOMParser: { fromSchema(s: PmSchema): { parse(n: Node): PmNode } };
	};
	const parser = DOMParser.fromSchema(schemaMod.schema);
	const loadMs = performance.now() - t0;

	const parse = (html: string): NoteNode => {
		const box = doc.createElement("div");
		box.innerHTML = html;
		// Zotero's root <div data-schema-version data-citation-items>: the metadata the citations' text comes from
		const root = box.firstElementChild?.tagName === "DIV" && box.childElementCount === 1 ? box.firstElementChild : box;
		const metadata = new Metadata();
		const attrs: Record<string, string> = {};
		for (const a of Array.from(root.attributes)) attrs[a.name] = a.value;
		metadata.parseAttributes(attrs);
		try {
			const node = parser.parse(root).toJSON() as NoteNode;
			labelCitations(node, metadata, formatCitationItem);
			return node;
		} catch (e) {
			console.warn("native notes: parse failed:", e instanceof Error ? e.message : e);
			return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: root.textContent ?? "" }] }] };
		}
	};
	return { parse, loadMs };
}

/** Give every citation node its display text, "(Smith 2020; Jones et al. 2019)", as Zotero's editor draws it. */
function labelCitations(n: NoteNode, metadata: PmMetadata, format: (item: unknown) => string): void {
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
				.map(format)
				.filter(Boolean)
				.map((s) => s.replace(/\bgeneral-et-al\b/g, "et al.").replace(/\bgeneral-and\b/g, "and"));
		} finally {
			console.warn = warn;
		}
		n.attrs = { ...n.attrs, text: parts.length ? `(${parts.join("; ")})` : "(citation)" };
	}
	for (const c of n.content ?? []) labelCitations(c, metadata, format);
}

// the little of ProseMirror's and Zotero's API used here
interface PmSchema {
	readonly nodes: unknown;
}
interface PmNode {
	toJSON(): unknown;
}
interface PmMetadata {
	parseAttributes(attrs: Record<string, string>): void;
	fillCitationItemsWithData(items: unknown[]): void;
}
