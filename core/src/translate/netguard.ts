// Where a request may go: one classifier for private and local destinations, DNS that is checked and then pinned, and a fetch
// that follows redirects only to public hosts. Used by the plugin `net` handler (plugin-host), by the `net.hosts` matcher and risk
// tier, and by Add from URL when a plugin asks for it (`publicOnly`): the translator runtime and attachment downloads call it
// for every request and every redirect hop of that job. Nothing here knows about plugins or Zotero; it only knows addresses.
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/** `blocked`: the destination is not allowed. `dns`: the name did not resolve. */
export class NetBlockedError extends Error {
	constructor(
		public readonly code: "blocked" | "dns",
		message: string,
	) {
		super(message);
		this.name = "NetBlockedError";
	}
}

// ------------------------------------------------------------------------------------------------ names and literals

/** Lower case, no brackets, no trailing dots: the form every comparison below uses. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

export function parseIPv4(s: string): number[] | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return undefined;
	const out = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return out.every((n) => n <= 255) && !/(^|\.)0\d/.test(s) ? out : undefined;
}

/** 16 bytes, or undefined. Accepts "::" compression, a dotted IPv4 tail and a %zone (ignored). */
export function parseIPv6(input: string): number[] | undefined {
	let s = input.replace(/%.*$/, "");
	if (!s.includes(":")) return undefined;
	const dot = s.lastIndexOf(".");
	if (dot >= 0) {
		const c = s.lastIndexOf(":");
		const v4 = parseIPv4(s.slice(c + 1));
		if (!v4) return undefined;
		s = `${s.slice(0, c + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const groups = (p: string) => (p === "" ? [] : p.split(":"));
	const head = groups(halves[0]!);
	const tail = halves.length === 2 ? groups(halves[1]!) : [];
	const fill = 8 - head.length - tail.length;
	if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
	const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
	const out: number[] = [];
	for (const g of all) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
		const n = parseInt(g, 16);
		out.push(n >> 8, n & 255);
	}
	return out;
}

export function isIpLiteral(host: string): boolean {
	const h = normalizeHost(host);
	return h.includes(":") || parseIPv4(h) !== undefined;
}

/** The last label looks like a number ("0.0.1", "0x7f", "2130706433"): the URL parser would read the host as an address. */
export function isNumericLike(host: string): boolean {
	return /^(\d+|0x[0-9a-f]*)$/i.test(normalizeHost(host).split(".").pop() ?? "");
}

export function isPrivateName(host: string): boolean {
	const h = normalizeHost(host);
	return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal");
}

// ------------------------------------------------------------------------------------------------ classification

function privateV4(b: number[]): boolean {
	const [a, c, d] = [b[0]!, b[1]!, b[2]!];
	return (
		a === 0 || // "this network", includes 0.0.0.0
		a === 10 ||
		a === 127 ||
		(a === 100 && c >= 64 && c <= 127) || // carrier-grade NAT
		(a === 169 && c === 254) ||
		(a === 172 && c >= 16 && c <= 31) ||
		(a === 192 && c === 168) ||
		(a === 192 && c === 0 && d === 0) || // IETF protocol assignments
		(a === 198 && (c === 18 || c === 19)) || // benchmarking
		a >= 224 // multicast, reserved, broadcast
	);
}

/** The IPv4 address an IPv6 address carries: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), SIIT, NAT64 64:ff9b::/96 and 6to4. */
export function embeddedV4(b: number[]): number[] | undefined {
	const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
	if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
	if (zero(0, 12)) return b.slice(12);
	if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return b.slice(12);
	if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12);
	if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
	return undefined;
}

function privateV6(b: number[]): boolean {
	const v4 = embeddedV4(b);
	if (v4) return privateV4(v4);
	if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
	if (b[0] === 0xfe && (b[1]! & 0x80) !== 0) return true; // fe80::/10 link-local and fec0::/10 site-local
	if (b[0] === 0xff) return true; // multicast
	if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
	if (b[0] === 1 && b.slice(1, 8).every((x) => x === 0)) return true; // 100::/64 discard-only
	return false;
}

/** An address literal (as DNS answers or the URL parser give it) in a non-global range. Anything that does not parse counts as private. */
export function isPrivateAddress(address: string): boolean {
	const h = normalizeHost(address);
	const v4 = parseIPv4(h);
	if (v4) return privateV4(v4);
	const v6 = parseIPv6(h);
	return v6 ? privateV6(v6) : true;
}

/** A host as written in a URL or a rule: a private name, a private address, or a number-like name that cannot be told from one. */
export function isPrivateHost(host: string): boolean {
	const h = normalizeHost(host);
	if (h.includes(":")) return isPrivateAddress(h);
	if (isPrivateName(h)) return true;
	const v4 = parseIPv4(h);
	if (v4) return privateV4(v4);
	return isNumericLike(h);
}

/** 127/8, 0/8 and ::1 / :: in any spelling: connects to this machine. */
export function isLoopbackOrUnspecified(address: string): boolean {
	const h = normalizeHost(address);
	const b = parseIPv4(h) ?? embeddedV4(parseIPv6(h) ?? Array(16).fill(1));
	return !!b && (b[0] === 127 || b[0] === 0);
}

const keyOf = (b: number[], v6: boolean) => (v6 ? "6:" : "4:") + b.map((x) => x.toString(16).padStart(2, "0")).join("");
function addressKeys(address: string): string[] {
	const h = normalizeHost(address);
	const v4 = parseIPv4(h);
	if (v4) return [keyOf(v4, false)];
	const v6 = parseIPv6(h);
	if (!v6) return [];
	const inner = embeddedV4(v6);
	return inner ? [keyOf(v6, true), keyOf(inner, false)] : [keyOf(v6, true)];
}

/** One of this machine's own interface addresses (in any v4-in-v6 spelling). */
export function isOwnAddress(address: string): boolean {
	const mine = new Set<string>();
	for (const list of Object.values(networkInterfaces()))
		for (const i of list ?? []) for (const k of addressKeys(i.address)) mine.add(k);
	return addressKeys(address).some((k) => mine.has(k));
}

// ------------------------------------------------------------------------------------------------ DNS

/** Every address a name has. Injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
let resolver: Resolver = systemResolver;
/** Test hook: replace DNS for this process. No argument restores the system resolver. */
export function setNetResolver(r?: Resolver): void {
	resolver = r ?? systemResolver;
}

/** The addresses to connect to for a host: the literal itself, or what DNS answers. Throws NetBlockedError("dns"). */
export async function resolveAddresses(host: string): Promise<string[]> {
	const h = normalizeHost(host);
	if (isIpLiteral(h)) return [h];
	let out: string[];
	try {
		out = await resolver(h);
	} catch (e) {
		throw new NetBlockedError("dns", (e as Error).message);
	}
	if (!out.length) throw new NetBlockedError("dns", `${h} has no address`);
	return out;
}

/** Throws unless every address of the host is public and none is one of this machine's own. Returns the addresses. */
export async function resolvePublic(host: string): Promise<string[]> {
	const h = normalizeHost(host);
	if (isPrivateName(h)) throw new NetBlockedError("blocked", `${h} is a local name`);
	const addrs = await resolveAddresses(h);
	for (const a of addrs) {
		if (isPrivateAddress(a)) throw new NetBlockedError("blocked", `${h} is, or resolves to, a private or local address`);
		if (isOwnAddress(a)) throw new NetBlockedError("blocked", `${h} resolves to an address of this machine`);
	}
	return addrs;
}

// ------------------------------------------------------------------------------------------------ connecting

/**
 * The request for one checked address. A name is replaced by that address in the URL, so the connection goes where the check
 * looked, with the original `Host` header; for https `tls.serverName` makes the certificate (and SNI) be checked against the
 * original name instead of the address (Bun 1.4.4 verifies the certificate against `serverName`: a different name fails with
 * ERR_TLS_CERT_ALTNAME_INVALID). An address literal in the URL is used as it is.
 */
export function pinned(url: URL, address: string): { url: URL; host?: string; serverName?: string } {
	const h = normalizeHost(url.hostname);
	if (isIpLiteral(h)) return { url };
	const u = new URL(url.href);
	u.hostname = address.includes(":") ? `[${address.replace(/%.*$/, "")}]` : address;
	return { url: u, host: url.host, serverName: url.protocol === "https:" ? h : undefined };
}

const CONNECT_FAILURE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ConnectionRefused|Unable to connect|FailedToOpenSocket/i;

/** fetch(url) where the connection goes to one of `addresses`, in order, moving on only when a connection cannot be made. */
export async function fetchPinned(url: URL, addresses: readonly string[], init: RequestInit): Promise<Response> {
	let last: unknown;
	for (const address of addresses) {
		const p = pinned(url, address);
		const headers = new Headers(init.headers);
		if (p.host) headers.set("Host", p.host);
		try {
			const tls = p.serverName ? { tls: { ...(init as { tls?: object }).tls, serverName: p.serverName } } : {};
			return await fetch(p.url, { ...init, headers, ...tls } as RequestInit);
		} catch (e) {
			last = e;
			const err = e as { code?: string; message?: string };
			if (init.signal?.aborted || !CONNECT_FAILURE.test(`${err?.code ?? ""} ${err?.message ?? ""}`)) throw e;
		}
	}
	throw last;
}

/** Headers that must not follow a redirect to another origin. */
export const CROSS_ORIGIN_STRIP = /^(authorization|cookie|proxy-authorization)$/i;

const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * fetch() for public hosts only: every hop is resolved, checked, pinned, and redirects are followed here (at most `maxRedirects`).
 * Authorization and Cookie headers are dropped when a redirect leaves the origin.
 */
export async function fetchPublic(input: string | URL, init: RequestInit = {}, maxRedirects = 10): Promise<Response> {
	let url = new URL(input);
	let method = init.method ?? "GET";
	let body = init.body;
	const headers = new Headers(init.headers);
	for (let hop = 0; ; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetBlockedError("blocked", `scheme ${url.protocol} is not allowed`);
		const addrs = await resolvePublic(url.hostname);
		const res = await fetchPinned(url, addrs, { ...init, method, body, headers, redirect: "manual" });
		const loc = res.headers.get("location");
		if (!loc || !REDIRECTS.includes(res.status) || init.redirect === "manual") return res;
		if (hop >= maxRedirects) {
			void res.body?.cancel();
			throw new Error("too many redirects");
		}
		void res.body?.cancel();
		const next = new URL(loc, url);
		if (next.origin !== url.origin) for (const k of [...headers.keys()]) if (CROSS_ORIGIN_STRIP.test(k)) headers.delete(k);
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
			method = method === "HEAD" ? "HEAD" : "GET";
			body = undefined;
		}
		url = next;
	}
}
