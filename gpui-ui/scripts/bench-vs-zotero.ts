// Zinc vs Zotero 10 on the same library: start-up, "library ready", memory, quick-search latency, install size.
//
//   bun gpui-ui/scripts/bench-vs-zotero.ts                     # all defaults: makes its own copies, 3 runs each, cleans up
//   bun gpui-ui/scripts/bench-vs-zotero.ts --runs 3 --work C:/scratch/bench --keep
//
// Options (all optional):
//   --zotero-exe   C:/Program Files/Zotero/zotero.exe           installed Zotero 10
//   --zotero-data  <real Zotero data dir>                       default %USERPROFILE%/Zotero (only READ, to make the copy)
//   --next-exe     %LOCALAPPDATA%/Programs/Zinc/zotero-next-gpui.exe (or Programs/Zotero Next for an install made before the rename)
//   --next-lib     <real Zinc library .sqlite>           default <repo>/data/library.sqlite (opened read-only; VACUUM INTO a copy)
//   --work         scratch dir for the copies and profiles      default <tmp>/zn-bench-vs-zotero (deleted at the end unless --keep)
//   --zotero-port 23131  --next-port 23191  --next-zport 23192   must differ from 23119/23120 (a running Zinc uses them)
//   --runs 3  --settle 12 (seconds after "ready" before sampling memory)  --calls 10 (timed calls per search query)
//   --queries "word,author,rare,year"                           default: picked from the library copy
//   --no-warmup   skip the unmeasured first Zotero launch (a new profile does one-off set-up work on its first start)
//   --visible     launch with a normal window instead of SW_SHOWMINNOACTIVE
//   --keep        keep the work dir
//
// ISOLATION. The real Zotero (profile in %APPDATA%/Zotero, data dir, sync, login) and the real Zinc library/settings are never
// written. Zotero 10 runs from a NEW profile (-profile <scratch> -no-remote) whose user.js points extensions.zotero.dataDir at a
// COPY (zotero.sqlite + -wal/-shm, styles/, translators/; no storage/), and turns off sync, updates, translator/style updates,
// first-run pages, telemetry, auto-rename/-recognize. Zinc runs on a VACUUM INTO copy with APPDATA/LOCALAPPDATA pointed at
// a scratch folder and ZN_SYNC=0. The script refuses to start if a zotero.exe is running (it never closes one it did not start).
//
// MEASURED (per run, a fresh process each time; windows are launched minimised without activation):
//   window ms   process start -> first visible top-level window owned by the process tree (EnumWindows, polled ~every 5 ms)
//   title ms    Zotero only: process start -> main window titled "<collection> - Zotero" (the library is on screen)
//   ready ms    process start -> the local data API answers 200 with at least one item. Zotero: /api/users/0/items/top?limit=1 (the
//               handler waits for the library's items to be loaded); Next: /api/items?limit=1. A PROXY for "items loaded", not for
//               "first row painted".
//   memory      sum over the whole process tree, <settle> s after ready: PrivateUsage and WorkingSetSize (GetProcessMemoryInfo)
//   search ms   warm quick-search calls through the same API (Zotero qmode=titleCreatorYear; Next ?q=), limit=25, JSON body read
// Windows only. Needs Bun (bun:ffi). Does not drive the mouse or keyboard.
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const argv = process.argv.slice(2);
const opt = (n: string, d: string) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const fwd = (p: string) => p.replaceAll("\\", "/");

const zExe = opt("zotero-exe", "C:/Program Files/Zotero/zotero.exe");
const zData = opt("zotero-data", join(homedir(), "Zotero"));
const nExe = opt(
	"next-exe",
	["Zinc", "Zotero Next"]
		.map((d) => join(process.env.LOCALAPPDATA ?? "", "Programs", d, "zotero-next-gpui.exe"))
		.find((f) => existsSync(f)) ?? join(process.env.LOCALAPPDATA ?? "", "Programs/Zinc/zotero-next-gpui.exe"),
); // installs made before the rename keep the "Zotero Next" folder
const nLibSrc = opt("next-lib", join(repo, "data/library.sqlite"));
const work = resolve(opt("work", join(tmpdir(), "zn-bench-vs-zotero")));
const zPort = Number(opt("zotero-port", "23131"));
const nPort = Number(opt("next-port", "23191"));
const nZPort = Number(opt("next-zport", "23192"));
const runs = Number(opt("runs", "3"));
const settleS = Number(opt("settle", "12"));
const calls = Number(opt("calls", "10"));
const warmup = !has("no-warmup");
const visible = has("visible");

