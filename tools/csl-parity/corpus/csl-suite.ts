// CSL test-suite corpus generator.
// Reads citation-style-language/test-suite processor-tests/machines/*.json and writes <CACHE_DIR>/corpus/csl-suite.jsonl
// (one Job per line; see ../types.ts). Downloads go to <CACHE_DIR>/src and <CACHE_DIR>/locales-src; never into the repo.
//
// Usage: bun tools/csl-parity/corpus/csl-suite.ts [--update]   (--update re-pulls both repos)

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR, type Cluster, type ClusterItem, type CslItem, type Job } from "../types.ts";

const SUITE_REPO = "https://github.com/citation-style-language/test-suite.git";
const LOCALES_REPO = "https://github.com/citation-style-language/locales.git";
const SUITE_DIR = join(CACHE_DIR, "src", "csl-test-suite");
const LOCALES_SRC = join(CACHE_DIR, "locales-src");
const LOCALES_DIR = join(CACHE_DIR, "locales");
const MACHINES_DIR = join(SUITE_DIR, "processor-tests", "machines");
const OUT_FILE = join(CACHE_DIR, "corpus", "csl-suite.jsonl");

const update = process.argv.includes("--update");

/** The machine-readable test layout (processor-tests/machines/*.json). Fields not used here are typed loosely. */
interface RawTest {
	abbreviations?: unknown;
	bibentries?: unknown;
	bibsection?: unknown;
	/** false, or a list of clusters, each a list of {id, prefix?, suffix?, locator?, ...} */
	citation_items?: unknown;
	/** false, or a list of [citationObject, citationsPre, citationsPost] in document order */
	citations?: unknown;
	csl: string;
	input: Record<string, unknown>[];
	mode: string;
	result: string;
	version?: unknown;
}

interface RawCitation {
	citationID?: string;
	citationItems: Record<string, unknown>[];
	properties?: { noteIndex?: number };
}

type SkipReason = string;

