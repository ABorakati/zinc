// Helpers for the property-based fuzz tests in this package (*.fuzz.test.ts, fast-check, run by `bun test`).
// Same contract as core/test/fuzz/harness.ts:
//   bun test                                    normal run: ~150 cases per property
//   ZN_FUZZ_RUNS=5000 bun test fuzz             long run
//   ZN_FUZZ_SEED=123 ZN_FUZZ_PATH="4:2:1" bun test <file> -t "<name>"   replay (a failure prints both)
import { test } from "bun:test";
import fc from "fast-check";

export { fc };

const envInt = (name: string): number | undefined => {
	const v = process.env[name];
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

export const runs = (normal = 150): number => envInt("ZN_FUZZ_RUNS") ?? normal;
export const SEED: number = envInt("ZN_FUZZ_SEED") ?? (Math.floor(Math.random() * 2 ** 31) | 0);
const PATH: string | undefined = process.env.ZN_FUZZ_PATH || undefined;

export function fuzz<T extends unknown[]>(
	name: string,
	arbs: { [K in keyof T]: fc.Arbitrary<T[K]> },
	property: (...args: T) => void | Promise<void>,
	opts: { normal?: number; timeBoxMs?: number } = {},
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
				await fc.assert((fc.asyncProperty as unknown as (...a: unknown[]) => fc.IAsyncProperty<T>)(...arbs, wrapped), { numRuns: runs(opts.normal), seed: SEED, path: PATH, verbose: 0 });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const path = /path: "([^"]*)"/.exec(msg)?.[1] ?? "";
				console.error(`[fuzz] FAILED ${name}\n  replay: ZN_FUZZ_SEED=${SEED}${path ? ` ZN_FUZZ_PATH="${path}"` : ""} bun test <file> -t ${JSON.stringify(name)}`);
				throw e;
			}
		},
		600_000,
	);
}

/** Fragments that tend to break parsers and URL builders. */
export const NASTY = ["{", "}", "<", ">", '"', "'", "\\", "/", "&", "=", "?", "#", "%", "%00", "%2F", "@", ":", ";", " ", "\n", "\0", "‮", "😀", "\ud800", "é", "..", "{z:title}", "{x?}", "&amp;", "&#99999999;", "javascript:", "//", "../"];
export const messyText = (maxLength = 60): fc.Arbitrary<string> =>
	fc
		.array(fc.oneof({ weight: 3, arbitrary: fc.string({ maxLength: 8 }) }, { weight: 2, arbitrary: fc.constantFrom(...NASTY) }), { maxLength: 12 })
		.map((a) => a.join("").slice(0, maxLength));
