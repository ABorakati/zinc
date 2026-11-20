// Zinc desktop app bridge over HTTP, matching word/addin/ZnClient.cs:
//   - zn.status -> GET  /api/ui/selection (800 ms probe)
//   - zn.lookup -> GET  /api/references/lookup?doi=...
//   - zn.reveal -> POST /api/ui/reveal {key, open: true}
// A browser task pane cannot inspect the filesystem/registry or spawn local executables, so `launcher` is "" and
// `launcherExists` / `started` are false; when Zinc is not running, zn.reveal returns {ok: false, started: false, error}.

import { type HttpClient, ZincUnavailableError, readErrorMessage } from "./http";

const PROBE_TIMEOUT_MS = 800;
const ZN_TIMEOUT_MS = 6_000;

export interface ZnStatusOut {
	up: boolean;
	api: string;
	launcher: string;
	launcherExists: boolean;
}

export interface ZnRevealOut {
	ok: boolean;
	started: boolean;
	error?: string;
}

export function znLightStatus(apiBase: string): ZnStatusOut {
	return { up: false, api: apiBase, launcher: "", launcherExists: false };
}

export async function isZnUp(http: HttpClient, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	try {
		await http.request("/api/ui/selection", { timeoutMs });
		return true;
	} catch {
		return false;
	}
}

export async function znStatus(http: HttpClient): Promise<ZnStatusOut> {
	const up = await isZnUp(http);
	return { up, api: http.apiBase(), launcher: "", launcherExists: false };
}

export async function znLookup(http: HttpClient, p: Record<string, unknown>): Promise<unknown> {
	const doi = p.doi === null || p.doi === undefined ? "" : String(p.doi);
	if (!doi) return null;
	try {
		return await http.getJson<unknown>(`/api/references/lookup?doi=${encodeURIComponent(doi)}`, ZN_TIMEOUT_MS);
	} catch {
		return null;
	}
}

export async function znReveal(http: HttpClient, p: Record<string, unknown>): Promise<ZnRevealOut> {
	const key = p.key === null || p.key === undefined ? "" : String(p.key);
	try {
		const res = await http.request("/api/ui/reveal", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, open: true }),
			timeoutMs: ZN_TIMEOUT_MS,
		});
		if (!res.ok) {
			let err = await readErrorMessage(res);
			if (err === "not found") err = "the running Zinc is too old to reveal items (update/restart it)";
			return { ok: false, started: false, error: err };
		}
		return { ok: true, started: false };
	} catch (e) {
		if (e instanceof ZincUnavailableError) {
			return { ok: false, started: false, error: "Zinc is not running. Start Zinc to open items in it." };
		}
		return { ok: false, started: false, error: e instanceof Error ? e.message : String(e) };
	}
}
