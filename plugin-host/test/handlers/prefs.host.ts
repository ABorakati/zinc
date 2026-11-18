// A `where: "host"` handler for the tests: it runs inside the plugin host process. It answers `prefs.get` from the manifest's
// default_prefs and tags string values with the host pid, so a test can see which process answered.
import { defineHandler } from "../../src/imports/registry";

export default defineHandler({
	interface: "zinc:plugin/prefs",
	where: "host",
	functions: {
		get(ctx, key: string) {
			const v = ctx.manifest.default_prefs?.[key];
			if (typeof v === "boolean") return { tag: "flag", val: v };
			if (typeof v === "number") return { tag: "integer", val: v };
			if (typeof v === "string") return { tag: "text", val: `${v}-from-host-${process.pid}` };
			return undefined;
		},
	},
});
