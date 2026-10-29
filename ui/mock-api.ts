// Mock of the zotero-next core HTTP API (core/src/api-types.ts) with ~30k generated
// items, for developing/testing ui/ without the real core.
//   bun ui/mock-api.ts   -> http://127.0.0.1:23121/app/  (API under /api)
import { join } from "node:path";
import type {
	Collection, ItemSummary, ItemDetail, ZoteroItemData, ChildSummary, SearchHit, ReaderAnnotation,
} from "../core/src/api-types";

const PORT = Number(process.env.PORT ?? 23121);
const DIST = join(import.meta.dir, "dist");

// ---- deterministic data -------------------------------------------------
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const WORDS = "neural graph protein cohort surgical imaging bayesian outcomes network transformer genome stochastic clinical randomised trial mapping ontology semantic vector embedding retrieval language model cancer immune cell dynamics learning robust sparse kernel liver renal transplant registry survival regression inference causal federated privacy".split(" ");
const FIRST = ["Aditya", "Maria", "Chen", "Olu", "Sam", "Priya", "Jonas", "Fatima", "Lucia", "Kenji", "Anna", "Tom"];
const LAST = ["Borakati", "Smith", "Nguyen", "Okafor", "Garcia", "Patel", "Mueller", "Haddad", "Rossi", "Tanaka", "Kowalski", "Brown"];
const JOURNALS = ["Nature", "The Lancet", "BMJ", "Annals of Surgery", "PLOS ONE", "JAMA", "Science", "npj Digital Medicine", "British Journal of Surgery", null];
const TAGS = ["to-read", "review", "methods", "ML", "surgery", "transplant", "NLP", "key paper", "dataset", "stats", "ethics", "imaging"];
const title = () => {
	const n = 4 + Math.floor(rnd() * 7);
	const w = Array.from({ length: n }, () => pick(WORDS));
	w[0] = w[0][0].toUpperCase() + w[0].slice(1);
	return w.join(" ");
};
const key = () => Array.from({ length: 8 }, () => "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"[Math.floor(rnd() * 33)]).join("");

interface Rec {
	data: ZoteroItemData;
	summary: ItemSummary;
	collections: Set<string>;
	tags: Set<string>;
	children: string[];
	trashed: boolean;
	text: string;
	sortCreator: string;
	sortTitle: string;
}
const recs = new Map<string, Rec>();
const childRecs = new Map<string, ZoteroItemData & { annotations: number; hasFile: boolean }>();
const annotations = new Map<string, ReaderAnnotation[]>();
const viewStates = new Map<string, object>();

const collections = new Map<string, Collection>();
const collKeys: string[] = [];
for (let i = 0; i < 80; i++) {
	const parent = i > 12 && rnd() < 0.6 ? collKeys[Math.floor(rnd() * Math.min(i, 20))] : null;
	const k = key();
	collections.set(k, { key: k, name: `${pick(WORDS)} ${pick(WORDS)}`.replace(/^./, (c) => c.toUpperCase()), parentKey: parent, itemCount: 0 });
	collKeys.push(k);
}

for (let i = 0; i < 30000; i++) {
	const k = key();
	const authors = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ creatorType: "author", firstName: pick(FIRST), lastName: pick(LAST) }));
	const year = 1990 + Math.floor(rnd() * 36);
	const pub = pick(JOURNALS);
	const added = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 6.5 * 365) * 86400000 + i * 1000).toISOString();
	const t = title();
	const summaryCreators = authors.length > 2 ? `${authors[0].lastName} et al.` : authors.map((a) => a.lastName).join(" and ");
	const hasPdf = rnd() < 0.7;
	const children: string[] = [];
	if (hasPdf) {
		const ck = key();
		children.push(ck);
		childRecs.set(ck, { key: ck, itemType: "attachment", title: "Full Text PDF", contentType: "application/pdf", linkMode: "imported_file", parentItem: k, annotations: Math.floor(rnd() * 12), hasFile: true });
	}
	let noteCount = 0;
	if (rnd() < 0.15) {
		const nk = key();
		children.push(nk);
		noteCount = 1;
		childRecs.set(nk, { key: nk, itemType: "note", title: "Note", note: `<h2>Notes</h2><p>Key point about <b>${pick(WORDS)}</b>.</p><script>alert(1)</script><p onclick="x()">Second paragraph <a href="javascript:alert(1)">bad</a> <a href="https://example.org">ok</a></p>`, parentItem: k, annotations: 0, hasFile: false });
	}
	const itemTags = new Set<string>();
	if (rnd() < 0.6) itemTags.add(pick(TAGS));
	if (rnd() < 0.3) itemTags.add(pick(TAGS));
	const colls = new Set<string>();
	if (rnd() < 0.7) colls.add(pick(collKeys));
	const data: ZoteroItemData = {
		key: k, itemType: "journalArticle", title: t, creators: authors, date: `${year}-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
		abstractNote: `We study ${t.toLowerCase()} using ${pick(WORDS)} methods. ` + "Lorem ipsum dolor sit amet. ".repeat(4),
		publicationTitle: pub ?? undefined, DOI: `10.1000/zn.${i}`, url: rnd() < 0.5 ? `https://example.org/paper/${i}` : undefined,
		dateAdded: added, dateModified: added,
	};
	recs.set(k, {
		data, collections: colls, tags: itemTags, children, trashed: i % 400 === 0,
		sortCreator: summaryCreators.toLowerCase(), sortTitle: t.toLowerCase(),
		text: (t + " " + summaryCreators + " " + year).toLowerCase(),
		summary: {
			key: k, itemType: "journalArticle", title: t, creatorsSummary: summaryCreators, year, publication: pub, dateAdded: added,
			primaryAttachment: hasPdf ? { key: children[0], contentType: "application/pdf" } : null,
			attachmentCount: hasPdf ? 1 : 0, noteCount,
		},
	});
}
const all = [...recs.values()];

