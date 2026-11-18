// One Worker per plugin, inside the plugin host process. Loads a jco-transpiled component (JSPI) and runs its exports; the logic is
// in plugin-runtime.ts. Two ways to run a plugin from here:
//   default                       import the transpiled glue from disk and instantiate it in this Worker
//   ZN_PLUGIN_RUNNER=aot-process  the plugin has an AOT executable (aot/plugin.exe, built at install time by package/aot.ts): start it as a
//                                 child process and relay the host's messages to it over Bun IPC. This Worker then only forwards.
//                                 A plugin without the executable runs in the Worker as usual.
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { TRANSPILED_ENTRY } from "./manifest";
import { AOT_EXE } from "./package/aot-layout";
import type { FromWorker, ToWorker } from "./protocol";
import { startRuntime } from "./plugin-runtime";

declare const self: Worker;
const post = (m: FromWorker) => self.postMessage(m);

const handle = startRuntime(post, async (spec, imports) => {
	const entry = join(spec.dir, TRANSPILED_ENTRY);
	const mod = await import(pathToFileURL(entry).href);
	const coreDir = dirname(entry);
	return mod.instantiate(async (p: string) => WebAssembly.compile(await Bun.file(join(coreDir, p)).arrayBuffer()), imports);
});

let relay: ((m: ToWorker) => void) | undefined;

/** Start the plugin's executable and relay to it. Resolves false when it cannot start or dies before it answered `init`. */
function startChild(exe: string, init: ToWorker): void {
	let answered = false;
	const child = Bun.spawn([exe], {
		stdin: "pipe", // the child exits when this pipe closes (aot-entry.template.ts)
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		env: { ...process.env, BUN_BE_BUN: "", ZN_PARENT_PID: String(process.pid) }, // BUN_BE_BUN would make the exe act as the bun CLI
		ipc: (msg: FromWorker) => {
			if (msg.t === "reply" && msg.id === 0) answered = true;
			post(msg);
		},
		onExit: (_p, code, signal) => {
			if (!answered) {
				// Stale, corrupt or unrunnable executable: say so and run the plugin in this Worker instead.
				post({ t: "log", level: "warn", message: `runner aot-process: ${exe} exited before it was ready (code ${code}, signal ${signal}); running in a Worker` });
				relay = undefined;
				handle(init);
				return;
			}
			// Surfaces as the Worker's `error` event, which host-main turns into plugin-exit
			setTimeout(() => {
				throw new Error(`plugin process exited (code ${code}, signal ${signal})`);
			});
		},
	});
	relay = (m) => child.send(m);
	child.send(init);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
	const m = ev.data;
	if (m.t === "init" && process.env.ZN_PLUGIN_RUNNER === "aot-process") {
		const exe = join(m.spec.dir, AOT_EXE);
		if (Bun.file(exe).size > 0) {
			try {
				return startChild(exe, m);
			} catch (e) {
				post({ t: "log", level: "warn", message: `runner aot-process: ${exe} cannot be started (${(e as Error).message}); running in a Worker` });
			}
		} else post({ t: "log", level: "warn", message: `runner aot-process: ${exe} is missing; running in a Worker` });
	}
	if (relay) relay(m);
	else handle(m);
};