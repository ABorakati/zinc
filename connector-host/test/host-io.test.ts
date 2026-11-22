// The host's pipe handling, called through runHost with the frames a browser extension sends (no compiled exe needed):
// writes that wait for a full pipe, a cap on what uploads may hold, and the library left open under a running extraction.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/src/db";
import { extractions } from "../src/dispatch";
import { FrameReader, encodeFrame } from "../src/frames";
import { runHost } from "../src/host";
import { stdoutWriter, type WriteTarget } from "../src/stdout";

const dir = mkdtempSync(join(tmpdir(), "znh-io-"));
const dbPath = join(dir, "library.sqlite");
openDb(dbPath).close();
afterAll(() => {
	// a library left open on purpose by one test keeps its folder locked on Windows: never fail the run for that
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (e) {
		console.warn(`could not remove ${dir}:`, e);
	}
});

async function* frames(...msgs: unknown[]): AsyncIterable<Uint8Array> {
	for (const m of msgs) yield encodeFrame(m);
}
const spaces = (n: number) => Buffer.alloc(n, 0x20).toString("base64"); // JSON stays valid with trailing blanks

/** Runs the host over the messages and returns the decoded frames it wrote. */
async function run(msgs: unknown[], opts: Parameters<typeof runHost>[2] = {}) {
	const out: any[] = [];
	const reader = new FrameReader();
	await runHost(frames(...msgs), (b) => void out.push(...reader.push(b)), { dbPath, appPort: 0, ...opts });
	return out;
}
const ping = { t: "req", id: 1, method: "ping", http: "GET" };

describe("output pipe", () => {
	class FakeOut implements WriteTarget {
		handlers: Record<string, (() => void)[]> = {};
		full = false;
		written = 0;
		on(ev: string, fn: () => void) {
			(this.handlers[ev] ??= []).push(fn);
			return this;
		}
		emit(ev: string) {
			for (const f of this.handlers[ev] ?? []) f();
		}
		write(): boolean {
			this.written++;
			return !this.full;
		}
	}
	const settled = async (p: Promise<unknown>) => {
		let done = false;
		p.then(() => (done = true));
		await new Promise((r) => setTimeout(r, 10));
		return done;
	};

	test("a write waits for the pipe to drain when it said it was full", async () => {
		const out = new FakeOut();
		const write = stdoutWriter(out);
		out.full = true;
		const p = write(Buffer.from("a"));
		expect(await settled(p)).toBe(false);
		out.emit("drain");
		expect(await settled(p)).toBe(true);
	});

	test("when the pipe is closed the waits end and later writes are dropped", async () => {
		const out = new FakeOut();
		const write = stdoutWriter(out);
		out.full = true;
		const p = write(Buffer.from("a"));
		out.emit("close");
		expect(await settled(p)).toBe(true);
		const before = out.written;
		await write(Buffer.from("b"));
		expect(out.written).toBe(before);
	});

	test("a write that throws does not throw out of the writer", async () => {
		const out = new FakeOut();
		out.write = () => {
			throw new Error("EPIPE");
		};
		await stdoutWriter(out)(Buffer.from("a"));
	});

	test("the host waits for a slow write before it finishes", async () => {
		let release!: () => void;
		let wrote = 0;
		const done = runHost(
			frames(ping),
			() => {
				wrote++;
				return new Promise<void>((r) => (release = r));
			},
			{ dbPath, appPort: 0 },
		);
		expect(await settled(done)).toBe(false);
		expect(wrote).toBe(1);
		release();
		expect(await settled(done)).toBe(true);
	});

	test("a write that fails does not stop the host", async () => {
		await runHost(
			frames(ping),
			() => {
				throw new Error("EPIPE");
			},
			{ dbPath, appPort: 0 },
		);
	});
});

describe("uploads", () => {
	const selection = (uid: string) => ({
		t: "req",
		id: 9,
		method: "api",
		http: "POST",
		path: "/api/ui/selection",
		headers: { "Content-Type": "application/json" },
		body: { kind: "upload", uid },
	});
	const json = Buffer.from(JSON.stringify({ kind: "library" })).toString("base64");
	const status = (out: any[]) => out.find((f) => f.t === "res")?.status;

	test("an upload within the limits is used", async () => {
		const out = await run([{ t: "up", uid: "u", data: json, last: true }, selection("u")]);
		expect(status(out)).toBe(200);
	});

	test("one upload over the limit is dropped, and the request that names it fails", async () => {
		const out = await run([{ t: "up", uid: "u", data: json, last: true }, selection("u")], { maxUploadBytes: 10 });
		expect(status(out)).toBe(400);
	});

	test("chunks of an upload that grows past the limit are dropped, the later chunks too", async () => {
		const out = await run(
			[
				{ t: "up", uid: "u", data: json },
				{ t: "up", uid: "u", data: spaces(60) },
				{ t: "up", uid: "u", data: spaces(60), last: true },
				selection("u"),
			],
			{ maxUploadBytes: 100 },
		);
		expect(status(out)).toBe(400);
	});

	test("uploads together over the held limit are dropped, the first stays", async () => {
		const out = await run(
			[
				{ t: "up", uid: "a", data: json, last: true },
				{ t: "up", uid: "b", data: json, last: true },
				{ ...selection("b"), id: 1 },
				{ ...selection("a"), id: 2 },
			],
			{ maxHeldUploadBytes: Buffer.from(json, "base64").length + 5 },
		);
		const byId = Object.fromEntries(out.filter((f) => f.t === "res").map((f) => [f.id, f.status]));
		expect(byId).toEqual({ 1: 400, 2: 200 });
	});
});

describe("exit with an extraction still running", () => {
	function counting() {
		let closed = 0;
		const open = (p: string): Database => {
			const db = openDb(p);
			const close = db.close.bind(db);
			db.close = (...a: Parameters<Database["close"]>) => {
				closed++;
				return close(...a);
			};
			return db;
		};
		return { open, closed: () => closed };
	}
	const selectionRead = { t: "req", id: 3, method: "api", http: "GET", path: "/api/ui/selection" };

	test("the library is left open when an extraction outlives the wait", async () => {
		const c = counting();
		let finish!: () => void;
		const running = new Promise<void>((r) => (finish = r));
		extractions.add(running);
		const warn = console.error;
		const logged: string[] = [];
		console.error = (...a: unknown[]) => void logged.push(a.join(" "));
		try {
			await run([selectionRead], { open: c.open, drainMs: 20 });
		} finally {
			console.error = warn;
			extractions.delete(running);
			finish();
		}
		expect(c.closed()).toBe(0);
		expect(logged.join("\n")).toContain("still running");
	});

	test("the library is closed when no extraction is running", async () => {
		const c = counting();
		await run([selectionRead], { open: c.open, drainMs: 20 });
		expect(c.closed()).toBe(1);
	});

	test("the library is closed when the extraction finishes within the wait", async () => {
		const c = counting();
		const quick = new Promise<void>((r) => setTimeout(r, 5));
		extractions.add(quick);
		try {
			await run([selectionRead], { open: c.open, drainMs: 2000 });
		} finally {
			extractions.delete(quick);
		}
		expect(c.closed()).toBe(1);
	});
});
