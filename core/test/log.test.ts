import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
	configureLog, flushLog, formatReport, installConsoleMirror, lastLogTime, listLogFiles, log, logError, makeZip, markCleanExit, markRunning,
	pruneLogs, readRecentLogs, redact, resetLog, summarizeErrors,
} from "../src/log";

let dir: string;
let clock: Date;
const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "zn-log-"));
	clock = new Date(2026, 10, 6, 12, 0, 0);
	resetLog();
	configureLog({ dir, now: () => clock, version: "1.2.3", build: "source", os: "TestOS 1.0 x64", home: "C:\\Users\\alice" });
});
afterEach(async () => {
	await flushLog();
	resetLog();
	rmSync(dir, { recursive: true, force: true });
});

describe("redaction", () => {
	test("API keys, tokens and Bearer headers", () => {
		expect(redact("Authorization: Bearer abcdef1234567890XYZ")).not.toContain("abcdef1234567890XYZ");
		expect(redact("header Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fw")).toBe("header Bearer [redacted]");
		expect(redact("Zotero-API-Key: Qm4yT8bP0wLk3VnX9sRz7HcA")).toBe("Zotero-API-Key: [redacted]");
		expect(redact('{"apiKey":"Qm4yT8bP0wLk3VnX9sRz7HcA","x":1}')).toBe('{"apiKey":"[redacted]","x":1}');
		expect(redact("GET https://api.zotero.org/users/1/items?key=Qm4yT8bP0wLk3VnX9sRz7HcA&limit=5")).toBe("GET https://api.zotero.org/users/1/items?key=[redacted]&limit=5");
		expect(redact("token=abc123 password: hunter2")).toBe("token=[redacted] password: [redacted]");
		expect(redact("using sk-abcdefghijklmnopqrstuv0123 now")).toBe("using [redacted-key] now");
		expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[redacted-key]");
	});
	test("key-like strings, but not ordinary words", () => {
		expect(redact("id Qm4yT8bP0wLk3VnX9sRz7HcA done")).toBe("id [redacted-key] done");
		expect(redact("internationalizationconfiguration is fine")).toBe("internationalizationconfiguration is fine");
		expect(redact("item ABCD1234 in collection")).toBe("item ABCD1234 in collection");
		expect(redact("GET /api/items/ABCD1234/children")).toBe("GET /api/items/ABCD1234/children");
	});
	test("titles, notes and other content fields", () => {
		const out = redact('{"title":"My secret thesis","note":"<p>dear diary</p>","itemType":"book"}');
		expect(out).not.toContain("secret thesis");
		expect(out).not.toContain("diary");
		expect(out).toContain('"itemType":"book"');
	});
	test("the user's folder becomes %USERPROFILE%, in all spellings", () => {
		expect(redact("open C:\\Users\\alice\\zotero-next\\data\\library.sqlite")).toBe("open %USERPROFILE%\\zotero-next\\data\\library.sqlite");
		expect(redact("at file:///C:/Users/alice/x.ts:1")).toBe("at file:///%USERPROFILE%/x.ts:1");
		expect(redact("json C:\\\\Users\\\\alice\\\\a")).toBe("json %USERPROFILE%\\\\a");
		expect(redact("c:\\users\\ALICE\\a")).toBe("%USERPROFILE%\\a");
		expect(redact("other C:\\Users\\bob\\Documents\\f.pdf")).toBe("other %USERPROFILE%\\Documents\\f.pdf");
	});
	test("is idempotent", () => {
		const once = redact("Bearer abcdefgh12345678 in C:\\Users\\alice\\x token=zzz");
		expect(redact(once)).toBe(once);
	});
	test("log lines are redacted when written", async () => {
		log("error", "core", "request failed for C:\\Users\\alice\\a.pdf with Bearer abcdefgh12345678", new Error("boom at C:\\Users\\alice\\b.ts"), { url: "https://x/?key=Qm4yT8bP0wLk3VnX9sRz7HcA" });
		await flushLog();
		const text = readFileSync(listLogFiles(dir)[0]!.file, "utf8");
		expect(text).not.toContain("alice");
		expect(text).not.toContain("abcdefgh12345678");
		expect(text).not.toContain("Qm4yT8bP0wLk3VnX9sRz7HcA");
		expect(text).toContain("%USERPROFILE%");
	});
});

