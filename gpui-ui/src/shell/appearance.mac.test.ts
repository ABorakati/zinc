// macOS light/dark (appearance.ts: readMacDark, onMacThemeChange). Runs on macOS only. The first two tests change nothing; the
// third writes the global AppleInterfaceStyle preference, so it runs only in CI (macos.yml) and puts the old value back.
import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { onMacThemeChange, readMacDark } from "./appearance";

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

	test("onMacThemeChange runs its callback on AppleInterfaceThemeChangedNotification", async () => {
		// GPUIX's tick() runs the main run loop in the app; here CFRunLoopRunInMode does it
		const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
			CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
			CFNotificationCenterGetDistributedCenter: { args: [], returns: FFIType.u64 },
			CFNotificationCenterPostNotification: {
				args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.bool],
				returns: FFIType.void,
			},
			CFRunLoopRunInMode: { args: [FFIType.u64, FFIType.f64, FFIType.bool], returns: FFIType.i32 },
		}).symbols;
		const str = (s: string) => cf.CFStringCreateWithCString(null, Buffer.from(`${s}\0`, "utf8"), 0x08000100) as bigint;
		const mode = str("kCFRunLoopDefaultMode");

		let calls = 0;
		expect(onMacThemeChange(() => calls++)).toBe(true);
		cf.CFNotificationCenterPostNotification(
			cf.CFNotificationCenterGetDistributedCenter() as bigint,
			str("AppleInterfaceThemeChangedNotification"),
			0n,
			0n,
			true,
		);
		for (let i = 0; i < 50 && calls === 0; i++) {
			cf.CFRunLoopRunInMode(mode, 0.05, false);
			await Bun.sleep(10);
		}
		expect(calls).toBeGreaterThan(0);
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
