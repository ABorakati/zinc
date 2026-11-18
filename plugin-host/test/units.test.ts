import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { camel, ifaceName, kebab, shortIface } from "../src/names";
import { asyncLists, readInterfaceFunctions, worldInterfaces } from "../src/wit";
import { HandlerTable } from "../src/imports/registry";
import { createWasiStubs, WasiDenied } from "../src/wasi-stubs";

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

describe("WIT-derived async lists", () => {
	const witDir = join(import.meta.dir, "..", "..", "plugin-api", "wit");
	test("every function of every interface is found (nothing typed by hand)", async () => {
		const fns = await readInterfaceFunctions(witDir);
		expect(fns.get("lifecycle")).toEqual(["install", "startup", "shutdown", "uninstall", "main-window-load", "main-window-unload"]);
		expect(fns.get("prefs")).toContain("get-app");
		expect(fns.get("types")).toEqual([]);
		// the whole world `plugin`
		const all = [...fns.values()].flat().length;
		expect(all).toBeGreaterThanOrEqual(361);
		// resources: methods in jco's name form, constructors listed too (the async list leaves them out)
		expect(fns.get("net")).toEqual(expect.arrayContaining(["send-streamed", "[method]body-reader.read", "[method]body-reader.close"]));
		expect(fns.get("attachments")).toEqual(expect.arrayContaining(["[constructor]file-writer", "[method]file-writer.append", "[method]file-writer.finish"]));
	});
	test("lists follow the component's own world", async () => {
		const fns = await readInterfaceFunctions(witDir);
		const world = worldInterfaces(`world root {
  import zinc:plugin/types@0.1.0;
  import zinc:plugin/log@0.1.0;
  import wasi:cli/stdout@0.2.12;
  export zinc:plugin/lifecycle@0.1.0;
}`);
		expect(world).toEqual({ imports: ["types", "log"], exports: ["lifecycle"] });
		const l = asyncLists(fns, world);
		expect(l.asyncImports).toEqual(["zinc:plugin/log#write", "zinc:plugin/log#write-error", "zinc:plugin/log#debug-enabled"]);
		expect(l.asyncExports).toContain("zinc:plugin/lifecycle#startup");
	});
});

describe("wasi stubs", () => {
	const stubs = createWasiStubs(() => {});
	test("no environment, no preopened directory, no terminal", () => {
		const env: any = stubs("wasi:cli/environment@0.2.12");
		expect(env.getEnvironment()).toEqual([]);
		expect(env.getArguments()).toEqual([]);
		expect(env.initialCwd()).toBeUndefined();
		expect((stubs("wasi:filesystem/preopens") as any).getDirectories()).toEqual([]);
		expect((stubs("wasi:cli/terminal-stdout") as any).getTerminalStdout()).toBeUndefined();
	});
	test("sockets, http, polling and exit trap with a clear message", () => {
		expect(() => (stubs("wasi:sockets/tcp@0.2.12") as any).connect()).toThrow(WasiDenied);
		expect(() => (stubs("wasi:http/outgoing-handler") as any).handle()).toThrow(/WASI is not available/);
		expect(() => (stubs("wasi:io/poll") as any).poll([])).toThrow(WasiDenied);
		expect(() => (stubs("wasi:cli/exit") as any).exit({ tag: "ok" })).toThrow(WasiDenied);
	});
	test("stderr lines reach the sink", () => {
		const got: string[] = [];
		const s = createWasiStubs((stream, text) => got.push(`${stream}:${text}`));
		const err = (s("wasi:cli/stderr") as any).getStderr();
		err.blockingWriteAndFlush(new TextEncoder().encode("boom\nhalf"));
		err.blockingFlush();
		expect(got).toEqual(["stderr:boom", "stderr:half"]);
	});
});
