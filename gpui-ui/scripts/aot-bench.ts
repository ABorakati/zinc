// Startup + memory of the GPUI app: running sources (`bun src/main.tsx`) vs the ahead-of-time compiled executables from build.ts.
//
//   bun scripts/build.ts                         # first: builds out/zotero-next-gpui-{plain,bytecode,bytecode-min}.exe
//   bun scripts/aot-bench.ts                     # 3 runs x (sources + each exe) x (external core, in-process core)
//   bun scripts/aot-bench.ts --variants bytecode,aot   (aot = canary AOT build: bun scripts/build.ts --aot)
//   bun scripts/aot-bench.ts --runs 3 --wait 15 --modes external,inproc --variants sources,plain,bytecode,bytecode-min
//   bun scripts/aot-bench.ts --url http://127.0.0.1:23160 --port 23160        (external core, already running)
//   bun scripts/aot-bench.ts --db-source C:/path/to/lib.sqlite                (library copy the in-process core gets a COPY of)
//
// Per run (one generated PowerShell script, so launch, window poll and memory sample share a clock):
//   * launches the variant with ZN_TRACE=1 and either ZN_URL (external mode) or ZN_DB=<fresh copy> + ZN_PORT (in-process mode),
//   * polls every ~10 ms for a visible top-level window owned by the process tree ("window ms"),
//   * "items ms" = the app's own "[zn-t] first-items" (older builds: items-loaded) milestone (first page of items in the store; src/trace.ts) from stdout,
//   * at <wait> s records PrivateMemorySize64 + WorkingSet64 of the process tree and (external mode) of the core on <port>,
//   * closes the window (CloseMainWindow, taskkill /T /F after 4 s).
// Runs are interleaved (run 1 of every variant, then run 2 ...) so machine drift hits all variants alike.
// SAFETY: the in-process core WRITES to ZN_DB. Each run gets its own copy of --db-source (made once with bun:sqlite VACUUM INTO
// under out/bench/), deleted afterwards. The real library (zotero-next/data) is never opened. Windows open visibly; nothing is clicked.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const runs = Number(arg("runs", "3"));
const waitS = Number(arg("wait", "15"));
const url = arg("url", "http://127.0.0.1:23160");
const port = Number(arg("port", "23160"));
const innerPort = Number(arg("inproc-port", "23162"));
const modes = arg("modes", "external,inproc").split(",");
const dbSource = arg(
	"db-source",
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-core/lib.sqlite",
);
const outDir = join(root, "out");

if (/zotero-next\/data\//i.test(dbSource.replaceAll("\\", "/"))) {
	console.error(`refusing --db-source ${dbSource}: that is the real library`);
	process.exit(2);
}

interface Variant {
	id: string;
	exe: string;
	args: string[];
}
const ALL: Variant[] = [
	{ id: "sources", exe: process.execPath, args: ["src/main.tsx"] },
	{ id: "plain", exe: join(outDir, "zotero-next-gpui-plain.exe"), args: [] },
	{ id: "bytecode", exe: join(outDir, "zotero-next-gpui-bytecode.exe"), args: [] },
	{ id: "bytecode-min", exe: join(outDir, "zotero-next-gpui-bytecode-min.exe"), args: [] },
	// bun canary's ahead-of-time compiler: bun scripts/build.ts --aot (builds out/zotero-next-gpui-aot.exe)
	{ id: "aot", exe: join(outDir, "zotero-next-gpui-aot.exe"), args: [] },
	// the installed package (scripts/package.ts output copied to %USERPROFILE%\ZoteroNext\gpui): what the Start-menu shortcut runs
	{ id: "installed", exe: join(process.env.USERPROFILE ?? "", "ZoteroNext", "gpui", "zotero-next-gpui.exe"), args: [] },
];
const wantedV = arg("variants", ALL.map((v) => v.id).join(",")).split(",");
// aot-<name>: another AOT build kept as out/zotero-next-gpui-aot-<name>.exe (e.g. one per Bun canary, to compare them)
for (const id of wantedV)
	if (/^aot-[\w-]+$/.test(id) && !ALL.some((v) => v.id === id))
		ALL.push({ id, exe: join(outDir, `zotero-next-gpui-${id}.exe`), args: [] });
const variants = ALL.filter((v) => wantedV.includes(v.id));
for (const v of variants)
	if (!existsSync(v.exe)) {
		console.error(`missing ${v.exe}; run: bun scripts/build.ts`);
		process.exit(2);
	}

