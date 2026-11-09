# CSL parity harness

Compares CSL citation-style output across engines: the in-process citeproc-js in zotero-next's core, and any
external engine (for example the hayagriva engine) that speaks the same JSONL protocol. It can also check output
against reference text from a source test suite.

## Contract

`types.ts` is the contract and must not change. A **Job** is one citation or bibliography rendering: a style (CSL
XML), a locale, CSL-JSON items, citation clusters in document order, and an optional `expected` string. An
**Engine** turns a batch of Jobs into **Results** (`ok`, `output`, `error`, `ms`).

- Corpora: `corpus/*.ts` write `<CACHE_DIR>/corpus/<name>.jsonl`. `CACHE_DIR` defaults to
  `C:/Users/abora/zn-ws/csl-parity-cache` and can be overridden with `ZN_PARITY_CACHE`. Downloads and generated
  data live there, never in the repo.
- Engines: `engines/citeproc-js.ts` (in-process) and `engines/external.ts` (a command).
- Reports: `<CACHE_DIR>/reports/<corpus>-<engines joined by +>.{json,md}`.

## Generating corpora

Corpus generators are `corpus/csl-suite.ts`, `corpus/citeproc-js-fixtures.ts` and `corpus/zinc.ts`, which are
written separately. Each one writes `<CACHE_DIR>/corpus/<name>.jsonl` and is run with `bun`:

    bun tools/csl-parity/corpus/smoke.ts     # 3-job smoke corpus, already present

## Running

    bun tools/csl-parity/run.ts --corpus smoke --engine citeproc-js --engine citeproc-js
    bun tools/csl-parity/run.ts --corpus <name> --engine citeproc-js --engine "hayagriva=<command> <args>"
    bun tools/csl-parity/run.ts --corpus <name> --limit 50 --filter disambiguation --text

- The first engine is the reference. Every engine is compared with `job.expected` (pass/fail/n/a) and with the
  reference (agree/differ).
- Repeated engine names are labelled `name#2`, `name#3`, and so on.
- `--text` strips HTML tags before comparing, for engines that output plain text.
- The report `.md` has a summary table, a breakdown by the first tag of each job, the first 40 differences side by
  side (600 characters each), and the list of expected mismatches.
- Comparison uses `normalize.ts`: entities are decoded, quotes, dashes and spaces are unified, the csl-entry and
  csl-bib-body wrappers are stripped, runs of spaces collapse, and blank lines are dropped.

## Plugging in an external engine

Write a program that reads JSONL Jobs on stdin and writes one JSONL Result per line on stdout (any order, matched by
`id`). Stderr is captured into the error of any job that did not return a result. Pass it to the runner as
`--engine name=command args`; quote the whole value if the command has spaces. A batch is killed after
`ZN_PARITY_TIMEOUT_MS` (default 600000) and the results printed so far are kept.

## Known limits

- `Job.corpus` is a closed union in `types.ts`, so the smoke jobs use `"csl-suite"` with a `smoke/` id prefix.
- Bibliography entries are joined onto one line each: internal newlines become spaces.

## Baseline (2026-11-09)

| Corpus | Jobs | citeproc-js vs expected | hayagriva 0.10.1 vs expected | hayagriva vs citeproc-js |
| --- | --- | --- | --- | --- |
| CSL test suite | 845 | 806 pass, 28 fail, 11 n/a (edit sequences) | 509 pass, 307 fail, 18 errors | 63% of jobs identical |
| citeproc-js fixtures | 517 | 459 pass, 57 fail | 135 pass, 298 fail, 83 errors | 36% of jobs identical |
| Zinc (43 styles × 2 modes) | 86 | (no expected output) | panics on date ranges in every job | without the date-range item: 47% of citations and 9.5% of bibliography entries identical (`bun tools/csl-parity/lines.ts <report.json>`) |

citeproc-js's remaining CSL-suite failures are mostly locale-version differences (e.g. "499AD" vs "499 AD"). Edit-sequence
tests (a citation id processed more than once with its own pre/post lists) are reported n/a against expected output,
because a Job only describes the final document. Bibliography line agreement with hayagriva is understated where it
prints second-field-align numbers differently from citeproc-js's csl-left-margin markup.
