// The per-platform openers: argument arrays only, no shell, and a hostile path or URL can never become an option.
import { describe, expect, test } from "bun:test";
import { openerArgv, openWithSystem } from "../src/os-open";

describe("openerArgv", () => {
	test("Windows", () => {
		expect(openerArgv("win32", "reveal", "C:\\Lib\\a b.pdf")).toEqual(["explorer.exe", "/select,", "C:\\Lib\\a b.pdf"]);
		expect(openerArgv("win32", "openFile", "C:\\Lib\\a.pdf")).toEqual(["explorer.exe", "C:\\Lib\\a.pdf"]);
		expect(openerArgv("win32", "openFile", "\\\\server\\share\\a.pdf")).toEqual(["explorer.exe", "\\\\server\\share\\a.pdf"]);
		expect(openerArgv("win32", "openUrl", "https://x.test/a?b=1&c=2")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", "https://x.test/a?b=1&c=2"]);
	});
	test("macOS", () => {
		expect(openerArgv("darwin", "reveal", "/Users/u/a.pdf")).toEqual(["open", "-R", "/Users/u/a.pdf"]);
		expect(openerArgv("darwin", "openFile", "/Users/u/a.pdf")).toEqual(["open", "/Users/u/a.pdf"]);
		expect(openerArgv("darwin", "openUrl", "https://x.test/")).toEqual(["open", "https://x.test/"]);
	});
	test("Linux and other Unix systems", () => {
		for (const p of ["linux", "freebsd"]) {
			expect(openerArgv(p, "openFile", "/home/u/a.pdf")).toEqual(["xdg-open", "/home/u/a.pdf"]);
			expect(openerArgv(p, "reveal", "/home/u/lib/a.pdf")).toEqual(["xdg-open", "/home/u/lib"]);
			expect(openerArgv(p, "reveal", "/a.pdf")).toEqual(["xdg-open", "/"]);
			expect(openerArgv(p, "openUrl", "http://x.test/")).toEqual(["xdg-open", "http://x.test/"]);
		}
	});
	test("a target that could be an option is refused on every platform", () => {
		for (const p of ["win32", "darwin", "linux"]) {
			for (const a of ["reveal", "openFile"] as const) {
				for (const bad of ["-a Calculator", "--help", "-R", "relative/a.pdf", "", "/select,x" /* not absolute on Windows */, "file\0.pdf"]) {
					if (p !== "win32" && bad === "/select,x") continue; // an absolute POSIX path
					expect(() => openerArgv(p, a, bad)).toThrow();
				}
			}
			for (const bad of ["-a Calculator", "--help", "file:///etc/passwd", "javascript:alert(1)", "ftp://x/", "https://x.test/ a", "https://x\n.test/"])
				expect(() => openerArgv(p, "openUrl", bad)).toThrow();
		}
	});
});

describe("openWithSystem", () => {
	test("passes one argument array to the injected spawn, with the platform's executable", () => {
		const seen: string[][] = [];
		openWithSystem("openFile", "/home/u/a b;rm -rf.pdf", (c) => seen.push(c), "linux");
		openWithSystem("reveal", "/Users/u/a.pdf", (c) => seen.push(c), "darwin");
		expect(seen).toEqual([
			["xdg-open", "/home/u/a b;rm -rf.pdf"],
			["open", "-R", "/Users/u/a.pdf"],
		]);
	});
	test("a refused target never reaches the spawn", () => {
		const seen: string[][] = [];
		expect(() => openWithSystem("openFile", "--version", (c) => seen.push(c), "linux")).toThrow();
		expect(seen).toEqual([]);
	});
});