// ---- safety ---------------------------------------------------------------------------------------------------------------------
const inside = (p: string, dir: string) => {
	const a = fwd(resolve(p)).toLowerCase(),
		b = fwd(resolve(dir)).toLowerCase() + "/";
	return (a + "/").startsWith(b);
};
for (const bad of [zData, join(repo, "data"), join(process.env.APPDATA ?? "", "Zotero")]) {
	if (inside(work, bad)) {
		console.error(`refusing --work ${work}: inside ${bad}`);
		process.exit(2);
	}
}
if ([zPort, nPort, nZPort].some((p) => p === 23119 || p === 23120)) {
	console.error("ports 23119/23120 belong to the real apps");
	process.exit(2);
}
for (const f of [zExe, nExe, join(zData, "zotero.sqlite"), nLibSrc])
	if (!existsSync(f)) {
		console.error(`missing ${f}`);
		process.exit(2);
	}

// ---- Win32 via bun:ffi ----------------------------------------------------------------------------------------------------------
const u32 = dlopen("user32.dll", {
	EnumWindows: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
	GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
	IsWindowVisible: { args: [FFIType.u64], returns: FFIType.i32 },
	GetWindow: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u64 },
	GetWindowTextW: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	PostMessageW: { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
}).symbols;
const k32 = dlopen("kernel32.dll", {
	CreateProcessW: {
		args: [
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.i32,
			FFIType.u32,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
		],
		returns: FFIType.i32,
	},
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
	Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
	TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
	GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
	WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
	CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
}).symbols;
const psapi = dlopen("psapi.dll", {
	GetProcessMemoryInfo: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
}).symbols;

const wstr = (s: string) => Buffer.from(s + "\0", "utf16le");

/** pid -> { parent, exe } for every process. */
function snapshot(): Map<number, { parent: number; exe: string }> {
	const m = new Map<number, { parent: number; exe: string }>();
	const h = k32.CreateToolhelp32Snapshot(2, 0);
	const e = Buffer.alloc(568);
	e.writeUInt32LE(568, 0);
	for (let ok = k32.Process32FirstW(h, ptr(e)); ok; ok = k32.Process32NextW(h, ptr(e))) {
		m.set(e.readUInt32LE(8), {
			parent: e.readUInt32LE(32),
			exe: e
				.toString("utf16le", 44, 44 + 520)
				.split("\0")[0]!
				.toLowerCase(),
		});
	}
	k32.CloseHandle(h);
	return m;
}
function tree(root: number, snap = snapshot()): number[] {
	const ids = new Set([root]);
	for (let grew = true; grew;) {
		grew = false;
		for (const [pid, p] of snap)
			if (!ids.has(pid) && ids.has(p.parent)) {
				ids.add(pid);
				grew = true;
			}
	}
	return [...ids].filter((p) => snap.has(p));
}
function mem(pid: number): { priv: number; ws: number } | null {
	const h = k32.OpenProcess(0x1000 | 0x400 | 0x10, 0, pid);
	if (!h) return null;
	const b = Buffer.alloc(80);
	b.writeUInt32LE(80, 0);
	const ok = psapi.GetProcessMemoryInfo(h, ptr(b), 80);
	k32.CloseHandle(h);
	return ok ? { ws: Number(b.readBigUInt64LE(16)), priv: Number(b.readBigUInt64LE(72)) } : null;
}
function treeMem(root: number) {
	let priv = 0,
		ws = 0,
		n = 0;
	for (const p of tree(root)) {
		const m = mem(p);
		if (m) {
			priv += m.priv;
			ws += m.ws;
			n++;
		}
	}
	return { privMB: +(priv / 1048576).toFixed(1), wsMB: +(ws / 1048576).toFixed(1), procs: n };
}
function killTree(root: number) {
	for (const p of tree(root).reverse()) {
		const h = k32.OpenProcess(0x1, 0, p);
		if (h) {
			k32.TerminateProcess(h, 1);
			k32.CloseHandle(h);
		}
	}
}
function zoteroRunning(): number[] {
	return [...snapshot()].filter(([, p]) => p.exe === "zotero.exe").map(([pid]) => pid);
}

