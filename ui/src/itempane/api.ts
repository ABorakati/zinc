// Item-pane specific API calls (Phase 3 routes). Kept out of ../api.ts, which another agent owns.
import type { ItemDetail, ZoteroItemData } from "../api";
import type { ZoteroSchema } from "../../../core/src/api-types";

export type { ZoteroSchema, ZoteroSchemaItemType, ZoteroSchemaField } from "../../../core/src/api-types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch("/api" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

let schemaP: Promise<ZoteroSchema> | null = null;

export const ipApi = {
	/** Cached for the lifetime of the page; retried if the first load failed. */
	schema: () => (schemaP ??= req<ZoteroSchema>("GET", "/schema").catch((e) => { schemaP = null; throw e; })),
	createChild: (data: Partial<ZoteroItemData>) => req<ItemDetail>("POST", "/items", { data }),
	addRelated: (key: string, keys: string[]) => req<ItemDetail>("POST", `/items/${key}/related`, { keys }),
	removeRelated: (key: string, keys: string[]) => req<ItemDetail>("DELETE", `/items/${key}/related`, { keys }),
	removeFromCollection: (coll: string, keys: string[]) =>
		req<{ ok: true }>("DELETE", `/collections/${coll}/items`, { keys }),
	reveal: (attachmentKey: string) => req<{ ok: true }>("POST", `/attachments/${attachmentKey}/reveal`),
	openExternal: (attachmentKey: string) => req<{ ok: true }>("POST", `/attachments/${attachmentKey}/open-external`),
	openUrl: (url: string) => req<{ ok: true }>("POST", "/open-url", { url }),
};
