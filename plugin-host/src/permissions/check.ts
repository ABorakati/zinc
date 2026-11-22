// Call-time permission checks, for every handler of every area.
//
//   import { requirePermission } from "../permissions";
//   async read(ctx, key) { requirePermission(ctx, "library.read"); ... }
//
// `requirePermission` throws `error::permission-denied(<id>)` (a WitError, so the plugin gets `result::err`) unless the plugin holds the
// permission right now. It reads the live grants of the context, so a revoke takes effect on the next call. An id that is not in
// the schema is a bug in the handler and fails loudly (`internal`) instead of denying every plugin silently.
import { WitError } from "../imports/registry";
import type { Grants } from "../manifest";
import { isKnownCapability } from "./ids";
import { matchNetHost, type NetHostMatch } from "../imports/data/nethosts";

export { matchNetHost, type NetHostMatch };

/** The part of HandlerContext the checks need. */
export interface PermissionContext {
	readonly grants: Readonly<Grants>;
	has(permission: string): boolean;
}

export function hasPermission(ctx: PermissionContext, id: string): boolean {
	if (!isKnownCapability(id)) throw new WitError("internal", `handler asked for unknown permission id "${id}"`);
	return ctx.has(id);
}

export function requirePermission(ctx: PermissionContext, id: string): void {
	if (!hasPermission(ctx, id)) throw new WitError("permission-denied", id);
}

/** Passes when the plugin holds at least one of the ids. The error names the first. */
export function requireAnyPermission(ctx: PermissionContext, ...ids: string[]): void {
	if (!ids.some((id) => hasPermission(ctx, id))) throw new WitError("permission-denied", ids[0]);
}

/**
 * Throws `permission-denied("net.hosts")` unless a granted entry allows the URL. Returns the match. `matchNetHost` is the static part
 * of the rule (lifecycle.wit, interface net; imports/data/nethosts.ts is the one implementation): the caller still has to refuse
 * Zinc's own port and 23119/23120, and check DNS results and every redirect again.
 */
export function requireNetHost(ctx: PermissionContext, url: string): NetHostMatch {
	const m = matchNetHost(ctx.grants.netHosts, url);
	if (!m) throw new WitError("permission-denied", "net.hosts");
	return m;
}
