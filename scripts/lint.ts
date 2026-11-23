// `bun run lint [args]`: runs `bun lint` (rules in bunfig.toml [lint]). Stable Bun 1.4.5 has no lint command yet, so this uses
// the Bun that runs this script when it has one, else the canary named by ZN_BUN_CANARY (the same variable the AOT build reads,
// gpui-ui/scripts/build.ts), else the canary's usual place in the workspace. The global Bun is never changed.
//
// Careful: in a Bun without the command, `bun lint` runs the package.json script named "lint", which is this file. So the probe
// runs in a folder with no package.json, and ZN_LINT_RUNNING stops a nested run at once instead of starting another.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

if (process.env.ZN_LINT_RUNNING) {
	console.error("scripts/lint.ts started itself: this Bun has no `bun lint`.");
	process.exit(2);
}
const env = { ...process.env, ZN_LINT_RUNNING: "1" };
const hasLint = (bun: string) =>
	Bun.spawnSync([bun, "lint", "--help"], { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
const candidates = [
	process.execPath,
	process.env.ZN_BUN_CANARY,
	"C:/Users/abora/zn-ws/_tmp/bun-aot/canary-2026-11-16/bun-windows-x64/bun.exe",
];
const bun = candidates.find((b): b is string => !!b && existsSync(b) && hasLint(b));
if (!bun) {
	console.error("No Bun with `bun lint` found: install a canary (bun upgrade --canary) or set ZN_BUN_CANARY to one.");
	process.exit(2);
}
const args = process.argv.slice(2);
// --no-script: `bun lint` would otherwise run the package.json "lint" script (this file) instead of linting
const proc = Bun.spawn([bun, "lint", "--no-script", ...(args.length ? args : ["."])], {
	cwd: `${import.meta.dir}/..`,
	env,
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
