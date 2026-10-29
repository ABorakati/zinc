// Item-pane test server. Reuses mock-api.ts (30k generated items, collections, tags) on an internal
// port and layers the Phase 3 routes the item pane needs on top: /api/schema, related items, child
// note creation/trash, reveal/open-external/open-url. Serves ui/dist-itempane on :23126.
//   bun --bun x vite build --outDir dist-itempane && bun itempane-mock.ts
import { join } from "node:path";
import type { ChildSummary, ItemDetail, ZoteroSchema, ZoteroSchemaItemType } from "../core/src/api-types";

const INNER = 23127;
process.env.PORT = String(INNER);
await import("./mock-api");

const PORT = Number(process.env.ITEMPANE_PORT ?? 23126);
const DIST = join(import.meta.dir, "dist-itempane");
const inner = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${INNER}${path}`, init);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

// ---- schema ---------------------------------------------------------------------
const L: Record<string, string> = {
	title: "Title", abstractNote: "Abstract", publicationTitle: "Publication", volume: "Volume", issue: "Issue", pages: "Pages",
	date: "Date", series: "Series", seriesTitle: "Series Title", seriesText: "Series Text", journalAbbreviation: "Journal Abbr",
	language: "Language", DOI: "DOI", ISSN: "ISSN", shortTitle: "Short Title", url: "URL", accessDate: "Accessed", archive: "Archive",
	archiveLocation: "Loc. in Archive", libraryCatalog: "Library Catalog", callNumber: "Call Number", rights: "Rights", extra: "Extra",
	bookTitle: "Book Title", publisher: "Publisher", place: "Place", edition: "Edition", numPages: "# of Pages", ISBN: "ISBN",
	numberOfVolumes: "# of Volumes", proceedingsTitle: "Proceedings Title", conferenceName: "Conference Name", institution: "Institution",
	reportNumber: "Report Number", reportType: "Report Type", university: "University", thesisType: "Type", websiteTitle: "Website Title",
	websiteType: "Website Type", repository: "Repository", archiveID: "Archive ID",
};
const f = (...names: string[]) => names.map((field) => ({ field, label: L[field] ?? field, ...(field === "bookTitle" ? { baseField: "publicationTitle" } : {}), ...(field === "proceedingsTitle" ? { baseField: "publicationTitle" } : {}), ...(field === "websiteTitle" ? { baseField: "publicationTitle" } : {}) }));
const tail = ["language", "shortTitle", "url", "accessDate", "archive", "archiveLocation", "libraryCatalog", "callNumber", "rights", "extra"];
const ct = (...xs: [string, string][]) => xs.map(([creatorType, label], i) => ({ creatorType, label, primary: i === 0 }));
const itemTypes: ZoteroSchemaItemType[] = [
	{ itemType: "journalArticle", label: "Journal Article", fields: f("title", "abstractNote", "publicationTitle", "volume", "issue", "pages", "date", "series", "seriesTitle", "seriesText", "journalAbbreviation", "DOI", "ISSN", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"], ["editor", "Editor"], ["translator", "Translator"], ["reviewedAuthor", "Reviewed Author"]) },
	{ itemType: "book", label: "Book", fields: f("title", "abstractNote", "series", "seriesNumber", "volume", "numberOfVolumes", "edition", "place", "publisher", "date", "numPages", "ISBN", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"], ["editor", "Editor"], ["translator", "Translator"], ["seriesEditor", "Series Editor"]) },
	{ itemType: "bookSection", label: "Book Section", fields: f("title", "abstractNote", "bookTitle", "series", "volume", "edition", "place", "publisher", "date", "pages", "ISBN", ...tail), creatorTypes: ct(["author", "Author"], ["bookAuthor", "Book Author"], ["contributor", "Contributor"], ["editor", "Editor"]) },
	{ itemType: "conferencePaper", label: "Conference Paper", fields: f("title", "abstractNote", "date", "proceedingsTitle", "conferenceName", "place", "publisher", "volume", "pages", "DOI", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"], ["editor", "Editor"]) },
	{ itemType: "report", label: "Report", fields: f("title", "abstractNote", "reportNumber", "reportType", "institution", "place", "date", "pages", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"]) },
	{ itemType: "thesis", label: "Thesis", fields: f("title", "abstractNote", "thesisType", "university", "place", "date", "numPages", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"]) },
	{ itemType: "webpage", label: "Web Page", fields: f("title", "abstractNote", "websiteTitle", "websiteType", "date", "shortTitle", "url", "accessDate", "language", "rights", "extra"), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"], ["translator", "Translator"]) },
	{ itemType: "preprint", label: "Preprint", fields: f("title", "abstractNote", "genre", "repository", "archiveID", "place", "date", "series", "seriesNumber", "DOI", ...tail), creatorTypes: ct(["author", "Author"], ["contributor", "Contributor"], ["editor", "Editor"]) },
];
const schema: ZoteroSchema = { version: 1, itemTypes, fieldLabels: L };

// ---- extra state layered on the base mock ---------------------------------------
const related = new Map<string, Set<string>>();
const createdNotes = new Map<string, { parent: string; html: string }>();
const trashedChildren = new Set<string>();
let seq = 0;
const noteKey = () => "NOTE" + String(++seq).padStart(4, "0");
const noteTitle = (html: string) => html.replace(/<[^>]*>/g, " ").trim().split(/\s{2,}|\n/)[0].slice(0, 80);

async function summary(k: string) {
	const d = (await (await inner(`/api/items/${k}`)).json()) as ItemDetail;
	return { key: k, itemType: d.data.itemType, title: d.data.title ?? "", creatorsSummary: (d.data.creators?.[0]?.lastName ?? "") + ((d.data.creators?.length ?? 0) > 1 ? " et al." : ""), year: Number(d.data.date?.match(/\d{4}/)?.[0]) || null };
}

async function augment(res: Response, key: string): Promise<Response> {
	if (!res.ok) return res;
	const d = (await res.json()) as ItemDetail;
	d.children = d.children.filter((c) => !trashedChildren.has(c.key));
	for (const [nk, n] of createdNotes) {
		if (n.parent === key && !trashedChildren.has(nk)) {
			d.children.push({ key: nk, itemType: "note", title: noteTitle(n.html) || "Untitled note", contentType: null, linkMode: null, hasFile: false, annotationCount: 0 } satisfies ChildSummary);
		}
	}
	// one missing-file attachment on every 5th item, to exercise that state
	if (/[AEIOU]$/.test(key) && !d.children.some((c) => c.title === "Supplement.pdf")) {
		d.children.push({ key: key + "_S", itemType: "attachment", title: "Supplement.pdf", contentType: "application/pdf", linkMode: "imported_file", hasFile: false, annotationCount: 0 });
	}
	d.related = await Promise.all([...(related.get(key) ?? [])].map(summary));
	d.data.relations = { "dc:relation": [...(related.get(key) ?? [])].map((k) => `http://zotero.org/users/local/items/${k}`) };
	// mark a tag automatic for demo
	if (d.tags.length) d.tags[0].type = 1;
	return json(d);
}

