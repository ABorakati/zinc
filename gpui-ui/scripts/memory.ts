// Memory + startup measurement of the real GPUI window.
//
//   bun scripts/memory.ts [--runs 3] [--wait 15] [--entry src/main.tsx]
//        external core (default):  [--url http://127.0.0.1:23160] [--port 23160]     (the core is its own process on <port>)
//        in-process core:          --db <library copy.sqlite> [--port 23161]         (sets ZN_DB; the core runs inside the GPUI process)
//        --startup                 print only the time-to-window / time-to-first-items summary (scripts/startup.ts does this)
//
// SAFETY: --db is passed to the app as ZN_DB and the core WRITES to its database. Always give a throwaway copy
// (bun:sqlite "VACUUM INTO"), never data/library.sqlite.
//
// Each run (driven by a generated PowerShell script, so the launch time, the window poll and the memory sample share one clock):
//   * starts `bun <entry>` with ZN_TRACE=1 and ZN_URL (or ZN_DB/ZN_PORT) set (opens a visible window; nothing is clicked/typed),
//   * polls every ~10 ms for a visible top-level window owned by the process or any descendant (EnumWindows) -> "window ms",
//   * the app prints "[zn-t] <milestone> <ms since process start>" (src/trace.ts); collected from its stdout: "items ms" is
//     when the app is mounted and the first page of items is in the store (the next frame paints them), "colls ms" the collections,
//   * at <wait> s after launch, records PrivateMemorySize64 + WorkingSet64 of the process tree (Get-Process) and, separately,
//     of the core API process that owns <port> (external mode; in-process mode reports the core as part of the GPUI process),
//   * closes the window (CloseMainWindow, then kills the tree if it is still alive after 4 s).
// Then prints a table. For comparison, the old Electrobun app (since removed from the repo) measured library-only: ~580 MB
// private / 710 MB WS total (bun main incl. core ~230 MB + 6 WebView2 processes ~350 MB).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const runs = Number(arg("runs", "3"));
const waitS = Number(arg("wait", "15"));
const entry = arg("entry", "src/main.tsx");
const url = arg("url", "http://127.0.0.1:23160");
const db = arg("db", "");
const port = Number(arg("port", db ? "23161" : "23160"));
const startupOnly = process.argv.includes("--startup");
if (db && /library\.sqlite$/i.test(db.replaceAll("\\", "/")) && !/(temp|scratch|copy)/i.test(db)) {
	console.error(`refusing --db ${db}: looks like a real library; pass a VACUUM INTO copy (path containing temp/scratch/copy)`);
	process.exit(2);
}

const PS1 = String.raw`
param([string]$Bun, [string]$Entry, [string]$Cwd, [string]$Url, [int]$WaitS, [int]$Port, [string]$LogBase, [string]$Db)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class ZnWin {
	delegate bool EnumProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
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
$env:ZN_TRACE = '1'
if ($Db) { $env:ZN_DB = $Db; $env:ZN_PORT = [string]$Port; Remove-Item Env:ZN_URL -ErrorAction SilentlyContinue } else { $env:ZN_URL = $Url; Remove-Item Env:ZN_DB -ErrorAction SilentlyContinue }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $Bun -ArgumentList $Entry -WorkingDirectory $Cwd -PassThru -RedirectStandardOutput "$LogBase.out.log" -RedirectStandardError "$LogBase.err.log"
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
$corePid = $null; $core = $null
$conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | Select-Object -First 1
if ($conn) { $corePid = $conn.OwningProcess } else {
	$line = (netstat -ano | Select-String ":$Port\s+\S+\s+LISTENING\s+(\d+)" | Select-Object -First 1)
	if ($line) { $corePid = [int]$line.Matches[0].Groups[1].Value }
}
if ($corePid) { $core = @(Mem @([int]$corePid)) | Select-Object -First 1 }
$coreInProc = ($corePid -and ($tree -contains [int]$corePid))
# close: graceful first, then kill the tree
$graceful = $false
if (-not $proc.HasExited) {
	foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }
	$null = $proc.WaitForExit(4000)
	$graceful = $proc.HasExited
	if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null }
}
[pscustomobject]@{ windowMs = $windowMs; exitedEarly = $exitedEarly; gracefulClose = $graceful; procs = $procs; coreProc = $core; coreInProc = [bool]$coreInProc } | ConvertTo-Json -Depth 4 -Compress
`;

mkdirSync(join(tmpdir(), "zn-memory"), { recursive: true });
const ps1 = join(tmpdir(), "zn-memory", "measure.ps1");
writeFileSync(ps1, PS1);

interface Proc { pid: number; name: string; privateMB: number; wsMB: number }
interface Run { windowMs: number | null; exitedEarly: boolean; gracefulClose: boolean; procs: Proc[]; coreProc: Proc | null; coreInProc: boolean }

