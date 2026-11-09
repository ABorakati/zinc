import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// citeproc-js ships untyped CommonJS; the zotero-next core already depends on it.
// @ts-ignore
import CSL from "../../../core/node_modules/citeproc/citeproc_commonjs.js";
import { CACHE_DIR, type Cluster, type Engine, type Job, type Result } from "../types";

const CSL_ANY = CSL as any;
const WORD_DEMO_LOCALES = "C:/Users/abora/zotero-next/website/word-demo/locales";
const CLUSTER_ITEM_KEYS = ["locator", "label", "prefix", "suffix", "suppress-author", "author-only"] as const;

const localeCache = new Map<string, string>();

/** Locale XML for a language: cache, then word-demo, then en-US (cache, then word-demo). */
function loadLocale(lang: string): string {
	const cached = localeCache.get(lang);
	if (cached !== undefined) return cached;
	const candidates = [
		join(CACHE_DIR, "locales", `locales-${lang}.xml`),
		join(WORD_DEMO_LOCALES, `locales-${lang}.xml`),
		join(CACHE_DIR, "locales", "locales-en-US.xml"),
		join(WORD_DEMO_LOCALES, "locales-en-US.xml"),
	];
	for (const path of candidates) {
		if (existsSync(path)) {
			const xml = readFileSync(path, "utf8");
			localeCache.set(lang, xml);
			return xml;
		}
	}
	throw new Error(`no locale XML found for ${lang} (and no en-US fallback)`);
}

/** Collapse a multi-line string to one line, trimmed. */
function oneLine(s: unknown): string {
	return String(s ?? "").trim().replace(/\s*\r?\n\s*/g, " ");
}

/**
 * Process clusters in document order. Each call gets the earlier clusters as citationsPre. The latest text of each
 * cluster is kept, because later clusters can change earlier output (disambiguation, ibid, subsequent authors).
 */
function processClusters(engine: any, clusters: Cluster[]): string[] {
	const pre: [string, number][] = [];
	const latest = new Map<string, string>();
	for (const c of clusters) {
		const cluster = {
			citationID: c.id,
			citationItems: c.items.map((it) => {
				const o: Record<string, unknown> = { id: it.id };
				for (const k of CLUSTER_ITEM_KEYS) if (it[k] !== undefined) o[k] = it[k];
				return o;
			}),
			properties: { noteIndex: c.noteIndex },
		};
		const ordered = [...pre.map((p) => p[0]), c.id];
		const res = engine.processCitationCluster(cluster, pre.slice(), []);
		const updates: unknown[] = Array.isArray(res?.[1]) ? res[1] : [];
		for (const u of updates) {
			if (!Array.isArray(u)) continue;
			const [index, text, id] = u as [number, string, string | undefined];
			const key = id ?? ordered[index];
			if (key !== undefined) latest.set(key, String(text));
		}
		pre.push([c.id, c.noteIndex]);
	}
	return clusters.map((c) => oneLine(latest.get(c.id) ?? ""));
}

function runJob(job: Job): string {
	const items = new Map(job.items.map((it) => [it.id, structuredClone(it)] as const));
	const sys = {
		retrieveLocale: (lang: string) => loadLocale(lang),
		retrieveItem: (id: string) => {
			const item = items.get(id);
			if (!item) throw new Error(`unknown item ${id}`);
			return item;
		},
	};
	const engine = new CSL_ANY.Engine(sys, job.style, job.locale ?? "en-US", false);
	engine.setOutputFormat(job.format ?? "html");
	const allIds = job.items.map((it) => it.id);
	const clusters = job.clusters ?? [];

	if (job.mode === "citation") {
		engine.updateItems(allIds);
		return processClusters(engine, clusters).join("\n");
	}

	// bibliography: cite the clusters first (establishes citation order), then add uncited items, or everything
	if (clusters.length > 0) processClusters(engine, clusters);
	if (job.uncited) engine.updateUncitedItems(job.uncited);
	else if (clusters.length === 0) engine.updateItems(allIds);
	// a style without a <bibliography> makes no bibliography: makeBibliography() returns false, the output is empty
	const bib = engine.makeBibliography();
	if (!bib) return "";
	const [, entries] = bib;
	return (entries as unknown[]).map(oneLine).join("\n");
}

/** citeproc-js (in-process), run against the zotero-next core copy. */
export function citeprocJs(): Engine {
	return {
		name: "citeproc-js",
		async run(jobs: Job[]): Promise<Result[]> {
			const results: Result[] = [];
			for (const job of jobs) {
				const t0 = performance.now();
				try {
					const output = runJob(job);
					results.push({ id: job.id, ok: true, output, ms: Math.round(performance.now() - t0) });
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e);
					results.push({ id: job.id, ok: false, error, ms: Math.round(performance.now() - t0) });
				}
			}
			return results;
		},
	};
}
