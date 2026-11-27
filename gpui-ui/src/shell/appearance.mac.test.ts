// macOS light/dark (appearance.ts: readMacDark, onMacThemeChange). Runs on macOS only. The first two tests change nothing; the
// third writes the global AppleInterfaceStyle preference, so it runs only in CI (macos.yml) and puts the old value back.
import { describe, expect, test } from "bun:test";
import { readMacDark } from "./appearance";

const onMac = process.platform === "darwin";

/** `defaults read -g AppleInterfaceStyle`: the value, or undefined when the key is absent (light mode). */
function defaultsStyle(): string | undefined {
	const r = Bun.spawnSync(["defaults", "read", "-g", "AppleInterfaceStyle"], { stdout: "pipe", stderr: "ignore" });
	return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

describe.skipIf(!onMac)("macOS appearance", () => {
	test("readMacDark agrees with `defaults read -g AppleInterfaceStyle`", () => {
		expect(readMacDark()).toBe(defaultsStyle() === "Dark");
	});

	test("onMacThemeChange runs its callback on AppleInterfaceThemeChangedNotification", () => {
		// in a child process: running the main run loop here would also run GPUI work left by earlier test files (test/macThemeChild.ts)
		const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/test/macThemeChild.ts`], { timeout: 20_000, stdout: "pipe", stderr: "pipe" });
		expect({ exitCode: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().slice(-1500) }).toEqual({ exitCode: 0, out: "OK", err: "" });
	});

	// "Dark" comes back as a tagged-pointer CFString; read through FFIType.ptr it crashed Bun.
	test.skipIf(!process.env.CI)("readMacDark reads AppleInterfaceStyle = Dark", () => {
		const before = defaultsStyle();
		try {
			Bun.spawnSync(["defaults", "write", "-g", "AppleInterfaceStyle", "Dark"]);
			expect(readMacDark()).toBe(true);
			Bun.spawnSync(["defaults", "delete", "-g", "AppleInterfaceStyle"]);
			expect(readMacDark()).toBe(false);
		} finally {
			if (before === undefined) Bun.spawnSync(["defaults", "delete", "-g", "AppleInterfaceStyle"], { stderr: "ignore" });
			else Bun.spawnSync(["defaults", "write", "-g", "AppleInterfaceStyle", before]);
		}
	});
});
