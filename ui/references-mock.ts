// Mock server for the References panel and the reader-host citation popups.
//   bun ui/references-mock.ts          (port 23129, or MOCK_PORT)
//   panel:  http://127.0.0.1:23129/app/dev.html?key=TEST   (TEST | EMPTY | FAIL | SLOW | BIG)
//   reader: http://127.0.0.1:23129/reader-host/?attachment=TEST   (vendor/reader/demo/pdf/demo.pdf)
//   log:    GET /__log (every mutating call: add, open-url, annotations ...), POST /__reset
// Build the panel first:  cd ui && bun --bun x vite build --config src/references/vite.config.ts
import { join, normalize, resolve } from "node:path";
import type { Reference, ReferenceDetail } from "../core/src/api-types";

const HERE = import.meta.dir;
const PANEL_DIST = join(HERE, "dist-references");
const READER_DIST = resolve(HERE, "../reader-host/dist");
const SAMPLE_PDF = resolve(HERE, "../vendor/reader/demo/pdf/demo.pdf");
const PORT = Number(process.env.MOCK_PORT ?? 23129);

// The first 19 are the demo PDF's real bibliography (TraceMonkey paper), so citations in the
// reader resolve; the rest pad the list to a realistic size.
type Seed = [title: string | null, authors: string[], year: number, venue: string, doi?: string, raw?: string];
const SEEDS: Seed[] = [
	[null, [], 2008, "", undefined, "LuaJIT roadmap 2008 - http://lua-users.org/lists/lua-l/200802/msg00051.html."],
	[null, [], 2008, "", undefined, "Mozilla -- Firefox web browser and Thunderbird email client http://www.mozilla.com."],
	[null, [], 1998, "", undefined, "SPECJVM98 - http://www.spec.org/jvm98/."],
	[null, [], 2008, "", undefined, "SpiderMonkey (JavaScript-C) Engine - http://www.mozilla.org/js/spidermonkey/."],
	["Announcing SquirrelFish Extreme", ["Stachowiak M"], 2008, "Surfin' Safari blog", undefined],
	["Compilers: Principles, Techniques, and Tools", ["Aho A", "Sethi R", "Ullman J", "Lam M"], 2006, "Addison-Wesley"],
	["Dynamo: A transparent dynamic optimization system", ["Bala V", "Duesterwald E", "Banerjia S"], 2000, "PLDI", "10.1145/349299.349303"],
	["Context Threading: a Flexible and Efficient Dispatch Technique for Virtual Machine Interpreters", ["Berndl M", "Vitale B", "Zaleski M", "Brown A"], 2005, "CGO", "10.1109/CGO.2005.14"],
	["Customization: Optimizing Compiler Technology for SELF, a Dynamically-Typed Object-Oriented Programming Language", ["Chambers C", "Ungar D"], 1989, "PLDI", "10.1145/73141.74831"],
	["Efficient Bytecode Verification and Compilation in a Virtual Machine", ["Gal A"], 2006, "PhD thesis, University of California, Irvine"],
	["HotpathVM: An effective JIT compiler for resource-constrained devices", ["Gal A", "Probst C", "Franz M"], 2006, "VEE", "10.1145/1134760.1134780"],
	["Measurement and Application of Dynamic Receiver Class Distributions", ["Garrett C", "Dean J", "Grove D", "Chambers C"], 1994, "Technical report"],
	["A concurrent trace-based just-in-time compiler for JavaScript", ["Ha J", "Haghighat M", "Cong S", "McKinley K"], 2009, "UT Austin TR-09-06"],
	[null, ["McCloskey B"], 2008, "", undefined, "B. McCloskey. Personal communication."],
	["Optimizing direct threaded code by selective inlining", ["Piumarta I", "Riccardi F"], 1998, "PLDI", "10.1145/277650.277743"],
	["Representation-Based Just-In-Time Specialization and the Psyco Prototype for Python", ["Rigo A"], 2004, "PEPM", "10.1145/1014007.1014010"],
	["Starkiller: A Static Type Inferencer and Compiler for Python", ["Salib M"], 2004, "Master's thesis, MIT"],
	["A Region-Based Compilation Technique for Dynamic Compilers", ["Suganuma T", "Yasue T", "Nakatani T"], 2006, "ACM TOPLAS", "10.1145/1111596.1111599"],
	["YETI: A graduallY Extensible Trace Interpreter", ["Zaleski M", "Brown A", "Stoodley K"], 2007, "VEE", "10.1145/1254810.1254821"],
	["Attention is all you need", ["Vaswani A", "Shazeer N", "Parmar N"], 2017, "NeurIPS", "10.48550/arXiv.1706.03762"],
	["Deep residual learning for image recognition", ["He K", "Zhang X", "Ren S", "Sun J"], 2016, "CVPR", "10.1109/CVPR.2016.90"],
	["BERT: Pre-training of deep bidirectional transformers for language understanding", ["Devlin J", "Chang M", "Lee K", "Toutanova K"], 2019, "NAACL", "10.18653/v1/N19-1423"],
	["Adam: A method for stochastic optimization", ["Kingma D", "Ba J"], 2015, "ICLR", "10.48550/arXiv.1412.6980"],
	["Dropout: a simple way to prevent neural networks from overfitting", ["Srivastava N", "Hinton G", "Krizhevsky A"], 2014, "JMLR"],
	["Highly accurate protein structure prediction with AlphaFold", ["Jumper J", "Evans R", "Pritzel A"], 2021, "Nature", "10.1038/s41586-021-03819-2"],
	["Mastering the game of Go with deep neural networks and tree search", ["Silver D", "Huang A", "Maddison C"], 2016, "Nature", "10.1038/nature16961"],
	["The PRISMA 2020 statement: an updated guideline for reporting systematic reviews", ["Page M", "McKenzie J", "Bossuyt P"], 2021, "BMJ", "10.1136/bmj.n71"],
	["Random forests", ["Breiman L"], 2001, "Machine Learning", "10.1023/A:1010933404324"],
	["Language models are few-shot learners", ["Brown T", "Mann B", "Ryder N"], 2020, "NeurIPS", "10.48550/arXiv.2005.14165"],
	["ImageNet classification with deep convolutional neural networks", ["Krizhevsky A", "Sutskever I", "Hinton G"], 2012, "NeurIPS", "10.1145/3065386"],
	["Generative adversarial nets", ["Goodfellow I", "Pouget-Abadie J", "Mirza M"], 2014, "NeurIPS", "10.1145/3422622"],
	["Reproducibility in machine learning for health research", ["McDermott M", "Wang S", "Marinsek N"], 2021, "Science Translational Medicine", "10.1126/scitranslmed.abb1655"],
	["A survey of clinical natural language processing", ["Wang Y", "Wang L", "Rastegar-Mojarad M"], 2018, "J Biomed Inform", "10.1016/j.jbi.2017.11.011"],
	["The FAIR Guiding Principles for scientific data management and stewardship", ["Wilkinson M", "Dumontier M", "Aalbersberg I"], 2016, "Scientific Data", "10.1038/sdata.2016.18"],
	["OMOP common data model for observational health research", ["Hripcsak G", "Duke J", "Shah N"], 2015, "Stud Health Technol Inform", "10.3233/978-1-61499-564-7-574"],
	["Retrieval-augmented generation for knowledge-intensive NLP tasks", ["Lewis P", "Perez E", "Piktus A"], 2020, "NeurIPS", "10.48550/arXiv.2005.11401"],
	["Scaling laws for neural language models", ["Kaplan J", "McCandlish S", "Henighan T"], 2020, "arXiv", "10.48550/arXiv.2001.08361"],
	["An image is worth 16x16 words: transformers for image recognition at scale", ["Dosovitskiy A", "Beyer L", "Kolesnikov A"], 2021, "ICLR", "10.48550/arXiv.2010.11929"],
	["BioBERT: a pre-trained biomedical language representation model", ["Lee J", "Yoon W", "Kim S"], 2020, "Bioinformatics", "10.1093/bioinformatics/btz682"],
	["Sentence-BERT: sentence embeddings using Siamese BERT-networks", ["Reimers N", "Gurevych I"], 2019, "EMNLP", "10.18653/v1/D19-1410"],
	["Approximate nearest neighbor search on high dimensional data", ["Li W", "Zhang Y", "Sun Y"], 2020, "IEEE TKDE", "10.1109/TKDE.2019.2909204"],
	["Efficient and robust approximate nearest neighbor search using HNSW graphs", ["Malkov Y", "Yashunin D"], 2020, "IEEE TPAMI", "10.1109/TPAMI.2018.2889473"],
	["Billion-scale similarity search with GPUs", ["Johnson J", "Douze M", "Jegou H"], 2021, "IEEE Trans Big Data", "10.1109/TBDATA.2019.2921572"],
	["Dense passage retrieval for open-domain question answering", ["Karpukhin V", "Oguz B", "Min S"], 2020, "EMNLP", "10.18653/v1/2020.emnlp-main.550"],
	["Gender differences in citation of scientific literature", ["Dworkin J", "Linn K", "Teich E"], 2020, "Nature Neuroscience", "10.1038/s41593-020-0658-y"],
	["Estimating the reproducibility of psychological science", ["Open Science Collaboration"], 2015, "Science", "10.1126/science.aac4716"],
	["The Zotero reader and the case for open reference management", ["Stillman D", "Rosenau M"], 2019, "Journal of Open Source Software"],
	["Why most published research findings are false", ["Ioannidis J"], 2005, "PLoS Medicine", "10.1371/journal.pmed.0020124"],
	["A comparison of DuckDB and SQLite for analytical workloads", ["Raasveldt M", "Muhleisen H"], 2019, "SIGMOD", "10.1145/3299869.3320212"],
	["Vector databases: a survey of storage and indexing strategies", ["Pan J", "Wang J", "Li G"], 2024, "The VLDB Journal", "10.1007/s00778-024-00851-w"],
	["Open access publishing and the impact of preprints on citation counts", ["Fraser N", "Momeni F", "Mayr P"], 2020, "Quantitative Science Studies", "10.1162/qss_a_00123"],
	["Diagnostic accuracy of large language models in clinical decision support", ["Singhal K", "Azizi S", "Tu T"], 2023, "Nature", "10.1038/s41586-023-06291-2"],
	["Federated learning for healthcare informatics", ["Xu J", "Glicksberg B", "Su C"], 2021, "Journal of Healthcare Informatics Research", "10.1007/s41666-020-00082-4"],
	["Ten simple rules for reproducible computational research", ["Sandve G", "Nekrutenko A", "Taylor J", "Hovig E"], 2013, "PLoS Computational Biology", "10.1371/journal.pcbi.1003285"],
	["Quality of reporting of machine learning prediction models in surgery", ["Borakati A", "Smith J", "Lee C"], 2022, "British Journal of Surgery", "10.1093/bjs/znac123"],
	["Clinical prediction models: a practical approach to development, validation and updating", ["Steyerberg E"], 2019, "Springer"],
	["Missing data in electronic health records: a review of imputation methods", ["Wells B", "Chagin K", "Nowacki A", "Kattan M"], 2013, "eGEMs", "10.13063/2327-9214.1007"],
	["Transparent reporting of a multivariable prediction model (TRIPOD)", ["Collins G", "Reitsma J", "Altman D", "Moons K"], 2015, "Annals of Internal Medicine", "10.7326/M14-0697"],
	["An overview of Crossref and OpenAlex as sources of bibliographic metadata", ["Delgado-Quirós L", "Ortega J"], 2024, "Scientometrics", "10.1007/s11192-024-04970-7"],
];

