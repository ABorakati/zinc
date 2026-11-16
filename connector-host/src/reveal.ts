// "Open in Zinc" for the browser extension: the extension calls the host method `revealInApp` with {key}, and the host asks the
// running app to show that item, the same way the Word add-in does (word/addin/ZnClient.cs Reveal): POST /api/ui/reveal on the
// app's loopback API (core/src/connector/ui.ts). The app polls for reveal requests (gpui-ui/src/shell/revealRequests.ts).
// When the app is not running, the host starts it and waits for its API first.
// Native messaging has no CORS and no Origin check to pass, so this works where a fetch from an extension page to the API would be
// refused (the API rejects cross-origin POSTs). See docs/design/web-connector-wasm.md.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RevealResult {
	status: number;
	body: { ok: boolean; started: boolean; error?: string; seq?: number; opened?: string | null };
}

export interface RevealOptions {
	/** Executables to try when the app is not running (first that exists wins). Default: launcherCandidates(process.env). */
	candidates?: string[];
	/** Start the app (default: a detached spawn). Tests replace it. */
	launch?: (exe: string) => void;
	/** How long to wait for a started app's API (default 40 s, like the Word add-in). */
	waitMs?: number;
	exists?: (path: string) => boolean;
	/** also open the item's PDF / EPUB / snapshot in the app's reader ({open: true} in /api/ui/reveal) */
	open?: boolean;
}

const KEY = /^[A-Za-z0-9]{1,32}$/;

/** Where the installer puts the app (word/addin/Settings.cs LauncherCandidates), ZN_LAUNCHER first. */
export function launcherCandidates(env: Record<string, string | undefined>): string[] {
	const out: string[] = [];
	if (env.ZN_LAUNCHER) out.push(env.ZN_LAUNCHER);
	if (env.LOCALAPPDATA)
		for (const dir of ["Zinc", "Zotero Next"]) out.push(join(env.LOCALAPPDATA, "Programs", dir, "zotero-next-gpui.exe"));
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiUp(base: string): Promise<boolean> {
	try {
		const r = await fetch(`${base}/api/ui/selection`, { signal: AbortSignal.timeout(800) });
		await r.body?.cancel();
		return true;
	} catch {
		return false;
	}
}

function defaultLaunch(exe: string): void {
	// Detached, so the app outlives the host (Chrome ends the host when the extension disconnects). Whether Chrome's job object
	// on Windows still takes the child down with it is an open point in the design note; the shell route (zinc:// handler) avoids it.
	const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: join(exe, "..") });
	child.unref();
}

export async function revealInApp(appPort: number, key: unknown, opts: RevealOptions = {}): Promise<RevealResult> {
	if (typeof key !== "string" || !KEY.test(key)) return { status: 400, body: { ok: false, started: false, error: "key required" } };
	if (!appPort) return { status: 503, body: { ok: false, started: false, error: "the app lookup is turned off (ZNH_APP_PORT=0)" } };
	const base = `http://127.0.0.1:${appPort}`;
	let started = false;
	if (!(await apiUp(base))) {
		const exists = opts.exists ?? existsSync;
		const exe = (opts.candidates ?? launcherCandidates(process.env)).find((c) => exists(c));
		if (!exe)
			return {
				status: 503,
				body: { ok: false, started, error: "Zinc is not running and its executable was not found (set ZN_LAUNCHER)" },
			};
		try {
			(opts.launch ?? defaultLaunch)(exe);
			started = true;
		} catch (e) {
			return {
				status: 500,
				body: { ok: false, started, error: `could not start Zinc: ${e instanceof Error ? e.message : String(e)}` },
			};
		}
		const until = Date.now() + (opts.waitMs ?? 40_000);
		while (Date.now() < until && !(await apiUp(base))) await sleep(250);
		if (!(await apiUp(base)))
			return { status: 504, body: { ok: false, started, error: "Zinc was started but its API did not answer in time" } };
	}
	try {
		const r = await fetch(`${base}/api/ui/reveal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts.open ? { key, open: true } : { key }),
			signal: AbortSignal.timeout(5000),
		});
		const j = (await r.json().catch(() => ({}))) as { error?: string; seq?: number; opened?: string | null };
		if (!r.ok) return { status: r.status, body: { ok: false, started, error: j.error ?? r.statusText } };
		return { status: 200, body: { ok: true, started, seq: j.seq, ...(opts.open ? { opened: j.opened ?? null } : {}) } };
	} catch (e) {
		return { status: 502, body: { ok: false, started, error: e instanceof Error ? e.message : String(e) } };
	}
}