const PS1 = String.raw`
param([string]$Exe, [string]$ExeArgs, [string]$Cwd, [string]$Url, [string]$Db, [int]$WaitS, [int]$Port, [int]$InnerPort, [string]$LogBase)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class ZnWin {
	delegate bool EnumProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
	public static HashSet<uint> VisibleWindowPids() {
		var set = new HashSet<uint>();
		EnumWindows((h, l) => {
			if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { uint pid; GetWindowThreadProcessId(h, out pid); set.Add(pid); }
			return true;
		}, IntPtr.Zero);
		return set;
	}
}
"@
function Get-Tree([int]$rootPid) {
	$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
	$ids = New-Object System.Collections.Generic.HashSet[int]
	[void]$ids.Add($rootPid)
	do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
	return @($ids)
}
function Mem([int[]]$ids) {
	$out = @()
	foreach ($id in $ids) {
		$p = Get-Process -Id $id -ErrorAction SilentlyContinue
		if ($p -and $p.ProcessName -ne 'conhost') { $out += [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; privateMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1); wsMB = [math]::Round($p.WorkingSet64 / 1MB, 1) } }
	}
	return $out
}
function Listener([int]$port) {
	# netstat first: Get-NetTCPConnection (CIM) intermittently returns nothing under load
	$line = (netstat -ano -p tcp | Select-String ":$port\s+\S+\s+LISTENING\s+(\d+)" | Select-Object -First 1)
	if ($line) { return [int]$line.Matches[0].Groups[1].Value }
	$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($conn) { return [int]$conn.OwningProcess }
	return $null
}
$env:ZN_TRACE = '1'
# a benchmark copy must not answer the browser Connector / Word on Zotero's port 23119, nor sync the library copy
$env:ZN_ZPORT = '0'
$env:ZN_SYNC = '0'
if ($Db) { $env:ZN_DB = $Db; $env:ZN_PORT = [string]$InnerPort; Remove-Item Env:ZN_URL -ErrorAction SilentlyContinue }
else { $env:ZN_URL = $Url; Remove-Item Env:ZN_DB -ErrorAction SilentlyContinue; Remove-Item Env:ZN_PORT -ErrorAction SilentlyContinue }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$sp = @{ FilePath = $Exe; WorkingDirectory = $Cwd; PassThru = $true; RedirectStandardOutput = "$LogBase.out.log"; RedirectStandardError = "$LogBase.err.log" }
if ($ExeArgs) { $sp.ArgumentList = $ExeArgs }
$proc = Start-Process @sp
$windowMs = $null; $exitedEarly = $false; $poll = 0
$tree = @($proc.Id)
while ($sw.Elapsed.TotalSeconds -lt $WaitS) {
	if ($proc.HasExited) { $exitedEarly = $true; break }
	if ($null -eq $windowMs) {
		$vis = [ZnWin]::VisibleWindowPids()
		if ($vis.Contains([uint32]$proc.Id)) { $windowMs = $sw.ElapsedMilliseconds }
		elseif (($poll++ % 10) -eq 9) {
			$tree = Get-Tree $proc.Id
			foreach ($id in $tree) { if ($vis.Contains([uint32]$id)) { $windowMs = $sw.ElapsedMilliseconds; break } }
		}
		Start-Sleep -Milliseconds 10
	} else { Start-Sleep -Milliseconds 200 }
}
$tree = if ($proc.HasExited) { @() } else { Get-Tree $proc.Id }
$procs = @(Mem $tree)
$coreProc = $null
if (-not $Db) { $cp = Listener $Port; if ($cp) { $coreProc = @(Mem @($cp)) | Select-Object -First 1 } }
$innerListening = $false
if ($Db) { $ip = Listener $InnerPort; $innerListening = [bool]($ip -and ($tree -contains $ip)) }
$graceful = $false
if (-not $proc.HasExited) {
	foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }
	$null = $proc.WaitForExit(4000)
	$graceful = $proc.HasExited
	if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null }
}
[pscustomobject]@{ windowMs = $windowMs; exitedEarly = $exitedEarly; gracefulClose = $graceful; procs = $procs; coreProc = $coreProc; innerListening = $innerListening } | ConvertTo-Json -Depth 4 -Compress
`;

