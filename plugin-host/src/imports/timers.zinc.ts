// The callback half of `timers` (lifecycle.wit): set-timeout, set-interval, request-idle, clear. The clock functions are in
// timers.host.ts. A fired timer calls `events.on-timer`; every timer is cancelled when the plugin stops (package/services.ts `cleanup`).
import { defineHandler } from "./registry";
import { getServices } from "../package/services";

const u32 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

export default defineHandler({
	interface: "zinc:plugin/timers",
	where: "zinc",
	functions: {
		"set-timeout"(ctx, ms: number) {
			return getServices().timers.setTimeout(ctx.pluginId, u32(ms));
		},
		"set-interval"(ctx, ms: number) {
			return getServices().timers.setInterval(ctx.pluginId, u32(ms));
		},
		"request-idle"(ctx, deadlineMs: number) {
			return getServices().timers.requestIdle(ctx.pluginId, u32(deadlineMs));
		},
		clear(ctx, timer: number) {
			getServices().timers.clear(ctx.pluginId, timer);
		},
	},
});
