// Client for /api/duplicates/* (core/src/duplicates/api.ts).
import { get, post } from "../http";
import type { ItemDetail, ZoteroSchema } from "../types";

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

export const duplicatesApi = {
	list: () => get<DuplicateList>("/api/duplicates?summary=1"),
	setDetails: (keys: string[]) => get<DuplicateSetDetails>("/api/duplicates/set?keys=" + encodeURIComponent(keys.join(","))),
	merge: (payload: MergeRequest) => post<ItemDetail>("/api/duplicates/merge", payload),
	markNotDuplicates: (keys: string[]) => post<{ ok: true }>("/api/duplicates/not-duplicates", { keys }),
};

let schema: Promise<ZoteroSchema> | undefined;
/** Field labels ("publicationTitle" -> "Publication"), fetched once. */
export const fieldLabels = (): Promise<Record<string, string>> =>
	(schema ??= get<ZoteroSchema>("/api/schema")).then(
		(s) => s.fieldLabels,
		() => {
			schema = undefined;
			return {};
		},
	);
