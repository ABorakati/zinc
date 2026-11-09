// Zinc corpus: about 50 independent CSL styles x {bibliography, citation} over the hand-written items in zinc-items.json.
// Styles are cached in <CACHE_DIR>/styles (pass --update to re-download); the corpus is written to <CACHE_DIR>/corpus/zinc.jsonl.
// Run: bun tools/csl-parity/corpus/zinc.ts [--update]

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, type Cluster, type ClusterItem, type CslItem, type Job } from "../types.ts";

const RAW = "https://raw.githubusercontent.com/citation-style-language/styles/master";

const STYLES = [
	"apa",
	"modern-language-association",
	"chicago-author-date",
	"chicago-note-bibliography",
	"harvard-cite-them-right",
	"ieee",
	"american-medical-association",
	"nature",
	"science",
	"cell",
	"the-lancet",
	"bmj",
	"new-england-journal-of-medicine",
	"elsevier-harvard",
	"elsevier-with-titles",
	"elsevier-vancouver",
	"springer-basic-author-date",
	"springer-vancouver-brackets",
	"taylor-and-francis-chicago-author-date",
	"apa-6th-edition",
	"american-chemical-society",
	"american-sociological-association",
	"american-political-science-association",
	"american-anthropological-association",
	"iso690-author-date-en",
	"deutsche-gesellschaft-fur-psychologie",
	"cambridge-university-press-author-date",
	"annual-reviews",
	"plos",
	"frontiers",
	"bmc-medicine",
	"journal-of-the-american-college-of-surgeons",
	"annals-of-surgery",
	"british-journal-of-surgery",
	"council-of-science-editors",
	"national-library-of-medicine",
	"american-institute-of-physics",
	"royal-society-of-chemistry",
	"multidisciplinary-digital-publishing-institute",
	"oscola",
	"bluebook-law-review",
	"the-journal-of-clinical-investigation",
	"angewandte-chemie",
];

/** Tried in order when the listed name 404s. */
const FALLBACKS: Record<string, string[]> = {
	"bmc-medicine": ["biomed-central"],
	"chicago-note-bibliography": ["chicago-notes-bibliography"],
	"new-england-journal-of-medicine": ["the-new-england-journal-of-medicine"],
	"council-of-science-editors": ["taylor-and-francis-council-of-science-editors-author-date"],
	"national-library-of-medicine": ["nlm-citation-sequence"],
};

/** The 31 citation clusters, in document order. Note styles get noteIndex = position + 1. */
const CLUSTERS: ClusterItem[][] = [
	[{ id: "zinc-jour-1" }],
	[{ id: "zinc-jour-2", locator: "45", label: "page" }],
	[{ id: "zinc-jour-3", prefix: "see also ", suffix: ", p. 2" }],
	[{ id: "zinc-jour-1", "suppress-author": true }],
	[{ id: "zinc-jour-6" }, { id: "zinc-jour-25" }],
	[{ id: "zinc-book-1", locator: "12", label: "chapter" }],
	[{ id: "zinc-jour-2" }],
	[{ id: "zinc-chap-1", locator: "3", label: "section" }],
	[{ id: "zinc-conf-1" }, { id: "zinc-thesis-1" }],
	[{ id: "zinc-report-1", locator: "7", label: "section" }],
	[{ id: "zinc-web-1" }],
	[{ id: "zinc-news-1" }],
	[{ id: "zinc-jour-1", locator: "128", label: "page" }],
	[{ id: "zinc-data-1" }, { id: "zinc-pre-1" }],
	[{ id: "zinc-pat-1" }],
	[{ id: "zinc-case-1", locator: "4", label: "paragraph" }],
	[{ id: "zinc-stat-1", locator: "5", label: "section" }],
	[{ id: "zinc-film-1" }],
	[{ id: "zinc-nodate-1" }],
	[{ id: "zinc-range-1" }, { id: "zinc-season-1" }],
	[{ id: "zinc-ital-1" }],
	[{ id: "zinc-part-1" }, { id: "zinc-part-2" }, { id: "zinc-part-3" }],
	[{ id: "zinc-orig-1", prefix: "cf. ", suffix: "; " }],
	[{ id: "zinc-jour-2" }, { id: "zinc-pair-a2" }],
	[{ id: "zinc-gn-1" }, { id: "zinc-gn-2" }],
	[{ id: "zinc-report-1" }, { id: "zinc-web-2" }],
	[{ id: "zinc-jour-3", "author-only": true }],
	[{ id: "zinc-jour-1", locator: "2" }, { id: "zinc-jour-2" }, { id: "zinc-jour-3" }],
	[{ id: "zinc-jour-25", suffix: ", passim" }],
	[{ id: "zinc-jour-6" }, { id: "zinc-book-1" }, { id: "zinc-web-1" }, { id: "zinc-pair-b1" }, { id: "zinc-pair-b2" }],
	[{ id: "zinc-uni-1" }, { id: "zinc-uni-2" }, { id: "zinc-uni-3" }],
];

