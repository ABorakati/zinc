import type { Subprocess } from "bun";
import type { Engine, Job, Result } from "../types";

const STDERR_TAIL_CHARS = 2000;

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * An engine that is an external command speaking JSONL: one Job per line on stdin, one Result per line on stdout
 * (any order, matched by id). A batch that exceeds ZN_PARITY_TIMEOUT_MS (default 10 minutes) is killed; results
 * already printed are kept and the rest are marked ok:false. Stderr is attached to the errors of failed jobs.
 */
export function externalEngine(name: string, cmd: string[]): Engine {
	return {
		name,
		async run(jobs: Job[]): Promise<Result[]> {
			if (jobs.length === 0) return [];
			const timeoutMs = Number(process.env.ZN_PARITY_TIMEOUT_MS) || 600_000;
			const input = jobs.map((job) => JSON.stringify(job)).join("\n") + "\n";

			let proc: Subprocess<"pipe", "pipe", "pipe">;
			try {
				proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			} catch (e) {
				return jobs.map((job) => ({
					id: job.id,
					ok: false,
					error: `could not start ${name} (${cmd.join(" ")}): ${errorMessage(e)}`,
				}));
			}

			// Read stdout and stderr while writing stdin, so a chatty engine cannot deadlock the pipe.
			const stdoutP = new Response(proc.stdout).text();
			const stderrP = new Response(proc.stderr).text();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, timeoutMs);

			try {
				proc.stdin.write(input);
				await proc.stdin.end();
			} catch {
				// the engine exited before reading all of stdin; its missing results are reported below
			}

			const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
			const exitCode = await proc.exited;
			clearTimeout(timer);

			const byId = new Map<string, Result>();
			for (const line of stdout.split("\n")) {
				const t = line.trim();
				if (!t.startsWith("{")) continue;
				try {
					const r = JSON.parse(t) as Result;
					if (r && typeof r.id === "string") byId.set(r.id, r);
				} catch {
					// not a Result line; ignore
				}
			}

			const stderrTail = stderr.trim().slice(-STDERR_TAIL_CHARS);
			return jobs.map((job): Result => {
				const r = byId.get(job.id);
				if (r) {
					const ok = r.ok === true;
					const error = !ok && stderrTail ? `${r.error ?? "engine reported failure"}\nstderr: ${stderrTail}` : r.error;
					return { id: job.id, ok, output: r.output, error, ms: r.ms };
				}
				const reason = timedOut ? `timeout after ${timeoutMs} ms` : `no result for this job (engine exit ${exitCode})`;
				return { id: job.id, ok: false, error: stderrTail ? `${reason}\nstderr: ${stderrTail}` : reason };
			});
		},
	};
}
