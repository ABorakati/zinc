// CSL parity runner.
//   bun tools/csl-parity/run.ts --corpus <name> [--engine citeproc-js] [--engine name=command args...]
//                               [--limit N] [--filter <substring of id or tag>] [--text]
// Reads <CACHE_DIR>/corpus/<name>.jsonl, runs each engine, compares each engine with job.expected (when present)
// and with the first engine, and writes <CACHE_DIR>/reports/<corpus>-<engines joined by +>.{json,md}.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { citeprocJs } from "./engines/citeproc-js";
import { externalEngine } from "./engines/external";
import { normalize, normalizeText, stripCitationMarkers } from "./normalize";
import { CACHE_DIR, type Engine, type Job, type Result } from "./types";

const MAX_DIFFS = 40;
const SNIPPET_CHARS = 600;

function die(msg: string): never {
	console.error(`run.ts: ${msg}`);
	process.exit(2);
}

interface EngineSpec {
	label: string;
	build: () => Engine;
}

interface Args {
	corpus?: string;
	engines: EngineSpec[];
	limit?: number;
	filter?: string;
	text: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { engines: [], text: false };
	const seen = new Map<string, number>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = (): string => {
			const v = argv[++i];
			if (v === undefined) die(`${flag} needs a value`);
			return v;
		};
		switch (flag) {
			case "--corpus":
				args.corpus = value();
				break;
			case "--limit": {
				const n = Number(value());
				if (!Number.isInteger(n) || n < 1) die("--limit needs a positive integer");
				args.limit = n;
				break;
			}
			case "--filter":
				args.filter = value();
				break;
			case "--text":
				args.text = true;
				break;
			case "--engine": {
				// "name=command arg ..." (quoted, or the following non-flag tokens are appended), or plain "citeproc-js"
				const parts = [value()];
				while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) parts.push(argv[++i]);
				const raw = parts.join(" ").trim();
				const eq = raw.indexOf("=");
				let base: string;
				let spec: EngineSpec;
				if (eq < 0) {
					if (raw !== "citeproc-js") die(`engine "${raw}": external engines need name=command`);
					base = "citeproc-js";
					spec = { label: base, build: () => citeprocJs() };
				} else {
					base = raw.slice(0, eq).trim();
					const cmd = raw
						.slice(eq + 1)
						.trim()
						.split(/\s+/);
					if (!base || cmd[0] === "") die(`engine "${raw}": expected name=command`);
					spec = { label: base, build: () => externalEngine(base, cmd) };
				}
				const n = (seen.get(base) ?? 0) + 1;
				seen.set(base, n);
				if (n > 1) spec.label = `${base}#${n}`;
				args.engines.push(spec);
				break;
			}
			default:
				die(`unknown argument ${flag}`);
		}
	}
	return args;
}

type Expected = "pass" | "fail" | "n/a" | "error";
type Agreement = "ref" | "agree" | "differ" | "error";

interface JobVerdict {
	id: string;
	tags: string[];
	expected: Record<string, Expected>;
	agreement: Record<string, Agreement>;
}

