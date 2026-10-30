// Core API access for academic/ (plain fetch; types from core/src/api-types.ts).
import type { ChildSummary, ItemDetail, Reference, ReferenceDetail, ReferenceList } from "../../../core/src/api-types";

export type { Reference, ReferenceDetail };

export class ApiError extends Error {
	constructor(message: string, readonly status: number, readonly body: Record<string, any> = {}) {
		super(message);
	}
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch("/api" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let data: Record<string, any> = {};
		try { data = await res.json(); } catch { /* not json */ }
		throw new ApiError(String(data.error ?? res.statusText), res.status, data);
	}
	return res.json() as Promise<T>;
}

export interface AcademicApi {
	/** The paper's resolved bibliography (cached; failures are retried after 30 s). */
	refs(): Promise<Reference[]>;
	refList(refresh?: boolean): Promise<ReferenceList>;
	lookup(r: Pick<Reference, "doi" | "title">): Promise<ReferenceDetail>;
	add(body: { doi?: string; reference?: Reference }): Promise<string>; // -> item key (also when it was already there)
	openUrl(url: string): Promise<void>;
	openExternal(attachmentKey: string): Promise<void>;
	item(key: string): Promise<ItemDetail>;
	children(): Promise<ChildSummary[]>;
	parent: ItemDetail | null;
	post(msg: Record<string, unknown>): void;
}

export function createApi(attachmentKey: string, itemKey: string | null): AcademicApi {
	let refsP: Promise<Reference[]> | null = null;
	let failedAt = 0;
	const detail = new Map<string, Promise<ReferenceDetail>>();
	let itemP: Promise<ItemDetail> | null = null;

	const api: AcademicApi = {
		parent: null,
		refs() {
			if (refsP && (!failedAt || Date.now() - failedAt < 30000)) return refsP;
			failedAt = 0;
			refsP = req<ReferenceList>("GET", `/references/${encodeURIComponent(itemKey ?? attachmentKey)}`)
				.then((l) => l.references)
				.catch((e) => { failedAt = Date.now(); console.warn("[academic] references unavailable:", e); return [] as Reference[]; });
			return refsP;
		},
		refList(refresh = false) {
			return req<ReferenceList>("GET", `/references/${encodeURIComponent(itemKey ?? attachmentKey)}${refresh ? "?refresh=1" : ""}`);
		},
		lookup(r) {
			const k = (r.doi ?? r.title ?? "").toLowerCase();
			let p = detail.get(k);
			if (!p) {
				const q = new URLSearchParams();
				if (r.doi) q.set("doi", r.doi);
				else if (r.title) q.set("title", r.title);
				p = req<ReferenceDetail>("GET", "/references/lookup?" + q);
				p.catch(() => detail.delete(k));
				detail.set(k, p);
			}
			return p;
		},
		async add(body) {
			try {
				const item = await req<ItemDetail>("POST", "/references/add", body);
				return item.data.key;
			}
			catch (e) {
				if (e instanceof ApiError && e.status === 409 && typeof e.body.key === "string") return e.body.key;
				throw e;
			}
		},
		async openUrl(url) { await req("POST", "/open-url", { url }); },
		async openExternal(key) { await req("POST", `/attachments/${encodeURIComponent(key)}/open-external`, {}); },
		item(key) { return req<ItemDetail>("GET", `/items/${encodeURIComponent(key)}`); },
		async children() {
			if (!itemKey) return [];
			itemP ??= api.item(itemKey).catch((e) => { itemP = null; throw e; });
			const it = await itemP;
			api.parent = it;
			return it.children;
		},
		post(msg) {
			try { window.parent?.postMessage(msg, "*"); } catch { /* standalone */ }
		},
	};
	return api;
}
