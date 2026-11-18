// Safe rich text: the `html-subset` format is parsed here into a tiny tree and written out as Markdown for GPUIX's native <markdown>.
// Only a whitelist of tags is ever emitted, so scripts, styles, event attributes, iframes and forms cannot get through: they are
// dropped with their content. Pure, no GPUIX.

export const mdEscape = (s: string): string => s.replace(/([\\`*_{}\[\]<>#~|])/g, "\\$1");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©" };
const decode = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});

interface HNode {
	tag: string;
	attrs: Record<string, string>;
	children: (HNode | string)[];
}
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);
const DROP = new Set(["script", "style", "iframe", "form", "object", "embed", "head", "title", "textarea", "select", "button", "svg", "math", "template", "noscript"]);

function parse(html: string): HNode {
	const root: HNode = { tag: "#root", attrs: {}, children: [] };
	const stack: HNode[] = [root];
	let drop = 0;
	const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[0].startsWith("<!--")) continue;
		if (m[4] !== undefined) {
			if (!drop) stack[stack.length - 1]!.children.push(decode(m[4]));
			continue;
		}
		const closing = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		if (DROP.has(tag)) {
			if (closing) drop = Math.max(0, drop - 1);
			else if (!/\/\s*$/.test(m[3] ?? "")) drop++;
			continue;
		}
		if (drop) continue;
		if (closing) {
			const i = stack.map((n) => n.tag).lastIndexOf(tag);
			if (i > 0) stack.length = i;
			continue;
		}
		const attrs: Record<string, string> = {};
		for (const a of (m[3] ?? "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g)) {
			const name = a[1]!.toLowerCase();
			if (name.startsWith("on")) continue; // event attributes
			attrs[name] = decode(a[3] ?? a[4] ?? a[2] ?? "");
		}
		const n: HNode = { tag, attrs, children: [] };
		stack[stack.length - 1]!.children.push(n);
		if (!VOID.has(tag)) stack.push(n);
	}
	return root;
}

const safeHref = (h: string | undefined) => (h && !/^\s*(javascript|data|vbscript|file):/i.test(h) ? h : undefined);

function plain(n: HNode | string): string {
	return typeof n === "string" ? n : n.children.map(plain).join("");
}

function render(n: HNode | string, ctx: { pre: boolean; list: string[]; quote: number }): string {
	if (typeof n === "string") return ctx.pre ? n : mdEscape(n.replace(/\s+/g, " "));
	const kids = (c = ctx) => n.children.map((k) => render(k, c)).join("");
	switch (n.tag) {
		case "#root":
		case "html":
		case "body":
		case "div":
		case "section":
		case "article":
		case "span":
			return n.tag === "span" ? kids() : `\n\n${kids()}\n\n`;
		case "p":
			return `\n\n${kids()}\n\n`;
		case "br":
			return "  \n";
		case "hr":
			return "\n\n---\n\n";
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return `\n\n${"#".repeat(Number(n.tag[1]))} ${kids().trim()}\n\n`;
		case "strong":
		case "b":
			return kids().trim() ? `**${kids().trim()}**` : "";
		case "em":
		case "i":
			return kids().trim() ? `*${kids().trim()}*` : "";
		case "del":
		case "s":
		case "strike":
			return kids().trim() ? `~~${kids().trim()}~~` : "";
		case "code":
			return ctx.pre ? plain(n) : "`" + plain(n).replace(/`/g, "'") + "`";
		case "pre":
			return `\n\n\`\`\`\n${plain(n).replace(/```/g, "'''")}\n\`\`\`\n\n`;
		case "blockquote":
			return (
				"\n\n" +
				kids()
					.trim()
					.split("\n")
					.map((l) => "> " + l)
					.join("\n") +
				"\n\n"
			);
		case "ul":
		case "ol":
			return "\n" + n.children.map((c, i) => (typeof c === "string" ? "" : render(c, { ...ctx, list: [...ctx.list, n.tag === "ol" ? `${i + 1}.` : "-"] }))).join("") + "\n";
		case "li": {
			const marker = ctx.list[ctx.list.length - 1] ?? "-";
			const indent = "  ".repeat(Math.max(0, ctx.list.length - 1));
			return `\n${indent}${marker} ${kids().trim().replace(/\n{2,}/g, "\n")}`;
		}
		case "a": {
			const href = safeHref(n.attrs.href);
			const label = kids().trim() || mdEscape(href ?? "");
			return href ? `[${label}](${href.replace(/\)/g, "%29")})` : label;
		}
		case "img":
			return `[image${n.attrs.alt ? ": " + mdEscape(n.attrs.alt) : ""}]`;
		case "table": {
			const rows: string[][] = [];
			const collect = (x: HNode) => {
				for (const c of x.children) {
					if (typeof c === "string") continue;
					if (c.tag === "tr") rows.push(c.children.filter((d): d is HNode => typeof d !== "string" && (d.tag === "td" || d.tag === "th")).map((d) => render(d, ctx).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")));
					else collect(c);
				}
			};
			collect(n);
			if (!rows.length) return "";
			const w = Math.max(...rows.map((r) => r.length));
			const line = (r: string[]) => "| " + Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ") + " |";
			return `\n\n${line(rows[0]!)}\n| ${Array.from({ length: w }, () => "---").join(" | ")} |\n${rows.slice(1).map(line).join("\n")}\n\n`;
		}
		case "td":
		case "th":
			return kids();
		default:
			return kids(); // unknown (harmless) tags keep their text
	}
}

/** `html-subset` -> Markdown. Links keep their href unless it is `javascript:`, `data:`, `vbscript:` or `file:`. */
export function htmlToMarkdown(html: string): string {
	return render(parse(html), { pre: false, list: [], quote: 0 })
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
