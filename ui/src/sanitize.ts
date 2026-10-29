// Minimal DOMParser-based HTML sanitiser. Parsing into an inert document
// never executes scripts or loads resources.
const NOTE_TAGS = new Set([
	"p", "br", "b", "i", "u", "em", "strong", "s", "sub", "sup", "code", "pre",
	"ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "a",
	"span", "div", "table", "thead", "tbody", "tr", "td", "th", "hr",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript"]);

function clean(node: Node, out: Node, allowed: Set<string>) {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			out.appendChild(document.createTextNode(child.textContent ?? ""));
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			const tag = el.tagName.toLowerCase();
			if (DROP_WITH_CONTENT.has(tag)) continue;
			if (!allowed.has(tag)) {
				clean(el, out, allowed); // unwrap
				continue;
			}
			const copy = document.createElement(tag);
			if (tag === "a") {
				const href = el.getAttribute("href") ?? "";
				if (/^https?:\/\//i.test(href)) {
					copy.setAttribute("href", href);
					copy.setAttribute("target", "_blank");
					copy.setAttribute("rel", "noopener noreferrer");
				}
			}
			clean(el, copy, allowed);
			out.appendChild(copy);
		}
	}
}

function sanitize(html: string, allowed: Set<string>): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const box = document.createElement("div");
	clean(doc.body, box, allowed);
	return box.innerHTML;
}

const MARK = new Set(["mark"]);
export const sanitizeNote = (html: string) => sanitize(html, NOTE_TAGS);
/** Search snippets: only <mark> survives; everything else is text. */
export const sanitizeSnippet = (html: string) => sanitize(html, MARK);
