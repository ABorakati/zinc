// Checks commit messages against the rules in CONTRIBUTING.md ("Commit messages"). Bun only, no dependency.
//
//   bun scripts/commit-lint.ts --file <path>      one message from a file: the commit-msg hook (.githooks/commit-msg)
//   bun scripts/commit-lint.ts --message <text>   one message given as text: a pull request title in CI
//   bun scripts/commit-lint.ts <base>..<head>     every commit in that range, merges excepted: the pull request's commits in CI
//
// Exit code 1 when a message breaks a rule, with one line per problem.

export const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
export const FIRST_LINE_MAX = 80;
export const BODY_LINE_MAX = 100;

const HEADER = /^([a-z]+)(\([^()\s]+\))?(!)?: (.+)$/;
// Messages git writes itself (merge, revert, fixup! and squash! for `rebase --autosquash`) are not checked.
const EXEMPT = /^(Merge |Revert "|fixup! |squash! |amend! )/;
// `git commit --verbose` puts the diff below this line; git drops it and everything after.
const SCISSORS = /^# -+ >8 -+$/;

/** The message as git stores it: comment lines and everything from the scissors line on removed, trailing blank lines dropped. */
export function cleanMessage(raw: string): string {
	const out: string[] = [];
	for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
		if (SCISSORS.test(line)) break;
		if (line.startsWith("#")) continue;
		out.push(line.trimEnd());
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	while (out.length && out[0] === "") out.shift();
	return out.join("\n");
}

/** The rules a message breaks; empty when it follows them all, or is one git writes itself. */
export function lintMessage(message: string): string[] {
	const lines = cleanMessage(message).split("\n");
	const first = lines[0] ?? "";
	if (EXEMPT.test(first)) return [];
	const problems: string[] = [];
	const m = HEADER.exec(first);
	if (!m) {
		problems.push(`the first line must be "type: subject" or "type(scope): subject", e.g. "fix(word): …"`);
	} else {
		if (!TYPES.includes(m[1]!)) problems.push(`"${m[1]}" is not a type; use one of ${TYPES.join(", ")}`);
		if (m[4]!.endsWith(".")) problems.push("the subject must not end with a full stop");
	}
	if (first.length > FIRST_LINE_MAX) problems.push(`the first line has ${first.length} characters; at most ${FIRST_LINE_MAX}`);
	if (lines.length > 1 && lines[1] !== "") problems.push("a blank line must separate the first line from the body");
	lines.slice(1).forEach((line, i) => {
		// a URL cannot be wrapped
		if (line.length > BODY_LINE_MAX && !/\S+:\/\/\S+/.test(line))
			problems.push(`line ${i + 2} has ${line.length} characters; at most ${BODY_LINE_MAX}`);
	});
	return problems;
}

function git(args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
	return r.stdout.toString();
}

function report(label: string, problems: string[]): boolean {
	if (!problems.length) return true;
	console.error(`${label}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	return false;
}

if (import.meta.main) {
	const [mode, value] = process.argv.slice(2);
	let ok = true;
	if (mode === "--file" && value) {
		const text = await Bun.file(value).text();
		ok = report(`commit message: ${cleanMessage(text).split("\n")[0]}`, lintMessage(text));
		if (!ok) console.error('\nThe rules are in CONTRIBUTING.md, "Commit messages". The message is kept in .git/COMMIT_EDITMSG.');
	} else if (mode === "--message" && value !== undefined) {
		ok = report(`title: ${value}`, lintMessage(value));
	} else if (mode && mode.includes("..") && !value) {
		for (const sha of git(["rev-list", "--no-merges", "--reverse", mode]).split("\n").filter(Boolean)) {
			const text = git(["log", "-1", "--format=%B", sha]);
			ok = report(`${sha.slice(0, 8)} ${text.split("\n")[0]}`, lintMessage(text)) && ok;
		}
	} else {
		console.error("usage: bun scripts/commit-lint.ts --file <path> | --message <text> | <base>..<head>");
		process.exit(2);
	}
	process.exit(ok ? 0 : 1);
}