/** Visible, un-owned top-level windows: hwnd + pid + title. */
let wins: { hwnd: bigint; pid: number; title: string }[] = [];
const enumCb = new JSCallback(
	(hwnd: bigint) => {
		if (u32.IsWindowVisible(hwnd) && u32.GetWindow(hwnd, 4) === 0n) {
			const pid = Buffer.alloc(4);
			u32.GetWindowThreadProcessId(hwnd, ptr(pid));
			const t = Buffer.alloc(512);
			const n = u32.GetWindowTextW(hwnd, ptr(t), 256);
			wins.push({ hwnd, pid: pid.readUInt32LE(0), title: t.toString("utf16le", 0, n * 2) });
		}
		return 1;
	},
	{ args: [FFIType.u64, FFIType.i64], returns: FFIType.i32 },
);
function visibleWindows() {
	wins = [];
	u32.EnumWindows(enumCb.ptr!, 0);
	return wins;
}

/** CreateProcessW with an environment block; SW_SHOWMINNOACTIVE unless --visible. */
function launch(exe: string, args: string[], env: Record<string, string>, cwd: string): { pid: number; hProcess: bigint } {
	const cmd = wstr([exe, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" "));
	const merged: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
	const envBlock = Buffer.concat([...Object.entries(merged).map(([k, v]) => wstr(`${k}=${v}`)), Buffer.from("\0\0", "utf16le")]);
	const si = Buffer.alloc(104);
	si.writeUInt32LE(104, 0);
	if (!visible) {
		si.writeUInt32LE(1, 60);
		si.writeUInt16LE(7, 64);
	} // STARTF_USESHOWWINDOW, SW_SHOWMINNOACTIVE
	const pi = Buffer.alloc(24);
	const cwdW = wstr(cwd);
	if (!k32.CreateProcessW(ptr(wstr(exe)), ptr(cmd), null, null, 0, 0x400, ptr(envBlock), ptr(cwdW), ptr(si), ptr(pi)))
		throw new Error(`CreateProcess failed for ${exe}`);
	k32.CloseHandle(pi.readBigUInt64LE(8));
	return { pid: pi.readUInt32LE(16), hProcess: pi.readBigUInt64LE(0) };
}
const exitCode = (h: bigint) => {
	const b = Buffer.alloc(4);
	k32.GetExitCodeProcess(h, ptr(b));
	return b.readUInt32LE(0);
};
const exited = (h: bigint) => k32.WaitForSingleObject(h, 0) === 0;
/** Zotero (like Firefox) starts a launcher process that re-executes itself and exits; the real application is then a NEW zotero.exe whose
 * parent is not a zotero.exe. zotero.exe is checked to be absent before every launch, so any such process is ours. */
function adoptZoteroRoot(): { pid: number; h: bigint } | null {
	const snap = snapshot();
	const z = new Set([...snap].filter(([, p]) => p.exe === "zotero.exe").map(([pid]) => pid));
	for (const pid of z)
		if (!z.has(snap.get(pid)!.parent)) {
			const h = k32.OpenProcess(0x100000 | 0x1, 0, pid);
			if (h) return { pid, h };
		}
	return null;
}

// ---- scratch layout, copies -----------------------------------------------------------------------------------------------------
const zCopy = join(work, "zotero-data");
const zProfile = join(work, "zotero-profile");
const nLib = join(work, "next.sqlite");
const nAppData = join(work, "next-appdata");
const nLocal = join(work, "next-localappdata");

function dirSize(d: string): number {
	let t = 0;
	try {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			t += e.isDirectory() ? dirSize(p) : statSync(p).size;
		}
	} catch {
		/* unreadable */
	}
	return t;
}
const mb = (b: number) => +(b / 1048576).toFixed(0);

