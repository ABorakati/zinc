import type { ItemDetail } from "../api";

export type DuplicateReason = "doi" | "isbn" | "title";

export interface DuplicateSet {
	keys: string[];
	reason: DuplicateReason;
	title?: string;
	creatorsSummary?: string;
	year?: number | null;
	itemType?: string;
}

export interface DuplicateList {
	sets: DuplicateSet[];
	total: number;
}

export interface DuplicateSetDetails {
	items: ItemDetail[];
	defaultMasterKey: string;
	differingFields: string[];
}

export interface MergeRequest {
	masterKey: string;
	otherKeys: string[];
	fieldChoices?: Record<string, string>;
}

async function dupReq<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch("/api/duplicates" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try {
			msg = ((await res.json()) as { error?: string }).error ?? msg;
		} catch {}
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

export const duplicatesApi = {
	list: (summary = true) => dupReq<DuplicateList>("GET", summary ? "?summary=1" : ""),
	setDetails: (keys: string[]) =>
		dupReq<DuplicateSetDetails>("GET", "/set?keys=" + encodeURIComponent(keys.join(","))),
	merge: (payload: MergeRequest) => dupReq<ItemDetail>("POST", "/merge", payload),
	markNotDuplicates: (keys: string[]) => dupReq<{ ok: true }>("POST", "/not-duplicates", { keys }),
};