async function git(args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { stdout: "inherit", stderr: "inherit" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed with exit ${code}`);
}

/** Clone a repo at depth 1 if missing; with --update, fast-forward an existing clone. */
async function ensureRepo(repo: string, dir: string): Promise<void> {
	if (!existsSync(join(dir, ".git"))) {
		await mkdir(dirname(dir), { recursive: true });
		await git(["clone", "--depth", "1", repo, dir]);
	} else if (update) {
		await git(["-C", dir, "pull", "--ff-only", "--depth", "1"]);
	}
}

/** Copy every locales-*.xml from the locales repo into <CACHE_DIR>/locales (the engine adapter reads from there). */
async function syncLocales(): Promise<number> {
	await mkdir(LOCALES_DIR, { recursive: true });
	const files = (await readdir(LOCALES_SRC)).filter((f) => /^locales-.*\.xml$/.test(f));
	for (const f of files) await copyFile(join(LOCALES_SRC, f), join(LOCALES_DIR, f));
	return files.length;
}

function toClusterItem(raw: Record<string, unknown>): ClusterItem {
	const out: ClusterItem = { id: String(raw.id) };
	if (raw.locator !== undefined && raw.locator !== null) out.locator = String(raw.locator);
	if (typeof raw.label === "string") out.label = raw.label;
	if (typeof raw.prefix === "string") out.prefix = raw.prefix;
	if (typeof raw.suffix === "string") out.suffix = raw.suffix;
	if (typeof raw["suppress-author"] === "boolean") out["suppress-author"] = raw["suppress-author"];
	if (typeof raw["author-only"] === "boolean") out["author-only"] = raw["author-only"];
	// position, near-note and first-reference-note-number are not representable in ClusterItem; the engine derives positions from clusters.
	return out;
}

/** citations: [citationObj, pre, post][] in document order; noteIndex comes from the citation object itself. */
function clustersFromCitations(citations: [RawCitation, unknown, unknown][]): Cluster[] {
	return citations.map(([c], i) => ({
		id: String(c.citationID ?? `c${i + 1}`),
		noteIndex: Number(c.properties?.noteIndex ?? 0),
		items: c.citationItems.map(toClusterItem),
	}));
}

/** citation_items: each inner list is one cluster; note styles number them 1..n, in-text styles use 0. */
function clustersFromCitationItems(lists: Record<string, unknown>[][], isNote: boolean): Cluster[] {
	return lists.map((list, i) => ({
		id: `c${i + 1}`,
		noteIndex: isNote ? i + 1 : 0,
		items: list.map(toClusterItem),
	}));
}

async function main(): Promise<void> {
	await ensureRepo(SUITE_REPO, SUITE_DIR);
	await ensureRepo(LOCALES_REPO, LOCALES_SRC);
	const localeCount = await syncLocales();

	const files = (await readdir(MACHINES_DIR)).filter((f) => f.endsWith(".json")).sort();
	const lines: string[] = [];
	const emittedByMode: Record<string, number> = {};
	const skipped: Record<SkipReason, number> = {};
	const categories: Record<string, number> = {};
	let citationsFormat = 0;
	let parseErrors = 0;

	const skip = (reason: SkipReason) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};

	for (const file of files) {
		const name = file.slice(0, -".json".length);
		const category = name.includes("_") ? name.slice(0, name.indexOf("_")) : name;

		let raw: RawTest;
		try {
			raw = JSON.parse(await readFile(join(MACHINES_DIR, file), "utf8")) as RawTest;
		} catch {
			parseErrors++;
			skip("parse-error");
			continue;
		}

		if (raw.mode !== "citation" && raw.mode !== "bibliography") {
			skip(`mode:${raw.mode}`);
			continue;
		}
		if (raw.bibsection) {
			skip("bibsection");
			continue;
		}
		if (raw.bibentries) {
			skip("bibentries");
			continue;
		}
		if (raw.abbreviations) {
			skip("abbreviations");
			continue;
		}
		if (typeof raw.csl !== "string") {
			skip("no-csl");
			continue;
		}
		if (!Array.isArray(raw.input) || raw.input.length === 0) {
			skip("no-input");
			continue;
		}

		const mode = raw.mode as "citation" | "bibliography";
		const isNote = /<style\b[^>]*\bclass\s*=\s*["']note["']/.test(raw.csl);
		const localeMatch = raw.csl.match(/<style\b[^>]*\bdefault-locale\s*=\s*["']([^"']+)["']/);
		const items = raw.input.map((it) => ({ ...it, id: String(it.id) }) as CslItem);

		let clusters: Cluster[] | undefined;
		let usesCitationsFormat = false;
		if (Array.isArray(raw.citations) && raw.citations.length > 0) {
			clusters = clustersFromCitations(raw.citations as [RawCitation, unknown, unknown][]);
			usesCitationsFormat = true;
		} else if (Array.isArray(raw.citation_items) && raw.citation_items.length > 0) {
			clusters = clustersFromCitationItems(raw.citation_items as Record<string, unknown>[][], isNote);
		}

		// citation mode with no explicit clusters: one cluster citing every item in order.
		// bibliography mode with no explicit clusters: no clusters, so every item is a bibliography entry.
		if (mode === "citation" && !clusters) {
			clusters = [
				{
					id: "c1",
					noteIndex: isNote ? 1 : 0,
					items: items.map((it) => ({ id: it.id })),
				},
			];
		}

		const job: Job = {
			id: `csl-suite/${name}`,
			corpus: "csl-suite",
			style: raw.csl,
			locale: localeMatch?.[1] ?? "en-US",
			items,
			mode,
			...(clusters ? { clusters } : {}),
			format: "html",
			expected: raw.result,
			tags: [category, mode, ...(usesCitationsFormat ? ["citations-format"] : [])],
		};

		lines.push(JSON.stringify(job));
		emittedByMode[mode] = (emittedByMode[mode] ?? 0) + 1;
		categories[category] = (categories[category] ?? 0) + 1;
		if (usesCitationsFormat) citationsFormat++;
	}

	await mkdir(dirname(OUT_FILE), { recursive: true });
	await Bun.write(OUT_FILE, lines.join("\n") + "\n");

	const topCategories = Object.entries(categories)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([c, n]) => `${c}=${n}`)
		.join(" ");

	console.log(`locales copied: ${localeCount}`);
	console.log(`total tests: ${files.length}`);
	console.log(`emitted: ${lines.length} ${JSON.stringify(emittedByMode)} (with citations-format: ${citationsFormat})`);
	console.log(`skipped: ${JSON.stringify(skipped)}`);
	console.log(`parse errors: ${parseErrors}`);
	console.log(`top categories: ${topCategories}`);
	console.log(`wrote ${OUT_FILE}`);
}

await main();
