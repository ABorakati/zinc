// Test preload (bunfig.toml): every temporary folder a test makes lands in ONE per-run folder, deleted when the run ends.
//
// The tests create their scratch libraries with mkdtempSync(join(tmpdir(), "zn-…")) in a dozen places and most never remove them
// (some hold a 380 MB library copy). Thousands piled up in %TEMP% and filled the disk. Rather than patch every call site, point
// os.tmpdir() (TEMP / TMP / TMPDIR) at %TEMP%\zn-test-run-<pid>-<time> for this process, and try to remove that folder on exit.
// On Windows that usually fails (the test databases are still open while the process exits), so each run also removes every
// earlier run folder whose process has ended: at most one run's worth (~1 GB) is ever left behind.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = tmpdir();
const PREFIX = "zn-test-run-";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const name of (() => { try { return readdirSync(base); } catch { return []; } })()) {
	if (!name.startsWith(PREFIX)) continue;
	try {
		const p = join(base, name);
		const pid = Number(name.slice(PREFIX.length).split("-")[0]);
		// a finished run (its process is gone), or a very old one whose pid may have been reused
		if (!alive(pid) || Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true });
	} catch { /* still in use or already gone */ }
}

// Older test scratch made outside a run folder (zn-core-*, zn-ft-*, zn-login-*… from runs that skipped this preload, e.g. started from
// another directory): remove the ones untouched for 6 hours. Thousands of them (7+ GB) once filled the disk.
for (const name of (() => { try { return readdirSync(base); } catch { return []; } })()) {
	if (!/^zn[a-z]*-/.test(name) || name.startsWith(PREFIX)) continue;
	try {
		const p = join(base, name);
		if (Date.now() - statSync(p).mtimeMs > 6 * 3600_000) rmSync(p, { recursive: true, force: true });
	} catch { /* in use or already gone */ }
}

const run = join(base, `${PREFIX}${process.pid}-${Date.now()}`);
mkdirSync(run, { recursive: true });
process.env.TEMP = run;
process.env.TMP = run;
process.env.TMPDIR = run;

process.on("exit", () => {
	try { rmSync(run, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* a file still open: next run's sweep removes it */ }
});

// Tests log through core/src/log.ts; keep that out of the user's real %APPDATA%\zotero-next-gpui\logs (1,700+ test lines once landed there).
if (!process.env.ZN_LOG_DIR) process.env.ZN_LOG_DIR = join(run, "logs");
