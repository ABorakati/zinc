// `secrets` (lifecycle.wit): per-plugin API keys and tokens, encrypted at rest (package/secrets-store.ts says how, and how that falls
// short of "the OS credential store"). No permission: the plugin id is the namespace, and no other plugin can read these values.
import { defineHandler, witError } from "./registry";
import { getServices } from "../package/services";
import { SecretError } from "../package/secrets-store";

function wrap<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof SecretError) throw witError(e.tag, e.message);
		throw e;
	}
}

export default defineHandler({
	interface: "zinc:plugin/secrets",
	where: "zinc",
	functions: {
		get: (ctx, name: string) => wrap(() => getServices().secrets.get(ctx.pluginId, name)),
		set: (ctx, name: string, value: string) => wrap(() => getServices().secrets.set(ctx.pluginId, name, value)),
		delete: (ctx, name: string) => wrap(() => getServices().secrets.delete(ctx.pluginId, name)),
		"list-names": (ctx) => wrap(() => getServices().secrets.listNames(ctx.pluginId)),
	},
});
