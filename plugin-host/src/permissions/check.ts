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
import { isPrivateHost, parseHostEntry } from "./risk";

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

export interface NetHostMatch {
	/** The granted entry that allows the URL. */
	entry: string;
	/** The URL's host is a loopback, private or link-local literal (the entry named it exactly). A name that resolves to such an address must be rechecked after DNS. */
	privateHost: boolean;
}

/**
 * Static part of the `net.hosts` rule (lifecycle.wit, interface net): does a granted entry allow this URL? Scheme defaults to https
 * (http only when the entry says so), `*.` matches subdomains (not the bare domain), "*" matches any public host over https, and
 * loopback or private literals need an entry that names that host (and port) exactly. Returns undefined when none matches.
 * The caller still has to refuse Zinc's own port and 23119/23120, and check DNS results and every redirect again.
 */
export function matchNetHost(entries: readonly string[], url: string): NetHostMatch | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
	const scheme = u.protocol === "https:" ? "https" : "http";
	const port = u.port ? Number(u.port) : scheme === "https" ? 443 : 80;
	const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const priv = isPrivateHost(host);
	for (const entry of entries) {
		let p;
		try {
			p = parseHostEntry(entry);
		} catch {
			continue;
		}
		if (p.scheme !== scheme) continue;
		if (p.any) {
			if (!priv) return { entry, privateHost: false };
			continue;
		}
		if (p.port !== undefined ? p.port !== port : port !== (scheme === "https" ? 443 : 80)) continue;
		if (p.subdomains) {
			if (!priv && host.endsWith("." + p.host)) return { entry, privateHost: false };
		} else if (host === p.host) return { entry, privateHost: priv };
	}
	return undefined;
}

/** Throws `permission-denied("net.hosts")` unless a granted entry allows the URL. Returns the match. */
export function requireNetHost(ctx: PermissionContext, url: string): NetHostMatch {
	const m = matchNetHost(ctx.grants.netHosts, url);
	if (!m) throw new WitError("permission-denied", "net.hosts");
	return m;
}
