// The prefs bundle: keys that are names on Object.prototype, secret and plain entries written together, the app settings pushed to
// `zhw` (a setting that loses its value is pushed as null), and who hears about a change of an app setting.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import prefsHandler from "../../src/imports/prefs.zinc";
import { WitError } from "../../src/imports/registry";
import { createLayout } from "../../src/package/layout";
import { PrefStore, type PrefValue } from "../../src/package/prefs-store";
import { fileKeyProvider } from "../../src/package/secrets-store";
import { PluginServices, setServices } from "../../src/package/services";
import { rmTree, scratch } from "./helpers";

const P = "p@x.test";
let root: string;
let services: PluginServices;
let appPrefs: Record<string, PrefValue>;
let notify: (key: string, value: PrefValue | undefined) => void = () => {};
const pushed: Array<Record<string, unknown>> = [];
const delivered: unknown[][] = [];
let granted: string[] = [];

beforeAll(() => {
	root = scratch("prefs-bundle");
	appPrefs = { "ui.theme.mode": "dark" };
	services = new PluginServices({
		manager: { root },
		secretKeys: fileKeyProvider(createLayout(root).secretsDir),
		app: {
			appPrefs: {
				get: (k) => appPrefs[k],
				subscribe: (fn) => {
					notify = fn;
					return () => {};
				},
			},
		},
	});
	setServices(services);
	// a supervisor that records what the services push to `zhw` and what they deliver to plugins
	services.attach({
		on: () => () => {},
		get: (id: string) => ({ id, grants: { capabilities: granted, netHosts: [] } }),
		list: () => [],
		call: async (id: string, iface: string, fn: string, args: unknown[]) => void delivered.push([id, iface, fn, ...args]),
		pushHost: (m: Record<string, unknown>) => void pushed.push(m),
	} as never);
});
afterAll(() => {
	services.dispose();
	setServices(undefined);
	rmTree(root);
});

const ctx = { pluginId: P } as never;
const fn = (name: string) => prefsHandler.functions[name]! as (c: never, ...a: unknown[]) => unknown;
const text = (v: string) => ({ tag: "text", val: v });
const failure = async (run: () => unknown) => {
	try {
		await run();
	} catch (e) {
		return e instanceof WitError ? (e.payload as { tag: string }).tag : `thrown: ${String(e)}`;
	}
	return undefined;
};

describe("keys that are names on Object.prototype", () => {
	test("have no value until set, and are stored like any other key", () => {
		const store = new PrefStore(createLayout(scratchRoot()), () => undefined);
		for (const k of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
			expect([k, store.get(P, k)]).toEqual([k, undefined]);
			expect([k, store.hasUserValue(P, k)]).toEqual([k, false]);
		}
		store.set(P, "__proto__", "x");
		store.set(P, "toString", "y");
		expect(store.get(P, "__proto__")).toBe("x");
		expect(store.get(P, "toString")).toBe("y");
		expect(store.hasUserValue(P, "toString")).toBe(true);
		store.clear(P, "toString");
		expect(store.get(P, "toString")).toBeUndefined();
		expect(store.getAll(P).map((e) => e.key)).toEqual(["__proto__"]);
	});
	test("an own default of that name still counts, and a missing default does not", () => {
		const store = new PrefStore(createLayout(scratchRoot()), () => ({ valueOf: "d" }));
		expect(store.get(P, "valueOf")).toBe("d");
		expect(store.get(P, "constructor")).toBeUndefined();
	});
	test("the plugin sees the same through the import", () => {
		expect(fn("get")(ctx, "toString")).toBeUndefined();
		expect(fn("has-user-value")(ctx, "constructor")).toBe(false);
	});
});
function scratchRoot() {
	const r = scratch("prefs-store");
	extra.push(r);
	return r;
}
const extra: string[] = [];
afterAll(() => extra.forEach(rmTree));

describe("set-many with secret and plain entries is all or none", () => {
	test("a bad plain entry stops a secret entry from being written", async () => {
		services.prefs.markSecret(P, "token");
		const before = services.secrets.listNames(P);
		expect(await failure(() => fn("set-many")(ctx, [["token", text("s3cret")], ["bad key!", text("x")]]))).toBe("invalid-argument");
		expect(services.secrets.listNames(P)).toEqual(before);
	});
	test("a bad secret entry stops plain entries from being written", async () => {
		expect(await failure(() => fn("set-many")(ctx, [["plain", text("x")], ["token", { tag: "flag", val: true }]]))).toBe("invalid-argument");
		expect(services.prefs.get(P, "plain")).toBeUndefined();
		const huge = "y".repeat(9 * 1024);
		expect(await failure(() => fn("set-many")(ctx, [["plain", text("x")], ["token", text(huge)]]))).toBe("limit-exceeded"); // a secret failure comes back as a WIT error
		expect(services.prefs.get(P, "plain")).toBeUndefined();
		expect(services.secrets.get(P, "pref:token")).toBeUndefined();
	});
	test("a good set of entries is written together", async () => {
		await fn("set-many")(ctx, [["plain", text("x")], ["token", text("s3cret")]]);
		expect(services.prefs.get(P, "plain")).toBe("x");
		expect(services.secrets.get(P, "pref:token")).toBe("s3cret");
	});
});

describe("app settings", () => {
	test("a setting that loses its value is pushed to zhw as null", () => {
		services.initState(); // zhw starts knowing ui.theme.mode = dark
		pushed.length = 0;
		delete appPrefs["ui.theme.mode"];
		notify("ui.theme.mode", undefined);
		expect(pushed.at(-1)).toEqual({ t: "prefs", appPrefs: { "ui.theme.mode": null } });
		pushed.length = 0;
		appPrefs["ui.theme.mode"] = "light";
		notify("ui.theme.mode", "light");
		expect(pushed.at(-1)).toEqual({ t: "prefs", appPrefs: { "ui.theme.mode": "light" } });
	});

	test("an observer of app settings hears changes only while the plugin has prefs.app-read", async () => {
		const id = services.observePref(P, "app", "ui.theme.mode", false);
		granted = [];
		delivered.length = 0;
		notify("ui.theme.mode", "dark");
		await Bun.sleep(30);
		expect(delivered).toEqual([]); // the permission was revoked (or never given): the observer is silent
		granted = ["prefs.app-read"];
		notify("ui.theme.mode", "light");
		await Bun.sleep(30);
		expect(delivered.map((d) => [d[2], d[3]])).toEqual([["on-pref-changed", id]]);
	});
});
