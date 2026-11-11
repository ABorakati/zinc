// Early data for the first screen. GpuixRenderer.init() blocks the JS thread for 300-500 ms (window + GPU set-up), and after it the
// core (~100 ms to load) and the store's first requests run one after the other on the same thread. A worker thread started BEFORE
// render() answers those first GET requests meanwhile, from its own read-only connection to the library, using the core's own handler;
// api.ts serves the store's matching requests from those answers (once each) instead of going through the core.
//
// Which requests? The ones the previous run made before its first page of items (collections, the items query with the stored sort,
// groups, schema, ...), remembered in %APPDATA%\zotero-next-gpui\prefetch-hint.json. No hint (first run, other library) = no prefetch.
// Only used with the in-process core (ZN_DB). ZN_PREFETCH=0 turns it off. A request that does not match, fails, or comes late falls
// back to the normal path, so this can only make the first screen faster, never different.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "../../core/src/platform-dirs";
import { expectEarly, takeRecordedPaths } from "./api";
import { logError } from "./shell/errorlog";
import { mark } from "./trace";

const compiled = !/^bun(.exe)?$/i.test(basename(process.execPath));

interface Hint { paths: string[] }

const hintFile = (): string => join(configDir(), "zotero-next-gpui", "prefetch-hint.json");

/** The paths the last run asked for. They do not depend on the library (the worker answers them from whichever one is open now). */
function readHint(): string[] {
	try {
		const h = JSON.parse(readFileSync(hintFile(), "utf8")) as Hint;
		if (Array.isArray(h.paths)) return h.paths.filter((p) => typeof p === "string").slice(0, 8);
	} catch { /* none yet */ }
	return [];
}

/** Start the worker (call before render()). Needs ZN_DB, i.e. the in-process core. True when it is answering requests. */
export function startPrefetch(): boolean {
	const db = process.env.ZN_DB;
	if (!db || process.env.ZN_PREFETCH === "0") return false;
	const paths = readHint().sort((a, b) => Number(b.startsWith("/items?")) - Number(a.startsWith("/items?"))); // the item list first
	if (!paths.length) return false;
	mark("prefetch-hint");
	const waiting = new Map<string, (text: string | null) => void>();
	for (const p of paths) expectEarly(p, new Promise<string | null>((resolve) => waiting.set(p, resolve)));
	const finish = () => { for (const r of waiting.values()) r(null); waiting.clear(); };
	let worker: Worker;
	try {
		// compiled exe: build.ts embeds the worker as /root/prefetch-worker.js; from sources it is this directory's .ts
		worker = new Worker(compiled ? "B:/~BUN/root/prefetch-worker.js" : new URL("./prefetch-worker.ts", import.meta.url).href);
	} catch (e) {
		console.warn("[prefetch] no worker:", e instanceof Error ? e.message : e);
		finish();
		return false;
	}
	worker.onmessage = (e: MessageEvent<{ path?: string; text?: string | null; ms?: number; done?: boolean }>) => {
		const m = e.data;
		if (m.done) { finish(); void worker.terminate(); return; }
		if (m.path === undefined) return;
		mark(`prefetch-${m.text == null ? "miss" : "hit"}-${m.path.split("?")[0]!.replace(/\W+/g, "-")}-w${m.ms}`);
		waiting.get(m.path)?.(m.text ?? null);
		waiting.delete(m.path);
	};
	worker.onerror = (ev) => {
		logError("worker", (ev as ErrorEvent).error ?? (ev as ErrorEvent).message, "prefetch worker");
		if (process.env.ZN_TRACE) console.warn("[prefetch] worker error:", (ev as ErrorEvent).message); finish(); void worker.terminate(); };
	worker.postMessage({ db, paths });
	mark("prefetch-started");
	setTimeout(finish, 8000).unref?.(); // never hold a request for long
	return true;
}

/** After the first page of items: remember which GET requests the first screen made, for the next start. */
export function saveHint(): void {
	const db = process.env.ZN_DB;
	if (!db || process.env.ZN_PREFETCH === "0") return;
	const paths = takeRecordedPaths();
	if (!paths.length) return;
	try {
		const cur = readHint();
		if (cur.length === paths.length && cur.every((p, i) => p === paths[i])) return;
		const f = hintFile();
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f + ".tmp", JSON.stringify({ paths } satisfies Hint));
		renameSync(f + ".tmp", f);
	} catch { /* best effort */ }
}
