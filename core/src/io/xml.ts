// Minimal XML reader for the importers (EndNote, Zotero RDF, MODS): elements, attributes, text, CDATA.
// Element names keep their namespace prefix ("bib:Article"); `local` strips it for matching.
import { decodeEntities } from "./common";

export interface XmlNode {
	name: string; // qualified name as written, e.g. "dc:title"
	attrs: Record<string, string>;
	children: XmlNode[];
	own: string; // the node's own text (direct text children only)
	text: string; // own text plus everything under it (styles flattened)
}

// Groups: 1 CDATA, 2 closing slash, 3 element name, 4 attributes, 5 self-closing slash, 6 text
const XML_SOURCE =
	"<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|<!--[\\s\\S]*?-->|<\\?[\\s\\S]*?\\?>|<!DOCTYPE[^>]*>|<(/?)" +
	"([A-Za-z_][\\w:.-]*)((?:\\s+[\\w:.-]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*'))*)\\s*(/?)>|([^<]+)";

export function parseXml(xml: string): XmlNode {
	const root: XmlNode = { name: "#root", attrs: {}, children: [], own: "", text: "" };
	const stack: XmlNode[] = [root];
	const re = new RegExp(XML_SOURCE, "g");
	let m: RegExpExecArray | null;
	const addText = (t: string) => {
		for (const n of stack) n.text += t;
		stack[stack.length - 1]!.own += t;
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
				const node: XmlNode = { name: m[3]!, attrs, children: [], own: "", text: "" };
				stack[stack.length - 1]!.children.push(node);
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
	return n ? n.text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
}
