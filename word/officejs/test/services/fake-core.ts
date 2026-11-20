// Fake Zinc core HTTP server on a free ephemeral port (Bun.serve({ port: 0 })), returning canned responses shaped
// identically to core/src/api.ts, core/src/cite/api.ts, core/src/connector/ui.ts, core/src/references/api.ts,
// core/src/searches/api.ts, core/src/files/api.ts, and core/src/websync/api.ts.
// Never touches data/library.sqlite, Zotero directories, or ports 23119 / 23120.

import type { CiteStyleInfo } from "../../../../core/src/cite/types";
import type { ItemDetail, ItemSummary, ReferenceDetail, SearchHit, ZoteroItemData } from "../../../../core/src/api-types";
import { venueOf } from "../../../../core/src/venue";
import { identityAliases } from "../../src/services/library";

export interface StoredFakeItem {
	data: ZoteroItemData;
	libraryId?: number;
	creatorsSummary: string;
	year: number | null;
	dateAdded: string;
	/** Whether the item matches metadata vs fulltext-only in FTS search. */
	matchedIn?: ("metadata" | "fulltext" | "notes")[];
}

export interface RecordedRequest {
	method: string;
	pathname: string;
	search: string;
	body: unknown;
}

export interface FakeCoreOptions {
	dbPath?: string | null;
	libraryKey?: string | null;
	userId?: string | null;
	/** Simulate a core build before GET /api/library is added (answers 404 on /api/library). */
	disableLibraryEndpoint?: boolean;
	/** Simulate an older Zinc build where POST /api/ui/reveal returns 404 {error: "not found"}. */
	oldRevealNotFound?: boolean;
	items?: StoredFakeItem[];
	groups?: { id: number; groupId: number; name: string }[];
	styles?: CiteStyleInfo[];
	styleXmlById?: Record<string, string>;
	localeXmlByLang?: Record<string, string>;
	referencesByDoi?: Record<string, ReferenceDetail>;
}

