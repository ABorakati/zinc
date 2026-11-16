// Proxied URL -> the publisher's own URL, as Zotero stores it. The extension sends the proxy that served the page
// with each save (payload.proxy = {toProperScheme | scheme, hosts, ...}); Zotero's ItemSaver turns item and
// attachment URLs back into proper ones with Zotero.Proxy.toProper. Port of that (zotero-connectors
// src/common/proxy.js: compileRegexp + toProper), so saved URLs match what Zotero would save.

/** URL contents matched by each scheme parameter. */
const PARAM_RE: Record<string, string> = {
	"%p": "(.*?)", // path
	"%h": "([a-zA-Z0-9]+[.\\-][a-zA-Z0-9.\\-]+)", // hostname
	"%u": "(.*?)", // url
};
/** The parameter in the scheme string (not escaped as %%p). */
const PARAM_IN_SCHEME: Record<string, RegExp> = { "%p": /([^%])%p/, "%h": /([^%])%h/, "%u": /([^%])%u/ };

/** Zotero.Utilities.quotemeta: escapes regexp syntax but not "%", so the scheme's %h / %p survive. */
const quotemeta = (s: string) => s.replace(/([.\\+*?[^\]$(){}=!<>|:\-])/g, "\\$1");

export interface ProxyInfo {
	/** e.g. "%h.ezproxy.kcl.ac.uk/%p" */
	scheme: string;
	hosts: string[];
}

/** The proxy JSON the extension sends, or null if it isn't one. */
export function proxyFrom(raw: unknown): ProxyInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as { toProperScheme?: unknown; scheme?: unknown; hosts?: unknown };
	const scheme =
		typeof o.toProperScheme === "string" && o.toProperScheme.trim()
			? o.toProperScheme.trim()
			: typeof o.scheme === "string"
				? o.scheme.trim()
				: "";
	if (!scheme || !/%[hpu]/.test(scheme)) return null;
	return { scheme, hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === "string") : [] };
}

function compile(scheme0: string): { re: RegExp; params: string[]; indices: Record<string, number> } {
	let scheme = scheme0;
	const indices: Record<string, number> = {};
	const params: string[] = [];
	for (const param of Object.keys(PARAM_RE)) {
		let index = scheme.indexOf(param);
		// an escaped %%p is a literal: drop the escape and look further
		while (index > 0 && scheme[index - 1] === "%") {
			scheme = scheme.slice(0, index - 1) + scheme.slice(index);
			index = scheme.indexOf(param, index + 1);
		}
		if (index !== -1) {
			indices[param] = index;
			params.push(param);
		}
	}
	params.sort((a, b) => indices[a]! - indices[b]!);
	let re = scheme.includes("://") ? "^" + quotemeta(scheme) + "$" : "^https?" + quotemeta("://" + scheme) + "$";
	for (let i = params.length - 1; i >= 0; i--) {
		const p = params[i]!;
		re = re.replace(PARAM_IN_SCHEME[p]!, (_m, before) => before + PARAM_RE[p]);
	}
	return { re: new RegExp(re), params, indices };
}

/** `url` with the proxy taken off (unchanged when it isn't a URL of this proxy). */
export function toProper(proxy: ProxyInfo | null, url: string): string {
	if (!proxy || !url) return url;
	let href: string;
	try {
		href = new URL(url).href;
	} catch {
		return url;
	}
	const { re, params, indices } = compile(proxy.scheme);
	const m = re.exec(href);
	if (!m) return url;
	const protocol = m[0].startsWith("https") ? "https://" : "http://";
	const hostIdx = params.indexOf("%h");
	let proper: string;
	if (hostIdx !== -1) proper = protocol + m[hostIdx + 1] + "/";
	else if (proxy.hosts[0]) proper = protocol + proxy.hosts[0] + "/";
	else return url;
	// EZproxy "HttpsHyphens": on https the publisher's dots are written as dashes (www-nature-com.ezproxy...)
	if (protocol === "https://" || !proper.includes(".")) proper = proper.replace(/-/g, ".");
	if (indices["%p"] !== undefined) proper += m[params.indexOf("%p") + 1] ?? "";
	return proper;
}