const log: string[] = [];

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;
		const m = req.method;
		try {
			if (p === "/__log") return json(log);
			if (p === "/api/schema") return json(schema);
			if (p === "/api/open-url" || /^\/api\/attachments\/[^/]+\/(reveal|open-external)$/.test(p)) {
				log.push(`${m} ${p} ${m === "POST" ? await req.text() : ""}`);
				return json({ ok: true });
			}
			let mm = p.match(/^\/api\/items\/([^/]+)\/related$/);
			if (mm) {
				const k = mm[1];
				const body = (await req.json()) as { keys: string[] };
				for (const o of body.keys) {
					for (const [a, b] of [[k, o], [o, k]]) {
						if (!related.has(a)) related.set(a, new Set());
						m === "POST" ? related.get(a)!.add(b) : related.get(a)!.delete(b);
					}
				}
				return augment(await inner(`/api/items/${k}`), k);
			}
			if (p === "/api/items" && m === "POST") {
				const body = (await req.json()) as { data: { itemType: string; parentItem: string; note?: string } };
				if (body.data.itemType !== "note") return json({ error: "mock: only notes" }, 400);
				const nk = noteKey();
				createdNotes.set(nk, { parent: body.data.parentItem, html: body.data.note ?? "" });
				return json({ data: { key: nk, itemType: "note", parentItem: body.data.parentItem, note: body.data.note }, children: [], collections: [], tags: [] });
			}
			mm = p.match(/^\/api\/items\/([^/]+)$/);
			if (mm && (m === "GET" || m === "PATCH")) {
				const k = mm[1];
				const init: RequestInit = m === "PATCH" ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: await req.text() } : {};
				const bodyText = typeof init.body === "string" ? init.body : "";
				if (m === "PATCH" && (createdNotes.has(k) || (/"deleted"/.test(bodyText) && k.length === 8 && !(await inner(`/api/items/${k}`)).ok))) {
					trashedChildren.add(k);
					return json({ data: { key: k }, children: [], collections: [], tags: [] });
				}
				if (m === "PATCH" && /"deleted"/.test(bodyText)) {
					// seeded child notes aren't top-level in the base mock
					const base = await inner(`/api/items/${k}`);
					if (base.ok) {
						const bd = (await base.json()) as ItemDetail;
						if (bd.data.itemType === "note") { trashedChildren.add(k); return json(bd); }
					}
				}
				const res = await inner(`/api/items/${k}`, init);
				return augment(res, k);
			}
			if (p.startsWith("/api/")) {
				const r = await inner(p + url.search, { method: m, headers: req.headers, body: m === "GET" ? undefined : await req.text() });
				return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
			}
			if (p === "/note-host/index.html") {
				return new Response(`<!doctype html><meta charset=utf-8><body style="font:13px system-ui;margin:0;padding:8px"><b>note-host stub</b><div id=a></div><script>a.textContent="note=" + new URLSearchParams(location.search).get("note")</script>`, { headers: { "Content-Type": "text/html" } });
			}
			let rel = p === "/" ? "index.html" : p.slice(1);
			if (rel.includes("..")) return json({ error: "bad path" }, 400);
			const file = Bun.file(join(DIST, rel));
			return (await file.exists()) ? new Response(file) : json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: (e as Error).message }, 500);
		}
	},
});
console.log(`item pane mock on http://127.0.0.1:${PORT}/`);
