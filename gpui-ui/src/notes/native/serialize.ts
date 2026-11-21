// Native note editing: a ProseMirror document (parse.ts's JSON) back to Zotero note HTML, the way Zotero's editor writes it
// (vendor/note-editor/src/core/schema/utils.js buildToHTML): the schema's DOMSerializer, a root <div> carrying the note's metadata
// (data-schema-version, data-citation-items) with its attributes sorted, a newline around block elements, and a list item's lone
// <p> unwrapped. Runs on a linkedom document of its own, like the parser.
import { parseHTML } from "linkedom";
import { DOMSerializer, Metadata, schema } from "./zotero-schema.gen.js";
import { type NoteNode, noteMetadata, parseNoteSync } from "./parse";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const serializer = DOMSerializer.fromSchema(schema);

/** The JSON as the schema wants it back: without the display text parse.ts adds to citations. */
export function clean(n: NoteNode): NoteNode {
	const out: NoteNode = { ...n };
	if (n.type === "citation" && n.attrs && "text" in n.attrs) {
		const { text: _text, ...attrs } = n.attrs;
		out.attrs = attrs;
	}
	if (n.content) out.content = n.content.map(clean);
	return out;
}

/** `clean`, plus the random node ids (citation, image) renumbered in document order: a document that compares and diffs. */
export function stableDoc(doc: NoteNode): NoteNode {
	let n = 0;
	const walk = (x: NoteNode): NoteNode => {
		const o: NoteNode = { ...x };
		if (x.attrs && "nodeID" in x.attrs) o.attrs = { ...x.attrs, nodeID: `NODE${String(++n).padStart(4, "0")}` };
		if (x.content) o.content = x.content.map(walk);
		return o;
	};
	return walk(clean(doc));
}

const TEXT_NODES = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "pre"];
const BLOCK_NODES = ["ol", "ul", "li", "hr", "blockquote", "table", "th", "tr", "td", "thead", "tbody", "tfoot"];

/** Zotero's layout of the serialized HTML: a newline after text blocks, inside and after block containers; a <li>'s only <p> unwrapped. */
function layout(root: Element): void {
	for (const node of Array.from(root.querySelectorAll([...TEXT_NODES, ...BLOCK_NODES].join(",")))) {
		// not into <hr>: the browser's serializer drops the children of a void element, linkedom's writes them (and a closing tag)
		if (BLOCK_NODES.includes(node.nodeName.toLowerCase()) && node.nodeName !== "HR")
			node.insertBefore(document.createTextNode("\n"), node.firstChild);
		node.parentNode?.insertBefore(document.createTextNode("\n"), node.nextSibling);
	}
	for (const li of Array.from(root.querySelectorAll("li"))) {
		if (li.children.length === 1 && li.firstElementChild?.nodeName === "P")
			li.firstElementChild.replaceWith(...Array.from(li.firstElementChild.childNodes));
	}
}

/**
 * Serialize with what Zotero's toDOM rules expect from the editor around them: `window.dir` (list rules read the page direction;
 * a stand-in exists only during the call, any real `window` is put back) and `schema.cached.metadata` (citations fill their item
 * data from it).
 */
function withEditorContext<T>(metadata: Metadata, run: () => T): T {
	const g = globalThis as { window?: unknown };
	const hadWindow = "window" in g;
	const prevWindow = g.window;
	if (!hadWindow) g.window = { dir: undefined };
	const cached = (schema as unknown as { cached: Record<string, unknown> }).cached;
	const prevMeta = cached.metadata;
	cached.metadata = metadata;
	try {
		return run();
	} finally {
		cached.metadata = prevMeta;
		if (!hadWindow) delete g.window;
		else g.window = prevWindow;
	}
}

const toFragment = (nodes: NoteNode[]) =>
	serializer.serializeFragment(schema.nodeFromJSON({ type: "doc", content: nodes.map(clean) }).content, { document });

/** Block nodes as an HTML fragment (no root <div>), e.g. for converting one block to Markdown. */
export function serializeBlocks(nodes: NoteNode[], metadata: Metadata = new Metadata()): string {
	return withEditorContext(metadata, () => {
		const box = document.createElement("div");
		box.append(toFragment(nodes));
		layout(box);
		return box.innerHTML;
	});
}

/** Zotero's `schema.version`; its own `buildToHTML` writes the one below when the note has no underline annotation. */
const SCHEMA_VERSION = (schema as unknown as { version: number }).version;

/**
 * The whole note as Zotero note HTML. `sourceHtml` is the note as loaded: its root <div>'s metadata (citation items) is kept, minus
 * the items no citation or annotation of the note *as loaded* uses (EditorCore drops those when it opens a note, and does not touch
 * the metadata on later edits). Like `buildToHTML`, an empty note (one
 * empty text block) is "" so Zotero can tell it is empty, the schema version is lowered by one when the note has no underline
 * annotation, and the text is NFC-normalised.
 */
export function serializeNote(doc: NoteNode, sourceHtml: string): string {
	const content = doc.content ?? [];
	const only = content.length === 1 ? content[0]! : null;
	// "a text block with no content": paragraph, heading, code block and display maths are all textblocks
	if (
		content.length === 0 ||
		(only && ["paragraph", "heading", "codeBlock", "math_display"].includes(only.type) && !(only.content ?? []).length)
	)
		return "";
	const src = document.createElement("div");
	src.innerHTML = sourceHtml;
	const metadata = noteMetadata(src);
	const nodes = content.map(clean);
	// (a note from a newer schema opens read-only in Zotero, which leaves its metadata alone)
	if (metadata.schemaVersion <= SCHEMA_VERSION) {
		const loaded = parseNoteSync(sourceHtml);
		metadata.deleteUnusedCitationItems({
			tr: { doc: schema.nodeFromJSON({ type: "doc", content: (loaded.content ?? []).map(clean) }) },
		});
	}
	return withEditorContext(metadata, () => {
		const container = document.createElement("div");
		const out = metadata.serializeAttributes();
		for (const k of Object.keys(out).sort()) container.setAttribute(k, out[k]!);
		container.append(toFragment(nodes));
		const holder = document.createElement("div");
		holder.append(container);
		layout(holder);
		if (SCHEMA_VERSION === 10 && !holder.querySelector("span.underline")) container.setAttribute("data-schema-version", "9");
		return holder.innerHTML.trim().normalize("NFC");
	});
}
