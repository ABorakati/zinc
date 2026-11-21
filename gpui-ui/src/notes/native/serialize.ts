// Native note editing: a ProseMirror document (parse.ts's JSON) back to Zotero note HTML, the way Zotero's editor writes it
// (vendor/note-editor/src/core/schema/utils.js buildToHTML): the schema's DOMSerializer, a root <div> carrying the note's metadata
// (data-schema-version, data-citation-items) with its attributes sorted, a newline around block elements, and a list item's lone
// <p> unwrapped. Runs on a linkedom document of its own, like the parser.
import { parseHTML } from "linkedom";
import { DOMSerializer, Metadata, schema } from "./zotero-schema.gen.js";
import type { NoteNode } from "./parse";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
const serializer = DOMSerializer.fromSchema(schema);

/** The JSON as the schema wants it back: without the display text parse.ts adds to citations. */
function clean(n: NoteNode): NoteNode {
	const out: NoteNode = { ...n };
	if (n.type === "citation" && n.attrs && "text" in n.attrs) {
		const { text: _text, ...attrs } = n.attrs;
		out.attrs = attrs;
	}
	if (n.content) out.content = n.content.map(clean);
	return out;
}

const TEXT_NODES = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "pre"];
const BLOCK_NODES = ["ol", "ul", "li", "hr", "blockquote", "table", "th", "tr", "td", "thead", "tbody", "tfoot"];

/** Zotero's layout of the serialized HTML: a newline after text blocks, inside and after block containers; a <li>'s only <p> unwrapped. */
function layout(root: Element): void {
	for (const node of Array.from(root.querySelectorAll([...TEXT_NODES, ...BLOCK_NODES].join(",")))) {
		if (BLOCK_NODES.includes(node.nodeName.toLowerCase())) node.insertBefore(document.createTextNode("\n"), node.firstChild);
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

/**
 * The whole note as Zotero note HTML. `sourceHtml` is the note as loaded: its root <div>'s metadata (citation items) is kept.
 * An empty note (one empty text block) is "" as in Zotero, so Zotero can tell the note is empty.
 */
export function serializeNote(doc: NoteNode, sourceHtml: string): string {
	const content = doc.content ?? [];
	if (content.length === 0 || (content.length === 1 && content[0]!.type === "paragraph" && !(content[0]!.content ?? []).length))
		return "";
	const metadata = new Metadata();
	const src = document.createElement("div");
	src.innerHTML = sourceHtml;
	const first = src.firstElementChild;
	const root = first && first.tagName === "DIV" && src.childElementCount === 1 ? first : null;
	const attrs: Record<string, string> = {};
	if (root) for (const a of Array.from(root.attributes as ArrayLike<{ name: string; value: string }>)) attrs[a.name] = a.value;
	metadata.parseAttributes(attrs);
	return withEditorContext(metadata, () => {
		const container = document.createElement("div");
		const out = metadata.serializeAttributes();
		for (const k of Object.keys(out).sort()) container.setAttribute(k, out[k]!);
		container.append(toFragment(content));
		const holder = document.createElement("div");
		holder.append(container);
		layout(holder);
		return holder.innerHTML;
	});
}
