// The add-in's field order (FieldOrder.cs) on plain numbers, through the C# harness. It starts the harness only: no Word is
// started, no library is opened. Skipped when the harness is not built (pwsh word/build.ps1 -Harness, or ZN_WORD_DIST).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const d = existsSync(HARNESS_EXE) ? describe : describe.skip;

type Order = { order: number[]; notes: number[] };

d("field order without Word", () => {
	let h: HarnessHost;
	const order = (fields: { main: boolean; start: number }[], notes: number[][] = []) => h.call<Order>("h.fieldOrder", { fields, notes });

	beforeAll(async () => {
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-order-"));
		h = await HarnessHost.start({ db: join(tmp, "none.sqlite"), settings: join(tmp, "settings.json"), cache: join(tmp, "cache") });
	}, 30_000);

	afterAll(async () => {
		await h?.stop();
	}, 30_000);

	test("body and note fields interleave by position", async () => {
		const r = await order(
			[
				{ main: true, start: 100 },
				{ main: false, start: 12 },
				{ main: true, start: 200 },
			],
			[[10, 20, 150]],
		);
		expect(r.order).toEqual([0, 1, 2]);
		expect(r.notes).toEqual([0, 1, 0]);
	});

	test("fields past 2.1 million characters keep document order", async () => {
		const r = await order(
			[
				{ main: true, start: 100 },
				{ main: true, start: 2_147_484 },
				{ main: true, start: 4_294_968 },
				{ main: true, start: 3_000_000 },
				{ main: true, start: 2_147_483 },
			],
			[],
		);
		expect(r.order).toEqual([0, 4, 1, 3, 2]);
	});

	test("note fields sort at their reference mark, in note order, and an unmapped one comes last", async () => {
		const r = await order(
			[
				{ main: true, start: 100 }, // 0
				{ main: true, start: 2_147_484 }, // 1
				{ main: false, start: 12 }, // 2  note 1, mark at 2,147,490
				{ main: false, start: 15 }, // 3  note 1 again: keeps scan order
				{ main: false, start: 35 }, // 4  note 2, mark at 50
				{ main: false, start: 999 }, // 5  in no note
				{ main: true, start: 5_000_000 }, // 6
			],
			[
				[10, 20, 2_147_490],
				[30, 40, 50],
			],
		);
		expect(r.notes).toEqual([0, 0, 1, 1, 2, 0, 0]);
		expect(r.order).toEqual([4, 0, 1, 2, 3, 6, 5]);
	});
});
