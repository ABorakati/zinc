// Smoke corpus for the runner: 3 jobs, no test-suite data.
//   bun tools/csl-parity/corpus/smoke.ts  ->  <CACHE_DIR>/corpus/smoke.jsonl
// Job 1: APA citation mode, 3 clusters (no expected -> n/a)
// Job 2: Vancouver bibliography mode with clusters and an uncited item (no expected -> n/a)
// Job 3: APA citation mode with a deliberately wrong expected string (-> fail)
// Note: Job.corpus is typed as a closed union; smoke jobs use "csl-suite" with a "smoke/" id prefix.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, type CslItem, type Job } from "../types";

const STYLES = "C:/Users/abora/zotero-next/website/word-demo/styles";

const items: CslItem[] = [
	{
		id: "ref1",
		type: "article-journal",
		title: "Outcomes after elective repair in a national cohort",
		author: [{ family: "Smith", given: "Jane" }],
		issued: { "date-parts": [[2020]] },
		"container-title": "Journal of Things",
		volume: "12",
		issue: "3",
		page: "45-67",
		DOI: "10.1000/xyz1",
	},
	{
		id: "ref2",
		type: "article-journal",
		title: "A second study of recovery times",
		author: [
			{ family: "Lee", given: "Kim" },
			{ family: "Patel", given: "Ravi" },
		],
		issued: { "date-parts": [[2018]] },
		"container-title": "Clinical Science",
		volume: "5",
		page: "1-10",
	},
	{
		id: "ref3",
		type: "book",
		title: "A book on things",
		author: [{ family: "Brown", given: "Tom" }],
		issued: { "date-parts": [[2015]] },
		publisher: "Academic Press",
		"publisher-place": "London",
	},
];

const apa = readFileSync(join(STYLES, "apa.csl"), "utf8");
const vancouver = readFileSync(join(STYLES, "vancouver.csl"), "utf8");

const clusters = [
	{ id: "c1", noteIndex: 0, items: [{ id: "ref1" }] },
	{ id: "c2", noteIndex: 0, items: [{ id: "ref2" }, { id: "ref3" }] },
	{ id: "c3", noteIndex: 0, items: [{ id: "ref1", locator: "12", label: "page" }] },
];

const jobs: Job[] = [
	{
		id: "smoke/apa-citation-clusters",
		corpus: "csl-suite",
		style: apa,
		items,
		mode: "citation",
		clusters,
		tags: ["smoke", "citation"],
	},
	{
		id: "smoke/vancouver-bibliography-uncited",
		corpus: "csl-suite",
		style: vancouver,
		items,
		mode: "bibliography",
		clusters: [
			{ id: "c1", noteIndex: 0, items: [{ id: "ref1" }] },
			{ id: "c2", noteIndex: 0, items: [{ id: "ref2" }] },
		],
		uncited: ["ref3"],
		tags: ["smoke", "bibliography"],
	},
	{
		id: "smoke/apa-citation-wrong-expected",
		corpus: "csl-suite",
		style: apa,
		items,
		mode: "citation",
		clusters,
		expected: "(Smith, 2020)\n(Lee & Patel, 2018; Brown, 2015)\n(Smith, 2020, p. 12)",
		tags: ["smoke", "citation", "deliberately-wrong"],
	},
];

const dir = join(CACHE_DIR, "corpus");
mkdirSync(dir, { recursive: true });
const path = join(dir, "smoke.jsonl");
writeFileSync(path, jobs.map((j) => JSON.stringify(j)).join("\n") + "\n");
console.log(`wrote ${jobs.length} jobs to ${path}`);
