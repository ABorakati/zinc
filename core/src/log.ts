// Local error / crash log, shared by the core and the GPUI shell (they run in one process; the shell's glue is
// gpui-ui/src/shell/errorlog.ts). Nothing here touches the network.
//
//   File    %APPDATA%\zotero-next-gpui\logs\zotero-next-YYYY-MM-DD.log (ZN_LOG_DIR overrides the folder). One JSON object per line:
//             {"time":"2026-11-06T12:00:00.123Z","level":"error","area":"core","message":"...","stack":"...","version":"dev",
//              "build":"source","os":"Windows_NT 10.0.26300 x64","ctx":{"method":"GET","path":"/api/items"}}
//           level: debug|info|warn|error|fatal. area: ui|core|reader|sync|websync|translate|bbt|worker|word|update.
//   Rotate  one file per local day; files older than 14 days are deleted; a file that would pass ~5 MB is renamed to
//           zotero-next-YYYY-MM-DD.old.log (replacing an older .old) and a fresh file starts: at most ~10 MB a day.
//   Writes  queued and appended asynchronously; log() never throws. "fatal" lines are written synchronously (the process may be dying).
//   Privacy redact() runs on every message, stack and context value before it is written, and again when a report is built:
//           API keys / tokens / Bearer headers / passwords / cookies, long key-like strings, JSON "title"/"note"/... fields, and the user's
//           folder (C:\Users\<name> -> %USERPROFILE%). Callers must still never pass item titles, notes or file contents.
//   Crash   markRunning() writes running-<pid>.json in the log folder at start; markCleanExit() removes it. A marker left by a process
//           that is gone = that session ended unexpectedly (crashed, killed, power cut, or exited after a fatal error).
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { arch, homedir, release, type as osType } from "node:os";
import { basename, join } from "node:path";
import { deflateRawSync } from "node:zlib";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export const LOG_AREAS = ["ui", "core", "reader", "sync", "websync", "translate", "bbt", "worker", "word", "update"] as const;
export type LogArea = (typeof LOG_AREAS)[number];

export interface LogRecord {
	time: string;
	level: LogLevel;
	area: LogArea;
	message: string;
	stack?: string;
	version: string;
	build: string;
	os: string;
	ctx?: Record<string, string | number | boolean | null>;
}

// ------------------------------------------------------------------------------------------------------------ configuration

interface Config {
	dir?: string;
	version?: string;
	build?: string;
	os?: string;
	maxBytes: number;
	keepDays: number;
	/** Lines allowed per RATE_WINDOW_MS before the rest are dropped (fatal lines always pass). */
	rateMax: number;
	now: () => Date;
	home?: string;
}
const DEFAULTS: Config = { maxBytes: 5 * 1024 * 1024, keepDays: 14, rateMax: 500, now: () => new Date() };
let cfg: Config = { ...DEFAULTS };
const RATE_WINDOW_MS = 10_000;
const MAX_QUEUE = 2000;
const MAX_MESSAGE = 4000;
const MAX_STACK = 8000;

/** Tests and the app: override the folder, the size cap, the clock, ... Resets the writer state. */
export function configureLog(c: Partial<Config>): void {
	cfg = { ...cfg, ...c };
	sizes.clear();
	dirReady.clear();
	lastPruneDay = "";
}

/** Tests: back to the defaults and an empty queue. */
export function resetLog(): void {
	cfg = { ...DEFAULTS };
	queue.length = 0;
	sizes.clear();
	dirReady.clear();
	lastPruneDay = "";
	windowStart = 0;
	windowCount = 0;
	dropped = 0;
	fatalSeen = false;
}

export function logDir(): string {
	if (cfg.dir) return cfg.dir;
	if (process.env.ZN_LOG_DIR) return process.env.ZN_LOG_DIR;
	return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "zotero-next-gpui", "logs");
}

export function appVersion(): string {
	return cfg.version ?? process.env.ZN_VERSION ?? "dev";
}