function prepare() {
	rmSync(work, { recursive: true, force: true });
	for (const d of [zCopy, zProfile, nAppData, nLocal]) mkdirSync(d, { recursive: true });
	try {
		const fs = statfsSync(dirname(work));
		const freeGB = (fs.bavail * fs.bsize) / 1e9;
		console.log(`free space on the work drive: ${freeGB.toFixed(0)} GB`);
		if (freeGB < 15) {
			console.error("less than 15 GB free; stopping");
			process.exit(2);
		}
	} catch {
		console.log("(could not read free space; make sure the drive has more than 15 GB)");
	}

	// Zotero data copy: database triplet together, plus styles/ and translators/. No storage/ (no PDF is opened).
	for (const f of ["zotero.sqlite", "zotero.sqlite-wal", "zotero.sqlite-shm"])
		if (existsSync(join(zData, f))) cpSync(join(zData, f), join(zCopy, f));
	for (const d of ["styles", "translators"]) if (existsSync(join(zData, d))) cpSync(join(zData, d), join(zCopy, d), { recursive: true });
	mkdirSync(join(zCopy, "storage"));

	// Zotero profile: user.js is read at every start and written into prefs.js. Names checked against Zotero 10.0.7's defaults.
	const prefs: Record<string, string | number | boolean> = {
		"extensions.zotero.dataDir": zCopy.replaceAll("/", "\\"),
		"extensions.zotero.useDataDir": true,
		"extensions.zotero.warnOnUnsafeDataDir": false,
		"extensions.zotero.httpServer.enabled": true,
		"extensions.zotero.httpServer.port": zPort,
		"extensions.zotero.httpServer.localAPI.enabled": true,
		"extensions.zotero.sync.autoSync": false,
		"extensions.zotero.sync.fulltext.enabled": false,
		"extensions.zotero.sync.reminder.autoSync.enabled": false,
		"extensions.zotero.firstRun2": false,
		"extensions.zotero.firstRunGuidance": false,
		"extensions.zotero.firstRunGuidanceShown.readAloud": false,
		"extensions.zotero.automaticScraperUpdates": false,
		"extensions.zotero.reportTranslationFailure": false,
		"extensions.zotero.autoRenameFiles": false,
		"extensions.zotero.autoRenameFiles.onMetadataChange": false,
		"extensions.zotero.autoRenameFiles.bannerShown": true,
		"extensions.zotero.autoRecognizeFiles": false,
		"extensions.zotero.automaticSnapshots": false,
		"extensions.zotero.downloadAssociatedFiles": false,
		"extensions.zotero.backup.numBackups": 0,
		"app.update.enabled": false,
		"app.update.auto": false,
		"app.update.checkInstallTime": false,
		"extensions.update.enabled": false,
		"extensions.update.autoUpdateDefault": false,
		"datareporting.policy.dataSubmissionEnabled": false,
		"datareporting.healthreport.uploadEnabled": false,
		"toolkit.telemetry.enabled": false,
		"toolkit.telemetry.unified": false,
		"network.captive-portal-service.enabled": false,
		"browser.shell.checkDefaultBrowser": false,
	};
	writeFileSync(
		join(zProfile, "user.js"),
		Object.entries(prefs)
			.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
			.join("\n") + "\n",
	);

	// Zinc library copy (source opened read-only), switched to WAL like the real one.
	if (/zotero-next[\\/]data[\\/]/i.test(nLib)) throw new Error("copy would land in the real data dir");
	const src = new Database(nLibSrc, { readonly: true });
	try {
		src.run(`VACUUM INTO '${fwd(nLib).replaceAll("'", "''")}'`);
	} finally {
		src.close();
	}
	const c = new Database(nLib);
	c.run("PRAGMA journal_mode = WAL");
	c.close();
	console.log(`copies: Zotero data ${mb(dirSize(zCopy))} MB, Zinc library ${mb(statSync(nLib).size)} MB, in ${work}`);
}

