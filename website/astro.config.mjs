// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { unified } from "@astrojs/markdown-remark";
import { normalizeBase, remarkDocs } from "./plugins/docs-markdown.mjs";
import { DOCS_NAV } from "./plugins/docs-nav.mjs";

// The docs are for local use and for browsing docs/ on GitHub; nothing here publishes them.
//   DOCS_BASE  path prefix the site is served under (default "/"; e.g. "/zinc/" behind a path)
//   DOCS_SITE  absolute origin, only needed for a sitemap/canonical URLs (default: none)
const base = normalizeBase(process.env.DOCS_BASE);
const site = process.env.DOCS_SITE || undefined;

const guide = (names) => names.map((n) => ({ slug: n }));

export default defineConfig({
	site,
	base,
	trailingSlash: "always",
	markdown: { processor: unified({ remarkPlugins: [[remarkDocs, { base }]] }) },
	integrations: [
		mermaid({ theme: "default", autoTheme: true }),
		starlight({
			title: "Zinc",
			description: "A fast, native, Zotero-compatible reference manager for Windows, Linux and macOS.",
			logo: { src: "./public/icon.svg", alt: "Zinc" },
			favicon: "/icon.svg",
			customCss: ["@fontsource-variable/inter/opsz.css", "@fontsource-variable/manrope/wght.css", "./src/styles/custom.css"],
			// the docs use the product pages' top bar (with Starlight's search in it), so the menu stays the same everywhere
			components: { Header: "./src/components/DocsHeader.astro", PageTitle: "./src/components/DocsPageTitle.astro" },
			editLink: undefined,
			lastUpdated: false,
			// the same order as the Markdown index for language models (/llms.txt): plugins/docs-nav.mjs
			sidebar: DOCS_NAV.map((g) => (g.slugs.length === 1 && g.label === "Overview" ? { label: g.label, slug: g.slugs[0] } : { label: g.label, items: guide(g.slugs) })),
		}),
	],
});
