// citeproc-js fixture corpus: clones Juris-M/citeproc-js fixtures/local into <CACHE_DIR>/src and converts each
// "humans"-format fixture (>>===== SECTION =====>> ... <<===== SECTION =====<<) into a Job (see ../types.ts).
// Writes <CACHE_DIR>/corpus/citeproc-js.jsonl.
//
// Usage: bun tools/csl-parity/corpus/citeproc-js-fixtures.ts [--update]
//   --update  fetch the latest upstream commit into the existing clone

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR, type Cluster, type ClusterItem, type CslItem, type Job } from "../types.ts";

const REPO = "https://github.com/Juris-M/citeproc-js.git";
const SRC = join(CACHE_DIR, "src", "citeproc-js");
const FIXTURES = join(SRC, "fixtures", "local");
const OUT = join(CACHE_DIR, "corpus", "citeproc-js.jsonl");
const UPDATE = process.argv.includes("--update");

/** Sections the contract cannot express: skipped with the section name as the reason. */
const UNSUPPORTED_SECTIONS = ["ABBREVIATIONS", "OPTIONS", "OPTIONZ", "BIBSECTION", "BIBENTRIES", "KEYS", "LANGPARAMS", "MULTIAFFIX"];
/** Groups that need CSL-M (multilingual, institutions, abbreviations, parallel, jurisdiction). */
const CSLM_GROUPS = new Set(["multilingual", "institutions", "abbrevs", "parallel", "juris", "jurisdiction"]);
/** CSL-M namespaces and attributes in a style. */
const CSLM_MARKUP = /xmlns:|\b(institution|parallel|jurisdiction|multi-)/;
const CLUSTER_ITEM_KEYS = ["locator", "label", "prefix", "suffix", "suppress-author", "author-only"] as const;

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited with ${code}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchFixtures(): Promise<void> {
  if (!(await exists(join(SRC, ".git")))) {
    await mkdir(SRC, { recursive: true });
    await run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO, SRC]);
  }
  if (UPDATE) {
    await run(["git", "-C", SRC, "fetch", "--depth", "1", "origin", "HEAD"]);
    await run(["git", "-C", SRC, "reset", "--hard", "FETCH_HEAD"]);
  }
  if (!(await exists(FIXTURES))) {
    await run(["git", "-C", SRC, "sparse-checkout", "set", "fixtures/local"]);
  }
}

const OPEN = /^>>=+\s*([A-Z][A-Z-]*)\s*=+>>\s*$/;

