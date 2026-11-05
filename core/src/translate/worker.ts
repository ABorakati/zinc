// Translation worker: runs the Zotero translate framework (see runtime/) off the main thread.
// Messages: {id, op: "web" | "import" | "export", params} -> {id, ok, result} | {id, ok: false, error}.
import { exportJob, importJob, webJob } from "./runtime/jobs";

const jobs: Record<string, (p: any) => Promise<unknown>> = { web: webJob, import: importJob, export: exportJob };

declare const self: Worker;

// a translator that left callbacks behind can fail after its job ended; that must not take down the next job
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});
self.addEventListener("error", (e) => e.preventDefault());
self.addEventListener("unhandledrejection", (e) => (e as PromiseRejectionEvent).preventDefault());

self.onmessage = async (e: MessageEvent) => {
	const { id, op, params } = e.data as { id: number; op: string; params: unknown };
	try {
		const run = jobs[op];
		if (!run) throw new Error(`unknown job: ${op}`);
		const result = await run(params);
		self.postMessage({ id, ok: true, result });
	} catch (err) {
		self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
};
self.postMessage({ ready: true });
