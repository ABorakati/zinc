// CSL parity harness: the contract every part shares. A corpus is a JSONL file of Jobs; an engine turns each Job into a
// Result; the runner compares engines' Results (and, where a test suite gives one, the expected output).
//
//   corpora   tools/csl-parity/corpus/*.ts write <cache>/corpus/<name>.jsonl  (cache: ZN_PARITY_CACHE, default
//             C:/Users/abora/zn-ws/csl-parity-cache; downloads and generated corpora live there, never in the repo)
//   engines   in-process adapters (engines/*.ts, e.g. citeproc-js) or an external command speaking JSONL: one Job per line on
//             stdin, one Result per line on stdout, in any order, matched by id
//   runner    tools/csl-parity/run.ts --corpus <name> --engine <a> [--engine <b>] -> <cache>/reports/<corpus>-<engines>.{json,md}

/** A CSL-JSON item (id plus CSL variables). */
export type CslItem = { id: string; type: string; [variable: string]: unknown };

export interface ClusterItem {
	id: string;
	locator?: string;
	label?: string;
	prefix?: string;
	suffix?: string;
	"suppress-author"?: boolean;
	"author-only"?: boolean;
}

/** One citation (cluster) in document order. noteIndex: 0 in the body; the footnote number in note styles. */
export interface Cluster {
	id: string;
	noteIndex: number;
	items: ClusterItem[];
}

export interface Job {
	/** unique within its corpus, e.g. "csl-suite/name_AsianGlyphs" */
	id: string;
	corpus: "csl-suite" | "citeproc-js" | "zinc";
	/** the style's full CSL XML (independent style) */
	style: string;
	/** "en-US" when absent */
	locale?: string;
	items: CslItem[];
	/**
	 * citation: format `clusters` in document order and output each cluster's text, one per line, in cluster order
	 *           (the final text of every cluster after the whole document is processed).
	 * bibliography: output the bibliography entries, one per line, after processing `clusters` (if any) and `uncited`.
	 */
	mode: "citation" | "bibliography";
	/** for citation mode, and to establish citation order for bibliography mode; when absent in bibliography mode, all
	 * items are bibliography entries (as if uncited) */
	clusters?: Cluster[];
	/** item ids in the bibliography without being cited */
	uncited?: string[];
	/** output format the expected text and engines use: "html" (default) or "text" */
	format?: "html" | "text";
	/** the reference output from the source test suite, when it has one (same format and line layout as Result.output) */
	expected?: string;
	/** free labels for grouping in reports: test-suite category, style name, feature ("disambiguation", "names", ...) */
	tags?: string[];
}

export interface Result {
	id: string;
	/** false when the engine threw or could not handle the job (then `error` says why) */
	ok: boolean;
	output?: string;
	error?: string;
	/** wall time for this job in milliseconds, engine-side */
	ms?: number;
}

/** An engine the runner can drive. */
export interface Engine {
	name: string;
	/** run a batch of jobs; results may come back in any order */
	run(jobs: Job[]): Promise<Result[]>;
	close?(): Promise<void>;
}

export const CACHE_DIR = process.env.ZN_PARITY_CACHE ?? "C:/Users/abora/zn-ws/csl-parity-cache";
