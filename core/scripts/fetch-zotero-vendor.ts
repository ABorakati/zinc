// Fetch the vendored Zotero translation code into core/vendor/zotero/ (vendor/ is git-ignored, so a fresh checkout needs this).
//   bun core/scripts/fetch-zotero-vendor.ts [--out <dir>] [--force]
// Downloads each upstream repo at the commit pinned below (GitHub tarballs), keeps only the files core/src/translate/** reads
// (the same selection as core/vendor/zotero/README.md documents) and writes README.md with the NOTICE. Everything fetched is
// AGPL-3.0 (see the NOTICE). Translators change often: `bun core/scripts/update-translators.ts` refreshes the data-dir copy the
// app prefers; bump PINS here to move the vendored baseline.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PINS = {
	translate: "bea5b9afc1cc424f066c38e77a42ddbef152070f",
	utilities: "4051881d59c6c12d34417d4c226f37218051be90",
	translators: "9d04f4b8b4e44b46782c8572fdb834147df18979",
	"zotero-schema": "b86c79b56479cadac3288e1f122cf34ef04e8809",
	"translation-server": "672d4f3b6254c3afd4d62cdeef5aed7602d84078",
} as const;
type Repo = keyof typeof PINS;

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const out = resolve(outArg >= 0 ? args[outArg + 1]! : join(import.meta.dir, "..", "vendor", "zotero"));
const force = args.includes("--force");
if (existsSync(join(out, "translators")) && !force) {
	console.log(`${out} already has the vendored code (pass --force to fetch it again)`);
	process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "zn-zotero-vendor-"));
async function fetchRepo(repo: Repo): Promise<string> {
	const url = `https://codeload.github.com/zotero/${repo}/tar.gz/${PINS[repo]}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const tgz = join(work, `${repo}.tar.gz`);
	await Bun.write(tgz, res);
	const dir = join(work, repo);
	mkdirSync(dir);
	// relative paths: GNU tar (Git Bash) reads "C:\…" as a remote host:path
	// The agent-config folders/symlinks in some upstream repos (.agents/skills, .claude/skills) cannot be created by Windows' bsdtar
	// without symlink rights and are not used here, so they are skipped.
	const skip = [".agents", ".claude", "CLAUDE.md", "AGENTS.md"].map((n) => `--exclude=*/${n}`);
	const tar = Bun.spawnSync(["tar", "-xzf", `${repo}.tar.gz`, "-C", repo, "--strip-components=1", ...skip], { cwd: work, stderr: "pipe" });
	if (tar.exitCode !== 0) throw new Error(`tar ${repo}: ${tar.stderr.toString()}`);
	return dir;
}
const copyMatching = (from: string, to: string, keep: (name: string) => boolean) => {
	mkdirSync(to, { recursive: true });
	for (const e of readdirSync(from, { withFileTypes: true })) if (e.isFile() && keep(e.name)) cpSync(join(from, e.name), join(to, e.name));
};

try {
	const src = Object.fromEntries(await Promise.all((Object.keys(PINS) as Repo[]).map(async (r) => [r, await fetchRepo(r)] as const))) as Record<Repo, string>;
	const stage = join(work, "out");
	cpSync(join(src.translate, "src"), join(stage, "translate", "src"), { recursive: true });
	cpSync(join(src.translate, "COPYING"), join(stage, "translate", "COPYING"));
	copyMatching(src.utilities, join(stage, "utilities"), (n) => n.endsWith(".js") || n === "COPYING");
	if (existsSync(join(src.utilities, "resource"))) cpSync(join(src.utilities, "resource"), join(stage, "utilities", "resource"), { recursive: true });
	copyMatching(src.translators, join(stage, "translators"), (n) => n.endsWith(".js") || n === "deleted.txt");
	cpSync(join(src.translate, "COPYING"), join(stage, "translators", "COPYING")); // the translators repo has no licence file of its own
	mkdirSync(join(stage, "zotero-schema"), { recursive: true });
	cpSync(join(src["zotero-schema"], "schema.json"), join(stage, "zotero-schema", "schema.json"));
	mkdirSync(join(stage, "translation-server"), { recursive: true });
	cpSync(join(src["translation-server"], "COPYING"), join(stage, "translation-server", "COPYING"));
	writeFileSync(join(stage, "README.md"), [
		"# Vendored Zotero translation code",
		"",
		"Fetched by `bun core/scripts/fetch-zotero-vendor.ts` (pinned commits are in that script). Used by `core/src/translate/**`.",
		"",
		"NOTICE: everything in this folder is part of Zotero and is licensed under the GNU Affero General Public License, version 3",
		"(see `COPYING` in each subfolder). Zotero is Copyright (c) Corporation for Digital Scholarship, Vienna, Virginia, USA, and the",
		"Center for History and New Media, George Mason University. Individual translators carry their own authors and the AGPL header.",
		"",
		...(Object.entries(PINS).map(([r, c]) => `- ${r}: https://github.com/zotero/${r} @ ${c}`)),
		"",
	].join("\n"));
	rmSync(out, { recursive: true, force: true });
	mkdirSync(resolve(out, ".."), { recursive: true });
	cpSync(stage, out, { recursive: true });
	const n = readdirSync(join(out, "translators")).filter((f) => f.endsWith(".js")).length;
	console.log(`vendored Zotero translation code -> ${out} (${n} translators)`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
