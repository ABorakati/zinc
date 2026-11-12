// The repository README as plain Markdown (/readme.md): what Zinc is, its features, how to install it.
import type { APIRoute } from "astro";
import { readmeMarkdown, textResponse } from "../lib/llms";

export const GET: APIRoute = () => textResponse(readmeMarkdown(), "text/markdown");
