// Library methods over Zinc core's HTTP API, returning shapes identical to word/addin/Library.cs:
//   - host.info library block (Library.Info)
//   - lib.uriBase (Library.UriBase)
//   - lib.search  (Library.Search)
//   - lib.items   (Library.Items)
//   - lib.byUri   (Library.ByUri)

import type { ItemDetail, ItemList, ItemSummary, SearchResult, ZoteroItemData } from "../../../../core/src/api-types";
import { venueOf } from "../../../../core/src/venue";
import { CoreHttpError, type HttpClient, mapPool } from "./http";
import type { SettingsStore } from "./settings";

export interface LibRow {
	key: string;
	title: string;
	creators: string;
	year: number | null;
	publication: string;
	itemType: string;
	doi: string;
}

export type LibItemResult =
	| { key: string; found: false }
	| {
			key: string;
			found: true;
			itemKey: string;
			trashed: boolean;
			itemType: string;
			data: ZoteroItemData;
			groupId: number | null;
	  };

export interface LibraryInfoOut {
	dbPath: string;
	dbExists: boolean;
	dataDir: string;
	items?: number;
	libraryKey?: string | null;
	error?: string;
}

export interface UriBaseOut {
	base: string;
	userId: string | null;
	source: "settings" | "detected" | "local";
}

export interface CoreLibraryMeta {
	dbPath: string | null;
	libraryKey: string | null;
	userId: string | null;
	items?: number;
}

interface CoreLibraryEntry {
	id: number;
	type: "user" | "group";
	groupId?: number;
	removed?: boolean;
}

const KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const URI_RE = /^https?:\/\/(?:www\.)?zotero\.org\/(users\/(?:local\/)?[A-Za-z0-9_-]+|groups\/\d+)\/items\/([A-Za-z0-9]{1,32})\/?$/;
const PROBE_TIMEOUT_MS = 800;
const ITEM_CONCURRENCY = 16;

function str(v: unknown, def = ""): string {
	return v === null || v === undefined ? def : String(v);
}

function int(v: unknown, def = 0): number {
	if (v === null || v === undefined || v === "") return def;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isTopRegularItem(itemType: string): boolean {
	return itemType !== "attachment" && itemType !== "note" && itemType !== "annotation";
}

/** Cross-platform dirname without node:path (runs inside the browser task pane). */
export function dirOf(path: string): string {
	if (!path) return "";
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (i < 0) return "";
	if (i === 0) return path[0]!;
	if (i === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
	return path.slice(0, i);
}

/**
 * Identity aliases under which a cited item may be recorded in another item's dc:replaces relation.
 * Exact port of Library.IdentityAliases in word/addin/Library.cs.
 */
export function identityAliases(uri: string, libraryKey?: string | null, userId?: string | null): string[] {
	const m = URI_RE.exec(uri);
	if (!m) return [];
	const scope = m[1]!;
	const key = m[2]!;
	const out: string[] = [];
	const add = (u: string) => {
		if (!out.includes(u)) out.push(u);
	};
	add(`http://zotero.org/${scope}/items/${key}`);
	if (scope.startsWith("users/")) {
		if (libraryKey) add(`http://zotero.org/users/local/${libraryKey}/items/${key}`);
		if (userId) add(`http://zotero.org/users/${userId}/items/${key}`);
	}
	return out;
}

/**
 * Convert an FTS5 `match` expression built by sidebar buildSearchArgs (e.g.
 * `{title creators abstract publication tags} : ("liver" "trans"*)`) back into a query string that
 * core's `GET /api/search?q=...` (parseQuery) compiles to the same FTS5 terms and prefix flags.
 */
export function ftsMatchToQuery(match: string): string {
	let body = match
		.trim()
		.replace(/^\s*\{[^}]*\}\s*:\s*/, "")
		.trim();
	if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1).trim();
	const parts: string[] = [];
	const re = /"([^"]*)"(\*?)|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		if (m[1] !== undefined) {
			const phrase = m[1].trim();
			const star = m[2] === "*";
			if (!phrase) continue;
			const words = phrase.split(/\s+/).filter(Boolean);
			if (star) {
				if (words.length === 1) parts.push(`${words[0]}*`);
				else parts.push(...words.slice(0, -1).map((w) => `"${w}"`), `${words[words.length - 1]}*`);
			} else {
				parts.push(`"${phrase}"`);
			}
		} else if (m[3]) {
			parts.push(m[3]);
		}
	}
	return parts.join(" ");
}

