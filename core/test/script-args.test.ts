// The two maintenance scripts that open a library need the library path on the command line: with none they stop and say so
// (they used to fall back to a fixed path on the author's machine).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const scripts = join(import.meta.dir, "..", "scripts");

describe.each(["reindex.ts", "mcp-smoke.ts"])("%s", (name) => {
	test("without a library path it exits with a usage message and opens nothing", async () => {
		const p = Bun.spawn([process.execPath, join(scripts, name)], { stdout: "pipe", stderr: "pipe", cwd: join(scripts, "..") });
		const [err, out, code] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text(), p.exited]);
		expect(code).toBe(2);
		expect(err).toContain(`usage: bun core/scripts/${name} <path/to/library.sqlite>`);
		expect(out).toBe("");
	});
});