// ---- queries from the library copy ----------------------------------------------------------------------------------------------
function pickQueries(): { label: string; q: string }[] {
	const given = opt("queries", "");
	if (given) {
		const [a, b, c, d] = given.split(",");
		return [
			{ label: "common word", q: a! },
			{ label: "author", q: b! },
			{ label: "rare word", q: c! },
			{ label: "year", q: d! },
		].filter((x) => x.q);
	}
	const db = new Database(join(zCopy, "zotero.sqlite"), { readonly: true });
	try {
		const titles = db
			.query<{ v: string }, []>(
				`SELECT v.value AS v FROM itemData d JOIN itemDataValues v USING(valueID) WHERE d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title') AND d.itemID NOT IN (SELECT itemID FROM deletedItems)`,
			)
			.all();
		const df = new Map<string, number>();
		for (const t of titles) for (const w of new Set(t.v.toLowerCase().match(/[a-z]{6,}/g) ?? [])) df.set(w, (df.get(w) ?? 0) + 1);
		const stop = new Set(["between", "analysis", "review", "study", "effects", "versus", "outcomes", "following", "systematic"]);
		const sorted = [...df].filter(([w]) => !stop.has(w)).sort((a, b) => b[1] - a[1]);
		const rare = [...df]
			.filter(([w, n]) => n === 1 && w.length >= 9)
			.map(([w]) => w)
			.sort();
		const author = db
			.query<{ n: string }, []>(
				`SELECT c.lastName AS n FROM itemCreators ic JOIN creators c USING(creatorID) WHERE length(c.lastName)>=4 GROUP BY lower(c.lastName) ORDER BY count(*) DESC LIMIT 1`,
			)
			.get();
		const years = db
			.query<{ y: string }, []>(
				`SELECT substr(v.value,1,4) AS y FROM itemData d JOIN itemDataValues v USING(valueID) WHERE d.fieldID=(SELECT fieldID FROM fields WHERE fieldName='date') AND substr(v.value,1,4) GLOB '[12][0-9][0-9][0-9]' GROUP BY y ORDER BY count(*) DESC LIMIT 1`,
			)
			.get();
		return [
			{ label: "common word", q: sorted[0]?.[0] ?? "patients" },
			{ label: "author", q: author?.n ?? "smith" },
			{ label: "rare word", q: rare[Math.floor(rare.length / 2)] ?? "zzzzzzzzz" },
			{ label: "year", q: years?.y ?? "2020" },
		];
	} finally {
		db.close();
	}
}

// ---- one launch -----------------------------------------------------------------------------------------------------------------
interface App {
	id: "zotero" | "next";
	exe: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	readyUrl: string;
	searchUrl: (q: string) => string;
}
const zApp: App = {
	id: "zotero",
	exe: zExe,
	args: ["-profile", zProfile, "-no-remote"],
	env: {},
	cwd: dirname(zExe),
	readyUrl: `http://127.0.0.1:${zPort}/api/users/0/items/top?limit=1`,
	searchUrl: (q) => `http://127.0.0.1:${zPort}/api/users/0/items/top?q=${encodeURIComponent(q)}&qmode=titleCreatorYear&limit=25`,
};
const nApp: App = {
	id: "next",
	exe: nExe,
	args: [],
	cwd: dirname(nExe),
	env: { ZN_LIBRARY: nLib, ZN_PORT: String(nPort), ZN_ZPORT: String(nZPort), ZN_SYNC: "0", APPDATA: nAppData, LOCALAPPDATA: nLocal },
	readyUrl: `http://127.0.0.1:${nPort}/api/items?limit=1`,
	searchUrl: (q) => `http://127.0.0.1:${nPort}/api/items?q=${encodeURIComponent(q)}&limit=25`,
};

const count = (b: unknown, h: Headers): number | null => {
	const t = h.get("total-results");
	if (t) return Number(t);
	if (Array.isArray(b)) return b.length;
	if (b && typeof b === "object") {
		const o = b as Record<string, unknown>;
		for (const k of ["total", "totalResults", "count"]) if (typeof o[k] === "number") return o[k] as number;
		for (const k of ["items", "results", "data"]) if (Array.isArray(o[k])) return (o[k] as unknown[]).length;
	}
	return null;
};
let lastProbe = "";
async function probe(url: string): Promise<{ ok: boolean; body?: unknown; headers?: Headers }> {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "zn-bench" } });
		lastProbe = `HTTP ${r.status}`;
		if (r.status !== 200) return { ok: false };
		const body = await r.json().catch(() => null);
		const n = count(body, r.headers);
		const arr = Array.isArray(body) ? body.length : n;
		return { ok: (arr ?? 0) > 0 || (n ?? 0) > 0, body, headers: r.headers };
	} catch (e) {
		lastProbe = String(e).slice(0, 80);
		return { ok: false };
	}
}

interface Result {
	app: string;
	warm: boolean;
	windowMs: number | null;
	titleMs: number | null;
	windowTitle: string;
	readyMs: number | null;
	privMB: number;
	wsMB: number;
	procs: number;
	search: Record<string, { medianMs: number; minMs: number; maxMs: number; results: number | null }>;
	closedGracefully: boolean;
	note: string;
}
const med = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};