async function get(name: string): Promise<string> {
	const res = await fetch(`${RAW}/${name}.csl`, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

/** Dependent styles point at their parent with <link rel="independent-parent">; engines need the parent's XML. */
async function fetchIndependent(name: string): Promise<{ xml: string; resolvedFrom?: string }> {
	const xml = await get(name);
	const link = xml.match(/<link\b[^>]*independent-parent[^>]*>/)?.[0];
	if (!link) return { xml };
	const href = link.match(/href="([^"]+)"/)?.[1];
	const parent = href?.split("/").filter(Boolean).pop();
	if (!parent) throw new Error(`dependent style ${name} has no parent href`);
	return { xml: await get(parent), resolvedFrom: `${name} -> ${parent} (dependent, parent used)` };
}

const update = process.argv.includes("--update");
const stylesDir = join(CACHE_DIR, "styles");
await mkdir(stylesDir, { recursive: true });

const styles = new Map<string, string>();
const downloaded: string[] = [];
const skipped: string[] = [];
const resolved: string[] = [];
const failed: string[] = [];

for (const name of STYLES) {
	const path = join(stylesDir, `${name}.csl`);
	const file = Bun.file(path);
	if (!update && (await file.exists())) {
		styles.set(name, await file.text());
		skipped.push(name);
		continue;
	}
	let got: { xml: string; resolvedFrom?: string } | undefined;
	let lastError = "";
	for (const candidate of [name, ...(FALLBACKS[name] ?? [])]) {
		try {
			got = await fetchIndependent(candidate);
			if (candidate !== name) resolved.push(`${name} -> ${candidate} (fallback name)`);
			break;
		} catch (error) {
			lastError = String(error);
		}
	}
	if (!got) {
		failed.push(`${name} (${lastError})`);
		continue;
	}
	await Bun.write(path, got.xml);
	styles.set(name, got.xml);
	downloaded.push(name);
	if (got.resolvedFrom) resolved.push(got.resolvedFrom);
}

const items = JSON.parse(await Bun.file(join(import.meta.dir, "zinc-items.json")).text()) as CslItem[];
const itemIds = new Set(items.map((item) => item.id));
if (itemIds.size !== items.length) throw new Error("duplicate item ids in zinc-items.json");
for (const cluster of CLUSTERS) {
	for (const cited of cluster) {
		if (!itemIds.has(cited.id)) throw new Error(`cluster references unknown item ${cited.id}`);
	}
}
const allIds = items.map((item) => item.id);

const jobs: Job[] = [];
for (const [name, xml] of styles) {
	const isNote = /<style\b[^>]*\bclass="note"/.test(xml);
	jobs.push({
		id: `zinc/${name}/bibliography`,
		corpus: "zinc",
		style: xml,
		mode: "bibliography",
		items,
		uncited: allIds,
		format: "html",
		tags: [name, "bibliography"],
	});
	const clusters: Cluster[] = CLUSTERS.map((cited, index) => ({
		id: `c${index + 1}`,
		noteIndex: isNote ? index + 1 : 0,
		items: cited,
	}));
	jobs.push({
		id: `zinc/${name}/citation`,
		corpus: "zinc",
		style: xml,
		mode: "citation",
		items,
		clusters,
		format: "html",
		tags: [name, "citation"],
	});
}

const corpusDir = join(CACHE_DIR, "corpus");
await mkdir(corpusDir, { recursive: true });
const out = join(corpusDir, "zinc.jsonl");
await Bun.write(out, `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`);

console.log(`styles: ${styles.size} available (${downloaded.length} downloaded, ${skipped.length} cached), ${failed.length} failed of ${STYLES.length} listed`);
for (const line of failed) console.log(`  failed: ${line}`);
for (const line of resolved) console.log(`  resolved: ${line}`);
console.log(`items: ${items.length}`);
console.log(`jobs: ${jobs.length} (${styles.size} bibliography + ${styles.size} citation)`);
console.log(`wrote: ${out}`);
