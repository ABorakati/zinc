// The translator pool must recover when a worker fails to start. Fixture workers in a temp folder; no translator is run.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runJob, shutdownTranslatePool, TranslateError } from "../../src/translate/pool";
import { tempDir } from "../fixture";

let dir: string;
let bad: string;
let good: string;
const saved = process.env.ZN_TRANSLATE_WORKER;
beforeAll(() => {
	dir = tempDir();
	bad = join(dir, "bad.js");
	writeFileSync(bad, "this is not ( valid javascript\n");
	good = join(dir, "good.js");
	writeFileSync(
		good,
		`self.onmessage = (e) => postMessage({ ok: true, result: { echoed: e.data.op } });\npostMessage({ ready: true });\n`,
	);
});
afterEach(() => shutdownTranslatePool());
afterAll(() => {
	shutdownTranslatePool();
	if (saved === undefined) delete process.env.ZN_TRANSLATE_WORKER;
	else process.env.ZN_TRANSLATE_WORKER = saved;
	rmSync(join(dir, "bad.js"), { force: true });
	rmSync(join(dir, "good.js"), { force: true });
});

const outcome = (p: Promise<unknown>) =>
	Promise.race([
		p.then(
			(v) => ({ ok: v }),
			(e) => ({ err: e }),
		),
		new Promise<{ hung: true }>((r) => setTimeout(() => r({ hung: true }), 4000)),
	]);

describe("worker start failures", () => {
	test("a worker that fails to load rejects the job instead of hanging", async () => {
		process.env.ZN_TRANSLATE_WORKER = bad;
		const r: any = await outcome(runJob("web", {}, 1500));
		expect(r.hung).toBeUndefined();
		expect(r.err).toBeInstanceOf(TranslateError);
	}, 15000);

	test("later jobs also fail fast, and a corrected worker works afterwards", async () => {
		process.env.ZN_TRANSLATE_WORKER = bad;
		for (let i = 0; i < 4; i++) {
			const r: any = await outcome(runJob("web", {}, 1500));
			expect(r.hung).toBeUndefined();
			expect(r.err).toBeInstanceOf(TranslateError);
		}
		process.env.ZN_TRANSLATE_WORKER = good;
		const ok: any = await outcome(runJob("import", {}, 5000));
		expect(ok.ok).toEqual({ echoed: "import" });
	}, 30000);

	test("a worker that never becomes ready is cut off by the job timeout", async () => {
		const silent = join(dir, "silent.js");
		writeFileSync(silent, "setInterval(() => {}, 1000);\n");
		process.env.ZN_TRANSLATE_WORKER = silent;
		const t0 = Date.now();
		const r: any = await outcome(runJob("web", {}, 800));
		rmSync(silent, { force: true });
		expect(r.hung).toBeUndefined();
		expect(r.err).toBeInstanceOf(TranslateError);
		expect(r.err.code).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(3500);
	}, 15000);
});
