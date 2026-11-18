// End to end: a built plugin (QuickJS, test/pkg/fixtures/e2e-js) is installed from a .zplugin, started by the supervisor, and calls prefs,
// timers, log, l10n, util, secrets, app, permissions and plugins through the real handlers of this area. The plugin runs a "probe" when
// `events.on-timer` is called with a number of 900 or more and logs each outcome, which the tests read back from the log ring.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InstallError } from "../../src/package/installer";
import type { ApproveFn } from "../../src/package/installer";
import { buildE2e, newRuntime, pack, rmTree, scratch, until } from "./helpers";

const ID = "e2e-js@zinc.test";
let built: string;

beforeAll(async () => {
	built = await buildE2e();
}, 120_000);

type Rt = Awaited<ReturnType<typeof newRuntime>>;
// The handlers find their services through a module-level slot (src/package/services.ts), so there is one runtime at a time: starting a
// new one shuts the previous one down first. Their folders are removed at the end.
let current: Rt | undefined;
const roots: string[] = [];
async function closeCurrent() {
	if (!current) return;
	current.services.dispose();
	await current.supervisor.shutdown().catch(() => {});
	current = undefined;
}
afterAll(async () => {
	await closeCurrent();
	for (const r of roots) rmTree(r);
});

async function runtime(o: Parameters<typeof newRuntime>[1] = {}, root?: string): Promise<Rt & { root: string }> {
	await closeCurrent();
	const dir = root ?? scratch("rt");
	if (!roots.includes(dir)) roots.push(dir);
	const rt = await newRuntime(dir, { ...o, manager: { zincVersion: "0.5.0", ...o.manager } });
	current = rt;
	return Object.assign(rt, { root: dir });
}

// like a callback from the UI: through the manager's per-plugin queue, so a pref observer or timer never enters the plugin while a probe waits in an import
const probe = (rt: Rt, n: number, id = ID) => rt.services.manager.callPlugin(id, "events", "on-timer", [n, "timeout"]);
const grantAll: ApproveFn = (req) => ({ grant: req.required });
const find = (lines: string[], prefix: string) => lines.find((l) => l.startsWith(prefix));

describe("install from a .zplugin", () => {
	test("layout, hash pin, ignored transpiled/, hooks with reasons, default grants", async () => {
		// a hostile transpiled/ in the package (an older build layout) is ignored
		const evil = "export const EVIL = true; throw new Error('ran the package transpiled code');";
		const zip = pack(built, { withTranspiled: true, extra: { "transpiled/plugin.js": evil } });
		const real = await runtime();
		const r = await real.services.manager.installPackage(zip);
		expect(r.error).toBeUndefined();
		expect(r.started).toBe(true);
		expect(r.action).toBe("install");
		expect(r.warnings.join("|")).toContain("transpiled/ folder was ignored");
		const dir = real.services.manager.layout.installed(ID);
		for (const f of ["manifest.json", "plugin.wasm", "locale/en-US/main.ftl", "locale/fr/main.ftl", "icons/a.png"]) expect(existsSync(join(dir, f))).toBe(true);
		expect(existsSync(join(dir, "transpiled"))).toBe(false);
		expect(existsSync(real.services.manager.layout.cacheRoot)).toBe(true);
		expect(real.supervisor.lastLoadInfo?.(ID)?.fromCwasm).toBe(true);
		const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		expect(m.main.sha256).toMatch(/^[0-9a-f]{64}$/); // pinned
		const lines = real.lines(ID);
		expect(lines).toContain("hook install addon-install v=1.0.0 prev=undefined");
		expect(lines).toContain("hook startup addon-install v=1.0.0 prev=undefined");
		expect(lines.indexOf("hook install addon-install v=1.0.0 prev=undefined")).toBeLessThan(lines.indexOf("hook startup addon-install v=1.0.0 prev=undefined"));
		// no approve function: low tier granted, medium not
		expect(real.services.manager.get(ID)?.granted).toEqual(["library.read"]);
		expect(real.supervisor.get(ID)?.grants).toEqual({ capabilities: ["library.read"], netHosts: [] });
		await real.services.manager.uninstall(ID);
		expect(existsSync(dir)).toBe(false);
	}, 90_000);
});