/** bytecode / aot (the compiled exe's variant) or source (run by bun). ZN_BUILD_VARIANT overrides. */
export function buildVariant(): string {
	if (cfg.build) return cfg.build;
	if (process.env.ZN_BUILD_VARIANT) return process.env.ZN_BUILD_VARIANT;
	const exe = basename(process.execPath).toLowerCase();
	if (/^bun(\.exe)?$/.test(exe)) return "source";
	const m = /^zotero-next-gpui-([a-z0-9-]+)\.exe$/.exec(exe);
	if (m) return m[1]!.startsWith("aot") ? "aot" : "bytecode";
	return "bytecode";
}

export function osVersion(): string {
	return cfg.os ?? `${osType()} ${release()} ${arch()}`;
}

// ------------------------------------------------------------------------------------------------------------ redaction

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function homeRegex(home: string): RegExp {
	const fwd = home.replaceAll("\\", "/");
	const variants = new Set([home, fwd, home.replaceAll("\\", "\\\\")]);
	return new RegExp([...variants].sort((a, b) => b.length - a.length).map(reEscape).join("|"), "gi");
}

const HOME_PATH = /\b[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+[^\\/\s"'<>|:*?]+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNED = /\b(authorization|zotero-api-key|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|cookie|set-cookie|session[_-]?id)(["']?\s*[:=]\s*)(["']?)(?!\[redacted)[^"'\s,;&}\]]+/gi;
const QUERY_SECRET = /([?&](?:key|api_?key|apikey|token|access_token|auth|password|secret|sig|signature)=)[^&\s"']+/gi;
const PREFIXED = /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const CONTENT_FIELDS = /("(?:title|shortTitle|note|abstractNote|abstract|extra|content|text|html|body|fulltext)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const KEYLIKE = /[A-Za-z0-9_+=-]{24,}/g; // no "/": URL paths such as /api/items/ABCD1234/children are not keys

/**
 * Remove what must not be kept in a log: secrets, key-like strings, content fields and the user's folder. Idempotent.
 * `home`: the folder to replace (default: the OS home); C:\Users\<anything> is replaced too.
 */
export function redact(text: string, o: { home?: string } = {}): string {
	if (!text) return text;
	let s = text;
	const homes = new Set<string>();
	for (const h of [o.home ?? cfg.home, homedir(), process.env.USERPROFILE]) if (h && h.length > 3) homes.add(h);
	for (const h of homes) s = s.replace(homeRegex(h), "%USERPROFILE%");
	s = s.replace(HOME_PATH, "%USERPROFILE%");
	s = s.replace(BEARER, "$1 [redacted]");
	s = s.replace(ASSIGNED, "$1$2$3[redacted]");
	s = s.replace(QUERY_SECRET, "$1[redacted]");
	s = s.replace(PREFIXED, "[redacted-key]");
	s = s.replace(CONTENT_FIELDS, '$1"[redacted]"');
	s = s.replace(KEYLIKE, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[redacted-key]" : m));
	return s;
}

// ------------------------------------------------------------------------------------------------------------ describing values

/** A value as log text without leaking its content: errors give message + stack, objects only their shape. */
export function describe(v: unknown): string {
	if (v instanceof Error) return `${v.name}: ${v.message}`;
	if (typeof v === "string") return v;
	if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
	if (typeof v === "function") return "[function]";
	if (typeof v === "symbol") return v.toString();
	if (Array.isArray(v)) return `[array of ${v.length}]`;
	const m = (v as { message?: unknown }).message;
	if (typeof m === "string") return m; // error-like (cross-realm / worker errors)
	return `[object ${Object.keys(v as object).slice(0, 8).join(",")}]`;
}

function stackOf(v: unknown): string | undefined {
	if (v instanceof Error) return v.stack;
	const s = (v as { stack?: unknown } | null)?.stack;
	return typeof s === "string" ? s : undefined;
}

// ------------------------------------------------------------------------------------------------------------ writer

const FILE_RE = /^zotero-next-(\d{4}-\d{2}-\d{2})(\.old)?\.log$/;
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fileFor = (day: string) => join(logDir(), `zotero-next-${day}.log`);

const queue: { file: string; text: string }[] = [];
const sizes = new Map<string, number>();
const dirReady = new Set<string>();
let pumping: Promise<void> | undefined;
let lastPruneDay = "";
let windowStart = 0;
let windowCount = 0;
let dropped = 0;
let fatalSeen = false;

function ensureDirSync(dir: string): void {
	if (dirReady.has(dir)) return;
	mkdirSync(dir, { recursive: true });
	dirReady.add(dir);
}

/** Delete log files dated `keepDays` or more days before `now`. Returns the deleted file names. Never throws. */
export function pruneLogs(dir = logDir(), now = cfg.now(), keepDays = cfg.keepDays): string[] {
	const gone: string[] = [];
	try {
		const cut = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays + 1).getTime(); // keep today + (keepDays - 1) earlier days
		for (const f of readdirSync(dir)) {
			const m = FILE_RE.exec(f);
			if (!m) continue;
			const [y, mo, d] = m[1]!.split("-").map(Number);
			if (new Date(y!, mo! - 1, d!).getTime() < cut) {
				try { unlinkSync(join(dir, f)); gone.push(f); } catch { /* in use */ }
			}
		}
	} catch { /* no folder yet */ }
	return gone;
}

/** Size of the file as far as this process knows (a stat the first time a file is seen). */
function sizeOf(file: string): number {
	let size = sizes.get(file);
	if (size === undefined) {
		try { size = statSync(file).size; } catch { size = 0; }
		sizes.set(file, size);
	}
	return size;
}

/** Would `bytes` more push the file past the cap (an empty file always takes one record)? */
const wouldExceed = (file: string, bytes: number): boolean => sizeOf(file) > 0 && sizeOf(file) + bytes > cfg.maxBytes;

/** Move the file to .old (replacing an older .old); the next append starts a new file. */
function roll(file: string): void {
	const old = file.replace(/.log$/, ".old.log");
	try { unlinkSync(old); } catch { /* none */ }
	try { renameSync(file, old); } catch { /* keep appending */ }
	sizes.set(file, 0);
}

async function pump(): Promise<void> {
	while (queue.length) {
		const batch = queue.splice(0, queue.length);
		let file = "";
		let acc = "";
		const flushAcc = async () => {
			if (!acc) return;
			const text = acc;
			acc = "";
			try {
				const dir = logDir();
				if (!dirReady.has(dir)) { await mkdir(dir, { recursive: true }); dirReady.add(dir); }
				await appendFile(file, text);
			} catch { /* a log must never break the app */ }
		};
		for (const b of batch) {
			const bytes = Buffer.byteLength(b.text);
			if (b.file !== file) { await flushAcc(); file = b.file; }
			if (wouldExceed(file, bytes)) { await flushAcc(); roll(file); }
			sizes.set(file, sizeOf(file) + bytes);
			acc += b.text;
		}
		await flushAcc();
	}
}

function schedule(): void {
	if (pumping) return;
	pumping = Promise.resolve().then(pump).finally(() => { pumping = undefined; if (queue.length) schedule(); });
}

/** Wait until everything logged so far is on disk. */
export async function flushLog(): Promise<void> {
	while (pumping || queue.length) {
		schedule();
		await pumping;
	}
}

/** Write what is queued, synchronously (a dying process; the writer's own async work may still be in flight). */
export function flushLogSync(): void {
	const batch = queue.splice(0, queue.length);
	for (const b of batch) {
		try {
			ensureDirSync(logDir());
			const bytes = Buffer.byteLength(b.text);
			if (wouldExceed(b.file, bytes)) roll(b.file);
			sizes.set(b.file, sizeOf(b.file) + bytes);
			appendFileSync(b.file, b.text);
		} catch { /* ignore */ }
	}
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s;
}

export function makeRecord(level: LogLevel, area: LogArea, message: string, err?: unknown, ctx?: Record<string, unknown>): LogRecord {
	const rec: LogRecord = {
		time: cfg.now().toISOString(),
		level,
		area,
		message: clip(redact(message), MAX_MESSAGE),
		version: appVersion(),
		build: buildVariant(),
		os: osVersion(),
	};
	const st = err === undefined ? undefined : stackOf(err);
	if (st) rec.stack = clip(redact(st), MAX_STACK);
	if (ctx) {
		const out: Record<string, string | number | boolean | null> = {};
		for (const [k, v] of Object.entries(ctx)) {
			if (v === undefined) continue;
			out[k] = typeof v === "string" ? clip(redact(v), 500) : typeof v === "number" || typeof v === "boolean" || v === null ? v : clip(redact(describe(v)), 500);
		}
		if (Object.keys(out).length) rec.ctx = out;
	}
	return rec;
}

/** Log one entry. Never throws; returns the record written (or undefined when rate-limited). */
export function log(level: LogLevel, area: LogArea, message: string, err?: unknown, ctx?: Record<string, unknown>): LogRecord | undefined {
	try {
		const now = cfg.now().getTime();
		if (now - windowStart > RATE_WINDOW_MS) {
			if (dropped > 0) enqueue(makeRecord("warn", "core", `log rate limit: ${dropped} line(s) dropped in the last ${RATE_WINDOW_MS / 1000} s`));
			windowStart = now;
			windowCount = 0;
			dropped = 0;
		}
		if (level !== "fatal" && windowCount >= cfg.rateMax) { dropped++; return undefined; }
		windowCount++;
		const rec = makeRecord(level, area, message, err, ctx);
		enqueue(rec);
		if (level === "fatal") { fatalSeen = true; flushLogSync(); }
		return rec;
	} catch {
		return undefined;
	}
}

function enqueue(rec: LogRecord): void {
	const day = dayOf(cfg.now());
	if (queue.length >= MAX_QUEUE) return;
	if (day !== lastPruneDay) {
		lastPruneDay = day;
		pruneLogs();
	}
	queue.push({ file: fileFor(day), text: JSON.stringify(rec) + "\n" });
	schedule();
}

/** Log a caught error. `where` (optional) says what was being done; keep titles, notes and file contents out of it. */
export function logError(area: LogArea, err: unknown, where?: string, ctx?: Record<string, unknown>): void {
	try {
		const msg = describe(err);
		if (typeof err === "object" && err !== null) logged.add(err);
		log("error", area, where ? `${where}: ${msg}` : msg, err, ctx);
	} catch { /* never throws */ }
}
export const logWarn = (area: LogArea, message: string, ctx?: Record<string, unknown>): void => void log("warn", area, message, undefined, ctx);
export const logInfo = (area: LogArea, message: string, ctx?: Record<string, unknown>): void => void log("info", area, message, undefined, ctx);

// ------------------------------------------------------------------------------------------------------------ console mirror

const TAG_AREA: Record<string, LogArea> = {
	core: "core", services: "core", server: "core", api: "core", db: "core", shell: "ui", ui: "ui", features: "ui", store: "ui",
	reader: "reader", pdf: "reader", structure: "worker", prefetch: "worker", worker: "worker", extract: "worker",
	sync: "sync", websync: "websync", translate: "translate", translation: "translate", bbt: "bbt", word: "word", connector: "core",
};

/** Errors already written by logError(): the console mirror skips them when the same object is also printed. */
const logged = new WeakSet<object>();

/** The area an error's stack points at (core/src/<folder>/...), if any. */
function areaFromStack(stack: string | undefined): LogArea | undefined {
	if (!stack) return undefined;
	const m = /[\/]core[\/]src[\/]([a-z-]+)[\/]/i.exec(stack);
	const dir = m?.[1]?.toLowerCase();
	if (dir === "extract") return "worker";
	if (dir === "sync" || dir === "websync" || dir === "translate" || dir === "bbt") return dir;
	return /[\/]core[\/]src[\/]/i.test(stack) ? "core" : undefined;
}

/** Mirror console.error / console.warn into the log (they are still printed). Safe to call twice. */
export function installConsoleMirror(defaultArea: LogArea = "ui"): void {
	const c = console as Console & { __znMirror?: boolean };
	if (c.__znMirror) return;
	c.__znMirror = true;
	let inside = false;
	for (const [name, level] of [["error", "error"], ["warn", "warn"]] as const) {
		const orig = c[name].bind(console);
		c[name] = (...args: unknown[]) => {
			orig(...args);
			if (inside) return;
			inside = true;
			try {
				if (args.some((a) => typeof a === "object" && a !== null && logged.has(a))) return; // logError() has it already
				const text = args.map(describe).join(" ");
				const tag = /^\[([\w-]+)\]/.exec(text)?.[1]?.toLowerCase();
				const err = args.find((a) => a instanceof Error || typeof (a as { stack?: unknown } | null)?.stack === "string");
				log(level, (tag && TAG_AREA[tag]) || areaFromStack(stackOf(err)) || defaultArea, text, err);
			} catch { /* never break console */ } finally { inside = false; }
		};
	}
}

// ------------------------------------------------------------------------------------------------------------ reading

/** Log files, oldest first (a day's .old file before its current file): { file, day, old }. */
export function listLogFiles(dir = logDir()): { file: string; day: string; old: boolean }[] {
	try {
		return readdirSync(dir)
			.map((f) => ({ f, m: FILE_RE.exec(f) }))
			.filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
			.map(({ f, m }) => ({ file: join(dir, f), day: m[1]!, old: !!m[2] }))
			.sort((a, b) => (a.day === b.day ? Number(b.old) - Number(a.old) : a.day < b.day ? -1 : 1));
	} catch {
		return [];
	}
}

/**
 * The last `days` days of log lines (today counts as day 1), oldest first, redacted again, at most `maxLines` of the newest.
 * `total` is how many lines the files hold for those days.
 */
export function readRecentLogs(days = 2, maxLines = 400, dir = logDir(), now = cfg.now()): { lines: string[]; total: number; files: string[] } {
	const since = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1));
	const files = listLogFiles(dir).filter((f) => f.day >= since);
	const all: string[] = [];
	for (const f of files) {
		try {
			for (const l of readFileSync(f.file, "utf8").split("\n")) if (l.trim()) all.push(redact(l));
		} catch { /* unreadable */ }
	}
	return { lines: all.slice(-maxLines), total: all.length, files: files.map((f) => f.file) };
}

export interface ErrorSummary { errors: number; warnings: number; fatal: number; byArea: Record<string, number>; recent: string[] }

/** Counts and the latest distinct error messages of JSON log lines. */
export function summarizeErrors(lines: string[], recent = 5): ErrorSummary {
	const s: ErrorSummary = { errors: 0, warnings: 0, fatal: 0, byArea: {}, recent: [] };
	const seen = new Set<string>();
	for (const l of lines) {
		let r: Partial<LogRecord>;
		try { r = JSON.parse(l) as Partial<LogRecord>; } catch { continue; }
		if (r.level === "warn") s.warnings++;
		else if (r.level === "error" || r.level === "fatal") {
			if (r.level === "fatal") s.fatal++; else s.errors++;
			s.byArea[r.area ?? "?"] = (s.byArea[r.area ?? "?"] ?? 0) + 1;
		}
	}
	for (let i = lines.length - 1; i >= 0 && s.recent.length < recent; i--) {
		let r: Partial<LogRecord>;
		try { r = JSON.parse(lines[i]!) as Partial<LogRecord>; } catch { continue; }
		if (r.level !== "error" && r.level !== "fatal") continue;
		const m = `${r.time ?? ""} [${r.area ?? "?"}] ${(r.message ?? "").split("\n")[0]!.slice(0, 160)}`;
		const k = `${r.area}|${r.message}`;
		if (!seen.has(k)) { seen.add(k); s.recent.push(m); }
	}
	return s;
}

/** The text of a problem report: a header of facts, the error summary, then the log lines. Everything is redacted here. */
export function formatReport(facts: Record<string, string | number | undefined>, lines: string[], total = lines.length): string {
	const sum = summarizeErrors(lines);
	const out: string[] = ["Zotero Next problem report", ""];
	for (const [k, v] of Object.entries(facts)) out.push(`${k}: ${v ?? "unknown"}`);
	out.push("");
	out.push(`Errors in this log: ${sum.errors} error, ${sum.fatal} fatal, ${sum.warnings} warning`);
	const areas = Object.entries(sum.byArea).map(([a, n]) => `${a} ${n}`).join(", ");
	if (areas) out.push(`By area: ${areas}`);
	if (sum.recent.length) { out.push("Most recent errors:"); for (const r of sum.recent) out.push(`  ${r}`); }
	out.push("");
	out.push(lines.length < total ? `Log lines (the last ${lines.length} of ${total}):` : `Log lines (${lines.length}):`);
	out.push(...lines);
	return redact(out.join("\n"));
}

// ------------------------------------------------------------------------------------------------------------ crash marker

export interface PreviousCrash { pid: number; startedAt: string; version?: string; build?: string; lastLogAt?: string }

const MARKER_RE = /^running-(\d+)\.json$/;
const markerOf = (pid: number) => join(logDir(), `running-${pid}.json`);

/** Time of the newest log line in the newest log file, if any. */
export function lastLogTime(dir = logDir()): string | undefined {
	const files = listLogFiles(dir);
	for (let i = files.length - 1; i >= 0; i--) {
		try {
			const f = files[i]!.file;
			const size = statSync(f).size;
			if (!size) continue;
			const len = Math.min(size, 16384);
			const fd = openSync(f, "r");
			const buf = Buffer.alloc(len);
			try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
			const rows = buf.toString("utf8").split("\n").filter((l) => l.trim());
			for (let j = rows.length - 1; j >= 0; j--) {
				try { const t = (JSON.parse(rows[j]!) as { time?: string }).time; if (t) return t; } catch { /* cut-off first line */ }
			}
		} catch { /* next file */ }
	}
	return undefined;
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

/**
 * At start: looks for markers left by processes that are gone (an unexpected end), logs "previous session ended unexpectedly" with the
 * time of the last log line, removes them, and writes this process's marker. Never throws. `alive` is injectable for tests.
 */
export function markRunning(o: { pid?: number; alive?: (pid: number) => boolean } = {}): PreviousCrash | null {
	const pid = o.pid ?? process.pid;
	const alive = o.alive ?? pidAlive;
	let crash: PreviousCrash | null = null;
	try {
		const dir = logDir();
		ensureDirSync(dir);
		const lastAt = lastLogTime(dir); // before this run adds its own lines
		for (const f of readdirSync(dir)) {
			const m = MARKER_RE.exec(f);
			if (!m) continue;
			const other = Number(m[1]);
			if (other === pid || alive(other)) continue; // another instance still running
			let info: Partial<PreviousCrash> = {};
			try { info = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<PreviousCrash>; } catch { /* torn marker */ }
			try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
			const c: PreviousCrash = { pid: other, startedAt: info.startedAt ?? "unknown", version: info.version, build: info.build, lastLogAt: lastAt };
			if (!crash || c.startedAt > crash.startedAt) crash = c;
		}
		writeFileSync(markerOf(pid), JSON.stringify({ pid, startedAt: cfg.now().toISOString(), version: appVersion(), build: buildVariant() }));
		if (crash) {
			log("error", "core", "previous session ended unexpectedly", undefined, {
				prevPid: crash.pid, prevStartedAt: crash.startedAt, lastLogAt: crash.lastLogAt ?? "none", prevVersion: crash.version, prevBuild: crash.build,
			});
		}
	} catch { /* no folder / read-only: no marker */ }
	return crash;
}

/** On a clean exit: flush and remove this process's marker. A process that logged a fatal error keeps it (that was not clean). */
export function markCleanExit(pid = process.pid): void {
	try {
		flushLogSync();
		if (fatalSeen) return;
		unlinkSync(markerOf(pid));
	} catch { /* none */ }
}

// ------------------------------------------------------------------------------------------------------------ zip (store/deflate, no dependencies)

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A .zip archive (deflate) of the given text/binary files. */
export function makeZip(files: { name: string; data: string | Uint8Array }[], when = new Date()): Uint8Array {
	const enc = new TextEncoder();
	const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
	const dosDate = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const f of files) {
		const name = enc.encode(f.name);
		const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
		const packed = new Uint8Array(deflateRawSync(raw));
		const crc = crc32(raw);
		const head = new DataView(new ArrayBuffer(30));
		head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 8, true);
		head.setUint16(10, dosTime, true); head.setUint16(12, dosDate, true); head.setUint32(14, crc, true);
		head.setUint32(18, packed.length, true); head.setUint32(22, raw.length, true); head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
		parts.push(new Uint8Array(head.buffer), name, packed);
		const cd = new DataView(new ArrayBuffer(46));
		cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 8, true);
		cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true);
		cd.setUint32(20, packed.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true);
		cd.setUint32(42, offset, true);
		central.push(new Uint8Array(cd.buffer), name);
		offset += 30 + name.length + packed.length;
	}
	const cdSize = central.reduce((n, p) => n + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
	end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
	const all = [...parts, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of all) { out.set(p, at); at += p.length; }
	return out;
}