const work = join(tmpdir(), "zn-aot-bench");
mkdirSync(work, { recursive: true });
const ps1 = join(work, "measure.ps1");
writeFileSync(ps1, PS1);

interface Proc {
	pid: number;
	name: string;
	privateMB: number;
	wsMB: number;
}
interface Run {
	windowMs: number | null;
	exitedEarly: boolean;
	gracefulClose: boolean;
	procs: Proc[];
	coreProc: Proc | null;
	innerListening: boolean;
}

// ---- the library copy for in-process mode ---------------------------------------------------------------------------------------
const benchDir = join(outDir, "bench");
const baseCopy = join(benchDir, "base-COPY.sqlite");
function makeBaseCopy() {
	mkdirSync(benchDir, { recursive: true });
	if (existsSync(baseCopy) && statSync(baseCopy).size > 0) return;
	rmSync(baseCopy, { force: true });
	const src = new Database(dbSource, { readonly: true });
	try {
		src.run(`VACUUM INTO '${baseCopy.replaceAll("\\", "/").replaceAll("'", "''")}'`);
	} finally {
		src.close();
	}
	// VACUUM INTO writes a rollback-journal database; the real library is WAL. Switch the copy once, or every run pays the core's
	// ~200 ms WAL conversion at start-up (the per-run copies are file copies of this one, so they start in WAL mode too).
	const c = new Database(baseCopy);
	try {
		c.run("PRAGMA journal_mode = WAL");
	} finally {
		c.close();
	}
	console.log(`library copy: ${baseCopy} (${(statSync(baseCopy).size / 1048576).toFixed(0)} MB) from ${dbSource}`);
}
function freshDb(tag: string): string {
	const p = join(benchDir, `run-${tag}-COPY.sqlite`);
	for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
	copyFileSync(baseCopy, p);
	return p;
}

async function measure(v: Variant, mode: string, tag: string): Promise<{ r: Run; err: string; marks: Record<string, number> }> {
	const logBase = join(work, tag);
	const outFile = join(work, `${tag}.json`);
	for (const f of [outFile, `${outFile}.err`, `${logBase}.out.log`, `${logBase}.err.log`]) writeFileSync(f, "");
	const db = mode === "inproc" ? freshDb(tag) : "";
	try {
		const p = Bun.spawn(
			[
				"pwsh",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				ps1,
				"-Exe",
				v.exe,
				"-ExeArgs",
				v.args.join(" "),
				"-Cwd",
				v.id === "sources" ? root : outDir,
				"-Url",
				url,
				"-Db",
				db,
				"-WaitS",
				String(waitS),
				"-Port",
				String(port),
				"-InnerPort",
				String(innerPort),
				"-LogBase",
				logBase,
			],
			{ stdout: Bun.file(outFile), stderr: Bun.file(`${outFile}.err`) },
		);
		const code = await p.exited;
		const raw = readFileSync(outFile, "utf8").trim();
		if (code !== 0 || !raw) throw new Error(`measure.ps1 failed (exit ${code}): ${raw}\n${readFileSync(`${outFile}.err`, "utf8")}`);
		const errLog = readFileSync(`${logBase}.err.log`, "utf8").trim();
		const marks: Record<string, number> = {};
		for (const m of readFileSync(`${logBase}.out.log`, "utf8").matchAll(/\[zn-t\] (\S+) (\d+)/g)) marks[m[1]!] = Number(m[2]);
		return { r: JSON.parse(raw.split("\n").pop()!) as Run, err: errLog, marks };
	} finally {
		if (db) for (const s of ["", "-wal", "-shm"]) rmSync(db + s, { force: true });
	}
}

// ---- run + report ---------------------------------------------------------------------------------------------------------------
const sum = (a: Proc[], k: "privateMB" | "wsMB") => +a.reduce((s, p) => s + p[k], 0).toFixed(1);
const f = (n: number | null | undefined, d = 0) => (n == null ? "-" : n.toFixed(d));
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]! : null);

interface Cell {
	win: number[];
	items: number[];
	priv: number[];
	ws: number[];
	cpriv: number[];
	cws: number[];
	early: string[];
	sizeMB: number | null;
}
const cells = new Map<string, Cell>();
const key = (mode: string, v: string) => `${mode}|${v}`;
for (const m of modes)
	for (const v of variants) {
		cells.set(key(m, v.id), {
			win: [],
			items: [],
			priv: [],
			ws: [],
			cpriv: [],
			cws: [],
			early: [],
			sizeMB: v.id === "sources" ? null : +(statSync(v.exe).size / 1048576).toFixed(1),
		});
	}