async function measure(i: number): Promise<{ r: Run; err: string; marks: Record<string, number> }> {
	const logBase = join(tmpdir(), "zn-memory", `run${i}`);
	const outFile = join(tmpdir(), "zn-memory", `run${i}.json`);
	for (const f of [outFile, `${outFile}.err`, `${logBase}.out.log`, `${logBase}.err.log`]) writeFileSync(f, ""); // Bun.file stdout overwrites in place without truncating
	const p = Bun.spawn(
		["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1,
			"-Bun", process.execPath, "-Entry", entry, "-Cwd", root, "-Url", url, "-WaitS", String(waitS), "-Port", String(port), "-LogBase", logBase, "-Db", db],
		{ stdout: Bun.file(outFile), stderr: Bun.file(`${outFile}.err`) }, // files, not pipes (a child that outlives us must not hold them)
	);
	const code = await p.exited;
	const raw = readFileSync(outFile, "utf8").trim();
	if (code !== 0 || !raw) throw new Error(`measure.ps1 failed (exit ${code}): ${raw}\n${existsSync(`${outFile}.err`) ? readFileSync(`${outFile}.err`, "utf8") : ""}`);
	const errLog = existsSync(`${logBase}.err.log`) ? readFileSync(`${logBase}.err.log`, "utf8").trim() : "";
	const marks: Record<string, number> = {};
	if (existsSync(`${logBase}.out.log`)) for (const m of readFileSync(`${logBase}.out.log`, "utf8").matchAll(/\[zn-t\] (\S+) (\d+)/g)) marks[m[1]!] = Number(m[2]);
	return { r: JSON.parse(raw.split("\n").pop()!) as Run, err: errLog, marks };
}

const sum = (a: Proc[], k: "privateMB" | "wsMB") => +a.reduce((s, p) => s + p[k], 0).toFixed(1);
const f = (n: number | null | undefined, d = 1) => (n == null ? "-" : n.toFixed(d));
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null);
const rows: string[][] = [["run", "window ms", "colls ms", "items ms", "procs", "GPUI private MB", "GPUI WS MB", "core private MB", "core WS MB", "total private MB", "total WS MB", "closed"]];
const nums = { win: [] as number[], colls: [] as number[], items: [] as number[], priv: [] as number[], ws: [] as number[], cpriv: [] as number[], cws: [] as number[] };

console.log(`entry=${entry} mode=${db ? `in-process core, ZN_DB=${db}` : `external core, ZN_URL=${url}`} wait=${waitS}s runs=${runs} (a visible GPUI window opens each run; do not touch it)`);
for (let i = 1; i <= runs; i++) {
	const { r, err, marks } = await measure(i);
	const priv = sum(r.procs, "privateMB");
	const ws = sum(r.procs, "wsMB");
	const ext = r.coreProc && !r.coreInProc ? r.coreProc : null; // a separate core process (external mode)
	const cp = ext?.privateMB ?? null;
	const cw = ext?.wsMB ?? null;
	if (r.windowMs != null) nums.win.push(r.windowMs);
	if (marks["collections-loaded"] != null) nums.colls.push(marks["collections-loaded"]!);
	if ((marks["first-items"] ?? marks["items-loaded"]) != null) nums.items.push((marks["first-items"] ?? marks["items-loaded"])!);
	if (r.procs.length) { nums.priv.push(priv); nums.ws.push(ws); }
	if (cp != null) nums.cpriv.push(cp);
	if (cw != null) nums.cws.push(cw);
	rows.push([
		String(i), r.windowMs == null ? "no window" : String(r.windowMs), String(marks["collections-loaded"] ?? "-"), String((marks["first-items"] ?? marks["items-loaded"]) ?? "-"),
		String(r.procs.length), f(priv), f(ws), f(cp), f(cw),
		f(cp == null ? priv : priv + cp), f(cw == null ? ws : ws + cw), r.exitedEarly ? "EXITED EARLY" : r.gracefulClose ? "graceful" : "killed",
	]);
	console.log(`run ${i}: window=${r.windowMs ?? "none"} ${r.procs.map((p) => `${p.name}#${p.pid} ${p.privateMB}/${p.wsMB}`).join(", ") || "(no process left)"} | core ${r.coreInProc ? "in-process" : r.coreProc ? `${r.coreProc.name}#${r.coreProc.pid}` : "not found"} | marks ${JSON.stringify(marks)}`);
	if (r.exitedEarly && err) console.log(`  stderr: ${err.split("\n").slice(-8).join("\n          ")}`);
	await Bun.sleep(1500);
}

rows.push(["avg", f(avg(nums.win), 0), f(avg(nums.colls), 0), f(avg(nums.items), 0), "", f(avg(nums.priv)), f(avg(nums.ws)), f(avg(nums.cpriv)), f(avg(nums.cws)),
	f(avg(nums.priv) == null ? null : avg(nums.priv)! + (avg(nums.cpriv) ?? 0)), f(avg(nums.ws) == null ? null : avg(nums.ws)! + (avg(nums.cws) ?? 0)), ""]);

if (startupOnly) {
	console.log(`\nstartup (ms since process start), ${nums.win.length} runs: time-to-window median ${f(median(nums.win), 0)} (avg ${f(avg(nums.win), 0)}, min ${f(Math.min(...nums.win), 0)}), collections ${f(median(nums.colls), 0)}, first items median ${f(median(nums.items), 0)} (avg ${f(avg(nums.items), 0)}, min ${f(Math.min(...nums.items), 0)})`);
} else {
	const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
	console.log("");
	for (const [n, r] of rows.entries()) {
		console.log(r.map((cell, c) => cell.padStart(widths[c]!)).join("  "));
		if (n === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
	}
	console.log("\nReference (Electrobun app, library only): ~580 MB private / ~710 MB WS total (bun main incl. core ~230 MB + 6 WebView2 ~350 MB).");
	console.log("GPUI figures are the GPUI process tree only; in external mode the core (separate process on the port) is its own column and 'total' adds it; in-process mode has no core column (it is inside the GPUI figure).");
	console.log("window ms = first visible window; items ms = first page of items in the store (the next frame paints it); both from process start.");
}
