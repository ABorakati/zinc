// The UI test harness: the real app, in the background, driven with real input.
//
//   bun run test:ui                  every scenario
//   bun run test:ui list edit        those whose file or name contains one of the words
//   --show: the windows on screen, to watch (they open on a hidden desktop otherwise: background.ts)
//   options: --jobs <n> (default half the cores, 2 to 8)  --out <dir> (default out/ui-test)  --keep (leave the temporary folders)  --list
//
// Each scenario runs in a process of its own, on a made-up library, with its own user folders: the machine's library, settings,
// clipboard and network are out of reach (fences.ts). A failure leaves result.json, screen.txt and failure.png in --out.
// Windows and macOS only: GPUI's test renderer needs one of them.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const GPUI = resolve(HERE, "..", "..");
const WORKER = join(HERE, "worker.ts");
const TIMEOUT_MS = 90_000;

const words: string[] = [];
let jobs = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
let out = join(GPUI, "out", "ui-test");
let keep = false;
let listOnly = false;
let show = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a === "--jobs") jobs = Math.max(1, Number(argv[++i]) || 1);
	else if (a === "--out") out = resolve(argv[++i]!);
	else if (a === "--keep") keep = true;
	else if (a === "--list") listOnly = true;
	else if (a === "--show") show = true;
	else if (a.startsWith("--")) {
		console.error(`unknown option ${a}`);
		process.exit(2);
	} else words.push(a.toLowerCase());
}

if (process.platform !== "win32" && process.platform !== "darwin") {
	console.error("The UI harness needs GPUI's test renderer, which exists for Windows and macOS only.");
	process.exit(2);
}

/** The environment of a child: the system's own variables, none of Zinc's or Zotero's, every user folder inside `root`. */
function childEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || /^(?:ZN_|ZNH_|ZOTERO_|XDG_)/i.test(k)) continue;
		env[k] = v;
	}
	// the PDF engine under test may be given; nothing else of Zinc's environment passes
	for (const k of ["ZN_PDF_DLL", "ZN_PDFIUM_DLL"]) if (process.env[k]) env[k] = process.env[k]!;
	const dir = (...parts: string[]) => {
		const d = join(root, ...parts);
		mkdirSync(d, { recursive: true });
		return d;
	};
	dir("library");
	return Object.assign(env, {
		USERPROFILE: dir("home"),
		HOME: dir("home"),
		APPDATA: dir("home", "AppData", "Roaming"),
		LOCALAPPDATA: dir("home", "AppData", "Local"),
		XDG_CONFIG_HOME: dir("home", "config"),
		XDG_DATA_HOME: dir("home", "data"),
		TEMP: dir("tmp"),
		TMP: dir("tmp"),
		TMPDIR: dir("tmp"),
		ZN_UI_TEST_ROOT: root,
		ZN_UI_TEST_SHOW: show ? "1" : "0",
		ZN_UI_STATE: join(root, "ui-state.json"),
		ZN_LOG_DIR: dir("logs"),
		ZN_CORE_DIRECT: "1",
		ZN_SYNC: "0",
		ZN_ZPORT: "0",
		ZN_PREFETCH: "0",
	});
}

interface Job {
	file: string;
	area: string;
	index: number;
	name: string;
	knownBug?: string;
}

interface Result extends Job {
	outcome: "pass" | "fail" | "known" | "fixed";
	ms: number;
	failure?: string;
	dir: string;
}

const base = mkdtempSync(join(tmpdir(), "zn-ui-"));

/** Scenario files that could not be loaded: the others still run, and the run fails. */
const unreadable: string[] = [];