/**
 * Fetch library metadata from `GET /api/library?count=0|1` (see NOTES.md), falling back on 404 to
 * existing `/api/files/settings` + `/api/websync/status` (+ `/api/items?limit=1` when `count` is true).
 */
export async function fetchLibraryMeta(http: HttpClient, count: boolean, timeoutMs?: number): Promise<CoreLibraryMeta> {
	try {
		const r = await http.getJson<{
			dbPath?: string | null;
			libraryKey?: string | null;
			userId?: string | number | null;
			items?: number;
		}>(`/api/library?count=${count ? 1 : 0}`, timeoutMs);
		return {
			dbPath: r.dbPath ?? null,
			libraryKey: r.libraryKey ?? null,
			userId: r.userId !== null && r.userId !== undefined && String(r.userId) !== "" ? String(r.userId) : null,
			...(count && typeof r.items === "number" ? { items: r.items } : {}),
		};
	} catch (e) {
		if (!(e instanceof CoreHttpError && e.status === 404)) throw e;
	}

	const [files, websync, list] = await Promise.all([
		http.getJson<{ library?: { dbPath?: string | null } }>("/api/files/settings", timeoutMs),
		http.getJson<{ account?: { userId?: number | string } }>("/api/websync/status", timeoutMs).catch(() => null),
		count ? http.getJson<ItemList>("/api/items?limit=1", timeoutMs) : Promise.resolve(null),
	]);
	const uid = websync?.account?.userId;
	return {
		dbPath: files.library?.dbPath ?? null,
		libraryKey: null,
		userId: uid !== undefined && uid !== null && String(uid) !== "" ? String(uid) : null,
		...(count && list ? { items: list.total } : {}),
	};
}

export function buildLibraryInfo(settings: SettingsStore, http: HttpClient, meta: CoreLibraryMeta | null, err?: unknown): LibraryInfoOut {
	if (!meta) {
		const fallbackPath = settings.getString("dbPath") ?? http.apiBase();
		return {
			dbPath: fallbackPath,
			dbExists: false,
			dataDir: dirOf(settings.getString("dbPath") ?? ""),
			error: err instanceof Error ? err.message : err !== undefined ? String(err) : "Zinc is not running",
		};
	}
	const dbPath = meta.dbPath ?? settings.getString("dbPath") ?? "(Zinc library)";
	return {
		dbPath,
		dbExists: true,
		dataDir: meta.dbPath ? dirOf(meta.dbPath) : "",
		...(meta.items !== undefined ? { items: meta.items } : {}),
		...(meta.libraryKey !== null ? { libraryKey: meta.libraryKey } : {}),
	};
}

export async function resolveUriBase(http: HttpClient, settings: SettingsStore, prefetched?: CoreLibraryMeta | null): Promise<UriBaseOut> {
	const configured = settings.getString("userId");
	if (configured) return { base: `http://zotero.org/users/${configured}`, userId: configured, source: "settings" };

	const cachedDetected = settings.getString("detectedUserId");
	if (cachedDetected) return { base: `http://zotero.org/users/${cachedDetected}`, userId: cachedDetected, source: "detected" };

	let meta = prefetched;
	if (meta === undefined) {
		try {
			meta = await fetchLibraryMeta(http, false, PROBE_TIMEOUT_MS);
		} catch {
			meta = null;
		}
	}
	if (meta?.userId) {
		await settings.patchInternal({ detectedUserId: meta.userId });
		return { base: `http://zotero.org/users/${meta.userId}`, userId: meta.userId, source: "detected" };
	}
	const lk = meta?.libraryKey || "znlocal0";
	return { base: `http://zotero.org/users/local/${lk}`, userId: null, source: "local" };
}

function summaryToRow(it: ItemSummary): LibRow {
	return {
		key: it.key,
		title: it.title ?? "",
		creators: it.creatorsSummary ?? "",
		year: typeof it.year === "number" && it.year !== 0 ? it.year : null,
		publication: it.publication ?? "",
		itemType: it.itemType,
		doi: it.fields?.DOI ?? "",
	};
}

