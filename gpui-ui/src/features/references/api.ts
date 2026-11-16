// Client for /api/references/* (core/src/references/api.ts).
import { get, post } from "../http";
import type { ItemDetail, Reference, ReferenceDetail, ReferenceList } from "../types";

export type { Reference, ReferenceDetail, ReferenceList };

export const referencesApi = {
	list: (itemKey: string, refresh = false) =>
		get<ReferenceList>(`/api/references/${encodeURIComponent(itemKey)}${refresh ? "?refresh=1" : ""}`),
	lookup: (r: Pick<Reference, "doi" | "title">) => {
		const p = new URLSearchParams();
		if (r.doi) p.set("doi", r.doi);
		else if (r.title) p.set("title", r.title);
		return get<ReferenceDetail>("/api/references/lookup?" + p);
	},
	add: (body: { doi?: string; reference?: Reference; collectionKey?: string; findFullText?: boolean }) =>
		post<ItemDetail>("/api/references/add", body),
};

const detailCache = new Map<string, Promise<ReferenceDetail>>();

/** Hover-card details, cached per DOI/title for the session. */
export function lookupReference(r: Reference): Promise<ReferenceDetail> {
	const k = (r.doi ?? r.title ?? "").toLowerCase();
	let p = detailCache.get(k);
	if (!p) {
		p = referencesApi.lookup(r);
		p.catch(() => detailCache.delete(k));
		detailCache.set(k, p);
	}
	return p;
}

/** The core answers 409 "already in the library" when adding something that is there; the error text is all apiRequest keeps. */
export const isAlreadyInLibrary = (e: unknown) => e instanceof Error && /already in the library/i.test(e.message);
