// `permissions` (lifecycle.wit): ask what the plugin may do, and ask for an optional permission. `request` goes to the prompt the app
// registered (`createPluginRuntime({ prompt })`, the ui area's `where: "zinc"` dialog); without one it returns `unavailable`.
import { defineHandler } from "./registry";
import { getServices } from "../package/services";
import { listPermissions, permissionState } from "../permissions/store";

export default defineHandler({
	interface: "zinc:plugin/permissions",
	where: "zinc",
	functions: {
		check: (ctx, permission: string) => permissionState(ctx.manifest, ctx.grants, permission),
		"list-permissions": (ctx) => listPermissions(ctx.manifest, ctx.grants),
		async request(ctx, permission: string, reason: unknown) {
			return getServices().permissions.request(ctx.manifest, ctx.grants, permission, reason);
		},
	},
});
