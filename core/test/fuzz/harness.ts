// Shared helpers for the property-based fuzz tests (fast-check, run by `bun test`).
//
//   bun test test/fuzz                          normal run: ~150 cases per property, whole suite well under a minute
//   ZN_FUZZ_RUNS=5000 bun test test/fuzz        long run (overnight)
//   ZN_FUZZ_SEED=123 ZN_FUZZ_PATH="4:2:1" bun test test/fuzz/ris.fuzz.test.ts -t "<property name>"
//                                               replay one failure: the failure output prints the exact seed and path
//
// A failing property prints "[fuzz] FAILED <name>" plus a "replay:" line with ZN_FUZZ_SEED / ZN_FUZZ_PATH, and fast-check's
// shrunk counterexample.
import { test } from "bun:test";
import fc from "fast-check";

export { fc };

const envInt = (name: string): number | undefined => {
	const v = process.env[name];
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

/** Cases per property: ZN_FUZZ_RUNS when set, else `normal` (default 150). */
export function runs(normal = 150): number {
	return envInt("ZN_FUZZ_RUNS") ?? normal;
}

/** Seed for this process: ZN_FUZZ_SEED, else random (printed on failure so it can be replayed). */
export const SEED: number = envInt("ZN_FUZZ_SEED") ?? Math.floor(Math.random() * 2 ** 31) | 0;
const PATH: string | undefined = process.env.ZN_FUZZ_PATH || undefined;

export interface PropOptions {
	/** Cases in a normal run (a ZN_FUZZ_RUNS value overrides it). */
	normal?: number;
	/** Wall-clock limit per case in milliseconds: a case that takes longer fails ("never hangs"). Default 3000. */
	timeBoxMs?: number;
}

/** A named property test. The property may be sync or async; throwing (or expect() failing) is a counterexample. */
export function fuzz<T extends unknown[]>(
	name: string,
	arbs: { [K in keyof T]: fc.Arbitrary<T[K]> },
	property: (...args: T) => void | Promise<void>,
	opts: PropOptions = {},
): void {
	const limit = opts.timeBoxMs ?? 3000;
	test(
		name,
		async () => {
			const wrapped = async (...args: T) => {
				const t0 = performance.now();
				await property(...args);
				const dt = performance.now() - t0;
				if (dt > limit) throw new Error(`case took ${Math.round(dt)} ms (limit ${limit} ms): possible hang or quadratic blow-up`);
			};
			try {
				await fc.assert((fc.asyncProperty as unknown as (...a: unknown[]) => fc.IAsyncProperty<T>)(...arbs, wrapped), {
					numRuns: runs(opts.normal),
					seed: SEED,
					path: PATH,
					verbose: 0,
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const path = /path: "([^"]*)"/.exec(msg)?.[1] ?? "";
				console.error(
					`[fuzz] FAILED ${name}\n  replay: ZN_FUZZ_SEED=${SEED}${path ? ` ZN_FUZZ_PATH="${path}"` : ""} bun test <file> -t ${JSON.stringify(name)}`,
				);
				throw e;
			}
		},
		600_000,
	);
}

// ---------- generators ----------

/** Fragments that tend to break parsers: delimiters of every format we read, controls, astral and lookalike code points. */
export const NASTY = [
	"{",
	"}",
	"(",
	")",
	"[",
	"]",
	"<",
	">",
	'"',
	"'",
	"\\",
	"/",
	"&",
	"&amp;",
	"&#x0;",
	"&#65;",
	"&lt;",
	"<![CDATA[",
	"]]>",
	"<!--",
	"-->",
	"<?xml",
	"<!DOCTYPE",
	"@",
	"#",
	"%",
	"$",
	"=",
	",",
	";",
	":",
	"|",
	"\n",
	"\r\n",
	"\r",
	"\t",
	"\0",
	"\u0001",
	"\u007f",
	"​",
	"﻿",
	"‮",
	"😀",
	"\ud800",
	"\udfff",
	"é",
	"ß",
	"ø",
	"Ł",
	"—",
	"–",
	"−",
	"．",
	"／",
	"  ",
	"ER  - ",
	"TY  - JOUR",
	"AU  - ",
	"@article{",
	"}}",
	"{{",
	"\\'",
	'\\"',
	"\\{",
	"\\}",
	"$$",
	"--",
	"...",
];

export const nastyToken: fc.Arbitrary<string> = fc.constantFrom(...NASTY);

/** Fully random text mixed with nasty tokens. */
export const messyText = (maxLength = 400): fc.Arbitrary<string> =>
	fc
		.array(
			fc.oneof(
				{ weight: 3, arbitrary: fc.string({ maxLength: 12 }) },
				{ weight: 2, arbitrary: nastyToken },
				{ weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 6 }) },
			),
			{ maxLength: Math.ceil(maxLength / 4) },
		)
		.map((a) => a.join("").slice(0, maxLength));

