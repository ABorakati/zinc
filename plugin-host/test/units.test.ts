import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { camel, ifaceName, kebab, shortIface } from "../src/names";
import { BUILTIN_HANDLER_MODULES, discoverHandlers, HandlerTable } from "../src/imports/registry";
import { createPluginSupervisor } from "../src/supervisor";
import { isCompiledBunfs, resolveZhwPath } from "../src/transport-wasmtime";

const IMPORTS_DIR = resolve(import.meta.dir, "../src/imports");
const ZHW_EXE = process.platform === "win32" ? "zhw.exe" : "zhw";

describe("names", () => {
	test("kebab, camel, interface names with and without version", () => {
		expect(camel("set-timeout")).toBe("setTimeout");
		expect(kebab("setTimeout")).toBe("set-timeout");
		expect(ifaceName("zinc:plugin/prefs@0.1.0")).toBe("zinc:plugin/prefs");
		expect(ifaceName("prefs")).toBe("zinc:plugin/prefs");
		expect(shortIface("zinc:plugin/extend-handlers@0.1.0")).toBe("extend-handlers");
	});
	test("handler tables accept kebab or camel function names and any interface spelling", async () => {
		const t = new HandlerTable([{ interface: "prefs", where: "host", functions: { "get-app": () => 1, setMany: () => 2 } }]);
		expect(await t.call({} as any, "zinc:plugin/prefs@0.1.0", "getApp", [])).toBe(1);
		expect(await t.call({} as any, "zinc:plugin/prefs", "set-many", [])).toBe(2);
		expect(t.has("zinc:plugin/prefs", "nope")).toBe(false);
		await expect(t.call({} as any, "zinc:plugin/prefs", "nope", [])).rejects.toThrow(/unavailable/);
	});
});

describe("discoverHandlers", () => {
	test("BUILTIN_HANDLER_MODULES stays in sync with all *.host.ts and *.zinc.ts files on disk", () => {
		const entries = readdirSync(IMPORTS_DIR);
		const hostOnDisk = entries.filter((f) => f.endsWith(".host.ts")).sort();
		const zincOnDisk = entries.filter((f) => f.endsWith(".zinc.ts")).sort();
		expect(Object.keys(BUILTIN_HANDLER_MODULES.host).sort()).toEqual(hostOnDisk);
		expect(Object.keys(BUILTIN_HANDLER_MODULES.zinc).sort()).toEqual(zincOnDisk);
	});

	test("static discovery matches disk discovery for both host and zinc handlers", async () => {
		const [staticHost, diskHost] = await Promise.all([discoverHandlers("host"), discoverHandlers("host", IMPORTS_DIR)]);
		expect(staticHost.map((h) => h.interface)).toEqual(diskHost.map((h) => h.interface));
		expect(staticHost.every((h) => h.where === "host")).toBe(true);

		const [staticZinc, diskZinc] = await Promise.all([discoverHandlers("zinc"), discoverHandlers("zinc", IMPORTS_DIR)]);
		expect(staticZinc.map((h) => h.interface)).toEqual(diskZinc.map((h) => h.interface));
		expect(staticZinc.every((h) => h.where === "zinc")).toBe(true);
	});

	test("custom dir argument still scans disk and validates where", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zinc-handlers-"));
		try {
			writeFileSync(
				join(dir, "custom.host.ts"),
				`export default { interface: "zinc:plugin/custom", where: "host", functions: { ping: () => "pong" } };\n`,
			);
			const found = await discoverHandlers("host", dir);
			expect(found.map((h) => h.interface)).toEqual(["zinc:plugin/custom"]);
			expect(await found[0]!.functions.ping!({} as any)).toBe("pong");

			writeFileSync(
				join(dir, "bad.host.ts"),
				`export default { interface: "zinc:plugin/bad", where: "zinc", functions: {} };\n`,
			);
			await expect(discoverHandlers("host", dir)).rejects.toThrow(/says where "zinc" but the file is \*\.host\.ts/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("packaged zhw resolution and startup failure handling", () => {
	test("isCompiledBunfs recognizes Linux/macOS and Windows virtual roots", () => {
		expect(isCompiledBunfs("/$bunfs/root/plugin-host/src")).toBe(true);
		expect(isCompiledBunfs("B:/~BUN/root/plugin-host/src")).toBe(true);
		expect(isCompiledBunfs("B:\\~BUN\\root\\plugin-host\\src")).toBe(true);
		expect(isCompiledBunfs("/Users/dev/zinc/plugin-host/src")).toBe(false);
		expect(isCompiledBunfs("C:\\dev\\zinc\\plugin-host\\src")).toBe(false);
	});

	test("resolveZhwPath prefers packaged locations and avoids dev paths in compiled bunfs", () => {
		const prevZhw = process.env.ZHW;
		const prevZnZhw = process.env.ZN_ZHW;
		delete process.env.ZHW;
		delete process.env.ZN_ZHW;
		const root = mkdtempSync(join(tmpdir(), "zinc-zhw-res-"));
		try {
			const macosDir = join(root, "Contents", "MacOS");
			const resDir = join(root, "Contents", "Resources");
			mkdirSync(macosDir, { recursive: true });
			mkdirSync(resDir, { recursive: true });
			const fakeExe = join(macosDir, "zotero-next-gpui");

			// Missing everywhere in compiled bunfs -> reports expected packaged path beside exe, never /$bunfs/...
			const missing = resolveZhwPath(undefined, { execPath: fakeExe, moduleDir: "/$bunfs/root/plugin-host/src" });
			expect(missing).toBe(join(macosDir, ZHW_EXE));

			// Resources fallback (macOS bundle)
			const inResources = join(resDir, ZHW_EXE);
			writeFileSync(inResources, "");
			expect(resolveZhwPath(undefined, { execPath: fakeExe, moduleDir: "/$bunfs/root/plugin-host/src" })).toBe(inResources);

			// Sibling next to exe takes priority over Resources
			const besideExe = join(macosDir, ZHW_EXE);
			writeFileSync(besideExe, "");
			expect(resolveZhwPath(undefined, { execPath: fakeExe, moduleDir: "/$bunfs/root/plugin-host/src" })).toBe(besideExe);
		} finally {
			if (prevZhw !== undefined) process.env.ZHW = prevZhw;
			if (prevZnZhw !== undefined) process.env.ZN_ZHW = prevZnZhw;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("supervisor ready() rejects promptly when zhw binary is missing", async () => {
		const sup = createPluginSupervisor({
			zhwPath: join(tmpdir(), "zinc-definitely-missing-zhw-binary"),
			discoverHostHandlers: false,
		});
		try {
			await expect(sup.ready()).rejects.toThrow(/zhw plugin host binary not found/);
		} finally {
			await sup.shutdown();
		}
	});

	test("supervisor ready() rejects promptly if host process exits before ready", async () => {
		const sup = createPluginSupervisor({
			zhwPath: process.execPath,
			discoverHostHandlers: false,
		});
		try {
			await expect(sup.ready()).rejects.toThrow(/exited before ready/);
		} finally {
			await sup.shutdown();
		}
	});
});
