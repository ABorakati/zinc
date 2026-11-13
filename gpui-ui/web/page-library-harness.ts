// The module web/page-library-check.ts bundles into its harness page: startPageLibrary() and a few probes for the check, nothing of the
// app. (The real page is wired by platform.web.ts; this is only the data layer.)
import { startPageLibrary, type PageLibrary } from "./browser-db/page-library";
import { pageStorageArea } from "./browser-db/sync-storage";

let lib: PageLibrary | undefined;
let changes = 0;
const area = pageStorageArea();

(globalThis as Record<string, unknown>).znH = {
	/** the test-only API base (read by the worker when it opens); stored where the page's key area is */
	async setApiBase(url: string) { await area.set({ zincTestZoteroApiBase: url }); },
	async peekKey(): Promise<string | null> { return ((await area.get("zincZoteroApiKey")).zincZoteroApiKey as string | undefined) ?? null; },
	async start(): Promise<{ ok: boolean; name?: string; message?: string }> {
		try {
			lib = await startPageLibrary();
			lib.onChanged(() => { changes++; });
			return { ok: true };
		} catch (e) {
			return { ok: false, name: (e as Error).name, message: (e as Error).message };
		}
	},
	/** one /api call as the app makes it (src/api.ts apiFetch: http://127.0.0.1/api<path>) */
	async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
		const res = await lib!.transport(new Request("http://127.0.0.1/api" + path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
		const text = await res.text();
		let json: unknown = null;
		try { json = JSON.parse(text); } catch { /* not JSON */ }
		return { status: res.status, json, text };
	},
	get changes() { return changes; },
};
