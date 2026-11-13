// install.ps1's host manifest: allowed_origins comes from the one list at the top of the script. Runs with -ManifestOnly into a
// temp folder, so no registry value is written and no real registration is touched.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_EXTENSION_ID } from "../../core/src/integrations/api";

const script = join(import.meta.dir, "..", "install.ps1");
const ROOT = mkdtempSync(join(tmpdir(), "znh-install-"));
const fakeExe = join(ROOT, "host.exe");
writeFileSync(fakeExe, "x");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const shell = Bun.which("pwsh") ?? Bun.which("powershell");
const run = (name: string, extra: string[] = []) => {
	const dir = join(ROOT, name);
	const p = Bun.spawnSync([shell!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ManifestOnly", "-ManifestDir", dir, "-HostExe", fakeExe, "-HostName", "com.zotero_next.connector_host_test", ...extra], { stdout: "pipe", stderr: "pipe" });
	const file = join(dir, "com.zotero_next.connector_host_test.json");
	return { code: p.exitCode, err: p.stderr.toString(), manifest: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
};

describe.skipIf(!shell)("install.ps1 allowed_origins", () => {
	test("default: the pinned unpacked id; the empty store slots are skipped", () => {
		const r = run("default");
		expect(r.code).toBe(0);
		expect(r.manifest.allowed_origins).toEqual([`chrome-extension://${CONNECTOR_EXTENSION_ID}/`]);
	});

	test("the script has a Chrome Web Store and an Edge Add-ons slot", () => {
		const src = readFileSync(script, "utf8");
		expect(src).toContain(`"unpacked"         = "${CONNECTOR_EXTENSION_ID}"`);
		expect(src).toMatch(/"chrome-web-store"\s*=\s*""/);
		expect(src).toMatch(/"edge-addons"\s*=\s*""/);
	});

	test("-ExtensionId lists several ids and replaces the default; duplicates are dropped", () => {
		const a = "a".repeat(32);
		const b = "b".repeat(32);
		const r = run("several", ["-ExtensionId", `${a},${b},${a}`]);
		expect(r.code).toBe(0);
		expect(r.manifest.allowed_origins).toEqual([`chrome-extension://${a}/`, `chrome-extension://${b}/`]);
	});

	test("an invalid id is refused and no manifest is written", () => {
		const r = run("bad", ["-ExtensionId", "not-an-id"]);
		expect(r.code).not.toBe(0);
		expect(r.manifest).toBeNull();
	});
});