function recount() {
	for (const c of collections.values()) c.itemCount = 0;
	for (const r of all) if (!r.trashed) for (const c of r.collections) { const x = collections.get(c); if (x) x.itemCount++; }
}
recount();

// ---- helpers -------------------------------------------------------------
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, error: string) => json({ error }, status);
const sortCache = new Map<string, Rec[]>();
const sorted = (sort: string, dir: string) => {
	const ck = sort + dir;
	let a = sortCache.get(ck);
	if (!a) {
		const f: Record<string, (r: Rec) => string | number> = {
			title: (r) => r.sortTitle, creator: (r) => r.sortCreator, year: (r) => r.summary.year ?? 0, dateAdded: (r) => r.summary.dateAdded,
		};
		const g = f[sort] ?? f.dateAdded;
		a = [...all].sort((x, y) => (g(x) < g(y) ? -1 : g(x) > g(y) ? 1 : 0));
		if (dir === "desc") a.reverse();
		sortCache.set(ck, a);
	}
	return a;
};
const detail = (r: Rec): ItemDetail => ({
	data: { ...r.data, collections: [...r.collections], tags: [...r.tags].map((tag) => ({ tag })) },
	children: r.children.map((ck): ChildSummary => {
		const c = childRecs.get(ck)!;
		return { key: ck, itemType: c.itemType as "attachment" | "note", title: c.title ?? "", contentType: c.contentType ?? null, linkMode: c.linkMode ?? null, hasFile: c.hasFile, annotationCount: annotations.get(ck)?.length ?? c.annotations };
	}),
	collections: [...r.collections],
	tags: [...r.tags].sort().map((tag) => ({ tag, type: 0 })),
});
const refresh = (r: Rec) => {
	const d = r.data;
	const m = d.date?.match(/\b(\d{4})\b/);
	r.summary.title = d.title ?? "";
	r.summary.year = m ? +m[1] : null;
	r.summary.publication = d.publicationTitle ?? null;
	r.sortTitle = (d.title ?? "").toLowerCase();
	r.text = `${d.title} ${r.summary.creatorsSummary} ${r.summary.year}`.toLowerCase();
	sortCache.clear();
};