describe("log lines", () => {
	test("format", async () => {
		logError("sync", new Error("kaboom"), "pull", { count: 3, note: undefined });
		await flushLog();
		const files = listLogFiles(dir);
		expect(files.map((f) => f.day)).toEqual([day(clock)]);
		const [r] = lines(files[0]!.file);
		expect(r).toMatchObject({ level: "error", area: "sync", message: "pull: Error: kaboom", version: "1.2.3", build: "source", os: "TestOS 1.0 x64", ctx: { count: 3 } });
		expect(r.time).toBe(clock.toISOString());
		expect(r.stack).toContain("kaboom");
		expect(r.ctx.note).toBeUndefined();
	});
	test("never throws, whatever it is given", () => {
		const evil = { get message(): string { throw new Error("getter"); } };
		expect(() => logError("core", evil)).not.toThrow();
		expect(() => log("info", "ui", undefined as unknown as string)).not.toThrow();
		configureLog({ dir: join(dir, "a\0b") }); // an impossible folder
		expect(() => log("error", "core", "x")).not.toThrow();
	});
	test("a burst is rate limited and says so", async () => {
		configureLog({ rateMax: 5 });
		for (let i = 0; i < 20; i++) log("warn", "ui", `m${i}`);
		clock = new Date(clock.getTime() + 11_000);
		log("warn", "ui", "later");
		await flushLog();
		const rows = lines(listLogFiles(dir)[0]!.file).map((r) => r.message as string);
		expect(rows.filter((m) => /^m\d+$/.test(m))).toHaveLength(5);
		expect(rows.some((m) => m.startsWith("log rate limit: 15"))).toBe(true);
		expect(rows).toContain("later");
	});
	test("console.error / warn are mirrored and still printed", async () => {
		const printed: unknown[][] = [];
		const keep = { error: console.error, warn: console.warn };
		console.error = (...a: unknown[]) => void printed.push(a);
		console.warn = (...a: unknown[]) => void printed.push(a);
		(console as unknown as { __znMirror?: boolean }).__znMirror = false;
		try {
			installConsoleMirror("ui");
			console.error("[sync] pull failed", new Error("nope"));
			console.warn("plain warning");
			await flushLog();
		} finally {
			console.error = keep.error;
			console.warn = keep.warn;
			(console as unknown as { __znMirror?: boolean }).__znMirror = false;
		}
		// Background work from earlier tests (a failed full-text extraction, say) can also log while this runs: look only at our two lines.
		const ours = (m: unknown) => typeof m === "string" && (m.startsWith("[sync] pull failed") || m === "plain warning");
		expect(printed.filter((a) => ours(a[0]))).toHaveLength(2);
		const rows = lines(listLogFiles(dir)[0]!.file).filter((r) => ours(r.message) || /pull failed/.test(String(r.message)));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ level: "error", area: "sync" });
		expect(rows[0].stack).toContain("nope");
		expect(rows[1]).toMatchObject({ level: "warn", area: "ui", message: "plain warning" });
	});
	test("objects are logged by shape, not by content", async () => {
		const keep = console.error;
		console.error = () => {};
		(console as unknown as { __znMirror?: boolean }).__znMirror = false;
		try {
			installConsoleMirror("ui");
			console.error("item", { title: "Private title", creators: [] });
			await flushLog();
		} finally {
			console.error = keep;
			(console as unknown as { __znMirror?: boolean }).__znMirror = false;
		}
		const text = readFileSync(listLogFiles(dir)[0]!.file, "utf8");
		expect(text).not.toContain("Private title");
	});
});

