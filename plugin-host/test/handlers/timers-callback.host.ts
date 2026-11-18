// A `where: "host"` handler that calls back into the plugin with ctx.callExport (as the notifier handler does). The call travels host
// process -> Zinc -> the supervisor's per-plugin queue -> the plugin.
import { defineHandler } from "../../src/imports/registry";

export default defineHandler({
	interface: "zinc:plugin/timers",
	where: "host",
	functions: {
		"set-timeout"(ctx, ms: number) {
			setTimeout(() => void ctx.callExport("events", "on-timer", [7, "timeout"]).catch((e) => ctx.log("error", `callExport failed: ${e}`)), ms + 10);
			return 7;
		},
	},
});
