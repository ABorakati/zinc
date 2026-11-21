// Startup error resilience, static handler collection, and packaged UI host registration for WASM plugins.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import uiHandler from "../../../plugin-host/src/imports/ui.zinc";
import { getPluginSupervisor, packageRuntime, pluginActions } from "./host";
import { collectZincHandlers, pluginServices, startWasmPlugins, stopWasmPlugins } from "./index";
import { installUiHost } from "./ui";

afterEach(async () => {
	await stopWasmPlugins();
});

describe("WASM plugin startup resilience", () => {
	test("collectZincHandlers resolves all built-in zinc handlers plus app handlers without duplicates", async () => {
		const handlers = await collectZincHandlers();
		const ifaces = handlers.map((h) => h.interface);
		expect(ifaces).toContain("zinc:plugin/extend");
		expect(ifaces).toContain("zinc:plugin/ui");
		expect(ifaces).toContain("zinc:plugin/reader");
		expect(ifaces).toContain("zinc:plugin/mcp");
		expect(ifaces).toContain("zinc:plugin/app");
		expect(new Set(handlers).size).toBe(handlers.length);
	});

	test("installUiHost binds the global slot so ui.zinc.ts works without dynamic URL imports", async () => {
		const uninstall = installUiHost();
		try {
			const theme = (await uiHandler.functions["get-theme"]!({ pluginId: "test" } as never)) as { mode?: string; colors?: unknown[] };
			expect(theme.mode === "light" || theme.mode === "dark").toBe(true);
			expect(Array.isArray(theme.colors)).toBe(true);
		} finally {
			uninstall();
		}
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("zinc.wasmplugins.ui-host")]).toBeUndefined();
	});

	test("startWasmPlugins catches host startup failures, logs, cleans up, and returns undefined (plain supervisor)", async () => {
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const missing = join(tmpdir(), "zinc-missing-zhw-plain");
			const sup = await startWasmPlugins({
				force: true,
				runtime: false,
				bindUi: false,
				handlers: [],
				supervisor: { zhwPath: missing, discoverHostHandlers: false },
			});
			expect(sup).toBeUndefined();
			expect(getPluginSupervisor()).toBeUndefined();
			expect(pluginServices()).toBeUndefined();
			expect(packageRuntime()).toBe(false);
			expect(pluginActions()).toBeUndefined();
			expect(errSpy).toHaveBeenCalled();
			const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
			expect(logged).toContain("[wasmplugins]");
		} finally {
			errSpy.mockRestore();
		}
	});

	test("startWasmPlugins catches host startup failures and cleans up partial package runtime state", async () => {
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		const root = mkdtempSync(join(tmpdir(), "zinc-wasm-startup-fail-"));
		const prevDir = process.env.ZN_PLUGINS_DIR;
		process.env.ZN_PLUGINS_DIR = join(root, "plugins");
		try {
			const missing = join(root, "does-not-exist-zhw");
			const sup = await startWasmPlugins({
				force: true,
				runtime: true,
				bindUi: false,
				handlers: [],
				supervisor: { zhwPath: missing, discoverHostHandlers: false },
			});
			expect(sup).toBeUndefined();
			expect(getPluginSupervisor()).toBeUndefined();
			expect(pluginServices()).toBeUndefined();
			expect(packageRuntime()).toBe(false);
			expect(pluginActions()).toBeUndefined();
			expect(errSpy).toHaveBeenCalled();
		} finally {
			if (prevDir !== undefined) process.env.ZN_PLUGINS_DIR = prevDir;
			else delete process.env.ZN_PLUGINS_DIR;
			errSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
