// The manifest's `permissions.net.hosts` allowlist (plugin-api/manifest.schema.json): `scheme://host[:port]`, a leading `*.` in the
// host for subdomains, https assumed without a scheme, `*` for any PUBLIC host. Loopback and private hosts must be listed exactly.
import { isIP } from "node:net";

export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	const kind = isIP(h);
	if (kind === 4) {
		const [a, b] = h.split(".").map(Number);
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	if (kind === 6) {
		if (h === "::1" || h === "::") return true;
		if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
		return mapped ? isPrivateHost(mapped[1]) : false;
	}
	return false;
}

interface Rule {
	scheme: "http" | "https";
	host: string;
	wild: boolean;
	port: string | undefined;
}

export function parseRule(entry: string): Rule | "any" | undefined {
	if (entry === "*") return "any";
	const m = /^(?:(https?):\/\/)?(\*\.)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(entry.trim());
	if (!m) return undefined;
	return { scheme: (m[1] as "http" | "https") ?? "https", host: m[3].toLowerCase(), wild: !!m[2], port: m[4] };
}

/** Does the allowlist let the plugin reach `url`? */
export function netHostAllowed(hosts: readonly string[], url: URL): boolean {
	const scheme = url.protocol === "http:" ? "http" : url.protocol === "https:" ? "https" : undefined;
	if (!scheme) return false;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (scheme === "https" ? "443" : "80");
	for (const entry of hosts) {
		const r = parseRule(entry);
		if (!r) continue;
		if (r === "any") {
			if (!isPrivateHost(host)) return true;
			continue;
		}
		if (r.scheme !== scheme) continue;
		const rulePort = r.port ?? (r.scheme === "https" ? "443" : "80");
		if (rulePort !== port) continue;
		if (r.wild ? host.endsWith("." + r.host) : host === r.host) return true;
	}
	return false;
}