/** Split a fixture into named sections. Throws on an unclosed section. */
export function parseSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN);
    if (!open) continue;
    const name = open[1];
    const close = new RegExp(`^<<=+\\s*${name}\\s*=+<<\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    if (j >= lines.length) throw new Error(`unclosed section ${name}`);
    if (!sections.has(name)) sections.set(name, lines.slice(i + 1, j).join("\n"));
    i = j;
  }
  return sections;
}

function toClusterItem(raw: Record<string, unknown>): ClusterItem {
  const item: ClusterItem = { id: String(raw.id) };
  for (const key of CLUSTER_ITEM_KEYS) {
    if (raw[key] !== undefined) (item as Record<string, unknown>)[key] = raw[key];
  }
  return item;
}

type Converted = { job: Job } | { skip: string };

export function convert(name: string, text: string): Converted {
  const sec = parseSections(text);
  const mode = sec.get("MODE")?.trim();
  if (!mode) return { skip: "no-mode" };
  if (mode !== "citation" && mode !== "bibliography") return { skip: `mode:${mode}` };
  for (const section of UNSUPPORTED_SECTIONS) {
    if (sec.has(section)) return { skip: `needs:${section}` };
  }
  const expected = sec.get("RESULT");
  if (expected === undefined) return { skip: "no-result" };
  const csl = sec.get("CSL")?.trim();
  if (!csl) return { skip: "no-csl" };

  let rawItems: unknown;
  try {
    rawItems = JSON.parse(sec.get("INPUT") ?? "");
  } catch {
    return { skip: "bad-json:INPUT" };
  }
  if (!Array.isArray(rawItems) || rawItems.some((it) => typeof it !== "object" || it === null || (it as { id?: unknown }).id === undefined)) {
    return { skip: "bad-input" };
  }
  const items = (rawItems as Record<string, unknown>[]).map((it) => ({ ...it, id: String(it.id) }) as CslItem);
  const itemIds = new Set(items.map((it) => it.id));

  const extraTags: string[] = [];
  let clusters: Cluster[] | undefined;
  const citations = sec.get("CITATIONS");
  const citationItems = sec.get("CITATION-ITEMS");
  try {
    if (citations !== undefined) {
      const parsed = JSON.parse(citations) as unknown[];
      clusters = parsed.map((entry, i) => {
        const head = (Array.isArray(entry) ? entry[0] : entry) as {
          citationID?: unknown;
          citationItems?: Record<string, unknown>[];
          properties?: { noteIndex?: unknown };
        };
        return {
          id: String(head.citationID ?? `c${i}`),
          noteIndex: Number(head.properties?.noteIndex ?? 0),
          items: (head.citationItems ?? []).map(toClusterItem),
        };
      });
      extraTags.push("citations-format");
    } else if (citationItems !== undefined) {
      const parsed = JSON.parse(citationItems) as Record<string, unknown>[][];
      clusters = parsed.map((cluster, i) => ({ id: `c${i}`, noteIndex: 0, items: cluster.map(toClusterItem) }));
    }
  } catch {
    return { skip: "bad-json:CITATIONS" };
  }
  if (clusters === undefined && mode === "citation") {
    clusters = [{ id: "c0", noteIndex: 0, items: items.map((it) => ({ id: it.id })) }];
  }
  if (clusters?.some((c) => c.items.some((ci) => !itemIds.has(ci.id)))) return { skip: "unknown-item-id" };

  const prefix = name.split("_")[0];
  const csl_m = CSLM_GROUPS.has(prefix) || CSLM_MARKUP.test(csl);
  const tags = [prefix, mode, ...(csl_m ? ["csl-m"] : []), ...extraTags];
  const job: Job = {
    id: `citeproc-js/${name}`,
    corpus: "citeproc-js",
    style: csl,
    items,
    mode: mode as Job["mode"],
    format: "html",
    expected: expected.trim(),
    tags,
  };
  if (clusters) job.clusters = clusters;
  return { job };
}

async function main(): Promise<void> {
  await fetchFixtures();
  const names = (await readdir(FIXTURES)).sort();
  const files = names.filter((f) => f.endsWith(".txt"));
  const jobs: Job[] = [];
  const skipped = new Map<string, number>();
  for (const file of files) {
    const name = file.replace(/\.txt$/, "");
    let outcome: Converted;
    try {
      outcome = convert(name, await Bun.file(join(FIXTURES, file)).text());
    } catch (err) {
      outcome = { skip: "parse-error" };
      console.error(`parse-error ${file}: ${(err as Error).message}`);
    }
    if ("skip" in outcome) {
      skipped.set(outcome.skip, (skipped.get(outcome.skip) ?? 0) + 1);
    } else {
      jobs.push(outcome.job);
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, jobs.map((j) => JSON.stringify(j)).join("\n") + "\n");

  const byMode = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const job of jobs) {
    byMode.set(job.mode, (byMode.get(job.mode) ?? 0) + 1);
    for (const tag of job.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const sortDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const nonTxt = names.length - files.length;

  console.log(`fixtures: ${files.length}${nonTxt ? ` (+${nonTxt} non-.txt ignored)` : ""}`);
  console.log(`emitted: ${jobs.length} ${JSON.stringify(Object.fromEntries(byMode))}`);
  console.log(`skipped: ${files.length - jobs.length}`);
  for (const [reason, n] of sortDesc(skipped)) console.log(`  ${n}  ${reason}`);
  console.log(`top tags: ${sortDesc(tagCounts).slice(0, 15).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  console.log(`wrote ${OUT}`);
}

if (import.meta.main) await main();
