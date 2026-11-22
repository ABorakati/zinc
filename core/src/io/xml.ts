// Minimal XML reader for the importers (EndNote, Zotero RDF, MODS): elements, attributes, text, CDATA.
// Element names keep their namespace prefix ("bib:Article"); `local` strips it for matching.
import { decodeEntities } from "./common";

export interface XmlNode {
	name: string; // qualified name as written, e.g. "dc:title"
	attrs: Record<string, string>;
	children: XmlNode[];
	readonly own: string; // the node's own text (direct text children only)
	readonly text: string; // own text plus everything under it, in document order (styles flattened)
}

/**
 * A parsed element. Text is kept once, in the element that directly holds it, as an ordered list of text pieces and child
 * elements; `own` and `text` are put together on request. (Appending every piece to every open ancestor used to cost
 * memory proportional to the text times the nesting depth.)
 */
class XmlElement implements XmlNode {
	children: XmlNode[] = [];
	/** Text pieces and child elements in document order. */
	parts: (string | XmlElement)[] = [];
	private flat: string | undefined;
	constructor(
		readonly name: string,
		readonly attrs: Record<string, string>,
	) {}

	get own(): string {
		let s = "";
		for (const p of this.parts) if (typeof p === "string") s += p;
		return s;
	}

	get text(): string {
		if (this.flat !== undefined) return this.flat;
		// walk the tree without recursion: documents can be nested thousands of levels deep
		const out: string[] = [];
		const stack: { el: XmlElement; i: number }[] = [{ el: this, i: 0 }];
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			if (top.i >= top.el.parts.length) {
				stack.pop();
				continue;
			}
			const p = top.el.parts[top.i++]!;
			if (typeof p === "string") out.push(p);
			else stack.push({ el: p, i: 0 });
		}
		return (this.flat = out.join(""));
	}
}

// Groups: 1 CDATA, 2 closing slash, 3 element name, 4 attributes, 5 self-closing slash, 6 text
const XML_SOURCE =
	"<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|<!--[\\s\\S]*?-->|<\\?[\\s\\S]*?\\?>|<!DOCTYPE[^>]*>|<(/?)" +
	"([A-Za-z_][\\w:.-]*)((?:\\s+[\\w:.-]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'))*)\\s*(/?)>|([^<]+)";

export function parseXml(xml: string): XmlNode {
	const root = new XmlElement("#root", {});
	const stack: XmlElement[] = [root];
	const re = new RegExp(XML_SOURCE, "g");
	let m: RegExpExecArray | null;
	const addText = (t: string) => {
		stack[stack.length - 1]!.parts.push(t);
	};
	while ((m = re.exec(xml))) {
		if (m[1] !== undefined) addText(m[1]);
		else if (m[6] !== undefined) addText(decodeEntities(m[6]));
		else if (m[3]) {
			if (m[2]) {
				if (stack.length > 1) stack.pop();
			} else {
				const attrs: Record<string, string> = {};
				for (const a of m[4]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
					attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
				}
				const node = new XmlElement(m[3]!, attrs);
				const parent = stack[stack.length - 1]!;
				parent.children.push(node);
				parent.parts.push(node);
				if (!m[5]) stack.push(node);
			}
		}
	}
	return root;
}

/** The part of an element name after the colon ("dc:title" -> "title"). */
export function local(name: string): string {
	const i = name.indexOf(":");
	return i < 0 ? name : name.slice(i + 1);
}

export function isLocal(n: XmlNode, name: string): boolean {
	return local(n.name) === name;
}

/** Child elements with a local name. */
export function children(n: XmlNode | undefined, name: string): XmlNode[] {
	return n ? n.children.filter((c) => local(c.name) === name) : [];
}

/** Every descendant element with a local name. */
export function descendants(n: XmlNode | undefined, name: string): XmlNode[] {
	const out: XmlNode[] = [];
	const walk = (x: XmlNode) => {
		for (const c of x.children) {
			if (local(c.name) === name) out.push(c);
			walk(c);
		}
	};
	if (n) walk(n);
	return out;
}

/** Follow a chain of child local names ("contributors", "authors", "author"). */
export function path(n: XmlNode, ...names: string[]): XmlNode[] {
	let cur: XmlNode[] = [n];
	for (const name of names) cur = cur.flatMap((c) => c.children.filter((k) => local(k.name) === name));
	return cur;
}

/** Trimmed, whitespace-collapsed descendant text. */
export function textOf(n: XmlNode | undefined): string {
	return n ? n.text.replace(/\s+/g, " ").trim() : "";
}

/** Trimmed text with its line structure kept. */
export function blockText(n: XmlNode | undefined): string {
	return n
		? n.text
				.replace(/\r\n?/g, "\n")
				.replace(/[ \t]+/g, " ")
				.replace(/\n{3,}/g, "\n\n")
				.trim()
		: "";
}
