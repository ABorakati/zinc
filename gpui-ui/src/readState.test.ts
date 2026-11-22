// bun test src/readState.test.ts -- a read mark made just before the app quits is saved (the 200 ms debounce must not drop it).
// Each case runs in its own process against a temp file (ZN_READ_STATE), so the user's real read state is never opened.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "zn-readstate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run `body` (it sees `readState`) in a fresh process, then read back the state file it was pointed at. */
async function run(name: string, body: string): Promise<Record<string, unknown>> {
	const file = join(dir, `${name}.json`);
	const mod = new URL("./readState.ts", import.meta.url).href;
	const p = Bun.spawn([process.execPath, "-e", `const { readState } = await import(${JSON.stringify(mod)}); ${body}`], {
		env: { ...process.env, ZN_READ_STATE: file },
		stdout: "ignore",
		stderr: "pipe",
	});
	const err = await new Response(p.stderr).text();
	expect(await p.exited, err).toBe(0);
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("read state at exit", () => {
	test("a mark made in the last 200 ms before the process ends is on disk", async () => {
		const saved = await run("quick", `readState.markRead("AAAA1111"); readState.markUnread("BBBB2222"); process.exit(0);`);
		expect(saved.items).toEqual({ AAAA1111: true, BBBB2222: false });
	});
	test("an exit with nothing pending leaves the file as it was", async () => {
		const saved = await run("idle", `readState.markRead("CCCC3333"); await Bun.sleep(400); readState.flush(); process.exit(0);`);
		expect(saved.items).toEqual({ CCCC3333: true });
	});
});
