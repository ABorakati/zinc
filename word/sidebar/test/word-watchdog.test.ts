// The UI watchdog's clock arithmetic (UiWatchdog.cs) on plain Environment.TickCount values, through the C# harness: no Word is
// started. Skipped when the harness is not built (pwsh word/build.ps1 -Harness, or ZN_WORD_DIST).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const d = existsSync(HARNESS_EXE) ? describe : describe.skip;
const MAX = 2147483647;
const MIN = -2147483648;

d("UI watchdog clock without Word", () => {
	let h: HarnessHost;
	const since = async (pairs: [number, number][]) => (await h.call<{ ms: number[] }>("h.watchdogSince", { pairs })).ms;

	beforeAll(async () => {
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-watchdog-"));
		h = await HarnessHost.start({ db: join(tmp, "none.sqlite"), settings: join(tmp, "settings.json"), cache: join(tmp, "cache") });
	}, 30_000);

	afterAll(async () => {
		await h?.stop();
	}, 30_000);

	test("an interval is its length, and never negative", async () => {
		expect(await since([[5000, 4000], [100, 100], [0, 0]])).toEqual([1000, 0, 0]);
	});

	test("an interval that spans the 24.9 day wrap of the tick counter is still short", async () => {
		// the beat was taken 500 ms before the counter turned negative, the check 500 ms after: 1 s, not -4,294,966 s
		expect(await since([[MIN + 500, MAX - 500]])).toEqual([1001]);
		expect(await since([[0, -1], [MIN, MAX], [10, -10]])).toEqual([1, 1, 20]);
	});

	test("an interval that spans the wrap back to zero at 49.7 days is still short", async () => {
		expect(await since([[500, -500]])).toEqual([1000]);
	});
});
