// Reads parts of the repository README at build time, so the site's benchmark tables, feature lists and comparison grid
// always match the README (one source of truth). Only the small Markdown subset the README uses is handled:
// headings, pipe tables, "- " bullets, paragraphs, and inline **bold**, *italic*, `code` and [links](url).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "https://github.com/ABorakati/zotero-next";
const text = readFileSync(resolve("../README.md"), "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");

/** The body under a heading (`## Features`, `### Fast`...), up to the next heading of the same or a higher level. */
export function section(heading: string): string {
	const level = /^#+/.exec(heading)![0].length;
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start < 0) throw new Error(`README.md: heading not found: ${heading}`);
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		const m = /^(#+)\s/.exec(l);
		if (m && m[1].length <= level) break;
		out.push(l);
	}
	return out.join("\n");
}

/** The `### Sub` headings directly under a section, with each one's body. */
export function subsections(body: string): { title: string; body: string }[] {
	const parts: { title: string; body: string }[] = [];
	for (const l of body.split("\n")) {
		const m = /^###\s+(.+)$/.exec(l);
		if (m) parts.push({ title: m[1].trim(), body: "" });
		else if (parts.length) parts[parts.length - 1].body += l + "\n";
	}
	return parts;
}

export interface Table { head: string[]; rows: string[][] }

const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Every pipe table in a block of Markdown. */
export function tables(body: string): Table[] {
	const out: Table[] = [];
	let cur: string[] = [];
	const flush = () => {
		if (cur.length >= 2) out.push({ head: cells(cur[0]), rows: cur.slice(2).map(cells) });
		cur = [];
	};
	for (const l of body.split("\n")) {
		if (l.trim().startsWith("|")) cur.push(l);
		else flush();
	}
	flush();
	return out;
}

/** Top-level "- " bullets (continuation lines folded in). */
export function bullets(body: string): string[] {
	const out: string[] = [];
	for (const l of body.split("\n")) {
		if (/^- /.test(l)) out.push(l.slice(2).trim());
		else if (out.length && /^\s+\S/.test(l)) out[out.length - 1] += " " + l.trim();
	}
	return out;
}

/** Plain paragraphs (not tables, bullets, headings, images or comments). */
export function paragraphs(body: string): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	const flush = () => { if (cur.length) out.push(cur.join(" ")); cur = []; };
	for (const l of body.split("\n")) {
		const t = l.trim();
		if (!t || /^(\||- |#|!\[|<!--|```|\d+\. )/.test(t)) flush();
		else cur.push(t);
	}
	flush();
	return out.filter((p) => !p.startsWith("*How measured*"));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Where a README link should point on the site: its own anchors become site pages, repository paths go to GitHub. */
function href(url: string, base: string): string {
	const anchors: Record<string, string> = {
		"#benchmarks": `${base}compare/`,
		"#feature-comparison-with-zotero-10": `${base}compare/#features`,
		"#mcp-for-ai-agents": `${base}user-guide/mcp/`,
		"#install": `${base}download/`,
		"#the-word-add-in": `${base}user-guide/word/`,
		"#the-browser-connector": `${base}download/#connector`,
	};
	if (url.startsWith("#")) return anchors[url] ?? `${base}overview/`;
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
	const doc = /^docs\/(.+)\.md(#.*)?$/i.exec(url);
	if (doc) return `${base}${doc[1].replace(/\/readme$/i, "").toLowerCase()}/${doc[2] ?? ""}`;
	return `${REPO}/blob/main/${url}`;
}

/** Inline Markdown to HTML (escaped first, so README text cannot inject markup). */
export function inline(md: string, base: string): string {
	const codes: string[] = [];
	let s = esc(md).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
	s = s
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
			const h = href(u.replace(/&amp;/g, "&"), base);
			const ext = /^https?:/.test(h) && !h.startsWith(REPO) ? ' rel="noopener"' : "";
			return `<a href="${esc(h)}"${ext}>${t}</a>`;
		})
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** ✅ / ⚠️ / ❌ / n/a cells of the comparison grid, as a label and a tone. */
export function mark(cell: string): { label: string; tone: "yes" | "part" | "no" | "na" } | null {
	if (cell.includes("✅")) return { label: "Yes", tone: "yes" };
	if (cell.includes("⚠")) return { label: "Partly", tone: "part" };
	if (cell.includes("❌")) return { label: "No", tone: "no" };
	if (cell.toLowerCase() === "n/a") return { label: "n/a", tone: "na" };
	return null;
}
