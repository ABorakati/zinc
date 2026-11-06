import { readFileSync } from "node:fs";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// The site renders ../docs (plain GitHub Markdown, no front matter needed). The page title is its first "# Heading";
// the remark plugin in plugins/docs-markdown.mjs removes that heading from the body and fixes relative links.
const BACKSLASH = new RegExp(String.fromCharCode(92, 92), "g");

const inner = glob({
	pattern: "**/*.md",
	base: "../docs",
	generateId: ({ entry }) => {
		const s = entry.replace(BACKSLASH, "/").replace(/\.md$/i, "");
		if (s.toLowerCase() === "readme") return "overview";
		return s.replace(/\/readme$/i, "").toLowerCase();
	},
});

const titleOf = (file: string): string => {
	const text = readFileSync(file, "utf8").replace(/^---[\s\S]*?\n---\r?\n/, "");
	const m = /^#\s+(.+?)\s*$/m.exec(text);
	if (!m) throw new Error(`${file}: every docs page needs a "# Title" line`);
	return m[1].replace(/[`*_]/g, "");
};

const docsLoader = {
	...inner,
	load: (ctx: Parameters<typeof inner.load>[0]) =>
		inner.load({
			...ctx,
			parseData: (o: { id: string; data: Record<string, unknown>; filePath?: string }) =>
				ctx.parseData({ ...o, data: { title: o.filePath ? titleOf(o.filePath) : o.id, ...o.data } }),
		} as typeof ctx),
};

export const collections = {
	docs: defineCollection({ loader: docsLoader, schema: docsSchema() }),
};