describe("the imports of one installed plugin", () => {
	let rt: Rt & { root: string };
	let locale = "en-US";
	const hidden = false;

	beforeAll(async () => {
		rt = await runtime({ app: { locale: () => locale, timeZone: () => "UTC", mainWindows: () => [1, 2], windowsHidden: () => hidden } });
	}, 60_000);

	test("install with the approval prompt: groups by tier, grants only what was ticked", async () => {
		let seen: any;
		const r = await rt.services.manager.installPackage(pack(built), {
			approve: (req) => {
				seen = req;
				return { grant: ["library.read"] };
			},
		});
		expect(r.started).toBe(true);
		expect(seen.action).toBe("install");
		expect(seen.groups.map((g: any) => g.tier)).toEqual(["low", "medium"]);
		expect(seen.groups[1].items.map((i: any) => [i.id, i.optional])).toEqual([["prefs.app-read", false], ["library.write", true]]);
		expect(seen.groups[1].items[1].reason).toBe("Writes results back to the library.");
		expect(r.granted).toEqual(["library.read"]);
		const st = rt.services.manager.get(ID)!;
		expect(st.state).toBe("enabled");
		expect(JSON.parse(readFileSync(rt.services.manager.layout.stateFile, "utf8")).plugins[ID].enabled).toBe(true);
	}, 30_000);

	test("log: levels, limits, last error", async () => {
		await probe(rt, 900);
		await until(() => rt.lines(ID).some((l) => l.endsWith("[truncated]")));
		const lines = rt.lines(ID);
		expect(lines).toContain("probe log");
		expect(lines).toContain("debug-enabled=false");
		expect(lines).not.toContain("a debug line"); // debug output is off
		expect(rt.services.logs.lastError(ID)?.message).toBe("something broke");
		expect(rt.services.logs.lastError(ID)?.stack).toBe("at plugin.js:1");
		expect(lines.some((l) => l.startsWith("something broke"))).toBe(true);
		rt.services.logs.debugEnabled = true;
		await probe(rt, 900);
		await until(() => rt.lines(ID).includes("debug-enabled=true"));
		expect(rt.lines(ID)).toContain("a debug line");
		rt.services.logs.debugEnabled = false;
	}, 20_000);

	test("prefs: defaults, types, atomic set-many, observers, persistence", async () => {
		await probe(rt, 902);
		await until(() => rt.lines(ID).some((l) => l.startsWith("prefs.reset=")));
		const lines = rt.lines(ID);
		expect(lines).toContain('prefs.get=ok:{"tag":"text","val":"hello"}');
		expect(lines).toContain("prefs.get-none=ok:undefined");
		expect(find(lines, "prefs.set-type=")).toMatch(/^prefs\.set-type=err:invalid-argument\(greeting has a default of type text/);
		expect(find(lines, "prefs.set-key=")).toContain("err:invalid-argument(bad pref key");
		expect(lines).toContain("prefs.set=ok:undefined");
		expect(lines).toContain("prefs.user=ok:[true,false]");
		expect(find(lines, "prefs.set-many-atomic=")).toContain("err:invalid-argument");
		expect(lines).toContain('prefs.limit-after=ok:{"tag":"integer","val":10}'); // nothing from the failed set-many was written
		expect(lines).toContain("observe=1");
		expect(lines).toContain('prefs.getAll=ok:["enabled:false","greeting:true","limit:false","starts:true"]');
		expect(lines).toContain('prefs.after-clear=ok:{"tag":"text","val":"hello"}');
		expect(find(lines, "prefs.get-app-denied=")).toBe("prefs.get-app-denied=err:permission-denied(prefs.app-read)");
		expect(find(lines, "prefs.observe-app-denied=")).toBe("prefs.observe-app-denied=err:permission-denied(prefs.app-read)");
		// the observer (prefix "gre") heard the plugin's own writes, after the calls that caused them returned
		await until(() => rt.lines(ID).filter((l) => l.startsWith("pref-changed")).length >= 2);
		const heard = rt.lines(ID).filter((l) => l.startsWith("pref-changed"));
		expect(heard).toContain('pref-changed sub=1 scope=plugin-own greeting={"tag":"text","val":"changed"}');
		expect(heard).toContain('pref-changed sub=1 scope=plugin-own greeting={"tag":"text","val":"hello"}');
		// a change made outside the plugin (a UI binding) is observed too, and only for the observed prefix
		rt.services.prefs.set(ID, "other", "x");
		rt.services.prefs.set(ID, "greeting", "from the ui");
		await until(() => rt.lines(ID).some((l) => l.includes("from the ui")));
		expect(rt.lines(ID).filter((l) => l.startsWith("pref-changed") && l.includes("other="))).toEqual([]);
		// persistence on disk: only user values
		const file = JSON.parse(readFileSync(rt.services.manager.layout.prefsFile(ID), "utf8"));
		expect(file).toEqual({ other: "x", greeting: "from the ui" }); // the probe's `reset` dropped "starts"
		rt.services.prefs.clear(ID, "greeting");
	}, 30_000);

	test("timers: set, clear, interval, sleep, clock, limit of 64, cancelled on stop", async () => {
		await probe(rt, 906);
		await until(() => rt.lines(ID).some((l) => l.startsWith("slept>=35=")));
		const m = /^timers=(\d+),(\d+),(\d+)$/.exec(find(rt.lines(ID), "timers=")!)!;
		const [a, b, c] = [m[1], m[2], m[3]];
		expect(rt.lines(ID)).toContain("slept>=35=true");
		expect(rt.lines(ID)).toContain("now>2020=true");
		await until(() => rt.lines(ID).filter((l) => l === `timer ${c} interval`).length >= 2);
		expect(rt.lines(ID)).toContain(`timer ${a} timeout`);
		expect(rt.lines(ID)).not.toContain(`timer ${b} timeout`); // cleared
		rt.services.timers.clearAll(ID); // (stops the interval for the rest of the tests)

		await probe(rt, 908);
		await until(() => rt.lines(ID).some((l) => l.startsWith("timers.limit=")));
		expect(find(rt.lines(ID), "timers.limit=")).toBe("timers.limit=err:limit-exceeded(at most 64 timers per plugin)");
		expect(rt.services.timers.count(ID)).toBe(64);
		rt.services.timers.clearAll(ID);
	}, 30_000);

	test("l10n: Fluent from the package, locale chain, args, fallback, dates and numbers", async () => {
		await probe(rt, 901);
		await until(() => rt.lines(ID).some((l) => l.startsWith("l10n.date=")));
		let lines = rt.lines(ID);
		expect(lines).toContain('l10n.hello=ok:"Hello, Ada!"');
		expect(lines).toContain('l10n.items1=ok:"One item"');
		expect(lines).toContain('l10n.items5=ok:"5 items"');
		expect(lines).toContain('l10n.multi=ok:"first line\\nsecond line"');
		expect(lines).toContain('l10n.term=ok:"About Zinc"');
		expect(lines).toContain('l10n.attr=ok:"Save the file"');
		expect(lines).toContain('l10n.onlyen=ok:"Only in English"');
		expect(lines).toContain('l10n.missing=ok:"nope"');
		expect(lines).toContain('l10n.fallback=ok:"Fallback text"');
		expect(lines).toContain('l10n.many=ok:["Save","nope"]');
		expect(lines).toContain("l10n.has=ok:[true,false,true]");
		expect(lines).toContain('l10n.locale=ok:"en-US"');
		expect(lines).toContain('l10n.locales=ok:["en-US","fr"]');
		expect(lines).toContain('l10n.number=ok:"1,234.50"');
		expect(lines).toContain('l10n.date=ok:"1/1/70"');
		expect(rt.services.logs.recent({ plugin: ID, limit: 5000 }).some((l) => l.level === "warn" && l.message.includes('missing message "nope"'))).toBe(true);

		// the UI language changes: the plugin is told, strings follow, a message the French file lacks comes from the default locale
		locale = "fr-CA";
		rt.services.app.notifyLocaleChanged("fr-CA");
		await until(() => rt.lines(ID).includes("locale-changed fr-CA"));
		const before = rt.lines(ID).length;
		await probe(rt, 901);
		await until(() => rt.lines(ID).slice(before).some((l) => l.startsWith("l10n.date=")));
		lines = rt.lines(ID).slice(before);
		expect(lines).toContain('l10n.hello=ok:"Bonjour, Ada !"');
		expect(lines).toContain('l10n.many=ok:["Enregistrer","nope"]');
		expect(lines).toContain('l10n.onlyen=ok:"Only in English"');
		// the UI side resolves localized-string values with the same bundle
		expect(rt.services.l10n.resolve(ID, { tag: "localized", val: { id: "button", args: [] } })).toBe("Enregistrer");
		expect(rt.services.l10n.resolve(ID, { tag: "plain", val: "as is" })).toBe("as is");
		locale = "en-US";
	}, 30_000);

	test("secrets: encrypted per plugin, limits, names only", async () => {
		await probe(rt, 903);
		await until(() => rt.lines(ID).some((l) => l.startsWith("secrets.after-delete=")));
		const lines = rt.lines(ID);
		expect(lines).toContain("secrets.get-none=ok:undefined");
		expect(lines).toContain('secrets.get=ok:"s3cret-é"');
		expect(lines).toContain('secrets.names=ok:["token"]');
		expect(find(lines, "secrets.big=")).toContain("err:limit-exceeded");
		expect(find(lines, "secrets.badname=")).toContain("err:invalid-argument");
		expect(lines).toContain("secrets.after-delete=ok:undefined");
		const file = rt.services.manager.layout.secretsFile(ID);
		expect(readFileSync(file, "utf8")).not.toContain("kept");
		expect(rt.services.secrets.get(ID, "keep")).toBe("kept");
	}, 20_000);

	test("util, app, plugins (own record, denied calls)", async () => {
		await probe(rt, 905);
		await until(() => rt.lines(ID).some((l) => l.startsWith("util.title=")));
		let lines = rt.lines(ID);
		expect(lines).toContain("util.uuid=ok:36");
		expect(lines).toContain("util.random=ok:16");
		expect(lines).toContain('util.sha256=ok:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"');
		expect(lines).toContain('util.md5=ok:"900150983cd24fb0d6963f7d28e17f72"');
		expect(lines).toContain("util.semver=ok:[-1,0,-1]");
		expect(lines).toContain('util.doi=ok:"10.1000/xyz123"');
		expect(lines).toContain('util.isbn=ok:"9780306406157"');
		expect(lines).toContain('util.issn=ok:"0378-5955"');
		expect(lines).toContain('util.html=ok:"a & b\\nc"');
		expect(lines).toContain('util.title=ok:"The Art of War and Peace"');

		await probe(rt, 907);
		await until(() => rt.lines(ID).some((l) => l.startsWith("plugins.get-self=")));
		lines = rt.lines(ID);
		expect(lines).toContain('app.info=ok:["Zinc","0.1.0","0.1.0","windows","en-US"]'.replace('"windows"', `"${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"}"`));
		expect(lines).toContain("app.ready=ok:true");
		expect(lines).toContain("app.windows=ok:[1,2]");
		expect(lines).toContain(`plugins.self=ok:["${ID}","E2E (QuickJS test plugin)","1.0.0","enabled",["library.read"]]`);
		// no `result` in these three signatures: without plugins.read the plugin sees only itself
		expect(find(lines, "plugins.list-denied=")).toBe(`plugins.list-denied=ok:["${ID}"]`);
		expect(find(lines, "plugins.get-other-denied=")).toBe("plugins.get-other-denied=ok:undefined");
		expect(find(lines, "plugins.observe-denied=")).toBe("plugins.observe-denied=err:permission-denied(plugins.read)");
		expect(lines).toContain('plugins.get-self=ok:"E2E (QuickJS test plugin)"');
	}, 20_000);

	test("permissions: check states, list, request with and without a prompt, on-permission-changed, persisted grant", async () => {
		await probe(rt, 904);
		await until(() => rt.lines(ID).some((l) => l.startsWith("perm.after=")));
		let lines = rt.lines(ID);
		expect(lines).toContain('perm.library.read=ok:"granted"');
		expect(lines).toContain('perm.prefs.app-read=ok:"denied"');
		expect(lines).toContain('perm.library.write=ok:"optional"');
		expect(lines).toContain('perm.library.erase=ok:"undeclared"');
		expect(lines).toContain('perm.list=ok:[["library.read","granted"],["prefs.app-read","denied"],["library.write","optional"]]');
		expect(find(lines, "perm.request-undeclared=")).toBe("perm.request-undeclared=err:permission-denied(library.erase)");
		expect(find(lines, "perm.request-denied-required=")).toContain("err:invalid-argument");
		expect(find(lines, "perm.request=")).toContain("err:unavailable"); // no prompt provided yet
		expect(lines).toContain('perm.after=ok:"optional"');

		// the ui area's prompt is injectable
		const asked: any[] = [];
		rt.services.permissions.prompt = (req) => (asked.push(req), true);
		const before = rt.lines(ID).length;
		await probe(rt, 904);
		await until(() => rt.lines(ID).slice(before).some((l) => l.startsWith("perm.after=")));
		lines = rt.lines(ID).slice(before);
		expect(lines).toContain("perm.request=ok:true");
		expect(lines).toContain('perm.after=ok:"granted"');
		expect(asked[0]).toMatchObject({ pluginId: ID, permission: "library.write", tier: "medium", reason: "Save" }); // the reason is a Fluent reference, resolved
		await until(() => rt.lines(ID).includes("permission-changed library.write true"));
		expect(rt.supervisor.get(ID)?.grants.capabilities).toContain("library.write");
		expect(JSON.parse(readFileSync(rt.services.manager.layout.grantsFile, "utf8"))[ID].granted).toContain("library.write");

		// revoked in Settings: the plugin hears it and the next call is refused
		await rt.services.manager.setPermission(ID, "library.write", false);
		await until(() => rt.lines(ID).includes("permission-changed library.write false"));
		expect(rt.supervisor.get(ID)?.grants.capabilities).not.toContain("library.write");
		rt.services.permissions.prompt = undefined;
	}, 30_000);

	test("hooks: main-window-load and -unload reach running plugins", async () => {
		await rt.services.manager.windowLoaded(7);
		await rt.services.manager.windowUnloaded(7);
		expect(rt.lines(ID)).toContain("hook main-window-load 7");
		expect(rt.lines(ID)).toContain("hook main-window-unload 7");
	}, 20_000);

	test("disable and enable: shutdown and startup with their reasons, timers and observers dropped", async () => {
		rt.services.timers.setInterval(ID, 60_000);
		await rt.services.manager.setEnabled(ID, false);
		expect(rt.lines(ID)).toContain("hook shutdown addon-disable v=1.0.0");
		expect(rt.supervisor.get(ID)).toBeUndefined();
		expect(rt.services.manager.get(ID)?.state).toBe("disabled");
		expect(rt.services.timers.count(ID)).toBe(0);
		await rt.services.manager.setEnabled(ID, true);
		expect(rt.lines(ID)).toContain("hook startup addon-enable v=1.0.0 prev=undefined");
		expect(rt.services.manager.get(ID)?.state).toBe("enabled");
		expect(rt.supervisor.get(ID)?.status).toBe("running");
	}, 30_000);

	test("another plugin's lifecycle events reach an observer with plugins.read; icons and records", async () => {
		await rt.services.manager.installPackage(pack(built, { manifest: (m) => ((m.permissions.capabilities as string[]).push("plugins.read"), (m.version = "1.0.1")) }), { approve: grantAll });
		await probe(rt, 909);
		await until(() => rt.lines(ID).some((l) => l.startsWith("plugins.get-other=")));
		expect(find(rt.lines(ID), "plugins.observe=")).toBe("plugins.observe=ok:undefined");
		expect(find(rt.lines(ID), "plugins.list=")).toBe(`plugins.list=ok:["${ID}:enabled"]`);
		expect(find(rt.lines(ID), "plugins.icon=")).toBe("plugins.icon=ok:8");
		const second = pack(built, { manifest: (m) => ((m.id = "second@zinc.test"), (m.name = "Second")) });
		await rt.services.manager.installPackage(second, { approve: grantAll });
		await until(() => rt.lines(ID).includes("plugin-event second@zinc.test startup addon-install"));
		expect(rt.lines(ID)).toContain("plugin-event second@zinc.test install addon-install");
		await probe(rt, 909);
		await until(() => rt.lines(ID).filter((l) => l.startsWith("plugins.get-other=")).length >= 2);
		expect(rt.lines(ID).filter((l) => l.startsWith("plugins.get-other="))[1]).toBe('plugins.get-other=ok:"Second"');
		await rt.services.manager.uninstall("second@zinc.test");
		await until(() => rt.lines(ID).includes("plugin-event second@zinc.test uninstall addon-uninstall"));
	}, 60_000);
});

describe("update, downgrade, uninstall", () => {
	test("upgrade: old shutdown + uninstall, new install + startup, reasons and previous version, data and prefs stay", async () => {
		const rt = await runtime();
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		rt.services.prefs.set(ID, "mine", "kept across the update");
		const r = await rt.services.manager.installPackage(pack(built, { manifest: (m) => (m.version = "1.1.0") }), { approve: grantAll });
		expect(r).toMatchObject({ action: "upgrade", previousVersion: "1.0.0", started: true });
		const lines = rt.lines(ID);
		const order = ["hook shutdown addon-upgrade v=1.0.0", "hook uninstall addon-upgrade v=1.0.0", "hook install addon-upgrade v=1.1.0 prev=1.0.0", "hook startup addon-upgrade v=1.1.0 prev=1.0.0"].map((l) => lines.indexOf(l));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(lines).toContain("starts=2"); // the prefs the first run wrote were still there
		expect(rt.services.prefs.get(ID, "mine")).toBe("kept across the update");
		expect(rt.services.manager.get(ID)?.version).toBe("1.1.0");
		expect(readdirSync(rt.services.manager.layout.installedRoot)).toEqual([ID]);

		const d = await rt.services.manager.installPackage(pack(built, { manifest: (m) => (m.version = "0.9.0") }), { approve: grantAll });
		expect(d).toMatchObject({ action: "downgrade", previousVersion: "1.1.0", started: true });
		expect(rt.lines(ID)).toContain("hook shutdown addon-downgrade v=1.1.0");
		expect(rt.lines(ID)).toContain("hook startup addon-downgrade v=0.9.0 prev=1.1.0");
	}, 90_000);

	test("an update that adds a permission stays disabled until the user approves", async () => {
		const rt = await runtime();
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		const r = await rt.services.manager.installPackage(pack(built, { manifest: (m) => ((m.version = "1.2.0"), (m.permissions.capabilities as string[]).push("clipboard.write")) }));
		expect(r).toMatchObject({ action: "upgrade", started: false, pendingApproval: ["clipboard.write"] });
		const p = rt.services.manager.get(ID)!;
		expect(p.state).toBe("disabled");
		expect(p.stateDetail).toContain("approval");
		expect(rt.supervisor.get(ID)).toBeUndefined();
		await expect(rt.services.manager.setEnabled(ID, true)).rejects.toThrow(/approved first/);
		await rt.services.manager.approvePending(ID, ["clipboard.write"]);
		expect(rt.services.manager.get(ID)?.state).toBe("enabled");
		expect(rt.services.manager.get(ID)?.granted).toContain("clipboard.write");
		expect(rt.lines(ID)).toContain("hook startup addon-enable v=1.2.0 prev=undefined");
		// an update with the same permissions needs no approval
		const again = await rt.services.manager.installPackage(pack(built, { manifest: (m) => ((m.version = "1.3.0"), (m.permissions.capabilities as string[]).push("clipboard.write")) }));
		expect(again.started).toBe(true);
	}, 90_000);

	test("uninstall: hooks, then folder, data, prefs, secrets and grants are removed", async () => {
		const rt = await runtime();
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		const lay = rt.services.manager.layout;
		await probe(rt, 903); // leaves the secret "keep"
		await until(() => rt.lines(ID).some((l) => l.startsWith("secrets.after-delete=")));
		const { mkdirSync } = await import("node:fs");
		mkdirSync(lay.data(ID), { recursive: true });
		writeFileSync(join(lay.data(ID), "x.txt"), "data");
		const seen: string[] = [];
		rt.supervisor.on("log", (l) => void seen.push(l.message)); // the plugin's log is cleared with it, so listen while it runs
		rt.services.prefs.set(ID, "mine", "x");
		expect(existsSync(lay.prefsFile(ID))).toBe(true);
		await rt.services.manager.uninstall(ID);
		expect(seen).toContain("hook shutdown addon-uninstall v=1.0.0");
		expect(seen).toContain("hook uninstall addon-uninstall v=1.0.0");
		expect(seen.indexOf("hook shutdown addon-uninstall v=1.0.0")).toBeLessThan(seen.indexOf("hook uninstall addon-uninstall v=1.0.0"));
		for (const p of [lay.installed(ID), lay.data(ID), lay.prefsFile(ID), lay.secretsFile(ID)]) expect(existsSync(p)).toBe(false);
		expect(rt.services.manager.get(ID)).toBeUndefined();
		expect(rt.supervisor.get(ID)).toBeUndefined();
		expect(JSON.parse(readFileSync(lay.grantsFile, "utf8"))).toEqual({});
		expect(JSON.parse(readFileSync(lay.stateFile, "utf8")).plugins).toEqual({});
	}, 60_000);

	test("uninstall with keepData keeps data, prefs and secrets", async () => {
		const rt = await runtime();
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		const lay = rt.services.manager.layout;
		await probe(rt, 903);
		await until(() => rt.lines(ID).some((l) => l.startsWith("secrets.after-delete=")));
		const { mkdirSync } = await import("node:fs");
		mkdirSync(lay.data(ID), { recursive: true });
		writeFileSync(join(lay.data(ID), "x.txt"), "data");
		await rt.services.manager.uninstall(ID, { keepData: true });
		expect(existsSync(lay.installed(ID))).toBe(false);
		expect(existsSync(join(lay.data(ID), "x.txt"))).toBe(true);
		expect(existsSync(lay.prefsFile(ID))).toBe(true);
		expect(rt.services.secrets.get(ID, "keep")).toBe("kept");
		// a reinstall finds them again
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		expect(rt.lines(ID).filter((l) => l.startsWith("starts=")).at(-1)).toBe("starts=2");
	}, 60_000);

	test("update check: newest compatible update above the installed version, hash required", async () => {
		const { checkForUpdate, downloadUpdate } = await import("../../src/package/update");
		const hash = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
		const pkg = new TextEncoder().encode("package bytes");
		const doc = {
			addons: {
				[ID]: {
					updates: [
						{ version: "1.5.0", update_link: "https://x.test/a.zplugin", update_hash: `sha256:${hash(pkg)}`, applications: { zinc: { strict_min_version: "0.1.0" } }, notes_url: "https://x.test/notes" },
						{ version: "3.0.0", update_link: "https://x.test/b.zplugin", update_hash: `sha256:${hash(pkg)}`, applications: { zinc: { strict_min_version: "9.0.0" } } }, // needs a newer Zinc
						{ version: "2.0.0", update_link: "http://x.test/c.zplugin", update_hash: `sha256:${hash(pkg)}` }, // not https
						{ version: "2.1.0", update_link: "https://x.test/d.zplugin" }, // no hash
						{ version: "0.5.0", update_link: "https://x.test/e.zplugin", update_hash: `sha256:${hash(pkg)}` }, // older
					],
				},
			},
		};
		const fetchJson = async (url: string) => ({ ok: true, status: 200, json: async () => doc, arrayBuffer: async () => pkg.buffer.slice(0) as ArrayBuffer, url });
		const manifest: any = { id: ID, version: "1.0.0", update_url: "https://x.test/updates.json" };
		const u = await checkForUpdate(manifest, { zincVersion: "0.5.0", fetch: fetchJson });
		expect(u).toEqual({ version: "1.5.0", link: "https://x.test/a.zplugin", sha256: hash(pkg), notesUrl: "https://x.test/notes" });
		expect(await checkForUpdate({ ...manifest, version: "1.5.0" }, { zincVersion: "0.5.0", fetch: fetchJson })).toBeUndefined();
		expect(await checkForUpdate({ ...manifest, update_url: undefined }, { zincVersion: "0.5.0", fetch: fetchJson })).toBeUndefined();
		await expect(checkForUpdate({ ...manifest, update_url: "http://x.test/u.json" }, { zincVersion: "0.5.0", fetch: fetchJson })).rejects.toThrow(/https/);
		expect(await downloadUpdate(u!, { zincVersion: "0.5.0", fetch: fetchJson })).toEqual(pkg);
		await expect(downloadUpdate({ ...u!, sha256: "0".repeat(64) }, { zincVersion: "0.5.0", fetch: fetchJson })).rejects.toThrow(/update_hash/);
	});
});

describe("refusals leave nothing behind", () => {
	test("bad packages and manifests, incompatibility, hash, approval cancelled, blocklist", async () => {
		const rt = await runtime({ manager: { blocklist: (id, v) => (id === "blocked@zinc.test" && v === "1.0.0" ? "known to corrupt libraries" : undefined) } });
		const m = rt.services.manager;
		const code = async (p: Promise<unknown>): Promise<string | undefined> => ((await p.then(() => undefined, (e) => e)) as InstallError | undefined)?.code;
		const withManifest = (f: (m: any) => void) => pack(built, { manifest: f });
		expect(await code(m.installPackage(new TextEncoder().encode("not a zip at all, just text padding.....")))).toBe("invalid-package");
		expect(await code(m.installPackage(withManifest((x) => (x.surprise = 1))))).toBe("invalid-manifest");
		expect(await code(m.installPackage(withManifest((x) => (x.permissions.capabilities = ["made.up"]))))).toBe("invalid-manifest");
		expect(await code(m.installPackage(withManifest((x) => (x.zinc.min_version = "9.0.0"))))).toBe("incompatible");
		expect(await code(m.installPackage(withManifest((x) => (x.zinc.api_version = "0.2"))))).toBe("incompatible");
		expect(await code(m.installPackage(withManifest((x) => (x.zinc.platforms = [process.platform === "win32" ? "linux" : "windows"]))))).toBe("incompatible");
		expect(await code(m.installPackage(withManifest((x) => (x.main.sha256 = "0".repeat(64)))))).toBe("hash-mismatch");
		expect(await code(m.installPackage(withManifest((x) => (x.main.wasm = "missing.wasm"))))).toBe("invalid-package");
		expect(await code(m.installPackage(pack(built, { extra: { "plugin.wasm": "this is not wasm at all" }, manifest: (x) => delete x.main.sha256 })))).toBe("invalid-package");
		expect(await code(m.installPackage(withManifest((x) => ((x.id = "blocked@zinc.test"), (x.version = "1.0.0")))))).toBe("incompatible");
		expect(await code(m.installPackage(pack(built), { approve: () => false }))).toBe("cancelled");
		// a component zhw cannot compile
		const bad = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
		const real = await runtime();
		expect(await code(real.services.manager.installPackage(pack(built, { extra: { "plugin.wasm": bad }, manifest: (x) => delete x.main.sha256 })))).toBe("prepare-failed");
		for (const r of [m, real.services.manager]) {
			expect(r.list()).toEqual([]);
			expect(existsSync(r.layout.installedRoot) ? readdirSync(r.layout.installedRoot) : []).toEqual([]);
			expect(existsSync(r.layout.staging) ? readdirSync(r.layout.staging) : []).toEqual([]);
		}
	}, 90_000);

});

describe("restart of Zinc: startAll, quit, tampering", () => {
	test("startAll starts enabled plugins with app-startup, stopAll shuts them down with app-shutdown; disabled ones stay off", async () => {
		const root = scratch("restart");
		const first = await runtime({}, root);
		await first.services.manager.installPackage(pack(built), { approve: grantAll });
		await first.services.manager.installPackage(pack(built, { manifest: (m) => ((m.id = "off@zinc.test"), (m.name = "Off")) }), { approve: grantAll });
		await first.services.manager.setEnabled("off@zinc.test", false);
		first.services.dispose();
		await first.supervisor.shutdown();

		const second = await runtime({}, root);
		const mgr = second.services.manager;
		expect(mgr.list().map((p) => [p.id, p.state])).toEqual([[ID, "enabled"], ["off@zinc.test", "disabled"]]);
		await mgr.startAll();
		expect(second.lines(ID)).toContain("hook startup app-startup v=1.0.0 prev=undefined");
		expect(second.lines(ID).filter((l) => l.startsWith("starts=")).at(-1)).toBe("starts=2");
		expect(second.supervisor.get("off@zinc.test")).toBeUndefined();
		await mgr.stopAll();
		expect(second.lines(ID)).toContain("hook shutdown app-shutdown v=1.0.0");
	}, 90_000);

	test("a changed plugin.wasm is refused at load", async () => {
		const root = scratch("tamper");
		const first = await runtime({}, root);
		await first.services.manager.installPackage(pack(built), { approve: grantAll });
		const dir = first.services.manager.layout.installed(ID);
		first.services.dispose();
		await first.supervisor.shutdown();

		expect(existsSync(join(dir, "transpiled"))).toBe(false);
		writeFileSync(join(dir, "plugin.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
		const rt2 = await runtime({}, root);
		await rt2.services.manager.startAll();
		expect(rt2.services.manager.get(ID)).toMatchObject({ state: "failed" });
		expect(rt2.services.manager.get(ID)?.stateDetail).toContain("pinned hash");
		expect(rt2.supervisor.get(ID)).toBeUndefined();
	}, 60_000);

	test(".cwasm cache: warm load, JIT fallback when missing, and rebuild + prune on zhw version bump", async () => {
		const root = scratch("cwasm-e2e");
		// 1. Install under version v1 -> precompiled .cwasm is built and loaded (fromCwasm === true)
		const v1 = await runtime({ manager: { zhwVersionOverride: "zhw-test-v1" } }, root);
		await v1.services.manager.installPackage(pack(built), { approve: grantAll });
		const lay = v1.services.manager.layout;
		const sha = v1.services.manager.manifestOf(ID)!.main.sha256!;
		expect(readdirSync(lay.cacheRoot)).toEqual(["zhw-test-v1"]);
		const cwasmV1 = join(lay.cacheRoot, "zhw-test-v1", `${sha}.cwasm`);
		expect(existsSync(cwasmV1)).toBe(true);
		expect(v1.supervisor.lastLoadInfo?.(ID)?.fromCwasm).toBe(true);
		const stats = (await v1.supervisor.stats?.()) as { rssBytes?: number; plugins?: Array<{ plugin: string }> } | undefined;
		expect(stats?.plugins?.some((p) => p.plugin === ID)).toBe(true);
		v1.services.dispose();
		await v1.supervisor.shutdown();

		// 2. Delete the .cwasm file under the SAME version -> falls back to JIT compilation (fromCwasm === false)
		rmSync(cwasmV1, { force: true });
		const jit = await runtime({ manager: { zhwVersionOverride: "zhw-test-v1" } }, root);
		await jit.services.manager.startAll();
		expect(jit.supervisor.get(ID)?.status).toBe("running");
		expect(jit.supervisor.lastLoadInfo?.(ID)?.fromCwasm).toBe(false);
		expect(jit.lines(ID).filter((l) => l.startsWith("starts=")).at(-1)).toBe("starts=2");
		jit.services.dispose();
		await jit.supervisor.shutdown();

		// 3. Bump zhwVersionOverride to v2 -> stale v1 dir is pruned, .cwasm is rebuilt in v2, and fromCwasm === true
		mkdirSync(join(lay.cacheRoot, "zhw-test-v1"), { recursive: true });
		writeFileSync(cwasmV1, "stale");
		const v2 = await runtime({ manager: { zhwVersionOverride: "zhw-test-v2" } }, root);
		await v2.services.manager.startAll();
		expect(readdirSync(lay.cacheRoot)).toEqual(["zhw-test-v2"]);
		expect(existsSync(join(lay.cacheRoot, "zhw-test-v2", `${sha}.cwasm`))).toBe(true);
		expect(v2.supervisor.get(ID)?.status).toBe("running");
		expect(v2.supervisor.lastLoadInfo?.(ID)?.fromCwasm).toBe(true);
		expect(v2.lines(ID).filter((l) => l.startsWith("starts=")).at(-1)).toBe("starts=3");

		// 4. Uninstall prunes the plugin's .cwasm from the active cache folder
		await v2.services.manager.uninstall(ID);
		expect(readdirSync(join(lay.cacheRoot, "zhw-test-v2"))).toEqual([]);
	}, 90_000);

	test("a plugin that no longer fits this Zinc is marked incompatible, not started", async () => {
		const root = scratch("compat");
		const first = await runtime({}, root);
		await first.services.manager.installPackage(pack(built, { manifest: (m) => (m.zinc.min_version = "0.5.0") }), { approve: grantAll });
		first.services.dispose();
		await first.supervisor.shutdown();
		const rt = await runtime({ manager: { zincVersion: "0.4.0" } }, root);
		await rt.services.manager.startAll();
		expect(rt.services.manager.get(ID)).toMatchObject({ state: "incompatible" });
		expect(rt.services.manager.get(ID)?.stateDetail).toContain("0.5.0");
	}, 60_000);
});
