import { createResource, createSignal, type Accessor } from "solid-js";
import type { ItemDetail, Reference, ReferenceDetail, ReferenceList } from "../../../core/src/api-types";

export type { Reference, ReferenceDetail, ReferenceList };

export class ApiError extends Error {
	constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
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
		let data: Record<string, unknown> = {};
		try { data = await res.json(); } catch { /* not json */ }
		throw new ApiError(String(data.error ?? res.statusText), res.status, data);
	}
	return res.json() as Promise<T>;
}

export const referencesApi = {
	list: (itemKey: string, refresh = false) =>
		req<ReferenceList>("GET", `/references/${encodeURIComponent(itemKey)}${refresh ? "?refresh=1" : ""}`),
	lookup: (r: Pick<Reference, "doi" | "title">) => {
		const p = new URLSearchParams();
		if (r.doi) p.set("doi", r.doi);
		else if (r.title) p.set("title", r.title);
		return req<ReferenceDetail>("GET", "/references/lookup?" + p);
	},
	add: (body: { doi?: string; reference?: Reference; collectionKey?: string; findFullText?: boolean }) =>
		req<ItemDetail>("POST", "/references/add", body),
	openUrl: (url: string) => req<{ ok: true }>("POST", "/open-url", { url }),
	collections: () => req<{ key: string; name: string; parentKey: string | null }[]>("GET", "/collections"),
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

/** The item's resolved bibliography; `refresh()` bypasses the server cache. */
export function useReferences(itemKey: Accessor<string | undefined>) {
	const [tick, setTick] = createSignal(0);
	let force = false;
	const [list, { mutate }] = createResource(
		() => {
			const k = itemKey();
			return k ? ([k, tick()] as const) : false;
		},
		async ([k]) => {
			const refresh = force;
			force = false;
			return referencesApi.list(k, refresh);
		},
	);
	return {
		list,
		refresh() { force = true; setTick((t) => t + 1); },
		/** Mark a reference as in the library (after adding it). */
		markInLibrary(index: number, key: string) {
			mutate((l) => l && { ...l, references: l.references.map((r) => (r.index === index ? { ...r, inLibraryKey: key } : r)) });
		},
	};
}
