import { join } from "node:path";
import { buildPlugin } from "../scripts/build-plugin";
import { buildAot } from "../src/package/aot";
import { defineHandler, type ImportHandler } from "../src/imports/registry";
import { createPluginSupervisor, type PluginSupervisor, type SupervisorOptions } from "../src/supervisor";

const fixtures = join(import.meta.dir, "fixtures");
export const fixtureOut = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "zn-wasm-fixtures");

/** Build the three fixture plugins once per test run. Returns the loadable folders. */
let built: Promise<Record<"hello-rust" | "spin-rust" | "hello-js", string>> | undefined;
export function buildFixtures() {
	built ??= (async () => {
		const jobs = {
			"hello-rust": buildPlugin({ dir: join(fixtures, "hello-rust"), out: join(fixtureOut, "hello-rust") }),
			"spin-rust": buildPlugin({ dir: join(fixtures, "spin-rust"), out: join(fixtureOut, "spin-rust") }),
			"hello-js": buildPlugin({ dir: join(fixtures, "hello-js"), out: join(fixtureOut, "hello-js"), world: "hello" }),
		};
		const entries = await Promise.all(
			Object.entries(jobs).map(async ([k, v]) => {
				const out = (await v).out;
				// ZN_TEST_RUNNER=aot-process: the same tests against per-plugin AOT executables (needs the Bun canary; phase2-aot.md)
				if (AOT_RUNNER) await buildAot(out);
				return [k, out] as const;
			}),
		);
		return Object.fromEntries(entries) as Record<"hello-rust" | "spin-rust" | "hello-js", string>;
	})();
	return built;
}

/** `ZN_TEST_RUNNER=aot-process bun test` runs every supervisor test with the plugins as AOT child processes. */
export const AOT_RUNNER = process.env.ZN_TEST_RUNNER === "aot-process";

export const prefsHostModule = join(import.meta.dir, "handlers", "prefs.host.ts");

/** `where: "zinc"` handlers for the tests: `log.write` collects lines, `timers.set-timeout` schedules an `events.on-timer` callback. */
export function zincHandlers(lines: string[]): ImportHandler[] {
	return [
		defineHandler({
			interface: "zinc:plugin/log",
			where: "zinc",
			functions: {
				write: (ctx, _level: string, message: string) => void lines.push(`${ctx.pluginId}: ${message}`),
			},
		}),
		defineHandler({
			interface: "zinc:plugin/timers",
			where: "zinc",
			functions: {
				"set-timeout": (ctx, ms: number) => {
					const id = 7;
					setTimeout(() => void ctx.callExport("events", "on-timer", [id, "timeout"]).catch(() => {}), ms + 10);
					return id;
				},
			},
		}),
	];
}

export function newSupervisor(lines: string[], extra: SupervisorOptions = {}): PluginSupervisor {
	return createPluginSupervisor({
		importHandlers: zincHandlers(lines),
		hostHandlerModules: [prefsHostModule],
		// these tests bring their own stub handlers: the real src/imports/*.host.ts of the other areas must not shadow them
		discoverHostHandlers: false,
		...(AOT_RUNNER ? { runner: "aot-process" as const } : {}),
		...extra,
	});
}

export async function until(cond: () => boolean, ms = 3000, what = "condition") {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

export function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
