// The README.txt of the Windows package (scripts/readme.ts): no path from a developer's machine, and the folder names keep their backslashes.
import { describe, expect, test } from "bun:test";
import { windowsReadme } from "./readme";

describe("Windows package README", () => {
	const text = windowsReadme();
	test("names no path from a developer's machine", () => {
		expect(text).not.toMatch(/C:[\\/]Users[\\/]/i);
		expect(text).not.toContain("abora");
	});
	test("keeps the backslashes of its folder names", () => {
		expect(text).toContain("%APPDATA%\\zotero-next-gpui.exe\\EBWebView");
		expect(text).toContain("%APPDATA%\\zotero-next-signin.exe\\EBWebView");
		expect(text).toContain("%LOCALAPPDATA%\\zotero-next-gpui\\signin");
		expect(text).toContain("Settings and window state: %APPDATA%\\zotero-next-gpui\\");
		// what a lost backslash leaves behind
		expect(text).not.toContain("%APPDATA%zotero");
		expect(text).not.toMatch(/gpui\.exeEBWebView|signin\.exeEBWebView/);
	});
	test("uses Windows line ends", () => {
		expect(text.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r"))).toBe(true);
	});
});
