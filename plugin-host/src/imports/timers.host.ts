// The clock half of `timers` (lifecycle.wit): now, monotonic-ms, sleep. They need no state, so they run in the plugin host process and
// cost no IPC round trip. `set-timeout`, `set-interval`, `request-idle` and `clear` are in timers.zinc.ts (they call back into the plugin).
import { defineHandler } from "./registry";

const t0 = performance.now();

export default defineHandler({
	interface: "zinc:plugin/timers",
	where: "host",
	functions: {
		now() {
			return BigInt(Date.now());
		},
		"monotonic-ms"() {
			return BigInt(Math.floor(performance.now() - t0));
		},
		async sleep(_ctx, ms: number) {
			// The plugin's time budget does not run while a host import waits, so a long sleep never gets a plugin killed.
			await Bun.sleep(Math.max(0, Math.min(ms, 3_600_000)));
		},
	},
});