async function activeLibraries(http: HttpClient): Promise<CoreLibraryEntry[]> {
	const res = await http.getJson<{ libraries?: CoreLibraryEntry[] }>("/api/libraries");
	const libs = (res.libraries ?? []).filter((l) => !l.removed);
	return libs.length > 0 ? libs : [{ id: 1, type: "user" }];
}

export async function searchLibrary(http: HttpClient, p: Record<string, unknown>): Promise<LibRow[]> {
	const match = str(p.match).trim();
	const doi = str(p.doi).trim();
	const year = int(p.year, 0);
	const limit = Math.min(Math.max(int(p.limit, 30), 1), 200);
	const fetchLimit = Math.min(limit + 20, 1000);

	if (match) {
		const q = ftsMatchToQuery(match);
		if (!q) return [];
		const libs = await activeLibraries(http);
		const perLibLimit = year > 0 ? 200 : Math.min(Math.max(limit * 2, 20), 200);
		const pages = await Promise.all(
			libs.map((l) =>
				http.getJson<SearchResult>(
					`/api/search?q=${encodeURIComponent(q)}&limit=${perLibLimit}${l.id !== 1 ? `&library=${l.id}` : ""}`,
				),
			),
		);
		const merged = pages
			.flatMap((pg) => pg.hits ?? [])
			.filter((h) => (!Array.isArray(h.matchedIn) || h.matchedIn.includes("metadata")) && (year <= 0 || h.year === year));
		if (libs.length > 1) merged.sort((a, b) => a.rank - b.rank);
		const seen = new Set<string>();
		const chosen = merged.filter((h) => (seen.has(h.key) ? false : (seen.add(h.key), true))).slice(0, limit);
		if (chosen.length === 0) return [];

		const details = await mapPool(chosen, ITEM_CONCURRENCY, async (hit) => {
			try {
				const d = await http.getJson<ItemDetail>(`/api/items/${encodeURIComponent(hit.key)}`);
				return { hit, data: d.data };
			} catch (e) {
				if (e instanceof CoreHttpError && e.status === 404) return null;
				throw e;
			}
		});
		const rows: LibRow[] = [];
		for (const entry of details) {
			if (!entry) continue;
			const { hit, data } = entry;
			if (!isTopRegularItem(data.itemType)) continue;
			rows.push({
				key: hit.key,
				title: hit.title ?? data.title ?? "",
				creators: hit.creatorsSummary ?? "",
				year: typeof hit.year === "number" && hit.year !== 0 ? hit.year : null,
				publication: venueOf(data as Record<string, unknown>, data.itemType) ?? "",
				itemType: data.itemType,
				doi: typeof data.DOI === "string" ? data.DOI : "",
			});
		}
		return rows;
	}

	if (doi) {
		const res = await http.postJson<ItemList>("/api/searches/run", {
			conditions: [{ field: "DOI", operator: "is", value: doi }],
			options: { topLevelOnly: true },
			fields: ["DOI"],
			limit: fetchLimit,
		});
		return res.items
			.filter((it) => isTopRegularItem(it.itemType))
			.slice(0, limit)
			.map(summaryToRow);
	}

	if (year > 0) {
		const res = await http.postJson<ItemList>("/api/searches/run", {
			conditions: [{ field: "year", operator: "is", value: String(year) }],
			options: { topLevelOnly: true },
			sort: "dateAdded",
			dir: "desc",
			fields: ["DOI"],
			limit: fetchLimit,
		});
		return res.items
			.filter((it) => isTopRegularItem(it.itemType))
			.slice(0, limit)
			.map(summaryToRow);
	}

	const [libs, mainList] = await Promise.all([
		activeLibraries(http),
		http.getJson<ItemList>(`/api/items?sort=dateAdded&dir=desc&limit=${fetchLimit}&fields=DOI`),
	]);
	const groupLibs = libs.filter((l) => l.id !== 1);
	if (groupLibs.length === 0) {
		return mainList.items
			.filter((it) => isTopRegularItem(it.itemType))
			.slice(0, limit)
			.map(summaryToRow);
	}
	const extraLists = await Promise.all(
		groupLibs.map((g) => http.getJson<ItemList>(`/api/items?library=${g.id}&sort=dateAdded&dir=desc&limit=${fetchLimit}&fields=DOI`)),
	);
	const allItems = [mainList, ...extraLists]
		.flatMap((l) => l.items)
		.filter((it) => isTopRegularItem(it.itemType))
		.sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : a.dateAdded > b.dateAdded ? -1 : 0));
	return allItems.slice(0, limit).map(summaryToRow);
}

