// One scenario in one process (run.ts starts it): the app's store and registries are singletons, so nothing is shared between two.
//   bun test/ui/worker.ts <scenario file> list
//   bun test/ui/worker.ts <scenario file> run <index> <out dir>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { moveToBackgroundDesktop } from "./background";
import { scenarios } from "./define";
import { installFences, violations } from "./fences";

moveToBackgroundDesktop(); // first: before anything can open a window
const [file, command, indexArg, outDir] = process.argv.slice(2);
await import(pathToFileURL(resolve(file!)).href);

if (command === "list") {
	console.log(JSON.stringify(scenarios.map((s) => ({ name: s.name, knownBug: s.options.knownBug, inProcessOnly: s.options.inProcessOnly }))));
	process.exit(0);
}

const root = process.env.ZN_UI_TEST_ROOT;
if (!root || !process.env.APPDATA || !resolve(process.env.APPDATA).startsWith(resolve(root) + sep))
	throw new Error("worker.ts runs only under test/ui/run.ts, which gives it folders of its own");

const chosen = scenarios[Number(indexArg)];
if (!chosen || !outDir) throw new Error("no such scenario");
mkdirSync(outDir, { recursive: true });

// ZN_UI_APP (run.ts --app): the packaged app in a process of its own; else the app in this process
const realApp = process.env.ZN_UI_APP || undefined;
if (!realApp) installFences();
const errors: string[] = [];
const text = (v: unknown) => (v instanceof Error ? (v.stack ?? v.message) : typeof v === "string" ? v : JSON.stringify(v));
const consoleError = console.error;
// The PDF text worker is vendored (git-ignored, see CONTRIBUTING.md): a checkout without it logs that for the library's PDF, and
// only that is let through.
const noPdfWorker = !existsSync(join(import.meta.dir, "..", "..", "..", "vendor", "document-worker", "build", "worker.js"));
console.error = (...args: unknown[]) => {
	const line = args.map(text).join(" ");
	if (noPdfWorker && line.includes("full-text extraction failed") && line.includes("document-worker")) return;
	errors.push(line.slice(0, 1500));
};
process.on("uncaughtException", (e) => void errors.push(`uncaught: ${text(e)}`));
process.on("unhandledRejection", (e) => void errors.push(`unhandled rejection: ${text(e)}`));

const { makeLibrary } = await import("./library");
const db = makeLibrary(root, chosen.options.items ?? 130);
if (!realApp) process.env.ZN_DB = db; // (the packaged app gets it in its own environment, backend.ts)
const { bootApp, bootRemote } = await import("./app");

let failure: string | undefined;
let ui: Awaited<ReturnType<typeof bootApp>> | undefined;
try {
	const t0 = performance.now();
	ui = realApp ? await bootRemote(resolve(realApp), chosen.options, outDir, root, db) : await bootApp(chosen.options, outDir);
	ui.steps.push(`started in ${Math.round(performance.now() - t0)} ms`);
	await chosen.run(ui);
	await ui.settle(300);
	if (violations.length) failure = `reached outside the test: ${[...new Set(violations)].join("; ")}`;
	else if (errors.length) failure = `the app logged ${errors.length} error(s):\n${errors.slice(0, 4).join("\n")}`;
} catch (e) {
	failure = e instanceof Error ? e.message : String(e);
}

if (failure && ui) {
	try {
		await ui.screenshot("failure");
	} catch {
		/* no GPU to capture with: the text below still says what happened */
	}
	try {
		writeFileSync(join(outDir, "screen.txt"), (await ui.painted()).join("\n"));
	} catch {
		/* the window is gone */
	}
}
const report = { name: chosen.name, ok: !failure, failure, steps: ui?.steps ?? [], errors, violations };
writeFileSync(join(outDir, "result.json"), JSON.stringify(report, null, 2));
console.error = consoleError;
await ui?.backend.close().catch(() => {});
process.exit(failure ? 1 : 0);
