// JSON calls to the core API for the shell's own screens (Settings, sync). api.ts only has the list queries; this is the generic
// request. An /api path goes through api.ts's request(), like every other call of the UI: the external core, the in-process
// core's loopback server, the ZN_CORE_DIRECT shortcut, or the browser build's in-page core (setDirect). Before, it always
// fetched BASE_URL: with the shortcut Settings showed "Loading…", and the browser build polled http://127.0.0.1:23160 (whatever
// listened there) every few seconds.
import { apiRequest, BASE_URL } from "../api";

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return apiRequest<T>(method, path.slice(4), body);
	const res = await fetch(BASE_URL + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try {
			msg = ((await res.json()) as { error?: string }).error ?? msg;
		} catch {
			/* keep status text */
		}
		throw Object.assign(new Error(msg), { status: res.status }); // callers tell a refusal (e.g. 409) from a failure
	}
	return (await res.json()) as T;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "3 s ago", "12 min ago", a date for old ones, "never" for none. */
export function ago(iso?: string | null): string {
	if (!iso) return "never";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 10) return "just now";
	if (s < 90) return `${Math.round(s)} s ago`;
	if (s < 5400) return `${Math.round(s / 60)} min ago`;
	if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
	return new Date(iso).toLocaleDateString();
}

export const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export function bytes(n: number | null | undefined): string {
	if (n == null) return "";
	if (n < 1024) return `${n} B`;
	const u = ["KB", "MB", "GB", "TB"];
	let v = n / 1024,
		i = 0;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
