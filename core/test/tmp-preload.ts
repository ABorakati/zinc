// Test preload (bunfig.toml): every temporary folder a test makes lands in ONE per-run folder, deleted when the run ends.
//
// The tests create their scratch libraries with mkdtempSync(join(tmpdir(), "zn-…")) in a dozen places and most never remove them
// (some hold a 380 MB library copy). Thousands piled up in %TEMP% and filled the disk. Rather than patch every call site, point
// os.tmpdir() (TEMP / TMP / TMPDIR) at %TEMP%\zn-test-run-<pid>-<time> for this process, and remove that folder when the run ends.
// On Windows that fails while the test databases are open, so a cleaner deletes it once the process has gone (removeRun below);
// and, should that fail too, each run removes every earlier run folder whose process has ended.
import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = tmpdir();
const PREFIX = "zn-test-run-";
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
for (const name of (() => {
	try {
		return readdirSync(base);
	} catch {
		return [];
	}
})()) {
	if (!name.startsWith(PREFIX)) continue;
	try {
		const p = join(base, name);
		const pid = Number(name.slice(PREFIX.length).split("-")[0]);
		// a finished run (its process is gone), or a very old one whose pid may have been reused
		if (!alive(pid) || Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true });
	} catch {
		/* still in use or already gone */
	}
}

// Older test scratch made outside a run folder (zn-core-*, zn-ft-*, zn-login-*… from runs that skipped this preload, e.g. started from
// another directory): remove the ones untouched for 6 hours. Thousands of them (7+ GB) once filled the disk.
for (const name of (() => {
	try {
		return readdirSync(base);
	} catch {
		return [];
	}
})()) {
	if (!/^zn[a-z]*-/.test(name) || name.startsWith(PREFIX)) continue;
	try {
		const p = join(base, name);
		if (Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true });
	} catch {
		/* in use or already gone */
	}
}

const run = join(base, `${PREFIX}${process.pid}-${Date.now()}`);
mkdirSync(run, { recursive: true });
process.env.TEMP = run;
process.env.TMP = run;
process.env.TMPDIR = run;

// The cleaner: waits for the test process to exit (at most 2 min), then deletes the run folder.
const CLEANER = `import { rmSync } from "node:fs";
const pid = Number(process.argv[2]), dir = process.argv[3], until = Date.now() + 120000;
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
while (alive() && Date.now() < until) await Bun.sleep(200);
if (dir && dir.includes(${JSON.stringify(PREFIX)})) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {} }
`;

/**
 * Remove this run's folder once every test has run. `bun test` runs no process "exit" handler, so this is a global afterAll (a
 * preload's hooks run once, after the last file). On Linux and macOS open files can be deleted, so rmSync is enough. On Windows
 * the test databases stay open until the process is gone, so the folder (1-2 GB) is handed to a cleaner that waits for this
 * process to exit. Bun ends its own child processes when it exits, so the cleaner is started through WMI (Win32_Process.Create),
 * which makes it nobody's child; it runs from the plain temp folder, so it neither loads this preload nor holds the folder open.
 */
function removeRun(): void {
	try {
		rmSync(run, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	} catch {
		/* a file still open: see below */
	}
	if (!existsSync(run) || process.platform !== "win32") return;
	try {
		const file = join(base, "zn-test-cleaner.mjs");
		writeFileSync(file, CLEANER);
		const cmd = `"${process.execPath}" "${file}" ${process.pid} "${run}"`;
		const q = (s: string) => s.replace(/'/g, "''");
		spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(cmd)}'; CurrentDirectory = '${q(base)}' } | Out-Null`,
			],
			{ windowsHide: true, stdio: "ignore", timeout: 15_000 },
		);
	} catch {
		/* no cleaner: the next run's sweep removes it */
	}
}
afterAll(removeRun);

// Tests log through core/src/log.ts; keep that out of the user's real %APPDATA%\zotero-next-gpui\logs (1,700+ test lines once landed there).
if (!process.env.ZN_LOG_DIR) process.env.ZN_LOG_DIR = join(run, "logs");
