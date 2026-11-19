// The agent skills for plugin authors (.claude/skills/zinc-plugin-*), zipped at build time for download from the site:
//   /skills/<name>.zip   one skill folder, as <name>/SKILL.md, <name>/references/..., <name>/scripts/...
// Unzip it into ~/.claude/skills/ (or a project's .claude/skills/) and Claude Code finds the skill. The page that explains them is
// docs/developer-guide/wasm-plugins/agent-skills.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeZip, type ZipWriteEntry } from "../../../plugin-host/src/package/zip";

// from the working folder (website/), as lib/llms.ts does: in the build bundle a module's own URL points into dist
const SKILLS_ROOT = path.resolve(process.cwd(), "..", ".claude", "skills");

/** The skills offered for download: every skill folder whose name starts with "zinc-plugin-" and that has a SKILL.md. */
export function skillNames(): string[] {
	if (!existsSync(SKILLS_ROOT)) return [];
	return readdirSync(SKILLS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith("zinc-plugin-") && existsSync(path.join(SKILLS_ROOT, d.name, "SKILL.md")))
		.map((d) => d.name)
		.sort();
}

/** Every file under `dir`, as paths relative to it with forward slashes, sorted so the zip is the same on every build. */
function filesUnder(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const d of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${d.name}` : d.name;
		if (d.isDirectory()) out.push(...filesUnder(dir, r));
		else if (d.isFile()) out.push(r);
	}
	return out.sort();
}

/** One skill folder as a zip, with the folder itself as the top entry. Line endings are made LF so the zip does not depend on the checkout. */
export function skillZip(name: string): Uint8Array<ArrayBuffer> {
	const dir = path.join(SKILLS_ROOT, name);
	const entries: ZipWriteEntry[] = filesUnder(dir).map((rel) => {
		const bytes = readFileSync(path.join(dir, rel));
		const text = /\.(md|ts|js|json|txt)$/i.test(rel);
		return { name: `${name}/${rel}`, data: text ? new TextEncoder().encode(bytes.toString("utf8").replace(/\r\n/g, "\n")) : new Uint8Array(bytes) };
	});
	return new Uint8Array(writeZip(entries)); // a copy on a plain ArrayBuffer: what a Response body accepts
}