export const DEFAULT_FAKE_ITEMS: StoredFakeItem[] = [
	{
		libraryId: 1,
		creatorsSummary: "Smith and Haddad",
		year: 2021,
		dateAdded: "2026-03-10T10:00:00Z",
		data: {
			key: "AAAA1111",
			itemType: "journalArticle",
			title: "Outcomes after liver transplantation in the United Kingdom",
			creators: [
				{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
				{ creatorType: "author", firstName: "Omar", lastName: "Haddad" },
			],
			publicationTitle: "Transplantation",
			date: "2021-03-04",
			volume: "105",
			issue: "3",
			pages: "512-520",
			DOI: "10.1000/tx.2021.001",
			abstractNote: "Long-term outcomes after liver transplantation vary by centre.",
			relations: {
				"dc:replaces": "http://zotero.org/users/local/LIBKEY99/items/OLDK0001",
			},
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "Chen",
		year: 2019,
		dateAdded: "2026-03-11T10:00:00Z",
		data: {
			key: "BBBB2222",
			itemType: "journalArticle",
			title: "Machine perfusion for donor liver preservation",
			creators: [{ creatorType: "author", firstName: "Li", lastName: "Chen" }],
			publicationTitle: "Journal of Hepatology",
			date: "2019",
			DOI: "10.1000/jh.2019.044",
			abstractNote: "We reviewed 34 trials of normothermic and hypothermic machine perfusion.",
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "AttChild",
		year: null,
		dateAdded: "2026-03-12T10:00:00Z",
		data: {
			key: "CHLD1111",
			itemType: "attachment",
			parentItem: "AAAA1111",
			title: "Full Text PDF",
			contentType: "application/pdf",
			linkMode: "imported_file",
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "",
		year: null,
		dateAdded: "2026-03-13T10:00:00Z",
		data: {
			key: "NOTE0001",
			itemType: "note",
			note: "<p>Standalone note that should never appear in lib.search</p>",
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "Trashed",
		year: 2020,
		dateAdded: "2026-03-09T10:00:00Z",
		data: {
			key: "TRSH1111",
			itemType: "journalArticle",
			title: "Retracted study in trash",
			creators: [{ creatorType: "author", firstName: "Tom", lastName: "Trashed" }],
			date: "2020",
			deleted: 1,
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "Orphan",
		year: null,
		dateAdded: "2026-03-08T10:00:00Z",
		data: {
			key: "ORPH1111",
			itemType: "attachment",
			parentItem: "GONE9999",
			title: "Dangling child attachment",
		},
	},
	{
		libraryId: 1,
		creatorsSummary: "BodyOnly",
		year: 2021,
		dateAdded: "2026-03-07T10:00:00Z",
		matchedIn: ["fulltext"],
		data: {
			key: "PDFONLY1",
			itemType: "journalArticle",
			title: "Unrelated cardiology paper",
			creators: [{ creatorType: "author", firstName: "Pat", lastName: "BodyOnly" }],
			publicationTitle: "Heart",
			date: "2021",
		},
	},
	{
		libraryId: 2,
		creatorsSummary: "Rossi and Kovacs",
		year: 2018,
		dateAdded: "2026-03-14T10:00:00Z",
		data: {
			key: "GRP00001",
			itemType: "book",
			title: "Clinical Transplantation Handbook",
			creators: [
				{ creatorType: "author", firstName: "Anna", lastName: "Rossi" },
				{ creatorType: "author", firstName: "Peter", lastName: "Kovacs" },
			],
			publisher: "Oxford University Press",
			date: "2018",
		},
	},
];

export const SAMPLE_VANCOUVER_CSL = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info><title>Vancouver</title><id>http://www.zotero.org/styles/vancouver</id></info>
</style>`;

export const SAMPLE_EN_US_LOCALE = `<?xml version="1.0" encoding="utf-8"?>
<locale xmlns="http://purl.org/net/xbiblio/csl" version="1.0" xml:lang="en-US">
  <terms><term name="et-al">et al.</term></terms>
</locale>`;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
	});
}

function toSummary(it: StoredFakeItem, fields: string[]): ItemSummary {
	const summary: ItemSummary = {
		key: it.data.key,
		itemType: it.data.itemType,
		title: it.data.title ?? "",
		creatorsSummary: it.creatorsSummary,
		year: it.year,
		publication: venueOf(it.data as Record<string, unknown>, it.data.itemType),
		dateAdded: it.dateAdded,
		primaryAttachment: null,
		attachmentCount: 0,
		noteCount: 0,
	};
	if (fields.length > 0) {
		const fMap: Record<string, string | null> = {};
		for (const f of fields) {
			const v = it.data[f];
			fMap[f] = v === undefined || v === null || v === "" ? null : String(v);
		}
		summary.fields = fMap;
	}
	return summary;
}

export function startFakeCore(opts: FakeCoreOptions = {}) {
	const items = structuredClone(opts.items ?? DEFAULT_FAKE_ITEMS);
	const groups = opts.groups ?? [{ id: 2, groupId: 778899, name: "Transplant Consortium" }];
	const dbPath = opts.dbPath === undefined ? "C:\\FakeZinc\\library.sqlite" : opts.dbPath;
	const libraryKey = opts.libraryKey === undefined ? "LIBKEY99" : opts.libraryKey;
	const userId = opts.userId === undefined ? "5106252" : opts.userId;
	const styles: CiteStyleInfo[] = opts.styles ?? [
		{ id: "vancouver", title: "Vancouver", format: "numeric", dependent: false, installed: true, bundled: true },
		{ id: "apa", title: "American Psychological Association 7th edition", format: "author-date", dependent: false, installed: true },
		{ id: "the-lancet", title: "The Lancet", dependent: true, installed: false },
	];
	const styleXml: Record<string, string> = opts.styleXmlById ?? { vancouver: SAMPLE_VANCOUVER_CSL };
	const localeXml: Record<string, string> = opts.localeXmlByLang ?? { "en-US": SAMPLE_EN_US_LOCALE };
	const refs: Record<string, ReferenceDetail> = opts.referencesByDoi ?? {
		"10.1000/tx.2021.001": {
			index: 1,
			doi: "10.1000/tx.2021.001",
			title: "Outcomes after liver transplantation in the United Kingdom",
			abstract: "Fetched online abstract from Crossref/OpenAlex.",
		},
	};
	const requests: RecordedRequest[] = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			let parsedBody: unknown = null;
			if (req.method !== "GET" && req.method !== "HEAD") {
				const raw = await req.text();
				if (raw) {
					try {
						parsedBody = JSON.parse(raw);
					} catch {
						return json({ error: "invalid JSON body" }, 400);
					}
				}
			}
			requests.push({ method: req.method, pathname: url.pathname, search: url.search, body: parsedBody });

			// GET /api/ui/selection
			if (url.pathname === "/api/ui/selection" && req.method === "GET") {
				return json({ selection: { kind: "library" }, rev: 1, ext: 0, reveal: null });
			}

			// POST /api/ui/reveal
			if (url.pathname === "/api/ui/reveal" && req.method === "POST") {
				if (opts.oldRevealNotFound) return json({ error: "not found" }, 404);
				const b = (parsedBody ?? {}) as { key?: unknown; open?: unknown };
				if (typeof b.key !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(b.key)) {
					return json({ error: "key required" }, 400);
				}
				let found = items.find((i) => i.data.key === b.key);
				if (found?.data.parentItem) found = items.find((i) => i.data.key === found!.data.parentItem);
				if (!found || found.data.deleted) return json({ error: "item not found" }, 404);
				return json({ ok: true, rev: 1, seq: 1, opened: b.open === true ? "CHLD1111" : null });
			}

			// GET /api/references/lookup
			if (url.pathname === "/api/references/lookup" && req.method === "GET") {
				const doi = (url.searchParams.get("doi") ?? "").toLowerCase();
				const hit = Object.entries(refs).find(([k]) => k.toLowerCase() === doi)?.[1];
				if (!hit) return json({ error: "reference not found" }, 404);
				return json(hit);
			}

			// GET /api/library
			if (url.pathname === "/api/library" && req.method === "GET") {
				if (opts.disableLibraryEndpoint) return json({ error: "not found" }, 404);
				const count = url.searchParams.get("count") === "1";
				const topCount = items.filter(
					(i) =>
						!i.data.parentItem &&
						!i.data.deleted &&
						i.data.itemType !== "attachment" &&
						i.data.itemType !== "note" &&
						i.data.itemType !== "annotation",
				).length;
				return json({
					dbPath,
					libraryKey,
					userId,
					...(count ? { items: topCount } : {}),
				});
			}

			// Fallback endpoints: GET /api/files/settings & GET /api/websync/status
			if (url.pathname === "/api/files/settings" && req.method === "GET") {
				return json({
					library: { dbPath, configPath: null, sizeBytes: 4096 },
					zotero: { dataDir: "", source: "zotero", configured: null },
					baseDir: { mode: "none", configured: null, effective: null, stored: { relative: 0, absolute: 0 } },
					storage: {},
				});
			}
			if (url.pathname === "/api/websync/status" && req.method === "GET") {
				return json({
					mode: "zotero-org",
					account: userId ? { keySet: true, userId: Number(userId) } : { keySet: false },
					push: false,
					files: "off",
					pending: 0,
					conflicts: 0,
					busy: false,
					groups: [],
				});
			}

			// GET /api/libraries
			if (url.pathname === "/api/libraries" && req.method === "GET") {
				return json({
					libraries: [
						{ id: 1, type: "user", name: "My Library", editable: true, filesEditable: true, removed: false, pending: 0 },
						...groups.map((g) => ({
							id: g.id,
							type: "group" as const,
							groupId: g.groupId,
							name: g.name,
							editable: true,
							filesEditable: true,
							removed: false,
							pending: 0,
						})),
					],
				});
			}

			// POST /api/items/by-uri
			if (url.pathname === "/api/items/by-uri" && req.method === "POST") {
				const b = (parsedBody ?? {}) as { uris?: string[]; userId?: string };
				const out: Record<string, string> = {};
				const effUid = b.userId ?? userId;
				for (const u of (b.uris ?? []).slice(0, 50)) {
					const aliases = identityAliases(u, libraryKey, effUid);
					for (const alias of aliases) {
						const owner = items.find((it) => {
							if (it.data.deleted || it.data.parentItem) return false;
							const rel = it.data.relations?.["dc:replaces"];
							const list = Array.isArray(rel) ? rel : typeof rel === "string" ? [rel] : [];
							return list.includes(alias);
						});
						if (owner) {
							out[u] = owner.data.key;
							break;
						}
					}
				}
				return json(out);
			}

			// GET /api/items/index
			if (url.pathname === "/api/items/index" && req.method === "GET") {
				const key = url.searchParams.get("key") ?? "";
				const lib = Number(url.searchParams.get("library") ?? "1");
				const trash = url.searchParams.get("trash") === "1";
				const list = items.filter((i) => (i.libraryId ?? 1) === lib && !i.data.parentItem && Boolean(i.data.deleted) === trash);
				return json({ index: list.findIndex((i) => i.data.key === key) });
			}

			// GET /api/items
			if (url.pathname === "/api/items" && req.method === "GET") {
				const lib = Number(url.searchParams.get("library") ?? "1");
				const trash = url.searchParams.get("trash") === "1";
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50"), 1), 1000);
				const fields = (url.searchParams.get("fields") ?? "")
					.split(",")
					.map((f) => f.trim())
					.filter(Boolean);
				const filtered = items
					.filter((i) => (i.libraryId ?? 1) === lib && !i.data.parentItem && Boolean(i.data.deleted) === trash)
					.sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : a.dateAdded > b.dateAdded ? -1 : 0));
				return json({
					total: filtered.length,
					items: filtered.slice(0, limit).map((i) => toSummary(i, fields)),
				});
			}

			// GET /api/items/:key
			if (url.pathname.startsWith("/api/items/") && req.method === "GET") {
				const key = decodeURIComponent(url.pathname.slice("/api/items/".length));
				const hit = items.find((i) => i.data.key === key);
				if (!hit) return json({ error: "item not found" }, 404);
				const detail: ItemDetail = {
					data: structuredClone(hit.data),
					children: [],
					collections: [],
					tags: [],
				};
				return json(detail);
			}

			// POST /api/searches/run
			if (url.pathname === "/api/searches/run" && req.method === "POST") {
				const b = (parsedBody ?? {}) as {
					conditions?: { field: string; operator: string; value: string }[];
					fields?: string[];
					limit?: number;
				};
				const conds = b.conditions ?? [];
				const fields = b.fields ?? [];
				const limit = Math.min(Math.max(Number(b.limit ?? 50), 1), 1000);
				let list = items.filter((i) => (i.libraryId ?? 1) === 1 && !i.data.parentItem && !i.data.deleted);
				for (const c of conds) {
					if (c.field.toLowerCase() === "doi" && c.operator === "is") {
						list = list.filter((i) => String(i.data.DOI ?? "").toLowerCase() === c.value.toLowerCase());
					} else if (c.field.toLowerCase() === "year" && c.operator === "is") {
						list = list.filter((i) => i.year === Number(c.value));
					}
				}
				list.sort((a, b2) => (a.dateAdded < b2.dateAdded ? 1 : a.dateAdded > b2.dateAdded ? -1 : 0));
				return json({
					total: list.length,
					items: list.slice(0, limit).map((i) => toSummary(i, fields)),
				});
			}

			// GET /api/search
			if (url.pathname === "/api/search" && req.method === "GET") {
				const q = url.searchParams.get("q") ?? "";
				const lib = Number(url.searchParams.get("library") ?? "1");
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 200);
				const terms: { text: string; prefix: boolean }[] = [];
				const re = /"([^"]*)"|(\S+)/g;
				let m: RegExpExecArray | null;
				while ((m = re.exec(q)) !== null) {
					const raw = m[1] ?? m[2]!;
					const prefix = m[2] !== undefined && raw.endsWith("*");
					const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
					if (words.length) terms.push({ text: words.join(" ").toLowerCase(), prefix });
				}
				if (terms.length === 0) return json({ total: 0, hits: [] });

				const candidates = items.filter(
					(i) =>
						(i.libraryId ?? 1) === lib &&
						!i.data.parentItem &&
						!i.data.deleted &&
						i.data.itemType !== "attachment" &&
						i.data.itemType !== "note" &&
						i.data.itemType !== "annotation",
				);
				const hits: SearchHit[] = [];
				for (const it of candidates) {
					const metaHay = [
						it.data.title ?? "",
						(it.data.creators ?? []).map((c) => `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.name ?? ""}`).join(" "),
						it.data.abstractNote ?? "",
						venueOf(it.data as Record<string, unknown>, it.data.itemType) ?? "",
					]
						.join(" ")
						.toLowerCase();
					const matchesMeta = terms.every((t) =>
						t.prefix ? metaHay.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(t.text)) : metaHay.includes(t.text),
					);
					const onlyFulltext = it.matchedIn && !it.matchedIn.includes("metadata");
					if (!matchesMeta && !onlyFulltext) continue;
					if (onlyFulltext && !terms.some((t) => t.text === "liver" || metaHay.includes(t.text))) continue;
					const titleRank = (it.data.title ?? "").toLowerCase().includes(terms[0]!.text) ? -10 : -2;
					hits.push({
						key: it.data.key,
						title: it.data.title ?? "",
						creatorsSummary: it.creatorsSummary,
						year: it.year,
						snippet: it.data.title ?? "",
						matchedIn: it.matchedIn ?? ["metadata"],
						rank: titleRank,
					});
				}
				hits.sort((a, b2) => a.rank - b2.rank);
				return json({ total: hits.length, hits: hits.slice(0, limit) });
			}

			// GET /api/cite/styles
			if (url.pathname === "/api/cite/styles" && req.method === "GET") {
				const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
				const quick = url.searchParams.get("quick") === "1";
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50"), 1), 500);
				let matched = styles;
				if (q) {
					matched = styles.filter((s) => s.id.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
				} else if (quick) {
					matched = styles.filter((s) => s.installed || s.bundled);
				}
				return json(matched.slice(0, limit), 200, {
					"X-Total": String(matched.length),
					"X-Styles-Index": "fresh",
				});
			}

			// GET /api/cite/styles/:id
			if (url.pathname.startsWith("/api/cite/styles/") && req.method === "GET") {
				const id = decodeURIComponent(url.pathname.slice("/api/cite/styles/".length));
				const xml = styleXml[id];
				if (!xml) return json({ error: `style "${id}" not found on zotero.org` }, 404);
				return json({ id, xml });
			}

			// GET /api/cite/locales/:lang
			if (url.pathname.startsWith("/api/cite/locales/") && req.method === "GET") {
				const lang = decodeURIComponent(url.pathname.slice("/api/cite/locales/".length));
				return json({ lang, xml: localeXml[lang] ?? null });
			}

			return json({ error: "not found" }, 404);
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port,
		items,
		requests,
		stop() {
			server.stop(true);
		},
	};
}

/** Allocate an ephemeral loopback port and close it immediately so requests deterministically fail with connection refused. */
export function unusedLocalApiUrl(): string {
	const tmp = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("closing"),
	});
	const port = tmp.port;
	tmp.stop(true);
	return `http://127.0.0.1:${port}`;
}