const LIBRARY_KEYS: Record<number, string> = { 7: "LIB00007", 11: "LIB00011", 18: "LIB00018", 21: "LIB00021", 27: "LIB00027", 33: "LIB00033", 44: "LIB00044" };
const OA_URLS: Record<number, string> = { 11: "https://example.org/hotpathvm.pdf", 20: "https://arxiv.org/pdf/1706.03762", 22: "https://arxiv.org/pdf/1810.04805", 38: "https://arxiv.org/pdf/2001.08361", 40: "https://arxiv.org/pdf/2010.11929", 8: "https://example.org/context-threading.pdf" };

function buildRefs(n = SEEDS.length): Reference[] {
	return Array.from({ length: n }, (_, i) => {
		const s = SEEDS[i % SEEDS.length]!;
		const index = i + 1;
		const [title, authors, year, venue, doi, raw] = s;
		const beyond = i >= SEEDS.length; // BIG mode repeats the list with distinct DOIs
		return {
			index,
			raw: raw ?? (authors.length && title ? `${authors.join(", ")}. ${title}. ${venue}, ${year}.` : undefined),
			doi: doi && beyond ? doi + "." + index : doi,
			title: title ?? undefined,
			authors: authors.length ? authors : undefined,
			year,
			venue: venue || undefined,
			url: doi ? `https://doi.org/${doi}` : raw?.match(/https?:\/\/\S+?(?=\.?$|\s)/)?.[0],
			openAccessUrl: OA_URLS[i + 1],
			citedByCount: doi ? 20 + ((index * 977) % 9000) : undefined,
			inLibraryKey: beyond ? undefined : LIBRARY_KEYS[index],
		} satisfies Reference;
	});
}

