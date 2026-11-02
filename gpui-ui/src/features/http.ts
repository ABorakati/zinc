// JSON client for the core API used by every feature (the web UI's per-feature post()/req() helpers, once).
// Mutating requests are JSON: the core's CSRF guard rejects other content types. `path` starts with "/api/...".
import { apiRequest, BASE_URL } from "../api";

const rel = (path: string) => path.replace(/^\/api/, "");

export async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	return apiRequest<T>(method, rel(path), body, signal);
}
export const get = <T,>(path: string, signal?: AbortSignal) => call<T>("GET", path, undefined, signal);
export const post = <T,>(path: string, body?: unknown) => call<T>("POST", path, body ?? {});

/** The raw Response, for the few endpoints that answer in headers too (X-Total). Needs the HTTP core (not ZN_CORE_DIRECT). */
export async function callRaw(method: string, path: string, signal?: AbortSignal): Promise<Response> {
	const res = await fetch(BASE_URL + path, { method, signal });
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res;
}
