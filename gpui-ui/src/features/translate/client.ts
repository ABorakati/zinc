// Client for /api/translate/* (Zotero translators run by the core): save from a web page, import and export in extra formats.
import { get, post } from "../http";
import type { ImportResult, ExportResult } from "../io/client";
import type { SavedItem, TranslatorFormat, WebChoices, WebOutcome, WebSaved } from "./logic";
import { parseWebResponse } from "./logic";

export type { ImportResult, ExportResult };

export interface TranslatorImportResult extends ImportResult { translator: string }

export const translateApi = {
	web: async (url: string, collectionKey?: string): Promise<WebOutcome> => parseWebResponse(await post<unknown>("/api/translate/web", { url, collectionKey })),
	select: (session: string, keys: string[], collectionKey?: string) =>
		post<{ items: SavedItem[]; translator: string | null }>("/api/translate/web/select", { session, keys, collectionKey }),
	importFormats: () => get<TranslatorFormat[]>("/api/translate/import-formats"),
	exportFormats: () => get<TranslatorFormat[]>("/api/translate/export-formats"),
	import: (b: { text?: string; path?: string; translatorID?: string; collectionKey?: string; collectionName?: string | null }) =>
		post<TranslatorImportResult>("/api/translate/import", b),
	export: (b: { translatorID: string; keys?: string[]; collectionKey?: string; includeNotes?: boolean; dir?: string }) =>
		post<ExportResult>("/api/translate/export", b),
};

export type { SavedItem, WebChoices, WebSaved };