async function runOne(app: App, queries: { label: string; q: string }[], isWarm: boolean): Promise<Result> {
	const stray = zoteroRunning();
	if (stray.length)
		throw new Error(
			`zotero.exe is running (pid ${stray.join(",")}); close it yourself first, this script never closes one it did not start`,
		);
	const r: Result = {
		app: app.id,
		warm: isWarm,
		windowMs: null,
		titleMs: null,
		windowTitle: "",
		readyMs: null,
		privMB: 0,
		wsMB: 0,
		procs: 0,
		search: {},
		closedGracefully: false,
		note: "",
	};
	const t0 = performance.now();
	let { pid, hProcess } = launch(app.exe, app.args, app.env, app.cwd);
	let adopted = false;
	const gone = () => {
		if (!exited(hProcess)) return false;
		if (app.id === "zotero" && !adopted) {
			// wait for the re-executed process
			for (let i = 0; i < 100; i++) {
				const a = adoptZoteroRoot();
				if (a) {
					pid = a.pid;
					hProcess = a.h;
					adopted = true;
					r.note = "launcher re-executed; following pid " + pid;
					return false;
				}
				Bun.sleepSync(20);
			}
		}
		r.note = `launched process exited (code ${exitCode(hProcess)}) after ${Math.round(performance.now() - t0)} ms`;
		return true;
	};
	let hwnd = 0n;
	const deadline = t0 + 90_000;
	let treeCache: number[] = [pid],
		treeAt = 0;
	const winLoop = (async () => {
		while (performance.now() < deadline && r.readyMs == null && !gone()) {
			if (performance.now() - treeAt > 40) {
				treeCache = tree(pid);
				treeAt = performance.now();
			}
			const mine = visibleWindows().filter((x) => treeCache.includes(x.pid));
			const w = mine[0];
			if (w && r.windowMs == null) {
				r.windowMs = Math.round(performance.now() - t0);
				r.windowTitle = w.title;
				hwnd = w.hwnd;
			}
			// Zotero names its main window "<collection> - Zotero" once the library is shown
			const main = mine.find((x) => / - Zotero$/.test(x.title));
			if (main && r.titleMs == null) {
				r.titleMs = Math.round(performance.now() - t0);
				hwnd = main.hwnd;
			}
			await Bun.sleep(5);
		}
	})();
	const readyLoop = (async () => {
		while (performance.now() < deadline && r.readyMs == null && !gone()) {
			// Zotero 10 answers 500 and then stops answering if its local API is hit before start-up has finished (seen: the first
			// request returned 500 after ~3 s, every later one timed out). So the first request is only sent once the main window shows
			// the library (title "... - Zotero"). Zotero ready therefore = max(main window with library, first good API answer).
			if (app.id === "zotero" && r.titleMs == null) {
				await Bun.sleep(5);
				continue;
			}
			const p = await probe(app.readyUrl);
			if (p.ok) r.readyMs = Math.round(performance.now() - t0);
			else await Bun.sleep(20);
		}
	})();
	try {
		await Promise.all([winLoop, readyLoop]);
		if (r.readyMs == null)
			r.note +=
				` last probe: ${lastProbe}; windows: ` +
				visibleWindows()
					.filter((x) => tree(pid).includes(x.pid))
					.map((x) => `"${x.title}"`)
					.join(",");
		if (gone()) r.note = "process exited early";
		if (r.readyMs != null) {
			await Bun.sleep(settleS * 1000);
			const m = treeMem(pid);
			Object.assign(r, { privMB: m.privMB, wsMB: m.wsMB, procs: m.procs });
			for (const { label, q } of queries) {
				await fetch(app.searchUrl(q))
					.then((x) => x.arrayBuffer())
					.catch(() => {}); // warm-up call, not timed
				const ts: number[] = [];
				let results: number | null = null;
				for (let i = 0; i < calls; i++) {
					const s = performance.now();
					const resp = await fetch(app.searchUrl(q), { headers: { "User-Agent": "zn-bench" } });
					const txt = await resp.text();
					ts.push(performance.now() - s);
					if (results == null) {
						try {
							results = count(JSON.parse(txt), resp.headers);
						} catch {
							/* not json */
						}
					}
				}
				r.search[label] = {
					medianMs: +med(ts).toFixed(1),
					minMs: +Math.min(...ts).toFixed(1),
					maxMs: +Math.max(...ts).toFixed(1),
					results,
				};
			}
		}
		// close: WM_CLOSE to the window, up to 8 s, then kill the tree
		if (!gone()) {
			if (hwnd) u32.PostMessageW(hwnd, 0x10, 0n, 0n);
			const until = performance.now() + 8000;
			while (!gone() && performance.now() < until) await Bun.sleep(100);
			r.closedGracefully = exited(hProcess);
		}
	} finally {
		killTree(pid);
		k32.CloseHandle(hProcess);
	} // any survivors (WebView2, helpers); also on errors
	await Bun.sleep(1500);
	return r;
}

