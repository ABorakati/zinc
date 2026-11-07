// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { unified } from "@astrojs/markdown-remark";
import { normalizeBase, remarkDocs } from "./plugins/docs-markdown.mjs";

// The docs are for local use and for browsing docs/ on GitHub; nothing here publishes them.
//   DOCS_BASE  path prefix the site is served under (default "/"; e.g. "/zotero-next/" behind a path)
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
			title: "Zotero Next",
			description: "A fast, native, Zotero-compatible reference manager for Windows.",
			logo: { src: "./public/icon.svg", alt: "Zotero Next" },
			favicon: "/icon.svg",
			customCss: ["@fontsource-variable/inter/opsz.css", "@fontsource-variable/manrope/wght.css", "./src/styles/custom.css"],
			editLink: undefined,
			lastUpdated: false,
			sidebar: [
				{ label: "Overview", slug: "overview" },
				{
					label: "User guide",
					items: guide([
						"user-guide",
						"user-guide/install",
						"user-guide/first-run",
						"user-guide/library",
						"user-guide/adding-items",
						"user-guide/reader",
						"user-guide/notes-and-web-tabs",
						"user-guide/find-full-text",
						"user-guide/locate-engines",
						"user-guide/citations",
						"user-guide/better-bibtex",
						"user-guide/zotmoov-storage",
						"user-guide/sync",
						"user-guide/import-export",
						"user-guide/word",
						"user-guide/mcp",
						"user-guide/settings",
						"user-guide/logs-and-reports",
						"user-guide/updates",
						"user-guide/troubleshooting",
						"user-guide/comparison",
					]),
				},
				{
					label: "Developer guide",
					items: guide([
						"developer-guide",
						"developer-guide/architecture",
						"developer-guide/building",
						"developer-guide/testing",
						"developer-guide/database",
						"developer-guide/http-api",
						"developer-guide/translators",
						"developer-guide/releasing",
						"developer-guide/contributing",
					]),
				},
			],
		}),
	],
});
