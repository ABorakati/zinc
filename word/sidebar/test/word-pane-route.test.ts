// A ribbon command reaches the sidebar of one Word window only. Real PaneControl objects (never shown, so not loaded and not
// visible) in the C# harness; no Word is started. Skipped when the harness is not built (pwsh word/build.ps1 -Harness, or ZN_WORD_DIST).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const d = existsSync(HARNESS_EXE) ? describe : describe.skip;

d("ribbon command routing without Word", () => {
	let h: HarnessHost;
	const send = (panes: number[], target: number) => h.call<{ count: number; got: number[] }>("h.paneRoute", { panes, target });

	beforeAll(async () => {
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-route-"));
		h = await HarnessHost.start({ db: join(tmp, "none.sqlite"), settings: join(tmp, "settings.json"), cache: join(tmp, "cache") });
	}, 30_000);

	afterAll(async () => {
		await h?.stop();
	}, 30_000);

	test("the sidebar of the active window gets the command, the others do not", async () => {
		const r = await send([1001, 2002, 3003], 2002);
		expect(r.got).toEqual([1]);
		expect(r.count).toBe(1);
	});

	test("a sidebar that is hidden or still loading is still the one that gets it", async () => {
		// none of these panes was ever shown or loaded
		const r = await send([1001, 2002], 1001);
		expect(r.got).toEqual([0]);
	});

	test("a window with no sidebar gets nothing, and no other window's sidebar does either", async () => {
		const r = await send([1001, 2002], 9999);
		expect(r.got).toEqual([]);
	});

	test("a sidebar whose window is not known is included, since it cannot be told from the right one", async () => {
		const r = await send([0, 2002, 3003], 2002);
		expect(r.got).toEqual([0, 1]);
	});
});