// ---- main -----------------------------------------------------------------------------------------------------------------------
async function zoteroVersion(): Promise<string> {
	try {
		return /^Version=(.+)$/m.exec(await Bun.file(join(dirname(zExe), "app/application.ini")).text())?.[1]?.trim() ?? "unknown";
	} catch {
		return "unknown";
	}
}

async function main() {
	if (zoteroRunning().length) {
		console.error("zotero.exe is running; close it yourself and re-run. Nothing was changed.");
		process.exit(2);
	}
	const zv = await zoteroVersion();
	console.log(`Zotero ${zv} (${zExe}); Zinc ${nExe}; runs=${runs}, settle=${settleS}s, calls=${calls}`);
	prepare();
	const queries = pickQueries();
	console.log("queries:", queries.map((x) => `${x.label}=${x.q}`).join(", "));
	const all: Result[] = [];
	let sizes: Record<string, number> = {};
	try {
		if (warmup) {
			const w = await runOne(zApp, queries, true);
			console.log("warm-up (not counted)", JSON.stringify({ ...w, search: undefined }));
			all.push(w);
		}
		for (let i = 1; i <= runs; i++) {
			for (const app of [zApp, nApp]) {
				const r = await runOne(app, queries, false);
				all.push(r);
				console.log(
					`run ${i} ${app.id.padEnd(6)} window=${r.windowMs} title=${r.titleMs} ready=${r.readyMs} priv=${r.privMB} ws=${r.wsMB} procs=${r.procs} closed=${r.closedGracefully} ${r.note} title="${r.windowTitle}"`,
				);
				console.log(
					"   search ms (median):",
					Object.entries(r.search)
						.map(([k, v]) => `${k}=${v.medianMs} [${v.results} hits]`)
						.join("  "),
				);
			}
		}
	} finally {
		// sizes are measured before the copies go
		sizes = {
			zoteroProgramMB: mb(dirSize(dirname(zExe))),
			zoteroDataDirMB: mb(dirSize(zData)),
			zoteroDbMB: mb(statSync(join(zData, "zotero.sqlite")).size),
			zoteroProfileMB: mb(dirSize(join(process.env.APPDATA ?? "", "Zotero"))),
			nextProgramMB: mb(dirSize(dirname(nExe))),
			nextLibraryMB: mb(statSync(nLibSrc).size),
			nextDataDirMB: mb(dirSize(dirname(nLibSrc))),
		};
		if (!has("keep")) {
			try {
				rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
			} catch (e) {
				console.error(`could not delete ${work}: ${e}`);
			}
		}
	}
	const ms = all.filter((r) => !r.warm);
	const stat = (app: string, f: (r: Result) => number | null | undefined) => {
		const v = ms
			.filter((r) => r.app === app)
			.map(f)
			.filter((x): x is number => x != null && !Number.isNaN(x));
		return v.length ? { median: med(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null;
	};
	const summary: Record<string, unknown> = {};
	for (const app of ["zotero", "next"]) {
		const s: Record<string, unknown> = {
			windowMs: stat(app, (r) => r.windowMs),
			readyMs: stat(app, (r) => r.readyMs),
			privMB: stat(app, (r) => r.privMB),
			wsMB: stat(app, (r) => r.wsMB),
			procs: stat(app, (r) => r.procs),
		};
		for (const { label } of queries) {
			s[`search:${label}`] = {
				pooledMedianMs: med(ms.filter((r) => r.app === app).flatMap((r) => (r.search[label] ? [r.search[label]!.medianMs] : []))),
				...stat(app, (r) => r.search[label]?.medianMs),
				hits: ms.find((r) => r.app === app)?.search[label]?.results,
			};
		}
		summary[app] = s;
	}
	const out = { zoteroVersion: zv, runs, settleS, calls, queries, sizes, summary, raw: all };
	console.log("\n" + JSON.stringify(out, null, 1));
	console.log(
		`Zotero warm-up (first launch of a new profile): ${warmup ? JSON.stringify({ windowMs: all[0]!.windowMs, readyMs: all[0]!.readyMs }) : "skipped"}`,
	);
	console.log("Done. Copies and scratch profiles " + (has("keep") ? `kept in ${work}` : "deleted") + ".");
}
await main();
