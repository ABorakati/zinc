// A quick pass of the differential fuzzer: 25 seeds against the richtext-core bridge and Zotero's note-editor oracle.
// Skipped unless ZN_RICHTEXT_BRIDGE names a built `pm_bridge` (cargo build --release --features fuzz --example pm_bridge in
// gpuix/packages/richtext-core) and the oracle exists (bun scripts/fuzz/build-oracle.ts).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { runFuzz, summary } from "./fuzz-notes";
import { DEFAULT_ORACLE } from "./oracle";

const bridge = process.env.ZN_RICHTEXT_BRIDGE;
const ready = !!bridge && existsSync(bridge) && existsSync(DEFAULT_ORACLE);

test.skipIf(!ready)(
	"25 random notes agree with Zotero's note editor",
	async () => {
		const r = await runFuzz({ bridge: bridge!, seeds: 25, shrinkMax: 0, fixtures: false });
		// R2c (attribute order, entity forms, `style` formatting) is linkedom's serializer against Gecko's: known, not a failure
		const failing = Object.entries(r.failuresByCheck).filter(([c, n]) => c !== "R2c" && n > 0);
		if (failing.length) console.log(summary(r), r.failures.filter((f) => f.check !== "R2c").slice(0, 5));
		expect(failing).toEqual([]);
	},
	120_000,
);
