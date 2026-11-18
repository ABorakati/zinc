// `log` (lifecycle.wit). Lines get the plugin id (the supervisor's "log" event carries it), pass the limits of package/log-ring.ts (8 KiB a
// line, 200 lines a second, debug only while debug output is on) and land in the ring buffer that Help > Debug Output and Settings > Plugins
// read (`getServices().logs`). No permission.
// NOT DONE: batching. Each call is one IPC message from the host to Zinc, the design's "batched write-back" is a later optimisation.
import { defineHandler } from "./registry";
import { getServices } from "../package/services";
import type { LogLevel } from "../package/log-ring";

const LEVELS = ["error", "warn", "info", "debug"];

export default defineHandler({
	interface: "zinc:plugin/log",
	where: "zinc",
	functions: {
		write(ctx, level: LogLevel, message: string) {
			const logs = getServices().logs;
			const text = logs.accept(ctx.pluginId, LEVELS.includes(level) ? level : "info", String(message));
			if (text !== undefined) {
				if (level === "error") logs.recordError(ctx.pluginId, text);
				ctx.log(level, text);
			}
		},
		"write-error"(ctx, message: string, stack: string | undefined) {
			const logs = getServices().logs;
			const text = logs.accept(ctx.pluginId, "error", stack ? `${message}\n${stack}` : String(message));
			logs.recordError(ctx.pluginId, String(message), stack);
			if (text !== undefined) ctx.log("error", text);
		},
		"debug-enabled"() {
			return getServices().logs.debugEnabled;
		},
	},
});
