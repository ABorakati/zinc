// `notifier` (library.wit): subscribe to library changes. One NotifierHub per plugin host process reads core's change log
// (GET /api/changes, long poll) and calls the plugin's exported `notifier-handler.on-events` with batches.
import { defineHandler, witError, type HandlerContext } from "./registry";
import { requirePermission } from "./data/perm";
import { NotifierHub, OBJECT_TYPES, type WitSubscription } from "./data/notifier-hub";

const MAX_SUBS_PER_PLUGIN = 32;
let hub: NotifierHub | undefined;
let hubUrl: string | undefined;
/** Plugins that already have their subscription-guard handle. */
const guarded = new Set<string>();

function getHub(ctx: HandlerContext): NotifierHub {
	if (!ctx.coreUrl) throw witError("unavailable", "no core URL: the notifier reads core's change log");
	if (!hub || hubUrl !== ctx.coreUrl) {
		hub?.stop();
		hubUrl = ctx.coreUrl;
		hub = new NotifierHub({ baseUrl: ctx.coreUrl.replace(/\/+$/, ""), log: (l, m) => ctx.log(l, m) });
	}
	return hub;
}

/** For tests: stop the feed and forget every subscription. */
export function resetNotifier(): void {
	hub?.stop();
	hub = undefined;
	guarded.clear();
}

export default defineHandler({
	interface: "zinc:plugin/notifier",
	where: "host",
	functions: {
		subscribe(ctx, sub: WitSubscription) {
			requirePermission(ctx, "library.read");
			const h = getHub(ctx);
			if (h.countFor(ctx.pluginId) >= MAX_SUBS_PER_PLUGIN) throw witError("limit-exceeded", `at most ${MAX_SUBS_PER_PLUGIN} subscriptions per plugin`);
			const s: WitSubscription = { types: sub.types ?? [], kinds: sub.kinds ?? [], priority: sub.priority ?? 100, skipOwn: !!sub.skipOwn, maxDelayMs: sub.maxDelayMs ?? 0, label: sub.label ?? "" };
			const id = h.subscribe(ctx.pluginId, s, async (subId, batch) => {
				await ctx.callExport("notifier-handler", "on-events", [subId, batch]);
			});
			// a handle with a drop hook: when the plugin is unloaded the host drops its resources, and with them its subscriptions
			if (!guarded.has(ctx.pluginId)) {
				guarded.add(ctx.pluginId); // one handle per plugin: the guest never sees it, so it could never be dropped one by one
				ctx.resource("subscription-guard", { plugin: ctx.pluginId });
			}
			return id;
		},

		unsubscribe(ctx, id: number) {
			if (!getHub(ctx).unsubscribe(ctx.pluginId, id)) throw witError("not-found", `subscription ${id}`);
		},

		trigger(ctx, ev: { object: string; kind: string; ids: string[]; options?: string }) {
			if (ev.kind !== "other") throw witError("invalid-argument", "only `other` events can be triggered by a plugin");
			let name: unknown;
			try {
				name = ev.options ? JSON.parse(ev.options).name : undefined;
			} catch {
				// handled below
			}
			if (typeof name !== "string" || !name) throw witError("invalid-argument", 'options must be JSON with a "name"');
			if (!OBJECT_TYPES.includes(ev.object)) throw witError("invalid-argument", `unknown object type ${ev.object}`);
			getHub(ctx).trigger(ctx.pluginId, { object: ev.object, ids: ev.ids ?? [], options: ev.options });
		},
	},
	resources: {
		"subscription-guard": {
			methods: {},
			drop(ctx, self: { plugin: string } | undefined) {
				guarded.delete(self?.plugin ?? ctx.pluginId);
				hub?.dropPlugin(self?.plugin ?? ctx.pluginId);
			},
		},
	},
});
