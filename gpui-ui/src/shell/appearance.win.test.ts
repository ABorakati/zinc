// bun test src/shell/appearance.win.test.ts -- the Windows light / dark read opens advapi32 once, not on every poll.
import { describe, expect, test } from "bun:test";
import type { dlopen } from "bun:ffi";

process.env.ZN_UI_STATE = "off";

type Open = typeof dlopen;
/** A fake dlopen that counts its calls and hands out a fake RegGetValueW. */
function fakeOpen(fail = false) {
	const calls: string[] = [];
	const open = ((name: string) => {
		calls.push(name);
		if (fail) throw new Error("no such library");
		return { symbols: { RegGetValueW: () => 0 }, close() {} };
	}) as unknown as Open;
	return { calls, open };
}

describe("the registry reader for the OS theme", () => {
	test("advapi32 is opened once, however many times the theme is polled", async () => {
		const { makeRegGetter } = await import("./appearance");
		const f = fakeOpen();
		const get = makeRegGetter(f.open);
		const first = get();
		for (let i = 0; i < 50; i++) expect(get()).toBe(first);
		expect(f.calls).toEqual(["advapi32.dll"]);
	});
	test("a failed open is not remembered: the next poll tries again", async () => {
		const { makeRegGetter } = await import("./appearance");
		const f = fakeOpen(true);
		const get = makeRegGetter(f.open);
		expect(() => get()).toThrow(); // readWindowsAppsUseDark catches it and reports "unknown"
		expect(() => get()).toThrow();
		expect(f.calls.length).toBe(2);
	});
	test.skipIf(process.platform !== "win32")("the real read still answers the same each time", async () => {
		const { readWindowsAppsUseDark } = await import("./appearance");
		const a = readWindowsAppsUseDark();
		for (let i = 0; i < 20; i++) expect(readWindowsAppsUseDark()).toBe(a);
	});
});
