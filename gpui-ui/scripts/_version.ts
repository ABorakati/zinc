// The build's version stamp, shared by build.ts (stamped into the exe), package.ts (version.txt in the folder) and installer.ts.
//
//   BUILD_VERSION  "0.1.0+<commit>-<yyyymmdd>": the release number (ZN_RELEASE, default 0.1.0), the repo commit and the build date.
//   numericVersion "0.1.<days since 2026-01-01>.0": the four-number form that installers and Windows version resources need. It is a pure
//                  function of the stamp (so the exe, the folder and the installer always agree) and rises with the build date.
//
// ZN_BUILD_VERSION overrides the stamp. The first import sets it, so child processes (the AOT build under the canary Bun, the installer
// compiler's sign hook) see the same stamp even if a build crosses midnight.
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");

function compute(): string {
	const base = process.env.ZN_RELEASE ?? "0.1.0";
	const run = (cmd: string[]) => {
		try {
			const r = Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "ignore" });
			return r.exitCode === 0 ? r.stdout.toString().trim() : "";
		} catch {
			return "";
		}
	};
	const commit =
		run(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id.short(8)"]) ||
		run(["git", "rev-parse", "--short=8", "HEAD"]) ||
		"unknown";
	return `${base}+${commit}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
}

/** "0.1.0+<commit>-<yyyymmdd>" */
export const BUILD_VERSION: string = process.env.ZN_BUILD_VERSION || (process.env.ZN_BUILD_VERSION = compute());

/**
 * "major.minor.<days since 2026-01-01>.<fourth>" for a stamp (each part fits the 16 bits of a Windows version resource). A release
 * with a fourth part (0.2.7.1, a fix of 0.2.7) puts it last, so it sorts after the release it fixes; others end in 0.
 */
export function numericVersion(stamp: string = BUILD_VERSION): string {
	const m = /^(\d+)\.(\d+)\.\d+(?:\.(\d+))?\+[^-]+-(\d{4})(\d{2})(\d{2})$/.exec(stamp);
	if (!m) throw new Error(`not a build stamp: ${stamp}`);
	const days = Math.floor((Date.UTC(+m[4]!, +m[5]! - 1, +m[6]!) - Date.UTC(2026, 0, 1)) / 86400000);
	if (days < 0 || days > 65535) throw new Error(`build date out of range in ${stamp}`);
	return `${m[1]}.${m[2]}.${days}.${Number(m[3] ?? 0)}`;
}

if (import.meta.main) console.log(process.argv.includes("--numeric") ? numericVersion() : BUILD_VERSION);