const state = {
	log: [] as { method: string; path: string; body?: unknown; at: number }[],
	added: new Map<string, string>(), // doi/title -> key
	annotations: new Map<string, any>(),
	viewState: null as any,
};
let nextKey = 1;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abstractFor(r: Reference) {
	if (!r.title) return undefined;
	return `${r.title}. This work ${r.year && r.year < 2005 ? "introduces an early approach to" : "presents a modern treatment of"} the problem studied by ${r.authors?.[0] ?? "the authors"} and colleagues, evaluating the method on standard benchmarks and discussing limitations and directions for future work. We describe the design, report quantitative results across several datasets, and release the artefacts needed to reproduce every table and figure in the paper.`;
}

const collections = [
	{ key: "COLL0001", name: "Compilers", parentKey: null, itemCount: 12 },
	{ key: "COLL0002", name: "Tracing JIT", parentKey: "COLL0001", itemCount: 4 },
	{ key: "COLL0003", name: "Machine learning", parentKey: null, itemCount: 31 },
	{ key: "COLL0004", name: "To read", parentKey: null, itemCount: 7 },
];

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;
		const m = req.method;
		const record = (body?: unknown) => {
			state.log.push({ method: m, path: p + url.search, body, at: Date.now() });
			console.log(m, p, body ? JSON.stringify(body).slice(0, 160) : "");
		};

		if (p === "/__log") return json(state.log);
		if (p === "/__msg" && m === "POST") { record(await req.json()); return json({ ok: true }); }
		// Shell stand-in: the reader inside an iframe, its postMessage()s forwarded to the log.
		if (p === "/reader-shell") {
			return new Response(
				`<!doctype html><body style="margin:0"><iframe src="/reader-host/?attachment=TEST" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe><script>
addEventListener("message", e => { if (e.data && e.data.type !== "reader-ready") fetch("/__msg", {method:"POST", body: JSON.stringify({parentGot: e.data})}); });
</script>`,
				{ headers: { "Content-Type": "text/html" } },
			);
		}
		if (p === "/__reset") { state.log.length = 0; state.added.clear(); return json({ ok: true }); }

		// ---- static ----
		const serve = async (root: string, rel: string) => {
			const file = normalize(join(root, rel));
			if (!file.startsWith(root)) return new Response("forbidden", { status: 403 });
			const f = Bun.file(file);
			if (!(await f.exists())) return new Response("not found", { status: 404 });
			return new Response(f, { headers: { "Cache-Control": "no-cache" } });
		};
		if (p.startsWith("/app/")) return serve(join(PANEL_DIST, "src/references"), decodeURIComponent(p.slice(5)) || "dev.html");
		if (p.startsWith("/assets/")) return serve(PANEL_DIST, decodeURIComponent(p.slice(1)));
		if (p.startsWith("/reader-host/")) return serve(READER_DIST, decodeURIComponent(p.slice("/reader-host/".length)) || "index.html");

		// ---- references ----
		if (p === "/api/references/lookup" && m === "GET") {
			await sleep(250);
			const doi = url.searchParams.get("doi")?.toLowerCase();
			const title = url.searchParams.get("title")?.toLowerCase();
			const hit = buildRefs(SEEDS.length).find((r) => (doi && r.doi?.toLowerCase() === doi) || (title && r.title?.toLowerCase() === title));
			if (!hit) return json({ error: "not found" }, 404);
			const detail: ReferenceDetail = {
				...hit,
				abstract: abstractFor(hit),
				referenceCount: 12 + ((hit.index * 31) % 90),
				citedByCount: hit.citedByCount ?? 40 + hit.index * 13,
				type: hit.venue?.match(/thesis|Springer|Addison/i) ? "book" : "journal-article",
			};
			return json(detail);
		}
		const refs = p.match(/^\/api\/references\/([^/]+)$/);
		if (refs && m === "GET") {
			const key = decodeURIComponent(refs[1]!);
			const list = (references: Reference[], source = "openalex") => json({ itemKey: key, source, fetchedAt: new Date().toISOString(), references });
			if (key === "FAIL") return json({ error: "OpenAlex responded 503 (service unavailable)" }, 502);
			if (key === "EMPTY") return list([], "pdf");
			if (key === "SLOW") { await sleep(2500); return list(buildRefs()); }
			if (key === "BIG") return list(buildRefs(150));
			await sleep(url.searchParams.has("refresh") ? 600 : 150);
			return list(buildRefs());
		}
		if (p === "/api/references/add" && m === "POST") {
			const body = (await req.json()) as { doi?: string; reference?: Reference; collectionKey?: string; findFullText?: boolean };
			record(body);
			await sleep(400);
			const id = (body.doi ?? body.reference?.title ?? "").toLowerCase();
			if (body.reference?.inLibraryKey || (body.doi && /\.dup$/.test(body.doi))) return json({ error: "already in library", key: body.reference?.inLibraryKey ?? "LIBDUP01" }, 409);
			const key = state.added.get(id) ?? `NEW${String(nextKey++).padStart(5, "0")}`;
			state.added.set(id, key);
			return json({ data: { key, itemType: "journalArticle", title: body.reference?.title ?? body.doi }, children: [], collections: body.collectionKey ? [body.collectionKey] : [], tags: [] });
		}
		if (p === "/api/open-url" && m === "POST") { record(await req.json()); return json({ ok: true }); }
		if (p === "/api/collections" && m === "GET") return json(collections);

		// ---- reader-host support ----
		const att = p.match(/^\/api\/attachments\/([^/]+)\/(file|annotations|view-state)$/);
		if (att) {
			const what = att[2];
			if (what === "file" && m === "GET") return new Response(Bun.file(SAMPLE_PDF), { headers: { "Content-Type": "application/pdf" } });
			if (what === "annotations") {
				if (m === "GET") return json([...state.annotations.values()]);
				if (m === "PUT") { for (const a of (await req.json()) as any[]) state.annotations.set(a.id, a); return json({ ok: true }); }
				if (m === "DELETE") { for (const id of ((await req.json()) as any).ids) state.annotations.delete(id); return json({ ok: true }); }
			}
			if (what === "view-state") {
				if (m === "GET") return json(state.viewState);
				if (m === "PUT") { state.viewState = await req.json(); return json({ ok: true }); }
			}
		}
		const item = p.match(/^\/api\/items\/([^/]+)$/);
		if (item && m === "GET") {
			const key = item[1]!;
			const base = { children: [], collections: [], tags: [] };
			if (key === "PARENT") return json({ ...base, data: { key, itemType: "journalArticle", title: "Trace-based Just-in-Time Type Specialization for Dynamic Languages" } });
			return json({ ...base, data: { key, itemType: "attachment", title: "demo.pdf", parentItem: "PARENT", contentType: "application/pdf" } });
		}

		return json({ error: `not found: ${m} ${p}` }, 404);
	},
});
console.log(`references mock on http://127.0.0.1:${PORT}  (panel /app/dev.html?key=TEST, reader /reader-host/?attachment=TEST)`);
