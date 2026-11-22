// The manifest's `permissions.net.hosts` allowlist (plugin-api/manifest.schema.json): `scheme://host[:port]`, a leading `*.` in the
// host for subdomains, https assumed without a scheme, `*` for any PUBLIC host over https. Loopback and private destinations must
// be listed exactly (host and port). This is the one place that parses an entry and matches it to a URL: `net`, `translate.web`,
// `matchNetHost` (permissions/check.ts) and the risk tier (permissions/risk.ts) all come here. What counts as a private address is
// decided by core/src/translate/netguard.ts, which Add from URL uses too.
import { isIpLiteral, isPrivateHost, normalizeHost } from "../../../../core/src/translate/netguard";

export { isPrivateHost };

export interface ParsedHostEntry {
	scheme: "http" | "https";
	/** Lower case, no "*.", no brackets, no trailing dot; an exact entry is in the URL parser's form ("0x7f.1" is "127.0.0.1"). Empty when `any`. */
	host: string;
	port: number | undefined;
	/** The entry started with "*.": any subdomain. */
	subdomains: boolean;
	/** The entry is "*": any public host (https). */
	any: boolean;
}

export function parseHostEntry(entry: string): ParsedHostEntry {
	if (entry === "*") return { scheme: "https", host: "", port: undefined, subdomains: false, any: true };
	const m = /^(?:(https?):\/\/)?(\*\.)?([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(entry);
	const port = m?.[4] ? Number(m[4]) : undefined;
	if (!m || (port !== undefined && (port < 1 || port > 65535))) throw new Error(`bad net host entry "${entry}"`);
	let host = normalizeHost(m[3]!);
	if (!m[2]) {
		// the same spelling the URL parser makes of the request's host, so "0x7f.1" and "2130706433" are 127.0.0.1 here too
		try {
			host = normalizeHost(new URL(`http://${host}`).hostname);
		} catch {
			throw new Error(`bad net host entry "${entry}"`);
		}
	}
	if (!host) throw new Error(`bad net host entry "${entry}"`);
	return { scheme: (m[1] as "http" | "https") ?? "https", host, port, subdomains: !!m[2], any: false };
}

/**
 * The entry can only mean a private destination, or (a wildcard) has a private or number-like suffix and so grants nothing:
 * "localhost", "10.0.0.1", "*.0.0.1", "*.internal". The risk tier of such an entry is high.
 */
export function entryIsPrivate(p: ParsedHostEntry): boolean {
	return !p.any && isPrivateHost(p.subdomains ? "x." + p.host : p.host);
}

export interface NetHostMatch {
	/** The granted entry that allows the URL. */
	entry: string;
	/** The URL's host is a loopback, private or link-local literal or name (the entry named it exactly). */
	privateHost: boolean;
}

/**
 * Static part of the `net.hosts` rule: does a granted entry allow this URL? Scheme defaults to https (http only when the entry says
 * so); the port is the entry's or the scheme's default; `*.` matches subdomains (not the bare domain, never an address, never a
 * private name, and an entry whose suffix is a private name or number-like grants nothing); "*" matches any public host over https
 * only; a private destination needs an entry that names that host and port exactly. DNS and redirects are checked by the caller.
 */
export function matchNetHost(entries: readonly string[], input: string | URL): NetHostMatch | undefined {
	let u: URL;
	try {
		u = typeof input === "string" ? new URL(input) : input;
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
	const scheme = u.protocol === "https:" ? "https" : "http";
	const defaultPort = scheme === "https" ? 443 : 80;
	const port = u.port ? Number(u.port) : defaultPort;
	const host = normalizeHost(u.hostname);
	const priv = isPrivateHost(host);
	for (const entry of entries) {
		let p: ParsedHostEntry;
		try {
			p = parseHostEntry(entry);
		} catch {
			continue;
		}
		if (p.any) {
			if (scheme === "https" && !priv) return { entry, privateHost: false };
			continue;
		}
		if (p.scheme !== scheme || (p.port ?? (p.scheme === "https" ? 443 : 80)) !== port) continue;
		if (p.subdomains) {
			if (!priv && !isIpLiteral(host) && !entryIsPrivate(p) && host.endsWith("." + p.host)) return { entry, privateHost: false };
		} else if (host === p.host) return { entry, privateHost: priv };
	}
	return undefined;
}

/** Does the allowlist let the plugin reach `url`? */
export function netHostAllowed(hosts: readonly string[], url: URL): boolean {
	return matchNetHost(hosts, url) !== undefined;
}
