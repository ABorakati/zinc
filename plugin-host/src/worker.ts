// One Worker per plugin, inside the plugin host process (`runner: "worker"`). Loads a jco-transpiled component (JSPI) from disk
// and runs its exports; the logic is in plugin-runtime.ts.
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { TRANSPILED_ENTRY } from "./manifest";
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

self.onmessage = (ev: MessageEvent<ToWorker>) => handle(ev.data);