async function findJobs(): Promise<Job[]> {
	const found: Job[] = [];
	const files = readdirSync(join(HERE, "scenarios")).filter((f) => f.endsWith(".ui.ts")).sort();
	for (const f of files) {
		const file = join(HERE, "scenarios", f);
		const root = mkdtempSync(join(base, "list-"));
		const p = Bun.spawn([process.execPath, WORKER, file, "list"], { cwd: GPUI, env: childEnv(root), stdout: "pipe", stderr: "pipe", windowsHide: true });
		const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (code !== 0) {
			unreadable.push(f);
			console.error(`FAIL  ${f} could not be loaded: ${err.trim().slice(-600)}`);
			continue;
		}
		const area = f.replace(".ui.ts", "");
		const list = JSON.parse(text.trim().split("\n").at(-1)!) as { name: string; knownBug?: string }[];
		list.forEach((s, index) => found.push({ file, area, index, ...s }));
	}
	return words.length ? found.filter((j) => words.some((w) => `${j.area} ${j.name}`.toLowerCase().includes(w))) : found;
}

async function runJob(job: Job): Promise<Result> {
	const root = mkdtempSync(join(base, "s-"));
	const slug = job.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60);
	const dir = join(out, job.area, `${job.index + 1}-${slug}`);
	mkdirSync(dir, { recursive: true });
	for (const stale of ["result.json", "screen.txt", "failure.png", "stderr.txt"]) rmSync(join(dir, stale), { force: true });

	const started = performance.now();
	const p = Bun.spawn([process.execPath, WORKER, job.file, "run", String(job.index), dir], {
		cwd: GPUI,
		env: childEnv(root),
		stdout: "ignore",
		stderr: "pipe",
		windowsHide: true,
	});
	const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
	const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
	clearTimeout(timer);

	const resultFile = join(dir, "result.json");
	let failure: string | undefined;
	if (existsSync(resultFile)) failure = (JSON.parse(readFileSync(resultFile, "utf8")) as { failure?: string }).failure;
	else {
		// no verdict: it crashed or hung, which is never the failure a known bug expects
		writeFileSync(join(dir, "stderr.txt"), err);
		failure = `the app process ended without a verdict (exit ${code}): ${err.trim().split("\n").slice(-6).join("\n")}`;
		return { ...job, outcome: "fail", ms: performance.now() - started, failure, dir };
	}
	if (code !== 0 && !failure) failure = `exit ${code}`;
	const outcome = job.knownBug ? (failure ? "known" : "fixed") : failure ? "fail" : "pass";
	return { ...job, outcome, ms: performance.now() - started, failure, dir };
}

try {
	const todo = await findJobs();
	if (!todo.length) {
		console.error("no scenario matches");
		process.exit(2);
	}
	if (listOnly) {
		for (const j of todo) console.log(`${j.area}: ${j.name}`);
	} else {
		const started = performance.now();
		const results: Result[] = [];
		const queue = [...todo];
		await Promise.all(
			Array.from({ length: Math.min(jobs, todo.length) }, async () => {
				for (let job = queue.shift(); job; job = queue.shift()) {
					const r = await runJob(job);
					results.push(r);
					const label = { pass: "ok   ", fail: "FAIL ", known: "known", fixed: "FIXED" }[r.outcome];
					console.log(`${label} ${r.area}: ${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
					if (r.outcome === "fail") console.log(`      ${r.failure?.replaceAll("\n", "\n      ")}\n      evidence: ${r.dir}`);
					if (r.outcome === "fixed") console.log(`      marked as a known bug, and it passes: take the mark off (${r.knownBug})`);
				}
			}),
		);
		const n = (o: Result["outcome"]) => results.filter((r) => r.outcome === o).length;
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
		console.log(`\n${n("pass")} passed, ${n("fail")} failed, ${n("known")} known bugs, ${n("fixed")} known bugs now fixed (${((performance.now() - started) / 1000).toFixed(1)} s)`);
		if (unreadable.length) console.log(`could not be loaded: ${unreadable.join(", ")}`);
		if (unreadable.length || n("fail") || n("fixed")) process.exitCode = 1;
	}
} finally {
	if (!keep) {
		try {
			rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			console.warn(`could not remove ${base}`);
		}
	}
}