// ---- API -----------------------------------------------------------------
async function api(req: Request, url: URL): Promise<Response> {
	const p = url.pathname.slice(4).split("/").filter(Boolean); // after /api
	const m = req.method;
	const body = async () => (await req.json().catch(() => ({}))) as any;
	await new Promise((r) => setTimeout(r, 15)); // light latency

	if (p[0] === "collections") {
		if (p.length === 1 && m === "GET") return json([...collections.values()]);
		if (p.length === 1 && m === "POST") {
			const b = await body();
			if (!b.name) return fail(400, "name required");
			const c: Collection = { key: key(), name: b.name, parentKey: b.parentKey ?? null, itemCount: 0 };
			collections.set(c.key, c);
			return json(c);
		}
		const c = collections.get(p[1]);
		if (!c) return fail(404, "no such collection");
		if (p.length === 2 && m === "PATCH") {
			const b = await body();
			if (b.name !== undefined) c.name = b.name;
			if (b.parentKey !== undefined) c.parentKey = b.parentKey;
			return json(c);
		}
		if (p.length === 2 && m === "DELETE") {
			collections.delete(c.key);
			for (const x of collections.values()) if (x.parentKey === c.key) x.parentKey = c.parentKey;
			for (const r of all) r.collections.delete(c.key);
			return json({ ok: true });
		}
		if (p[2] === "items") {
			const b = await body();
			for (const k of (b.keys ?? []) as string[]) {
				const r = recs.get(k);
				if (r) m === "POST" ? r.collections.add(c.key) : r.collections.delete(c.key);
			}
			recount();
			return json({ ok: true });
		}
	}
	if (p[0] === "items") {
		if (p.length === 1 && m === "GET") {
			const s = url.searchParams;
			const col = s.get("collection"), tag = s.get("tag"), q = s.get("q")?.toLowerCase();
			const trash = s.get("trash") === "1", unfiled = s.get("unfiled") === "1";
			const limit = Math.min(Number(s.get("limit") ?? 100), 500), offset = Number(s.get("offset") ?? 0);
			const rows = sorted(s.get("sort") ?? "dateAdded", s.get("dir") ?? "desc").filter(
				(r) => r.trashed === trash && (!col || r.collections.has(col)) && (!unfiled || r.collections.size === 0) &&
					(!tag || r.tags.has(tag)) && (!q || q.split(/\s+/).every((w) => r.text.includes(w))),
			);
			return json({ total: rows.length, items: rows.slice(offset, offset + limit).map((r) => r.summary) });
		}
		const r = recs.get(p[1]) ;
		const child = childRecs.get(p[1]);
		if (!r && child && p.length === 2 && m === "GET") return json({ data: child, children: [], collections: [], tags: [] } satisfies ItemDetail);
		if (!r) return fail(404, "no such item");
		if (p.length === 2 && m === "GET") return json(detail(r));
		if (p.length === 2 && m === "PATCH") {
			const b = await body();
			if (b.data && "deleted" in b.data) { r.trashed = !!b.data.deleted; delete b.data.deleted; recount(); }
			Object.assign(r.data, b.data ?? {});
			refresh(r);
			return json(detail(r));
		}
		if (p[2] === "tags") {
			const b = await body();
			for (const t of (b.tags ?? []) as string[]) m === "POST" ? r.tags.add(t) : r.tags.delete(t);
			return json({ ok: true });
		}
	}
	if (p[0] === "tags" && m === "GET") {
		const counts = new Map<string, number>();
		for (const r of all) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		return json([...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count));
	}
	if (p[0] === "attachments") {
		const k = p[1];
		if (p[2] === "file") return new Response("%PDF-1.4\n% mock\n", { headers: { "Content-Type": "application/pdf" } });
		if (p[2] === "annotations") {
			const list = annotations.get(k) ?? [];
			if (m === "GET") return json(list);
			const b = await body();
			if (m === "PUT") {
				const byId = new Map(list.map((a) => [a.id, a]));
				for (const a of b as ReaderAnnotation[]) byId.set(a.id, a);
				annotations.set(k, [...byId.values()]);
			} else annotations.set(k, list.filter((a) => !(b.ids ?? []).includes(a.id)));
			return json({ ok: true });
		}
		if (p[2] === "view-state") {
			if (m === "GET") return json(viewStates.get(k) ?? null);
			viewStates.set(k, await body());
			return json({ ok: true });
		}
	}
	if (p[0] === "search" && m === "GET") {
		const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
		const limit = Number(url.searchParams.get("limit") ?? 50), offset = Number(url.searchParams.get("offset") ?? 0);
		if (!q) return json({ total: 0, hits: [] });
		const words = q.split(/\s+/);
		const matches = all.filter((r) => !r.trashed && words.every((w) => r.text.includes(w) || r.data.abstractNote!.toLowerCase().includes(w)));
		const hits: SearchHit[] = matches.slice(offset, offset + limit).map((r, i) => {
			const abs = r.data.abstractNote ?? "";
			const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
			let snip = esc(abs.slice(0, 120));
			for (const w of words) snip = snip.replace(new RegExp(`(${w.replace(/[^a-z0-9]/g, "")})`, "ig"), "<mark>$1</mark>");
			snip += ' <img src=x onerror="alert(1)"><script>alert(2)</script>';
			return { key: r.data.key, title: r.summary.title, creatorsSummary: r.summary.creatorsSummary, year: r.summary.year, snippet: snip, matchedIn: ["metadata", "fulltext"], rank: i };
		});
		return json({ total: matches.length, hits });
	}
	return fail(404, "not found");
}

// ---- static --------------------------------------------------------------
const READER_STUB = `<!doctype html><meta charset=utf-8><title>reader stub</title><body style="font:14px system-ui;padding:2rem"><h2>reader-host stub</h2><p id=a></p><script>a.textContent="attachment=" + new URLSearchParams(location.search).get("attachment")</script>`;

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		try {
			if (url.pathname.startsWith("/api/")) return await api(req, url);
			if (url.pathname === "/reader-host/index.html") return new Response(READER_STUB, { headers: { "Content-Type": "text/html" } });
			if (url.pathname === "/" ) return Response.redirect("/app/", 302);
			if (url.pathname.startsWith("/app")) {
				let rel = url.pathname.slice(4).replace(/^\/+/, "") || "index.html";
				if (rel.includes("..")) return fail(400, "bad path");
				const f = Bun.file(join(DIST, rel));
				return (await f.exists()) ? new Response(f) : fail(404, "not found");
			}
		} catch (e) {
			return fail(500, (e as Error).message);
		}
		return fail(404, "not found");
	},
});
console.log(`mock core on http://127.0.0.1:${PORT}/app/  (${all.length} items, ${collections.size} collections)`);
