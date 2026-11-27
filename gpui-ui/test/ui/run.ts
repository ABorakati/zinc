// The UI test harness: the real app, in the background, driven with real input.
//
//   bun run test:ui                  every scenario
//   bun run test:ui list edit        those whose file or name contains one of the words
//   ZN_UI_SCENARIOS="mouse wheel, open pdf button"   the same filter from the environment, comma-separated (CI's manual run passes it)
//   The default (Windows): the packaged app (out/package-aot, built again first when its sources are newer: appPackage.ts), driven over
//     a pipe with the renderer that ships. A scenario marked inProcessOnly needs what only the in-process mode has; it runs there instead,
//     and is counted apart.
//   --app <exe>: that package only; inProcessOnly scenarios are skipped. --no-build: the package as it is, even if it is older than its sources.
//   --in-process: every scenario in its own process on GPUI's test renderer (the default on macOS, where the app's windows cannot be hidden)
//   --show: the windows on screen, to watch (they open on a hidden desktop otherwise: background.ts)
//   options: --jobs <n> (default half the cores, 2 to 8)  --out <dir> (default out/ui-test)  --keep (leave the temporary folders)  --list
//
// Each scenario runs in a process of its own, on a made-up library, with its own user folders: the machine's library, settings,
// clipboard and network are out of reach (fences.ts). A failure leaves result.json, screen.txt and failure.png in --out.
// Windows and macOS only: GPUI's test renderer needs one of them.
import { SMALL_WINDOW } from "./limits";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUN_CACHE, compileApp } from "./compiled";
import { ensurePackage, newerSource, packagedApp, recordPass } from "./appPackage";

const HERE = import.meta.dir;
const GPUI = resolve(HERE, "..", "..");
const WORKER = join(HERE, "worker.ts");
/** A scenario's process: the app as compiled once for this run (compiled.ts). */
const APP_BUN = [process.execPath, `--config=${join(HERE, "bunfig.toml")}`];
const TIMEOUT_MS = 90_000;

const words: string[] = [];
let jobs = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
let out = join(GPUI, "out", "ui-test");
let keep = false;
let listOnly = false;
let show = false;
let appExe: string | undefined;
/** default: the package, with inProcessOnly scenarios in-process; app: the given package only; in-process: no package */
let mode: "default" | "app" | "in-process" = process.platform === "win32" ? "default" : "in-process";
let build = true;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a === "--jobs") jobs = Math.max(1, Number(argv[++i]) || 1);
	else if (a === "--out") out = resolve(argv[++i]!);
	else if (a === "--keep") keep = true;
	else if (a === "--list") listOnly = true;
	else if (a === "--show") show = true;
	else if (a === "--app") (appExe = resolve(argv[++i] ?? "")), (mode = "app");
	else if (a === "--in-process") (appExe = undefined), (mode = "in-process");
	else if (a === "--no-build") build = false;
	else if (a.startsWith("--")) {
		console.error(`unknown option ${a}`);
		process.exit(2);
	} else words.push(a.toLowerCase());
}
for (const w of (process.env.ZN_UI_SCENARIOS ?? "").split(",")) if (w.trim()) words.push(w.trim().toLowerCase());

if (process.platform !== "win32" && process.platform !== "darwin") {
	console.error("The UI harness needs GPUI's test renderer, which exists for Windows and macOS only.");
	process.exit(2);
}

/** The environment of a child: the system's own variables, none of Zinc's or Zotero's, every user folder inside `root`. */
function childEnv(root: string, appExe: string | undefined): Record<string, string> {
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
		...(appExe ? { ZN_UI_APP: appExe } : {}),
		ZN_UI_STATE: join(root, "ui-state.json"),
		ZN_LOG_DIR: dir("logs"),
		ZN_CORE_DIRECT: "1",
		ZN_SYNC: "0",
		ZN_ZPORT: "0",
		ZN_PREFETCH: "0",
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE,
	});
}

interface Job {
	file: string;
	area: string;
	index: number;
	name: string;
	knownBug?: string;
	inProcessOnly?: string;
}

interface Result extends Job {
	outcome: "pass" | "fail" | "known" | "fixed" | "skipped";
	ms: number;
	failure?: string;
	dir: string;
	/** run in-process although the run drives the package (an inProcessOnly scenario in the default mode) */
	inProcess?: boolean;
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
		const p = Bun.spawn([...APP_BUN, WORKER, file, "list"], { cwd: GPUI, env: childEnv(root, undefined), stdout: "pipe", stderr: "pipe", windowsHide: true });
		const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (code !== 0) {
			unreadable.push(f);
			console.error(`FAIL  ${f} could not be loaded: ${err.trim().slice(-600)}`);
			continue;
		}
		const area = f.replace(".ui.ts", "");
		const list = JSON.parse(text.trim().split("\n").at(-1)!) as { name: string; knownBug?: string; inProcessOnly?: string }[];
		list.forEach((s, index) => found.push({ file, area, index, ...s }));
	}
	return words.length ? found.filter((j) => words.some((w) => `${j.area} ${j.name}`.toLowerCase().includes(w))) : found;
}