/** A valid seed document with a few random edits (delete / duplicate / swap a slice, insert a nasty token, flip a char, truncate, repeat). */
export function mutated(seed: string | fc.Arbitrary<string>, maxEdits = 6): fc.Arbitrary<string> {
	const seeds = typeof seed === "string" ? fc.constant(seed) : seed;
	const edit = fc.record({
		op: fc.constantFrom("delete", "insert", "dup", "swap", "flip", "truncate", "repeat", "token"),
		at: fc.double({ min: 0, max: 1, noNaN: true }),
		len: fc.integer({ min: 1, max: 40 }),
		tok: nastyToken,
		ch: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
		to: fc.double({ min: 0, max: 1, noNaN: true }),
	});
	return fc.tuple(seeds, fc.array(edit, { minLength: 1, maxLength: maxEdits })).map(([s0, edits]) => {
		let s = s0;
		for (const e of edits) {
			if (s.length === 0 && e.op !== "insert" && e.op !== "token") continue;
			const i = Math.min(s.length, Math.floor(e.at * (s.length + 1)));
			const j = Math.min(s.length, i + e.len);
			switch (e.op) {
				case "delete":
					s = s.slice(0, i) + s.slice(j);
					break;
				case "insert":
					s = s.slice(0, i) + e.ch + s.slice(i);
					break;
				case "token":
					s = s.slice(0, i) + e.tok + s.slice(i);
					break;
				case "dup":
					s = s.slice(0, j) + s.slice(i, j) + s.slice(j);
					break;
				case "swap": {
					const k = Math.min(s.length, Math.floor(e.to * (s.length + 1)));
					if (k > i) s = s.slice(0, i) + s.slice(k, k + e.len) + s.slice(i, k) + s.slice(k + e.len);
					break;
				}
				case "flip":
					s = s.slice(0, i) + e.ch + s.slice(i + 1);
					break;
				case "truncate":
					s = s.slice(0, i);
					break;
				case "repeat":
					s = s.slice(0, i) + s.slice(i, j).repeat(1 + (e.len % 20)) + s.slice(j);
					break;
			}
		}
		return s;
	});
}

/** The same mutations on raw bytes. */
export function mutatedBytes(seed: Uint8Array, maxEdits = 6): fc.Arbitrary<Uint8Array> {
	const edit = fc.record({
		op: fc.constantFrom("flip", "set", "delete", "insert", "truncate", "dup", "u16", "u32"),
		at: fc.double({ min: 0, max: 1, noNaN: true }),
		len: fc.integer({ min: 1, max: 32 }),
		byte: fc.integer({ min: 0, max: 255 }),
		val: fc.constantFrom(0, 1, 0x7f, 0x80, 0xff, 0xffff, 0x7fffffff, 0xffffffff),
	});
	return fc.array(edit, { minLength: 1, maxLength: maxEdits }).map((edits) => {
		let b = Array.from(seed);
		for (const e of edits) {
			const i = Math.min(Math.max(b.length - 1, 0), Math.floor(e.at * b.length));
			switch (e.op) {
				case "flip":
					if (b.length) b[i] = b[i]! ^ (1 << (e.byte % 8));
					break;
				case "set":
					if (b.length) b[i] = e.byte;
					break;
				case "delete":
					b.splice(i, e.len);
					break;
				case "insert":
					b.splice(i, 0, ...Array.from({ length: e.len }, (_, k) => (e.byte + k) & 255));
					break;
				case "truncate":
					b = b.slice(0, i);
					break;
				case "dup":
					b.splice(i, 0, ...b.slice(i, i + e.len));
					break;
				case "u16":
					if (b.length > i + 1) {
						b[i] = e.val & 255;
						b[i + 1] = (e.val >>> 8) & 255;
					}
					break;
				case "u32":
					if (b.length > i + 3) for (let k = 0; k < 4; k++) b[i + k] = (e.val >>> (8 * k)) & 255;
					break;
			}
		}
		return new Uint8Array(b);
	});
}

/** Run `fn` and return what it threw (or null). */
export function thrown(fn: () => unknown): unknown {
	try {
		fn();
		return null;
	} catch (e) {
		return e;
	}
}

export const describeError = (e: unknown): string => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));
