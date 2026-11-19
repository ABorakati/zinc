// /skills/<name>.zip: an agent skill for plugin authors, zipped from .claude/skills/<name> at build time (lib/skills.ts).
import type { APIRoute, GetStaticPaths } from "astro";
import { skillNames, skillZip } from "../../lib/skills";

export const getStaticPaths: GetStaticPaths = () => skillNames().map((name) => ({ params: { name } }));

export const GET: APIRoute = ({ params }) =>
	new Response(skillZip(String(params.name)), {
		headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${params.name}.zip"` },
	});
