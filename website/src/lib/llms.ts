// The docs as plain Markdown, for language models and for "Copy as Markdown" (llmstxt.org):
//   /<page>.md       each docs page's own Markdown ([...slug].md.ts), e.g. /user-guide/reader.md
//   /readme.md       the repository README (what Zinc is, features, install)
//   /llms.txt        an index of those, in the sidebar's order, with one line about each page
//   /llms-full.txt   all of them in one file
// The Markdown is docs/ as written, with relative links made into site addresses: a link to another page points at its .md
// version, a screenshot at <base>screenshots/. Addresses are absolute when the site's origin is known (DOCS_SITE), else rooted.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";
import { slugOf } from "../../plugins/docs-markdown.mjs";
import { DOCS_NAV } from "../../plugins/docs-nav.mjs";

const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const site = import.meta.env.SITE;
// from the working folder (website/), as src/content.config.ts's loader does: in the build bundle a module's own URL points into dist
const REPO_ROOT = path.resolve(process.cwd(), "..");
const DOCS_ROOT = path.join(REPO_ROOT, "docs");
const fwd = (p: string) => p.split(path.sep).join("/");

/** A site path (`user-guide/reader.md`) as the address to print: absolute when the origin is configured. */
export const addressOf = (p: string): string => (site ? new URL(`${base}${p}`, site).href : `${base}${p}`);
/** The Markdown address of a docs page. */
export const mdPathOf = (slug: string): string => `${slug}.md`;

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|#|\/)/i;

/** Rewrite the relative links and images of Markdown that lives in `fromDir` into site addresses (others are left alone). */
export function rewriteLinks(md: string, fromDir: string): string {
	return md.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang: string, text: string, url: string, title: string) => {
		if (ABSOLUTE.test(url)) return all;
		const [raw, hash] = url.split("#");
		if (!raw) return all;
		const target = path.resolve(fromDir, decodeURI(raw));
		const frag = hash ? `#${hash}` : "";
		if (!target.startsWith(DOCS_ROOT)) return all; // a repository path (core/MCP.md, LICENSE): not on the site
		let page: string | null = null;
		if (/\.md$/i.test(target)) page = target;
		else if (existsSync(target) && statSync(target).isDirectory() && existsSync(path.join(target, "README.md")))
			page = path.join(target, "README.md");
		if (page) return `${bang}[${text}](${addressOf(mdPathOf(slugOf(fwd(path.relative(DOCS_ROOT, page)))))}${frag}${title})`;
		const rel = fwd(path.relative(DOCS_ROOT, target));
		if (rel.startsWith("screenshots/")) return `${bang}[${text}](${addressOf(rel)}${title})`;
		return all;
	});
}

type Doc = CollectionEntry<"docs">;
export interface DocPage {
	slug: string;
	title: string;
	file: string;
	section: string;
}

/** Every docs page, in the sidebar's order (pages the sidebar does not list come last, under "Other"). */
export async function docPages(): Promise<DocPage[]> {
	const all = (await getCollection("docs")) as Doc[];
	const byId = new Map(all.map((d) => [d.id, d]));
	const page = (d: Doc, section: string): DocPage => ({ slug: d.id, title: d.data.title, file: path.resolve(d.filePath ?? ""), section });
	const out: DocPage[] = [];
	for (const g of DOCS_NAV)
		for (const s of g.slugs) {
			const d = byId.get(s);
			if (d) {
				out.push(page(d, g.label));
				byId.delete(s);
			}
		}
	for (const d of byId.values()) out.push(page(d, "Other"));
	return out;
}

/** A docs page's Markdown for the site (its own "# Title" line kept). */
export function markdownOf(p: DocPage): string {
	return rewriteLinks(
		readFileSync(p.file, "utf8")
			.replace(/^---[\s\S]*?\n---\r?\n/, "")
			.replace(/\r\n/g, "\n"),
		path.dirname(p.file),
	);
}

/** The repository README, with its links to docs/ made into site addresses. */
export function readmeMarkdown(): string {
	return rewriteLinks(readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n"), REPO_ROOT);
}

/** One line about a page: the first sentence of its first paragraph, without Markdown. */
export function summaryOf(md: string): string {
	for (const block of md.split(/\n\s*\n/)) {
		const t = block.trim();
		if (!t || /^(#|!|-|\*|\||>|<|```|\d+\.)/.test(t)) continue;
		const plain = t
			.replace(/\s+/g, " ")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/[*_`]/g, "");
		const m = /^(.{20,240}?[.!?])(\s|$)/.exec(plain);
		return m ? m[1] : plain.length > 240 ? `${plain.slice(0, 237).replace(/\s+\S*$/, "")}…` : plain;
	}
	return "";
}

export const SUMMARY =
	"Zinc is a fast, native, Zotero-compatible reference manager for Windows, Linux and macOS: a GPU-drawn library and PDF reader on your Zotero data, Zotero's own translators and sync, a Word add-in and a browser connector that work with the app closed (Windows), and a built-in MCP server for AI agents.";

export const textResponse = (body: string, type: string) => new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
