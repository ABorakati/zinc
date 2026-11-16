import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { leftByOtherPackage, packageRootOf } from "./packagedEnv";

// a fake disk: two Windows-style installs and a macOS bundle, by their executables
const root = resolve("/fake");
const NEW = join(root, "Programs", "Zinc");
const OLD = join(root, "Programs", "Zotero Next");
const MAC = join(root, "Applications", "Zinc.app", "Contents");
const files = new Set([join(NEW, "zotero-next-gpui.exe"), join(OLD, "zotero-next-gpui.exe"), join(MAC, "MacOS", "zotero-next-gpui")]);
const exists = (p: string) => files.has(resolve(p));
const names = ["zotero-next-gpui.exe", "zotero-next-gpui"];

describe("environment left by a previous Zinc", () => {
	test("the package folder of a file inside an install", () => {
		expect(packageRootOf(join(OLD, "zn_pdf.dll"), names, exists)).toBe(OLD);
		expect(packageRootOf(join(OLD, "reader-host", "dist"), names, exists)).toBe(OLD);
		expect(packageRootOf(join(MAC, "Resources", "vendor"), names, exists)).toBe(join(MAC, "MacOS"));
		expect(packageRootOf(join(root, "dev", "zn_pdf.dll"), names, exists)).toBeNull();
	});
	test("the old install's files are a leftover for the new install", () => {
		expect(leftByOtherPackage(join(OLD, "zn_pdf.dll"), NEW, names, exists)).toBe(true);
		expect(leftByOtherPackage(join(OLD, "vendor", "zotero"), NEW, names, exists)).toBe(true);
	});
	test("our own files and a user's override elsewhere are kept", () => {
		expect(leftByOtherPackage(join(NEW, "zn_pdf.dll"), NEW, names, exists)).toBe(false);
		expect(leftByOtherPackage(join(root, "dev", "target", "release", "zn_pdf.dll"), NEW, names, exists)).toBe(false);
	});
});
