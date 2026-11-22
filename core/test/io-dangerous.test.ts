import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dangerous from "../src/io/dangerous";

const dir = mkdtempSync(join(tmpdir(), "zn-dangerous-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("what macOS and Linux openers would run needs the confirmation too", () => {
	for (const name of ["x.desktop", "x.terminal", "x.fileloc", "x.inetloc", "x.webloc", "x.workflow", "x.action", "x.scpt", "x.scptd", "x.applescript", "x.pkg", "x.mpkg", "x.dmg", "x.tool", "x.zsh", "x.csh", "x.ksh", "x.fish", "x.AppImage", "x.prefPane", "x.mobileconfig", "x.flatpakref", "x.deb", "x.rpm"])
		expect([name, dangerous.isExecutableName(name)]).toEqual([name, true]);
	for (const name of ["paper.pdf", "notes.txt", "data.csv", "page.html", "README"]) expect([name, dangerous.isExecutableName(name)]).toEqual([name, false]);
});

test("a folder does not ask, and a version number is not an extension", () => {
	const runs = (dangerous as any).opensAsProgram;
	expect(runs(join(dir, "Papers"), "darwin", () => 0o40755)).toBe(false);
	expect(runs(join(dir, "Papers.app"), "darwin", () => 0o40755)).toBe(true);
	expect(runs(join(dir, "tool-1.2"), "linux", () => 0o100755)).toBe(true);
});

test("a file with no extension and the executable bit needs it as well", () => {
	const tool = join(dir, "tool");
	writeFileSync(tool, "#!/bin/sh\n");
	chmodSync(tool, 0o755);
	const runs = (dangerous as any).opensAsProgram;
	expect(runs(tool, "linux", () => 0o755)).toBe(true);
	expect(runs(tool, "darwin", () => 0o644)).toBe(false);
	expect(runs(join(dir, "paper.pdf"), "darwin", () => 0o755)).toBe(false);
	expect(runs(tool, "win32", () => 0o755)).toBe(false);
	expect(runs(join(dir, "x.desktop"), "win32")).toBe(true);
});
