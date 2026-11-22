// word/uninstall.ps1, checked without running it: the script is parsed, its helper functions are lifted out and called with
// fakes (uninstall-logic.ps1). Nothing is registered or unregistered, no registry is touched, nothing is deleted.
// Skipped when pwsh (PowerShell 7) is not on the PATH.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "uninstall.ps1");
const LOGIC = join(import.meta.dir, "uninstall-logic.ps1");
const hasPwsh = Bun.which("pwsh") !== null;
const d = hasPwsh ? describe : describe.skip;

function lift(): any {
	const scratch = mkdtempSync(join(tmpdir(), "zn-uninstall-"));
	const r = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-File", LOGIC, "-Script", SCRIPT, "-Scratch", scratch], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error("helper failed: " + r.stderr.toString() + r.stdout.toString());
	return JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
}

d("word/uninstall.ps1", () => {
	const r = hasPwsh ? lift() : ({} as any);

	test("parses", () => {
		expect(r.parseErrors).toEqual([]);
	});

	test("a missing add-in folder gives no dll (it used to stop the script before any key was removed)", () => {
		expect(r.functions).toContain("Resolve-AddinDll");
		expect(r.calledByScript).toContain("Resolve-AddinDll");
		expect(r.resolveMissing).toBe(true);
		expect(r.resolveEmpty).toBe(true);
		expect(r.resolveNull).toBe(true);
		expect(r.resolveReal).toMatch(/addin[\\/]ZoteroNextWord\.dll$/);
	});

	test("a failed HKCR redirect stops the unregister and says so, and a successful one is always put back", () => {
		expect(r.functions).toContain("Invoke-RedirectedUnregister");
		expect(r.calledByScript).toContain("Invoke-RedirectedUnregister");
		expect(r.failedRedirect).toEqual({ result: false, log: ["redirect"] });
		expect(r.okRedirect).toEqual({ result: true, log: ["redirect", "unregister", "restore"] });
		expect(r.throwingUnregister.thrown).toBe("boom");
		expect(r.throwingUnregister.log).toEqual(["redirect", "unregister", "restore"]);
	});

	test("-RemoveData also removes the folder the MCP token is in", () => {
		expect(r.functions).toContain("Get-DataFolders");
		expect(r.calledByScript).toContain("Get-DataFolders");
		const w = (...p: string[]) => p.join("\\");
		expect(r.dataFolders).toEqual([w("C:", "Fake", "Roaming", "ZoteroNextWord"), w("C:", "Fake", "Local", "ZoteroNextWord"), w("C:", "Fake", "Roaming", "zotero-next-word")]);
	});
});
