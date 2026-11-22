// Differential fuzzer: Zinc's native note pipeline (parse.ts, serialize.ts, the richtext-core ProseMirror bridge and its random edits)
// against Zotero's own note-editor code (the oracle built by build-oracle.ts). See checks.ts for the checks.
//   bun scripts/fuzz/fuzz-notes.ts --bridge <gpuix>/packages/richtext-core/target/release/examples/pm_bridge --seeds 2000 [--out dir]
//   bun scripts/fuzz/fuzz-notes.ts --bridge <bin> --seed 17        (one seed, with the generated HTML and every failure printed)
// Options: --start N (first seed, default 0), --steps K (edits per note, default 50), --shrink-max M (failures shrunk per check and failure kind, 2),
//   --oracle <file> (default $NOTE_EDITOR_ORACLE or /home/user/ref/note-editor/.oracle/oracle.js), --show (print the failing HTML).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNoteParser } from "../../src/notes/native/parse";
import { Bridge } from "./bridge";
import { CHECKS, type Env, type Failure, runChecks } from "./checks";
import { NoteGen } from "./gen";
import { loadOracle } from "./oracle";
import { shrink } from "./shrink";

const FIXTURES = new URL("../../src/notes/native/fixtures/", import.meta.url);

export interface FuzzOptions {
	bridge: string;
	seeds: number;
	start?: number;
	steps?: number;
	out?: string;
	oracle?: string;
	shrinkMax?: number;
	/** also run src/notes/native/fixtures/*.html (default true) */
	fixtures?: boolean;
	verbose?: boolean;
}
export interface FuzzResult {
	seeds: number;
	/** fixtures/*.html notes run before the seeds */
	fixtures: number;
	failuresByCheck: Record<string, number>;
	/** seeds where the oracle itself threw on the generated HTML (a generator problem, not a failure) */
	oracleErrors: number;
	bridgeRestarts: number;
	failures: { seed: number; check: string; sig: string; detail: string; html: string; minimal?: string }[];
	oracleCommit: string;
}

export async function runFuzz(o: FuzzOptions): Promise<FuzzResult> {
	const oracle = await loadOracle(o.oracle);
	const parser = (await loadNoteParser())!;
	const bridge = new Bridge(o.bridge);
	const env: Env = { oracle, bridge, parser, steps: o.steps ?? 50 };
	const start = o.start ?? 0;
	const result: FuzzResult = {
		seeds: 0,
		fixtures: 0,
		failuresByCheck: Object.fromEntries(CHECKS.map((c) => [c, 0])),
		oracleErrors: 0,
		bridgeRestarts: 0,
		failures: [],
		oracleCommit: oracle.commit,
	};
	const shrunk: Record<string, number> = {};
	if (o.out) mkdirSync(o.out, { recursive: true });
	try {
		// the synthetic notes of src/notes/native/fixtures first (every node and mark of the schema, written by hand), then the grammar's
		const fixtures =
			o.fixtures === false
				? []
				: readdirSync(FIXTURES)
						.filter((f) => f.endsWith(".html"))
						.sort();
		const todo: {
			seed: number;
			label: string;
			note: { html: string; tree: never[] | ReturnType<NoteGen["note"]>["tree"]; sep: string };
		}[] = fixtures.map((f, i) => ({
			seed: i,
			label: f,
			note: { html: readFileSync(new URL(f, FIXTURES), "utf8").trim(), tree: [], sep: "" },
		}));
		for (let seed = start; seed < start + o.seeds; seed++) todo.push({ seed, label: `seed ${seed}`, note: new NoteGen(seed).note() });
		for (const { seed, label, note } of todo) {
			const fails = await runChecks(env, note.html, seed);
			if (label.startsWith("seed")) result.seeds++;
			else result.fixtures++;
			const oracleFail = fails.find((f) => f.check === "oracle");
			if (oracleFail) {
				result.oracleErrors++;
				if (o.verbose) console.log(`${label}: oracle error ${oracleFail.detail}`);
				continue;
			}
			const seen = new Set<string>();
			for (const f of fails as Failure[]) {
				if (seen.has(f.check)) continue; // one report per check and seed
				seen.add(f.check);
				result.failuresByCheck[f.check] = (result.failuresByCheck[f.check] ?? 0) + 1;
				let minimal: string | undefined;
				const key = `${f.check} ${f.sig}`;
				if (f.check !== "R2c" && note.tree.length && (shrunk[key] ?? 0) < (o.shrinkMax ?? 2) && Object.keys(shrunk).length < 120) {
					shrunk[key] = (shrunk[key] ?? 0) + 1;
					const s = await shrink(note.tree, note.sep, async (html) =>
						(await runChecks(env, html, seed, f.check)).some((x) => x.check === f.check && x.sig === f.sig),
					);
					minimal = s.html;
				}
				result.failures.push({ seed, check: f.check, sig: f.sig, detail: f.detail, html: note.html, minimal });
				// R2c (byte-level serializer differences, expected) is counted, not written out
				if (o.out && f.check !== "R2c") {
					const base = join(o.out, `${f.check}-${label.replace(/\W+/g, "-")}`);
					writeFileSync(`${base}.html`, (minimal ?? note.html) + "\n");
					writeFileSync(
						`${base}.json`,
						JSON.stringify(
							{ check: f.check, sig: f.sig, seed, detail: f.detail, minimal: minimal !== undefined, original: note.html },
							null,
							2,
						) + "\n",
					);
				}
				if (o.verbose) console.log(`${label}: ${f.check}: ${f.detail}\n  ${JSON.stringify(minimal ?? note.html)}`);
			}
		}
	} finally {
		result.bridgeRestarts = bridge.restarts;
		bridge.close();
	}
	return result;
}

export function summary(r: FuzzResult): string {
	const rows = CHECKS.map((c) => `  ${c.padEnd(4)} ${String(r.failuresByCheck[c] ?? 0).padStart(6)}`);
	return [
		`seeds run ${r.seeds} + ${r.fixtures} fixtures (oracle: note-editor ${r.oracleCommit.slice(0, 7)}; oracle errors ${r.oracleErrors}; bridge restarts ${r.bridgeRestarts})`,
		"  check  failures",
		...rows,
	].join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const get = (n: string) => {
		const i = args.indexOf(n);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const bridge = get("--bridge");
	if (!bridge) throw new Error("usage: bun scripts/fuzz/fuzz-notes.ts --bridge <pm_bridge binary> --seeds N [--seed S] [--out dir]");
	const one = get("--seed");
	const r = await runFuzz({
		bridge,
		seeds: one !== undefined ? 1 : Number(get("--seeds") ?? 100),
		start: one !== undefined ? Number(one) : Number(get("--start") ?? 0),
		steps: Number(get("--steps") ?? 50),
		out: get("--out"),
		oracle: get("--oracle"),
		shrinkMax: Number(get("--shrink-max") ?? 2),
		verbose: one !== undefined || args.includes("--show"),
	});
	console.log(summary(r));
	process.exit(Object.entries(r.failuresByCheck).some(([c, n]) => c !== "R2c" && n > 0) ? 1 : 0);
}