describe("rotation and size cap", () => {
	test("one file per day", async () => {
		log("info", "core", "day one");
		await flushLog();
		clock = new Date(2026, 10, 7, 9, 0, 0);
		log("info", "core", "day two");
		await flushLog();
		expect(listLogFiles(dir).map((f) => f.day)).toEqual(["2026-11-06", "2026-11-07"]);
	});
	test("keeps 14 days: today and the 13 before; older files go, other files stay", () => {
		const name = (d: string) => join(dir, `zotero-next-${d}.log`);
		for (const d of ["2026-10-22", "2026-10-23", "2026-10-24", "2026-11-06"]) writeFileSync(name(d), "x\n");
		writeFileSync(join(dir, "notes.txt"), "keep");
		const gone = pruneLogs(dir, clock, 14);
		expect(gone.sort()).toEqual(["zotero-next-2026-10-22.log", "zotero-next-2026-10-23.log"]);
		expect(existsSync(name("2026-10-24"))).toBe(true); // the 14th day counting today as the first
		expect(existsSync(join(dir, "notes.txt"))).toBe(true);
	});
	test("pruning happens when the first line of a new day is written", async () => {
		writeFileSync(join(dir, "zotero-next-2026-09-01.log"), "x\n");
		log("info", "core", "now");
		await flushLog();
		expect(existsSync(join(dir, "zotero-next-2026-09-01.log"))).toBe(false);
	});
	test("a file stays under the cap: it rolls to .old and the old .old is replaced", async () => {
		configureLog({ maxBytes: 2000 });
		for (let i = 0; i < 60; i++) {
			log("info", "core", `line ${i} ${"x".repeat(60)}`);
			await flushLog();
		}
		const names = readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
		expect(names).toEqual(["zotero-next-2026-11-06.log", "zotero-next-2026-11-06.old.log"]);
		const [current, rolled] = names as [string, string];
		for (const n of names) expect(readFileSync(join(dir, n)).length).toBeLessThanOrEqual(2000);
		const cur = lines(join(dir, current)).map((r) => r.message as string);
		expect(cur.at(-1)).toContain("line 59"); // the newest line is in the current file
		const all = [...lines(join(dir, rolled)).map((r) => r.message as string), ...cur];
		expect(all.some((m) => m.includes("line 0 "))).toBe(false); // the oldest lines were dropped
		expect(listLogFiles(dir).map((f) => f.old)).toEqual([true, false]); // .old is read before the current file
	});
	test("a restart continues the same file and respects its size", async () => {
		configureLog({ maxBytes: 1500 });
		for (let i = 0; i < 4; i++) log("info", "core", `a${i} ${"y".repeat(100)}`);
		await flushLog();
		configureLog({ maxBytes: 1500 }); // a new process: the size is read from disk again
		for (let i = 0; i < 12; i++) log("info", "core", `b${i} ${"y".repeat(100)}`);
		await flushLog();
		for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(1500);
	});
});

describe("reading and reports", () => {
	test("the last two days only, oldest first, capped to the newest lines", () => {
		const w = (d: string, msgs: string[]) => writeFileSync(join(dir, `zotero-next-${d}.log`), msgs.map((m) => JSON.stringify({ time: `${d}T10:00:00.000Z`, level: "info", area: "core", message: m })).join("\n") + "\n");
		w("2026-11-04", ["too old"]);
		w("2026-11-05", ["y1", "y2"]);
		w("2026-11-06", ["t1", "t2"]);
		const r = readRecentLogs(2, 3, dir, clock);
		expect(r.total).toBe(4);
		expect(r.lines.map((l) => JSON.parse(l).message)).toEqual(["y2", "t1", "t2"]);
	});
	test("lines are redacted again on the way out", () => {
		writeFileSync(join(dir, "zotero-next-2026-11-06.log"), JSON.stringify({ time: "t", level: "info", area: "core", message: "C:\\Users\\alice\\a Bearer abcdefgh12345678" }) + "\n");
		expect(readRecentLogs(2, 10, dir, clock).lines[0]).not.toMatch(/alice|abcdefgh12345678/);
	});
	test("summary and report text", () => {
		const rec = (level: string, area: string, message: string) => JSON.stringify({ time: "2026-11-06T10:00:00Z", level, area, message });
		const ls = [rec("error", "core", "a"), rec("error", "core", "a"), rec("warn", "ui", "w"), rec("fatal", "ui", "dead"), rec("error", "sync", "b")];
		const s = summarizeErrors(ls);
		expect(s).toMatchObject({ errors: 3, fatal: 1, warnings: 1, byArea: { core: 2, ui: 1, sync: 1 } });
		expect(s.recent).toHaveLength(3); // "a" once
		const text = formatReport({ "App version": "1.2.3", "Library items": 42 }, ls, 9);
		expect(text).toContain("App version: 1.2.3");
		expect(text).toContain("Library items: 42");
		expect(text).toContain("the last 5 of 9");
	});
});