export async function getLibraryItems(http: HttpClient, p: Record<string, unknown>): Promise<LibItemResult[]> {
	const raw = Array.isArray(p.keys) ? p.keys : [];
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const x of raw) {
		if (x === null || x === undefined) continue;
		const k = String(x);
		if (KEY_RE.test(k) && !seen.has(k)) {
			seen.add(k);
			keys.push(k);
		}
	}
	if (keys.length === 0) return [];

	const detailCache = new Map<string, Promise<ItemDetail | null>>();
	const getDetail = (key: string): Promise<ItemDetail | null> => {
		let inflight = detailCache.get(key);
		if (!inflight) {
			inflight = http.getJson<ItemDetail>(`/api/items/${encodeURIComponent(key)}`).catch((e) => {
				if (e instanceof CoreHttpError && e.status === 404) return null;
				throw e;
			});
			detailCache.set(key, inflight);
		}
		return inflight;
	};

	const [libs, resolved] = await Promise.all([
		activeLibraries(http),
		mapPool(keys, ITEM_CONCURRENCY, async (k) => {
			let d = await getDetail(k);
			if (!d) return { reqKey: k, detail: null as ItemDetail | null };
			if (typeof d.data.parentItem === "string" && d.data.parentItem) {
				d = await getDetail(d.data.parentItem);
			}
			return { reqKey: k, detail: d };
		}),
	]);

	const groups = libs.filter((l): l is CoreLibraryEntry & { groupId: number } => l.type === "group" && typeof l.groupId === "number");
	const groupIdCache = new Map<string, Promise<number | null>>();
	const findGroupId = (itemKey: string, trashed: boolean): Promise<number | null> => {
		if (groups.length === 0) return Promise.resolve(null);
		let pGroup = groupIdCache.get(itemKey);
		if (!pGroup) {
			pGroup = (async () => {
				const trashParam = trashed ? "&trash=1" : "";
				const inUser = await http.getJson<{ index: number }>(`/api/items/index?key=${encodeURIComponent(itemKey)}${trashParam}`);
				if (inUser.index >= 0) return null;
				for (const g of groups) {
					const r = await http.getJson<{ index: number }>(
						`/api/items/index?key=${encodeURIComponent(itemKey)}&library=${g.id}${trashParam}`,
					);
					if (r.index >= 0) return g.groupId;
				}
				return null;
			})();
			groupIdCache.set(itemKey, pGroup);
		}
		return pGroup;
	};

	return mapPool(resolved, ITEM_CONCURRENCY, async ({ reqKey, detail }): Promise<LibItemResult> => {
		if (!detail) return { key: reqKey, found: false };
		const itemKey = typeof detail.data.key === "string" && detail.data.key ? detail.data.key : reqKey;
		const trashed = detail.data.deleted === 1 || (detail.data.deleted as unknown) === true;
		const data: ZoteroItemData = { ...detail.data, key: itemKey };
		const groupId = await findGroupId(itemKey, trashed);
		return {
			key: reqKey,
			found: true,
			itemKey,
			trashed,
			itemType: data.itemType,
			data,
			groupId,
		};
	});
}

export async function lookupByUri(http: HttpClient, settings: SettingsStore, p: Record<string, unknown>): Promise<Record<string, string>> {
	const raw = Array.isArray(p.uris) ? p.uris : [];
	const uris = raw
		.filter((u) => u !== null && u !== undefined)
		.map((u) => String(u))
		.filter((u) => u.length > 0)
		.slice(0, 50);
	if (uris.length === 0) return {};
	const userId = settings.getString("userId") ?? settings.getString("detectedUserId");
	return http.postJson<Record<string, string>>("/api/items/by-uri", {
		uris,
		...(userId ? { userId } : {}),
	});
}
