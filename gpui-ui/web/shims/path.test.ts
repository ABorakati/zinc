// The browser build's node:path on the /opfs/... paths core/src/sync/{apply,build}.ts feeds it (POSIX rules).
import { describe, expect, test } from "bun:test";
import path from "./path";

describe("shims/path on /opfs paths", () => {
	test("relative, resolve, join, isAbsolute, dirname", () => {
		expect(path.relative(path.resolve("/opfs/zinc", "storage"), path.resolve("/opfs/zinc/storage/AB12/x.pdf"))).toBe("AB12/x.pdf");
		expect(path.relative("/opfs/zinc/storage", "/opfs/zinc/other")).toBe("../other");
		expect(path.relative("/opfs/zinc/storage", "/opfs/zinc/storage")).toBe("");
		expect(path.join("/opfs/zinc", "storage", "K", "f.pdf")).toBe("/opfs/zinc/storage/K/f.pdf");
		expect(path.resolve("/a/b/../c", "./d")).toBe("/a/c/d");
		expect(path.isAbsolute("/opfs/x")).toBe(true);
		expect(path.isAbsolute("opfs/x")).toBe(false);
		expect(path.dirname("/opfs/zinc/library.sqlite")).toBe("/opfs/zinc");
	});
	test("case matters on POSIX paths, not on Windows ones", () => {
		expect(path.relative("/opfs/zinc/Storage", "/opfs/zinc/storage/a")).toBe("../storage/a");
		expect(path.relative("C:\\Data\\Storage", "c:\\data\\storage\\a")).toBe("a");
	});
});
