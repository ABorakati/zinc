// /llms.txt (llmstxt.org): what Zinc is, and an index of the site's Markdown pages in the sidebar's order, one line each.
import type { APIRoute } from "astro";
import { addressOf, docPages, markdownOf, mdPathOf, SUMMARY, summaryOf, textResponse } from "../lib/llms";

export const GET: APIRoute = async () => {
	const pages = await docPages();
	const sections = [...new Set(pages.map((p) => p.section))];
	const line = (title: string, href: string, about: string) => `- [${title}](${href})${about ? `: ${about}` : ""}`;
	const out = [
		"# Zinc",
		"",
		`> ${SUMMARY}`,
		"",
		"Zinc opens the same kind of library as Zotero (it imports a Zotero data folder read-only and syncs with zotero.org) and speaks the Zotero connector protocol. Every page below is plain Markdown. All of them in one file: " +
			`[llms-full.txt](${addressOf("llms-full.txt")}).`,
		"",
		"## About",
		"",
		line("README", addressOf("readme.md"), "what Zinc is, its features, how it compares with Zotero, how to install it"),
		"",
	];
	for (const s of sections) {
		out.push(`## ${s}`, "");
		for (const p of pages.filter((x) => x.section === s)) out.push(line(p.title, addressOf(mdPathOf(p.slug)), summaryOf(markdownOf(p).replace(/^#\s+.*\n/, ""))));
		out.push("");
	}
	return textResponse(out.join("\n"), "text/plain");
};
