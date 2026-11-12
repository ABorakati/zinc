// Each docs page as plain Markdown at its address + ".md" (/user-guide/reader.md), for "Copy as Markdown" and for language models.
import type { APIRoute, GetStaticPaths } from "astro";
import { docPages, markdownOf, textResponse, type DocPage } from "../lib/llms";

export const getStaticPaths: GetStaticPaths = async () => (await docPages()).map((p) => ({ params: { slug: p.slug }, props: { page: p } }));

export const GET: APIRoute = ({ props }) => textResponse(markdownOf((props as { page: DocPage }).page), "text/markdown");