describe("zip", () => {
	test("local headers, central directory and contents round-trip", () => {
		const zip = makeZip([{ name: "a.txt", data: "hello hello hello" }, { name: "dir/b.log", data: new Uint8Array([1, 2, 3, 4]) }]);
		const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
		expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(2);
		const nameLen = dv.getUint16(26, true);
		expect(new TextDecoder().decode(zip.slice(30, 30 + nameLen))).toBe("a.txt");
		const packedLen = dv.getUint32(18, true);
		const body = inflateRawSync(zip.slice(30 + nameLen, 30 + nameLen + packedLen));
		expect(new TextDecoder().decode(body)).toBe("hello hello hello");
	});
});

describe("crash marker", () => {
	const markers = () => readdirSync(dir).filter((f) => f.startsWith("running-"));
	test("first start: no crash, a marker is written; a clean exit removes it", () => {
		expect(markRunning({ pid: 111, alive: () => false })).toBeNull();
		expect(markers()).toEqual(["running-111.json"]);
		markCleanExit(111);
		expect(markers()).toEqual([]);
		expect(markRunning({ pid: 112, alive: () => false })).toBeNull();
	});
	test("a leftover marker of a dead process = previous session ended unexpectedly, with the last log time", async () => {
		markRunning({ pid: 111, alive: () => false });
		clock = new Date(2026, 10, 6, 12, 30, 0);
		log("info", "core", "last words");
		await flushLog();
		const lastAt = clock.toISOString();
		clock = new Date(2026, 10, 7, 8, 0, 0);
		const crash = markRunning({ pid: 222, alive: () => false });
		expect(crash).toMatchObject({ pid: 111, lastLogAt: lastAt, version: "1.2.3" });
		expect(markers()).toEqual(["running-222.json"]); // the old marker is consumed, so the next start is quiet
		await flushLog();
		const rows = lines(join(dir, "zotero-next-2026-11-07.log"));
		expect(rows.at(-1)).toMatchObject({ level: "error", message: "previous session ended unexpectedly", ctx: { prevPid: 111, lastLogAt: lastAt } });
		markCleanExit(222);
		expect(markRunning({ pid: 333, alive: () => false })).toBeNull();
	});
	test("a marker of a process that is still running (a second instance) is not a crash and is kept", () => {
		markRunning({ pid: 111, alive: () => false });
		expect(markRunning({ pid: 222, alive: (p) => p === 111 })).toBeNull();
		expect(markers().sort()).toEqual(["running-111.json", "running-222.json"]);
	});
	test("after a fatal error the exit is not clean: the marker stays", () => {
		markRunning({ pid: 111, alive: () => false });
		log("fatal", "core", "uncaught");
		markCleanExit(111);
		expect(markers()).toEqual(["running-111.json"]);
		expect(markRunning({ pid: 222, alive: () => false })).not.toBeNull();
	});
	test("a torn or empty marker still counts; lastLogTime of an empty folder is undefined", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "running-999.json"), "{not json");
		expect(lastLogTime(dir)).toBeUndefined();
		expect(markRunning({ pid: 5, alive: () => false })).toMatchObject({ pid: 999, startedAt: "unknown" });
	});
});