if (modes.includes("inproc")) makeBaseCopy();
console.log(
	`variants=${variants.map((v) => v.id).join(",")} modes=${modes.join(",")} runs=${runs} wait=${waitS}s (visible windows open; do not touch them)`,
);
for (let i = 1; i <= runs; i++) {
	for (const mode of modes)
		for (const v of variants) {
			const tag = `${mode}-${v.id}-${i}`;
			const { r, err, marks } = await measure(v, mode, tag);
			const c = cells.get(key(mode, v.id))!;
			const priv = sum(r.procs, "privateMB"),
				ws = sum(r.procs, "wsMB");
			if (r.windowMs != null) c.win.push(r.windowMs);
			const items = marks["first-items"] ?? marks["items-loaded"];
			if (items != null) c.items.push(items);
			if (r.procs.length) {
				c.priv.push(priv);
				c.ws.push(ws);
			}
			if (r.coreProc) {
				c.cpriv.push(r.coreProc.privateMB);
				c.cws.push(r.coreProc.wsMB);
			}
			if (r.exitedEarly) c.early.push(err.split("\n").slice(-4).join(" | ") || "(no stderr)");
			console.log(
				`run ${i} ${mode.padEnd(8)} ${v.id.padEnd(13)} window=${r.windowMs ?? "none"} ms items=${items ?? "-"} ms procs=${r.procs.length} priv=${priv} MB ws=${ws} MB${r.coreProc ? ` core=${r.coreProc.privateMB}/${r.coreProc.wsMB}` : ""}${mode === "inproc" ? ` inprocCore=${r.innerListening}` : ""}${r.exitedEarly ? " EXITED EARLY: " + err.split("\n").slice(-3).join(" | ") : ""}`,
			);
			await Bun.sleep(1500);
		}
}

console.log(
	"\nMedian (min..max) over " +
		runs +
		" runs; window/items = ms from process start; memory sampled at " +
		waitS +
		" s (PrivateMemorySize64 / WorkingSet64, process tree).",
);
for (const mode of modes) {
	const head = [
		"variant",
		"exe MB",
		"window ms",
		"items ms",
		"private MB",
		"WS MB",
		...(mode === "external" ? ["core priv MB", "core WS MB"] : []),
		"notes",
	];
	const rows: string[][] = [head];
	for (const v of variants) {
		const c = cells.get(key(mode, v.id))!;
		const rng = (a: number[]) => (a.length ? `${f(median(a))} (${f(Math.min(...a))}..${f(Math.max(...a))})` : "-");
		rows.push([
			v.id,
			c.sizeMB == null ? "-" : String(c.sizeMB),
			rng(c.win),
			rng(c.items),
			rng(c.priv),
			rng(c.ws),
			...(mode === "external" ? [f(median(c.cpriv)), f(median(c.cws))] : []),
			c.early.length
				? `EXITED EARLY x${c.early.length}: ${c.early[0]}`
				: c.win.length < runs
					? `window in ${c.win.length}/${runs}`
					: "",
		]);
	}
	const w = head.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
	console.log(
		`\n[${mode === "external" ? `external core at ${url} (core is a separate process)` : "in-process core (ZN_DB = copy of " + dbSource.split(/[\\/]/).slice(-2).join("/") + ")"}]`,
	);
	for (const [n, r] of rows.entries()) {
		console.log(r.map((cell, i) => (i === 0 || i === r.length - 1 ? cell.padEnd(w[i]!) : cell.padStart(w[i]!))).join("  "));
		if (n === 0) console.log(w.map((x) => "-".repeat(x)).join("  "));
	}
	if (mode === "external") console.log("(core columns are the already-running core on the port: a constant, not part of the variant)");
	const s = cells.get(key(mode, "sources"));
	if (s && s.priv.length) {
		for (const v of variants) {
			if (v.id === "sources") continue;
			const c = cells.get(key(mode, v.id))!;
			if (!c.priv.length) continue;
			console.log(
				`  ${v.id.padEnd(13)} vs sources: private ${f(median(c.priv)! - median(s.priv)!)} MB (${f((median(c.priv)! / median(s.priv)! - 1) * 100)}%), window ${f(median(c.win) == null || median(s.win) == null ? null : median(c.win)! - median(s.win)!)} ms`,
			);
		}
	}
}
