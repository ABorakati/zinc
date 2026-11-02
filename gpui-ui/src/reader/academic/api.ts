// Core API access for academic/ (the subset of reader-next/src/academic/api.ts the native reader uses). All requests go through
// src/api.ts (apiRequest), so they follow the core the app is connected to.
import { apiRequest } from "../../api";
import type { ChildSummary, ItemDetail, Reference, ReferenceDetail, ReferenceList } from "./types";

export interface AcademicApi {
	/** The paper's resolved bibliography (cached; failures are retried after 30 s). */
	refs(): Promise<Reference[]>;
	refList(refresh?: boolean): Promise<ReferenceList>;
	lookup(r: Pick<Reference, "doi" | "title">): Promise<ReferenceDetail>;
	/** Look up these references in the background (3 at a time). */
	prefetch(refs: Pick<Reference, "doi" | "title">[]): void;
	/** Add a reference to the library: resolves to the item key (also when it was already there). */
	add(body: { doi?: string; reference?: Reference }): Promise<string>;
	openUrl(url: string): Promise<void>;
	openExternal(attachmentKey: string): Promise<void>;
	item(key: string): Promise<ItemDetail>;
	children(): Promise<ChildSummary[]>;
}

export function createApi(attachmentKey: string, itemKey: string | null): AcademicApi {
	let refsP: Promise<Reference[]> | null = null;
	let failedAt = 0;
	const detail = new Map<string, Promise<ReferenceDetail>>();
	let itemP: Promise<ItemDetail> | null = null;
	const owner = encodeURIComponent(itemKey || attachmentKey);

	const api: AcademicApi = {
		refs() {
			if (refsP && (!failedAt || Date.now() - failedAt < 30000)) return refsP;
			failedAt = 0;
			refsP = apiRequest<ReferenceList>("GET", `/references/${owner}`)
				.then((l) => l.references)
				.catch((e) => { failedAt = Date.now(); console.warn("[academic] references unavailable:", (e as Error).message); return [] as Reference[]; });
			return refsP;
		},
		refList(refresh = false) {
			return apiRequest<ReferenceList>("GET", `/references/${owner}${refresh ? "?refresh=1" : ""}`).then((l) => { refsP = Promise.resolve(l.references); failedAt = 0; return l; });
		},
		lookup(r) {
			const k = (r.doi ?? r.title ?? "").toLowerCase();
			let p = detail.get(k);
			if (!p) {
				const q = new URLSearchParams();
				if (r.doi) q.set("doi", r.doi);
				else if (r.title) q.set("title", r.title);
				p = apiRequest<ReferenceDetail>("GET", "/references/lookup?" + q);
				p.catch(() => detail.delete(k));
				detail.set(k, p);
			}
			return p;
		},
		prefetch(refs) {
			// a few at a time in the background, so cards open with their abstract already there
			const queue = refs.filter((r) => (r.doi || r.title) && !detail.has((r.doi ?? r.title ?? "").toLowerCase()));
			const next = (): Promise<void> | undefined => {
				const r = queue.shift();
				return r && api.lookup(r).then(next, next);
			};
			for (let i = 0; i < 3; i++) void next();
		},
		async add(body) {
			try {
				const item = await apiRequest<ItemDetail>("POST", "/references/add", body);
				return item.data.key;
			} catch (e) {
				// 409: already in the library; the fresh reference list knows which item it is
				const list = await api.refList(true).catch(() => null);
				const doi = (body.doi ?? body.reference?.doi ?? "").toLowerCase();
				const hit = list?.references.find((r) => (doi && r.doi?.toLowerCase() === doi) || (body.reference && r.index === body.reference.index));
				if (hit?.inLibraryKey) return hit.inLibraryKey;
				throw e;
			}
		},
		async openUrl(url) { await apiRequest("POST", "/open-url", { url }); },
		async openExternal(key) { await apiRequest("POST", `/attachments/${encodeURIComponent(key)}/open-external`, {}); },
		item(key) { return apiRequest<ItemDetail>("GET", `/items/${encodeURIComponent(key)}`); },
		async children() {
			if (!itemKey) return [];
			itemP ??= api.item(itemKey).catch((e) => { itemP = null; throw e; });
			return (await itemP).children;
		},
	};
	return api;
}
