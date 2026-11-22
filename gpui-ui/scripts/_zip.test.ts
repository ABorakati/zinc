// compressCommand (scripts/_zip.ts), run through PowerShell on a folder whose name has a quote and brackets in it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressCommand, psQuote } from "./_zip";

const pwsh = Bun.which("pwsh");
const base = mkdtempSync(join(tmpdir(), "zinc-zip-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("psQuote", () => {
	test("doubles the quotes inside", () => {
		expect(psQuote("a'b")).toBe("'a''b'");
		expect(psQuote("plain")).toBe("'plain'");
	});
});

describe.skipIf(!pwsh)("compressCommand through pwsh", () => {
	for (const name of ["plain", "O'Brien", "build [x64]", "a'b[1]"]) {
		test(`a folder named ${name}`, () => {
			const app = join(base, name);
			mkdirSync(app, { recursive: true });
			writeFileSync(join(app, "file.txt"), "hello");
			const zip = join(base, `out-${name.replace(/\W/g, "_")}.zip`);
			const r = Bun.spawnSync([pwsh!, "-NoProfile", "-Command", compressCommand(app, zip)], { stdout: "pipe", stderr: "pipe" });
			expect(r.stderr.toString()).toBe("");
			expect(r.exitCode).toBe(0);
			expect(existsSync(zip)).toBe(true);
		});
	}
});