async function runJob(job: Job): Promise<Result> {
	if (mode === "app" && job.inProcessOnly) return { ...job, outcome: "skipped", ms: 0, failure: job.inProcessOnly, dir: "" };
	// the default mode runs such a scenario in-process: it needs what only that mode has
	const inProcess = !appExe || !!job.inProcessOnly;
	const exe = inProcess ? undefined : appExe;
	const r = await runIn(job, exe);
	return mode === "default" && inProcess ? { ...r, inProcess: true } : r;
}

async function runIn(job: Job, appExe: string | undefined): Promise<Result> {
	const root = mkdtempSync(join(base, "s-"));
	const slug = job.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60);
	const dir = join(out, job.area, `${job.index + 1}-${slug}`);
	mkdirSync(dir, { recursive: true });
	for (const stale of ["result.json", "screen.txt", "failure.png", "stderr.txt"]) rmSync(join(dir, stale), { force: true });

	const started = performance.now();
	const p = Bun.spawn([...APP_BUN, WORKER, job.file, "run", String(job.index), dir], {
		cwd: GPUI,
		env: childEnv(root, appExe),
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
	if (appExe && !existsSync(appExe)) {
		console.error(`--app: no such file: ${appExe}`);
		process.exit(2);
	}
	if (mode === "default" && !listOnly) {
		mkdirSync(out, { recursive: true });
		if (build) {
			const p = await ensurePackage(GPUI, join(out, "package.log"));
			if (p.built) console.log(`package built in ${(p.ms / 1000).toFixed(1)} s`);
			appExe = p.exe;
		} else {
			appExe = packagedApp(GPUI);
			const stale = newerSource(GPUI, appExe);
			if (stale === appExe) {
				console.error(`--no-build: there is no package at ${appExe}`);
				process.exit(2);
			}
			if (stale) console.warn(`--no-build: the package is older than ${stale}`);
		}
	}
	// (the packaged app is compiled already; the scenario processes only load the harness)
	const compileStarted = performance.now();
	const files = await compileApp();
	if (!listOnly) console.log(`${appExe ? `driving the packaged app ${appExe}; ` : ""}app compiled: ${files} files in ${((performance.now() - compileStarted) / 1000).toFixed(1)} s`);
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
					if (r.failure?.includes(SMALL_WINDOW)) {
						queue.length = 0; // every other scenario would fail the same way: stop here
						console.error(r.failure);
					}
					const label = { pass: "ok   ", fail: "FAIL ", known: "known", fixed: "FIXED", skipped: "skip " }[r.outcome];
					if (r.outcome === "skipped") console.log(`${label} ${r.area}: ${r.name} (skipped (in-process only: ${r.failure}))`);
					else console.log(`${label} ${r.area}: ${r.name} (${(r.ms / 1000).toFixed(1)} s${r.inProcess ? ", in-process" : ""})`);
					if (r.outcome === "fail") console.log(`      ${r.failure?.replaceAll("\n", "\n      ")}\n      evidence: ${r.dir}`);
					if (r.outcome === "fixed") console.log(`      marked as a known bug, and it passes: take the mark off (${r.knownBug})`);
				}
			}),
		);
		const n = (o: Result["outcome"]) => results.filter((r) => r.outcome === o).length;
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
		const inProc = results.filter((r) => r.inProcess).length;
		console.log(`\n${n("pass")} passed, ${n("fail")} failed, ${n("known")} known bugs, ${n("fixed")} known bugs now fixed${n("skipped") ? `, ${n("skipped")} skipped (in-process only)` : ""} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
		if (appExe) console.log(`the packaged app ran ${results.length - inProc - n("skipped")}${inProc ? `; ${inProc} needed the in-process mode (inProcessOnly) and ran there` : ""}`);
		if (unreadable.length) console.log(`could not be loaded: ${unreadable.join(", ")}`);
		if (unreadable.length || n("fail") || n("fixed")) process.exitCode = 1;
		// the release gate (scripts/release.ts): a whole default run of this package with nothing failed, skipped or unreadable
		else if (mode === "default" && appExe && !words.length && !n("skipped"))
			recordPass(appExe, { passed: n("pass"), knownBugs: n("known"), inProcess: inProc });
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