interface EngineSummary {
	jobs: number;
	pass: number;
	fail: number;
	na: number;
	errors: number;
	agree: number;
	differ: number;
	agreementPct: number | null;
	totalMs: number;
	medianMs: number;
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function firstTag(job: Job): string {
	return job.tags?.[0] ?? "(untagged)";
}

function truncate(s: string): string {
	return s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)} [...truncated, ${s.length} chars]` : s;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.corpus) die("--corpus <name> is required");
	if (args.engines.length === 0) args.engines.push({ label: "citeproc-js", build: () => citeprocJs() });

	const corpusPath = join(CACHE_DIR, "corpus", `${args.corpus}.jsonl`);
	if (!existsSync(corpusPath)) die(`no corpus at ${corpusPath}; run its generator in tools/csl-parity/corpus/ first`);
	let jobs = readFileSync(corpusPath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Job);
	if (args.filter) {
		const f = args.filter;
		jobs = jobs.filter((j) => j.id.includes(f) || (j.tags ?? []).some((t) => t.includes(f)));
	}
	if (args.limit) jobs = jobs.slice(0, args.limit);
	if (jobs.length === 0) die("no jobs after --filter/--limit");

	const norm = args.text ? normalizeText : normalize;
	const labels = args.engines.map((e) => e.label);
	const ref = labels[0];

	// run every engine over the whole batch
	const resultsBy = new Map<string, Map<string, Result>>();
	const rawResults: Record<string, Result[]> = {};
	for (const spec of args.engines) {
		const engine = spec.build();
		process.stderr.write(`running ${spec.label} on ${jobs.length} jobs...\n`);
		const results = await engine.run(jobs);
		await engine.close?.();
		rawResults[spec.label] = results;
		resultsBy.set(spec.label, new Map(results.map((r) => [r.id, r])));
	}

	// per-job verdicts
	const verdicts: JobVerdict[] = [];
	for (const job of jobs) {
		const expected: Record<string, Expected> = {};
		const agreement: Record<string, Agreement> = {};
		const refR = resultsBy.get(ref)?.get(job.id);
		// a test that re-processes a citation id is an edit sequence (each call with its own pre/post lists); the contract
		// only describes the final document, so its expected output is not comparable: n/a, but engines still agree or not
		const ids = (job.clusters ?? []).map((c) => c.id);
		const editSequence = new Set(ids).size !== ids.length;
		const want = job.expected === undefined ? undefined : norm(stripCitationMarkers(job.expected));
		for (const label of labels) {
			const r = resultsBy.get(label)?.get(job.id);
			if (want === undefined || editSequence) expected[label] = "n/a";
			else if (!r || !r.ok) expected[label] = "error";
			else expected[label] = norm(r.output ?? "") === want ? "pass" : "fail";

			if (label === ref) agreement[label] = "ref";
			else if (!r || !r.ok || !refR || !refR.ok) agreement[label] = "error";
			else agreement[label] = norm(r.output ?? "") === norm(refR.output ?? "") ? "agree" : "differ";
		}
		verdicts.push({ id: job.id, tags: job.tags ?? [], expected, agreement });
	}

	// summaries
	const summaries: Record<string, EngineSummary> = {};
	for (const label of labels) {
		const times: number[] = [];
		const s: EngineSummary = {
			jobs: jobs.length,
			pass: 0,
			fail: 0,
			na: 0,
			errors: 0,
			agree: 0,
			differ: 0,
			agreementPct: null,
			totalMs: 0,
			medianMs: 0,
		};
		for (const v of verdicts) {
			const e = v.expected[label];
			if (e === "pass") s.pass++;
			else if (e === "fail") s.fail++;
			else if (e === "n/a") s.na++;
			const a = v.agreement[label];
			if (a === "agree") s.agree++;
			else if (a === "differ") s.differ++;
		}
		for (const job of jobs) {
			const r = resultsBy.get(label)?.get(job.id);
			if (!r || !r.ok) s.errors++;
			if (r?.ms !== undefined) times.push(r.ms);
		}
		s.totalMs = times.reduce((a, b) => a + b, 0);
		s.medianMs = Math.round(median(times));
		if (label !== ref && s.agree + s.differ > 0) s.agreementPct = Math.round((1000 * s.agree) / (s.agree + s.differ)) / 10;
		summaries[label] = s;
	}

	// reports
	const reportsDir = join(CACHE_DIR, "reports");
	mkdirSync(reportsDir, { recursive: true });
	const base = join(reportsDir, `${args.corpus}-${labels.join("+")}`);
	const generatedAt = new Date().toISOString();

	writeFileSync(
		`${base}.json`,
		JSON.stringify(
			{
				corpus: args.corpus,
				generatedAt,
				normalization: args.text ? "text" : "html",
				reference: ref,
				engines: labels,
				summary: summaries,
				jobs: verdicts,
				results: rawResults,
			},
			null,
			2,
		),
	);

	const md: string[] = [];
	md.push(`# CSL parity: ${args.corpus}`, "");
	md.push(
		`Generated ${generatedAt}. Jobs: ${jobs.length}. Reference engine: \`${ref}\`. Normalization: ${args.text ? "text (tags removed)" : "html"}.`,
		"",
	);
	md.push("## Summary", "");
	md.push("| engine | jobs | pass | fail | n/a | errors | agree w/ ref | differ | agreement | total ms | median ms |");
	md.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
	for (const label of labels) {
		const s = summaries[label];
		const isRef = label === ref;
		md.push(
			`| ${label}${isRef ? " (ref)" : ""} | ${s.jobs} | ${s.pass} | ${s.fail} | ${s.na} | ${s.errors} | ${isRef ? "-" : s.agree} | ${isRef ? "-" : s.differ} | ${isRef || s.agreementPct === null ? "-" : `${s.agreementPct}%`} | ${s.totalMs} | ${s.medianMs} |`,
		);
	}
	md.push(
		"",
		"pass/fail/n/a are against job.expected; errors are jobs where the engine failed. agreement = agree / (agree + differ) against the reference.",
		"",
	);

	const tags = [...new Set(jobs.map(firstTag))];
	md.push("## By tag (first tag per job)", "");
	const headerCells = [...labels.map((l) => `${l} expected p/f`), ...labels.slice(1).map((l) => `${l} vs ref a/d`)];
	md.push(`| tag | jobs | ${headerCells.join(" | ")} |`);
	md.push(
		`|---|---:|${labels.map(() => "---:").join("|")}|${labels
			.slice(1)
			.map(() => "---:")
			.join("|")}|`,
	);
	for (const tag of tags) {
		const vs = verdicts.filter((v) => (v.tags[0] ?? "(untagged)") === tag);
		const exp = labels.map(
			(l) => `${vs.filter((v) => v.expected[l] === "pass").length}/${vs.filter((v) => v.expected[l] === "fail").length}`,
		);
		const agr = labels
			.slice(1)
			.map((l) => `${vs.filter((v) => v.agreement[l] === "agree").length}/${vs.filter((v) => v.agreement[l] === "differ").length}`);
		md.push(`| ${tag} | ${vs.length} | ${[...exp, ...agr].join(" | ")} |`);
	}
	md.push("");

	const diffJobs = jobs.filter((j) => labels.some((l) => l !== ref && verdicts.find((v) => v.id === j.id)?.agreement[l] === "differ"));
	md.push(`## Differences from ${ref} (first ${MAX_DIFFS} of ${diffJobs.length})`, "");
	for (const job of diffJobs.slice(0, MAX_DIFFS)) {
		md.push(`### ${job.id}`, "");
		const refOut = resultsBy.get(ref)?.get(job.id)?.output ?? "";
		md.push(`**${ref}**`, "", "```", truncate(refOut), "```", "");
		for (const label of labels.slice(1)) {
			if (verdicts.find((v) => v.id === job.id)?.agreement[label] !== "differ") continue;
			const out = resultsBy.get(label)?.get(job.id)?.output ?? "";
			md.push(`**${label}**`, "", "```", truncate(out), "```", "");
		}
	}
	const expFails = verdicts.filter((v) => labels.some((l) => v.expected[l] === "fail" || v.expected[l] === "error"));
	if (expFails.length > 0) {
		md.push(`## Expected-output mismatches (${expFails.length})`, "");
		for (const v of expFails.slice(0, MAX_DIFFS)) {
			const bad = labels.filter((l) => v.expected[l] === "fail" || v.expected[l] === "error").join(", ");
			md.push(`- \`${v.id}\`: ${bad}`);
		}
		md.push("");
	}
	writeFileSync(`${base}.md`, md.join("\n"));

	// stdout summary
	const out: string[] = [];
	out.push(`CSL parity: ${args.corpus} (${jobs.length} jobs, reference ${ref}, ${args.text ? "text" : "html"})`);
	out.push("engine\tpass\tfail\tn/a\terrors\tagree\tdiffer\tagreement\ttotal ms\tmedian ms");
	for (const label of labels) {
		const s = summaries[label];
		const isRef = label === ref;
		out.push(
			[
				label + (isRef ? " (ref)" : ""),
				s.pass,
				s.fail,
				s.na,
				s.errors,
				isRef ? "-" : s.agree,
				isRef ? "-" : s.differ,
				isRef || s.agreementPct === null ? "-" : `${s.agreementPct}%`,
				s.totalMs,
				s.medianMs,
			].join("\t"),
		);
	}
	out.push("", `report: ${base}.md`, `        ${base}.json`);
	console.log(out.join("\n"));
}

main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
