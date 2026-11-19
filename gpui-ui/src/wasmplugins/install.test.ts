// Settings > Plugins install, turn off, turn on and remove, through the real package runtime of the app (startWasmPlugins with the
// package manager) in a temporary plugins folder, with a built QuickJS plugin (plugin-host/test/pkg/fixtures/e2e-js). The install prompt
// is replaced by a function; its first ticks are tested on their own. Needs the `zhw` runner, like plugin-host's own package tests.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest } from "../../../plugin-host/src/package/installer";
import { embedPackage } from "../../../plugin-host/src/package/wasm-package";
import { readZip } from "../../../plugin-host/src/package/zip";
import { resolveZhwPath } from "../../../plugin-host/src/transport-wasmtime";
import { buildE2e, myZincHandlers, pack, rmTree, scratch } from "../../../plugin-host/test/pkg/helpers";
import { managedPlugins, packageRuntime, pluginActions } from "./host";
import { installPluginPackage, pluginServices, removePlugin, setPluginEnabled, startWasmPlugins, stopWasmPlugins } from "./index";
import { pluginRows } from "./register";
import { initialGrants } from "./ui/install";

const ID = "e2e-js@zinc.test";
let root = "";
let zplugin = "";
// Needs the Wasmtime plugin host (`zhw`, built by `cargo build --release` in plugin-host-wasmtime/). CI does not build it: the runtime
// tests skip there (as extend.test.ts does); the prompt's own test still runs.
const hasPluginHost = existsSync(resolveZhwPath());

beforeAll(async () => {
	if (!hasPluginHost) return;
	root = scratch("app-install");
	process.env.ZN_PLUGINS_DIR = join(root, "plugins");
	const built = await buildE2e();
	zplugin = join(root, "e2e.zplugin");
	writeFileSync(zplugin, pack(built));
	await startWasmPlugins({ force: true, runtime: true, bindUi: false, handlers: await myZincHandlers(), supervisor: { callTimeoutMs: 6000 } });
}, 180_000);

afterAll(async () => {
	if (!hasPluginHost) return;
	await stopWasmPlugins();
	expect(pluginActions()).toBeUndefined();
	expect(packageRuntime()).toBe(false);
	delete process.env.ZN_PLUGINS_DIR;
	rmTree(root);
});

describe("the install prompt", () => {
	test("ticks required low and medium permissions, leaves high ones and optional ones for the user", () => {
		const req: Pick<ApprovalRequest, "groups" | "required"> = {
			required: ["library.read", "library.write", "library.erase"],
			groups: [
				{ tier: "low", items: [{ id: "library.read", tier: "low", optional: false }] },
				{ tier: "medium", items: [{ id: "library.write", tier: "medium", optional: false }, { id: "ui.windows", tier: "medium", optional: true }] },
				{ tier: "high", items: [{ id: "library.erase", tier: "high", optional: false }] },
			],
		};
		expect([...initialGrants(req)].sort()).toEqual(["library.read", "library.write"]);
	});
});

describe.skipIf(!hasPluginHost)("Settings > Plugins with the package runtime", () => {
	test("the runtime is up, its Settings actions are registered, nothing is installed", () => {
		expect(packageRuntime()).toBe(true);
		expect(Object.keys(pluginActions() ?? {}).sort()).toEqual(["approvePermissions", "installFromFile", "remove", "setEnabled"]);
		expect(pluginServices()).toBeDefined();
		expect(pluginRows()).toEqual([]);
	});

	test("a broken file is refused and leaves nothing behind", async () => {
		const bad = join(root, "broken.zplugin");
		writeFileSync(bad, "not a zip");
		expect(await installPluginPackage(bad, { approve: (req) => ({ grant: req.required }) })).toBeUndefined();
		expect(managedPlugins()).toEqual([]);
	});

	test("cancelling the prompt installs nothing", async () => {
		expect(await installPluginPackage(zplugin, { approve: () => false })).toBeUndefined();
		expect(managedPlugins()).toEqual([]);
	});

	test("install: the prompt sees the permissions, the plugin runs and is listed as managed", async () => {
		let seen: ApprovalRequest | undefined;
		const r = await installPluginPackage(zplugin, {
			approve: (req) => {
				seen = req;
				return { grant: req.required };
			},
		});
		expect(r?.started).toBe(true);
		expect(seen?.action).toBe("install");
		expect(seen?.required.sort()).toEqual(["library.read", "prefs.app-read"]);
		const row = pluginRows().find((p) => p.id === ID);
		expect(row).toMatchObject({ managed: true, enabled: true, status: "running", pending: false });
		expect(existsSync(join(root, "plugins", "installed", ID, "plugin.wasm"))).toBe(true);
	}, 60_000);

	test("turning it off keeps it listed (the supervisor unloads it); turning it on starts it again", async () => {
		await setPluginEnabled(ID, false);
		expect(pluginRows().find((p) => p.id === ID)).toMatchObject({ managed: true, enabled: false, status: "off" });
		await setPluginEnabled(ID, true);
		expect(pluginRows().find((p) => p.id === ID)).toMatchObject({ enabled: true, status: "running" });
	}, 60_000);

	test("installing the same file again is a reinstall, not a second row", async () => {
		const r = await installPluginPackage(zplugin, { approve: (req) => ({ grant: req.required }) });
		expect(r?.action).toBe("reinstall");
		expect(pluginRows().filter((p) => p.id === ID).length).toBe(1);
	}, 60_000);

	test("remove: gone from the list and from the plugins folder", async () => {
		await removePlugin(ID, { ask: false });
		expect(pluginRows()).toEqual([]);
		expect(existsSync(join(root, "plugins", "installed", ID))).toBe(false);
	}, 60_000);

	test("a single-file .wasm installs the same plugin; a plain component is refused", async () => {
		const zip = readZip(new Uint8Array(readFileSync(zplugin)));
		const code = zip.find((f) => f.name === "plugin.wasm")!.data;
		const single = join(root, "e2e.wasm");
		writeFileSync(single, embedPackage(code, zip.filter((f) => f.name !== "plugin.wasm")));
		const r = await installPluginPackage(single, { approve: (req) => ({ grant: req.required }) });
		expect(r?.action).toBe("install");
		expect(pluginRows().find((p) => p.id === ID)).toMatchObject({ managed: true, status: "running" });
		await removePlugin(ID, { ask: false });

		const plain = join(root, "plain.wasm");
		writeFileSync(plain, code);
		expect(await installPluginPackage(plain, { approve: (req) => ({ grant: req.required }) })).toBeUndefined();
		expect(pluginRows()).toEqual([]);
	}, 60_000);
});
