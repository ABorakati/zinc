// `prefs` (lifecycle.wit): the plugin's own prefs (package/prefs-store.ts) and a read-only allowlist of Zinc's settings. Observers are
// delivered through `events.on-pref-changed`. No permission for the plugin's own prefs; `get-app` and app observers need `prefs.app-read`.
// A change made by a UI binding goes through the same PrefStore (`getServices().prefs.set(...)`), so observers fire for it too.
import { defineHandler, witError } from "./registry";
import { getServices } from "../package/services";
import { APP_PREF_ALLOWLIST } from "../package/app-service";
import { PrefError, fromWire, toWire, type PrefValue } from "../package/prefs-store";
import { requirePermission } from "../permissions/check";

const MAX_SUBSCRIPTIONS = 256;

function wrap<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof PrefError) throw witError(e.tag, e.message);
		throw e;
	}
}

type Wire = { tag: string; val: unknown };

/** A secret setting is not a pref: its value goes to `secrets` under "pref:<key>" (lifecycle.wit, interface prefs). */
function write(plugin: string, entries: Array<[string, PrefValue]>) {
	const s = getServices();
	const plain: Array<[string, PrefValue]> = [];
	for (const [k, v] of entries) {
		if (s.prefs.isSecret(plugin, k)) {
			if (typeof v !== "string") throw witError("invalid-argument", `${k} is a secret setting and holds text`);
			s.secrets.set(plugin, `pref:${k}`, v);
		} else plain.push([k, v]);
	}
	if (plain.length) s.prefs.setMany(plugin, plain);
}

export default defineHandler({
	interface: "zinc:plugin/prefs",
	where: "zinc",
	functions: {
		get(ctx, key: string) {
			const v = getServices().prefs.get(ctx.pluginId, key);
			return v === undefined ? undefined : toWire(v);
		},
		"get-app"(ctx, key: string) {
			requirePermission(ctx, "prefs.app-read");
			if (!APP_PREF_ALLOWLIST.includes(key)) throw witError("not-found", `"${key}" is not a Zinc setting that plugins can read`);
			const v = getServices().app.appPref(key);
			return v === undefined ? undefined : toWire(v);
		},
		"get-all"(ctx, prefix: string | undefined) {
			return getServices().prefs.getAll(ctx.pluginId, prefix).map((e) => ({ key: e.key, value: toWire(e.value), userSet: e.userSet }));
		},
		set(ctx, key: string, value: Wire) {
			wrap(() => write(ctx.pluginId, [[key, fromWire(value)]]));
		},
		"set-many"(ctx, entries: Array<[string, Wire]>) {
			wrap(() => write(ctx.pluginId, entries.map(([k, v]) => [k, fromWire(v)] as [string, PrefValue])));
		},
		clear(ctx, key: string) {
			getServices().prefs.clear(ctx.pluginId, key);
		},
		"has-user-value"(ctx, key: string) {
			return getServices().prefs.hasUserValue(ctx.pluginId, key);
		},
		reset(ctx, prefix: string | undefined, except: string[]) {
			getServices().prefs.reset(ctx.pluginId, prefix, except);
		},
		observe(ctx, scope: "plugin-own" | "app", key: string, prefix: boolean) {
			if (scope === "app") requirePermission(ctx, "prefs.app-read");
			if (!key || key.length > 128) throw witError("invalid-argument", "bad pref key");
			if (scope === "app" && !prefix && !APP_PREF_ALLOWLIST.includes(key)) throw witError("not-found", `"${key}" is not a Zinc setting that plugins can read`);
			const s = getServices();
			if (s.subscriptionCount(ctx.pluginId) >= MAX_SUBSCRIPTIONS) throw witError("limit-exceeded", `at most ${MAX_SUBSCRIPTIONS} pref observers per plugin`);
			return s.observePref(ctx.pluginId, scope, key, prefix);
		},
		unobserve(ctx, subscription: number) {
			getServices().unobservePref(ctx.pluginId, subscription);
		},
	},
});
