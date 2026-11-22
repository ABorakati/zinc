// The packaged extension (libreoffice/dist/zinc-libreoffice.oxt) installs with LibreOffice's own unopkg into a temp profile,
// and a headless LibreOffice on that profile loads its Python components and merges its sidebar, menu and command
// configuration. Off by default. Run with:
//   pwsh libreoffice/build.ps1   then
//   ZN_LO_E2E=1 ZN_LO_PROGRAM="<LibreOffice>/program" bun test test/libreoffice-extension.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LO_PROGRAM, LoHarnessHost, loAvailable } from "./lo-harness-host";

const ENABLED = process.env.ZN_LO_E2E === "1";
const OXT = join(import.meta.dir, "..", "..", "..", "libreoffice", "dist", "zinc-libreoffice.oxt");
const d = ENABLED ? describe : describe.skip;

d("the packaged LibreOffice extension", () => {
	let h: LoHarnessHost;
	let profile: string;

	beforeAll(async () => {
		if (!loAvailable()) throw new Error("set ZN_LO_PROGRAM to LibreOffice's program folder");
		if (!existsSync(OXT)) throw new Error("build the extension first: pwsh libreoffice/build.ps1");
		profile = join(mkdtempSync(join(tmpdir(), "zn-lo-ext-")), "profile");
		const unopkg = join(LO_PROGRAM, process.platform === "win32" ? "unopkg.com" : "unopkg");
		const r = Bun.spawnSync([unopkg, "add", "--suppress-license", `-env:UserInstallation=${pathToFileURL(profile).href}`, OXT]);
		if (r.exitCode !== 0) throw new Error("unopkg add failed: " + r.stdout.toString() + r.stderr.toString());
		h = await LoHarnessHost.start(profile);
		await h.raw("h.start");
	}, 180_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	test("components load and the sidebar deck, panel, menu and commands are registered", async () => {
		const x = await h.raw<Record<string, any>>("h.extension");
		expect(x["dev.zinc.libreoffice.PanelFactory"]).toBe("dev.zinc.libreoffice.PanelFactory");
		expect(x["dev.zinc.libreoffice.Commands"]).toBe("dev.zinc.libreoffice.Commands");
		expect(x.deck).toBe(true);
		expect(x.panelUrl).toBe("private:resource/toolpanel/ZincPanelFactory/ZincPanel");
		expect(x.panelWantsAWT).toBe(true);
		expect(x.factory).toBe("dev.zinc.libreoffice.PanelFactory");
		expect(x.protocol).toEqual(["vnd.zinc.lo:*"]);
		expect(x.menu).toBe(true);
		expect(String(x.location)).toContain("zinc-libreoffice.oxt");
	}, 60_000);

	test("the installed copy's document code works (it is what the sidebar calls)", async () => {
		await h.raw("h.newDoc");
		const st = await h.raw<{ hasDoc: boolean; name: string }>("doc.state");
		expect(st.hasDoc).toBe(true);
	}, 60_000);
});
