// /llms-full.txt (llmstxt.org): the README and every docs page as Markdown in one file, in the sidebar's order. Each page starts
// with a comment naming its address, so a model can cite it.
import type { APIRoute } from "astro";
import { addressOf, docPages, markdownOf, mdPathOf, readmeMarkdown, SUMMARY, textResponse } from "../lib/llms";

export const GET: APIRoute = async () => {
	const parts = [
		`# Zinc: the full documentation\n\n> ${SUMMARY}\n`,
		`<!-- ${addressOf("readme.md")} -->\n\n${readmeMarkdown().trim()}\n`,
	];
	for (const p of await docPages()) parts.push(`<!-- ${addressOf(mdPathOf(p.slug))} -->\n\n${markdownOf(p).trim()}\n`);
	return textResponse(parts.join("\n---\n\n"), "text/plain");
};
