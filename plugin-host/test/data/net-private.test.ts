// The net.hosts rule: one classifier for private/local addresses, one matcher, and the real `net` handler against throw-away
// servers. Blocked cases must leave the servers with zero hits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import net from "../../src/imports/net.host";
import translate from "../../src/imports/translate.host";
import { setNetResolver } from "../../../core/src/translate/netguard";
import { isPrivateHost as isPrivateRisk, netHostTier, permissionTier } from "../../src/permissions/risk";
import { matchNetHost } from "../../src/permissions/check";
import { isPrivateHost, netHostAllowed } from "../../src/imports/data/nethosts";
import { call, failure, fakeCtx, manifestOf } from "./core-fixture";

const PRIVATE_HOSTS = [
	// IPv4 non-global ranges
	"0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.9", "169.254.169.254",
	"172.16.0.1", "172.31.255.255", "192.0.0.8", "192.168.1.1", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.250",
	"240.0.0.1", "255.255.255.255",
	// IPv6 and the v4 forms embedded in it, dotted or hex
	"::", "::1", "fc00::1", "fd12::1", "fe80::1", "febf::1", "fec0::1", "feff::1", "ff02::1", "[::1]", "[fe80::1]",
	"::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
	"::127.0.0.1", "::7f00:1", "::10.0.0.1",
	"64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::a00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2002:0a00:0001::",
	"::ffff:0:7f00:1", "0:0:0:0:0:ffff:7f00:1",
	// names
	"localhost", "LOCALHOST", "localhost.", "foo.localhost", "foo.localhost.", "printer.local", "printer.local.", "svc.internal", "svc.internal.",
	// numeric-looking names that are not clean addresses fail closed
	"0.0.1", "254.169.254",
];
const PUBLIC_HOSTS = [
	"8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "198.17.255.255", "198.20.0.0",
	"223.255.255.255", "2606:4700::1111", "2001:db8::1", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1",
	"example.com", "api.example.org", "notlocalhost", "localhost.example.com", "example.internal.com", "xn--bcher-kva.example",
];

describe("private-address classifier (one implementation for net, translate.web, matchNetHost and the risk tier)", () => {
	for (const h of PRIVATE_HOSTS) test(`private: ${h}`, () => {
		expect(isPrivateHost(h)).toBe(true);
		expect(isPrivateRisk(h)).toBe(true);
	});
	for (const h of PUBLIC_HOSTS) test(`public: ${h}`, () => {
		expect(isPrivateHost(h)).toBe(false);
		expect(isPrivateRisk(h)).toBe(false);
	});
});

describe("allowlist matcher", () => {
	const allowed = (hosts: string[], url: string) => netHostAllowed(hosts, new URL(url));
	const cases: [string[], string, boolean][] = [
		// "*": public hosts over https only
		[["*"], "https://example.com/x", true],
		[["*"], "https://8.8.8.8/x", true],
		[["*"], "http://example.com/x", false],
		[["*"], "http://8.8.8.8/x", false],
		[["*"], "https://127.0.0.1/", false],
		[["*"], "https://[::1]/", false],
		[["*"], "https://[::ffff:127.0.0.1]/", false],
		[["*"], "https://[::ffff:7f00:1]/", false],
		[["*"], "https://[64:ff9b::7f00:1]/", false],
		[["*"], "https://[2002:7f00:1::]/", false],
		[["*"], "https://[fd00::1]/", false],
		[["*"], "https://169.254.169.254/latest/meta-data", false],
		[["*"], "https://localhost/", false],
		[["*"], "https://localhost./", false],
		[["*"], "https://app.localhost/", false],
		[["*"], "https://nas.local/", false],
		[["*"], "https://db.internal/", false],
		// wildcards: never an IP literal, never a private name, and a numeric or private suffix grants nothing
		[["*.example.com"], "https://a.example.com/", true],
		[["*.example.com"], "https://a.b.example.com/", true],
		[["*.example.com"], "https://example.com/", false],
		[["*.example.com"], "https://127.0.0.1/", false],
		[["http://*.0.0.1:8080"], "http://127.0.0.1:8080/", false],
		[["http://*.0.0.1:8080"], "http://10.0.0.1:8080/", false],
		[["*.0.0.1"], "https://127.0.0.1/", false],
		[["*.254.169.254"], "https://169.254.169.254/", false],
		[["*.168.1.1"], "https://192.168.1.1/", false],
		[["*.8.8"], "https://8.8.8.8/", false],
		[["*.localhost"], "https://a.localhost/", false],
		[["*.local"], "https://a.local/", false],
		[["*.internal"], "https://a.internal/", false],
		[["http://*.localhost:3000"], "http://a.localhost:3000/", false],
		// exact private entries: host and port both named (the default port of the scheme counts)
		[["http://localhost:11434"], "http://localhost:11434/api", true],
		[["http://localhost:11434"], "http://localhost:11435/api", false],
		[["http://localhost:11434"], "https://localhost:11434/api", false],
		[["http://localhost:11434"], "http://127.0.0.1:11434/api", false],
		[["http://localhost:11434"], "http://localhost.:11434/api", true],
		[["http://127.0.0.1"], "http://127.0.0.1:80/", true],
		[["http://127.0.0.1"], "http://127.0.0.1:8080/", false],
		[["https://localhost"], "https://localhost:443/", true],
		[["localhost:3000"], "http://localhost:3000/", false],
		[["localhost:3000"], "https://localhost:3000/", true],
		[["http://10.1.2.3:9000"], "http://10.1.2.3:9000/", true],
		// ordinary exact entries
		[["example.org"], "http://example.org/", false],
		[["http://example.org"], "http://example.org/", true],
		[["https://example.org:8443"], "https://example.org:8443/", true],
		[["https://example.org:8443"], "https://example.org/", false],
		[["example.org"], "https://example.org./", true],
		[["not a host", "also/bad"], "https://example.org/", false],
	];
	for (const [hosts, url, want] of cases) test(`${JSON.stringify(hosts)} ${want ? "allows" : "refuses"} ${url}`, () => {
		expect(allowed(hosts, url)).toBe(want);
		// matchNetHost is the same rule
		expect(matchNetHost(hosts, url) !== undefined).toBe(want);
	});

	test("matchNetHost says whether the destination is private", () => {
		expect(matchNetHost(["http://localhost:11434"], "http://localhost:11434/api")).toEqual({ entry: "http://localhost:11434", privateHost: true });
		expect(matchNetHost(["*.example.com"], "https://a.example.com/")).toEqual({ entry: "*.example.com", privateHost: false });
		expect(matchNetHost(["*"], "https://example.com/")).toEqual({ entry: "*", privateHost: false });
	});
});

describe("risk tier", () => {
	test("high for anything that can mean a private destination, and for wildcards that grant nothing", () => {
		for (const e of ["*", "*.0.0.1", "http://*.0.0.1:8080", "*.254.169.254", "*.168.1.1", "*.localhost", "*.local", "*.internal", "*.internal.", "http://*.localhost:3000",
			"http://localhost:11434", "127.0.0.1", "http://10.1.2.3:9000", "https://169.254.169.254", "0.0.0.0", "http://0x7f.1:8080", "2130706433", "printer.local", "http://localhost.:80"])
			expect([e, netHostTier(e)]).toEqual([e, "high"]);
		for (const e of ["https://api.openalex.org", "*.crossref.org", "api.example.org:8443", "8.8.8.8", "*.example.localhost.example.com"]) expect([e, netHostTier(e)]).toEqual([e, "medium"]);
		expect(permissionTier("net.hosts:*.0.0.1")).toBe("high");
		expect(permissionTier("net.hosts:*.crossref.org")).toBe("medium");
	});
});

// -------------------------------------------------------------------------------------------- the real handler
interface Hit {
	port: number;
	path: string;
	headers: Record<string, string>;
}
const hits: Hit[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
function start(): { port: number; url: string } {
	const s = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const u = new URL(req.url);
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			hits.push({ port: s.port as number, path: u.pathname, headers });
			if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: u.searchParams.get("to") ?? "/echo" } });
			return new Response("hello");
		},
	});
	servers.push(s);
	return { port: s.port as number, url: `http://127.0.0.1:${s.port}` };
}
let A: { port: number; url: string };
let B: { port: number; url: string };
beforeAll(() => {
	A = start();
	B = start();
});
afterAll(() => servers.forEach((s) => s.stop(true)));
const hitsOn = (port: number) => hits.filter((h) => h.port === port);

const request = (url: string, over: Record<string, unknown> = {}) => ({
	method: "GET", url, headers: [], body: undefined, timeoutMs: undefined, successCodes: undefined, redirect: "follow", credentials: undefined,
	cookies: { tag: "none" }, retry: undefined, bypassCache: false, maxResponseBytes: undefined, cancelKey: undefined, ...over,
});
const ctxOf = (hosts: string[], coreUrl?: string) => fakeCtx(coreUrl ? { url: coreUrl } : undefined, manifestOf({ netHosts: hosts }));

describe("net handler against throw-away servers", () => {
	test("a numeric wildcard does not reach loopback", async () => {
		const before = hitsOn(A.port).length;
		const f = await failure(call(net, ctxOf([`http://*.0.0.1:${A.port}`]), "send", request(`${A.url}/echo`)));
		expect(f).toMatchObject({ tag: "blocked" });
		expect(hitsOn(A.port).length).toBe(before);
	});

	test('"*" reaches neither loopback nor v4-in-v6 spellings of it, and never plain http', async () => {
		const before = hitsOn(A.port).length;
		for (const url of [`${A.url}/echo`, `http://[::ffff:127.0.0.1]:${A.port}/echo`, `http://[::ffff:7f00:1]:${A.port}/echo`, `https://[::ffff:7f00:1]:${A.port}/echo`, `http://[64:ff9b::7f00:1]:${A.port}/`, `http://[2002:7f00:1::]:${A.port}/`, `http://localhost:${A.port}/echo`, `http://localhost.:${A.port}/echo`, `http://x.localhost:${A.port}/echo`])
			expect([url, await failure(call(net, ctxOf(["*"]), "send", request(url)))]).toEqual([url, expect.objectContaining({ tag: "blocked" })]);
		expect(hitsOn(A.port).length).toBe(before);
	});

	test("a redirect from an exactly listed server to an unlisted one, or to a v4-in-v6 spelling, is stopped at the hop", async () => {
		const before = hitsOn(B.port).length;
		const c = ctxOf([A.url, "*"]);
		for (const to of [`${B.url}/echo`, `http://[::ffff:7f00:1]:${B.port}/echo`, `http://localhost:${B.port}/echo`]) {
			const f = await failure(call(net, c, "send", request(`${A.url}/redirect?to=${encodeURIComponent(to)}`)));
			expect([to, f]).toEqual([to, expect.objectContaining({ tag: "blocked" })]);
		}
		expect(hitsOn(B.port).length).toBe(before);
	});

	test("an exactly listed local server (a model server on http://localhost:<port>) still works", async () => {
		const c = ctxOf([A.url, `http://localhost:${A.port}`]);
		const before = hitsOn(A.port).length;
		expect((await call(net, c, "send", request(`${A.url}/echo`))).status).toBe(200);
		const r = await call(net, c, "send", request(`http://localhost:${A.port}/echo`));
		expect(new TextDecoder().decode(r.body)).toBe("hello");
		expect(hitsOn(A.port).length).toBe(before + 2);
		expect(hitsOn(A.port).at(-1)!.headers.host).toBe(`localhost:${A.port}`);
	});

	test("Zinc's own core port is refused even when the entry names it exactly", async () => {
		// A plays core: ctx.coreUrl points at it, so no spelling of this machine on that port may be reached
		const before = hitsOn(A.port).length;
		const c = ctxOf([A.url, `http://localhost:${A.port}`], A.url);
		for (const url of [`${A.url}/echo`, `http://localhost:${A.port}/echo`]) expect([url, await failure(call(net, c, "send", request(url)))]).toEqual([url, expect.objectContaining({ tag: "blocked" })]);
		expect(hitsOn(A.port).length).toBe(before);
		// another local server on the same plugin still works
		expect((await call(net, ctxOf([A.url, B.url], A.url), "send", request(`${B.url}/echo`))).status).toBe(200);
	});

	test("an Authorization header and credentials do not follow a redirect to another origin; a same-origin redirect keeps them", async () => {
		const c = ctxOf([A.url, B.url]);
		const headers = [{ name: "Authorization", value: "Bearer secret" }, { name: "X-Mine", value: "1" }];
		await call(net, c, "send", request(`${A.url}/redirect?to=${encodeURIComponent(B.url + "/echo")}`, { headers, credentials: { username: "u", password: "p" } }));
		const first = hitsOn(A.port).at(-1)!;
		const second = hitsOn(B.port).at(-1)!;
		expect(first.headers.authorization).toBe("Basic " + btoa("u:p")); // `credentials` wins over a header of the same name
		expect(second.path).toBe("/echo");
		expect(second.headers.authorization).toBeUndefined();
		expect(second.headers["x-mine"]).toBe("1");
		// credentials alone
		await call(net, c, "send", request(`${A.url}/redirect?to=${encodeURIComponent(B.url + "/echo")}`, { credentials: { username: "u", password: "p" } }));
		expect(hitsOn(A.port).at(-1)!.headers.authorization).toBe("Basic " + btoa("u:p"));
		expect(hitsOn(B.port).at(-1)!.headers.authorization).toBeUndefined();
		// same origin
		await call(net, c, "send", request(`${A.url}/redirect?to=/echo`, { headers, credentials: undefined }));
		expect(hitsOn(A.port).at(-1)!.path).toBe("/echo");
		expect(hitsOn(A.port).at(-1)!.headers.authorization).toBe("Bearer secret");
	});
});

// ------------------------------------------------------------------------------- DNS: every address, every hop, then pinned
describe("DNS", () => {
	const answers: Record<string, string[]> = {};
	beforeAll(() => setNetResolver(async (h) => answers[h] ?? Promise.reject(new Error("ENOTFOUND " + h))));
	afterAll(() => setNetResolver());

	test("a name that resolves to a private address is refused unless it is itself a private name, even when listed exactly", async () => {
		answers["rebind.example"] = ["127.0.0.1"];
		answers["mixed.example"] = ["93.184.216.34", "10.0.0.7"];
		const before = hitsOn(A.port).length;
		for (const [host, entries] of [["rebind.example", [`http://rebind.example:${A.port}`]], ["rebind.example", ["*.example"]], ["mixed.example", [`http://mixed.example:${A.port}`]]] as const)
			expect([host, await failure(call(net, ctxOf([...entries]), "send", request(`http://${host}:${A.port}/echo`)))]).toEqual([host, expect.objectContaining({ tag: "blocked" })]);
		expect(await failure(call(net, ctxOf(["*"]), "send", request("https://rebind.example/")))).toMatchObject({ tag: "blocked" });
		expect(hitsOn(A.port).length).toBe(before);
	});

	test("a listed private name connects to the address that was checked, with the name in Host", async () => {
		answers["files.internal"] = ["127.0.0.1"];
		const before = hitsOn(A.port).length;
		const r = await call(net, ctxOf([`http://files.internal:${A.port}`]), "send", request(`http://files.internal:${A.port}/echo`));
		expect(r.status).toBe(200);
		expect(hitsOn(A.port).length).toBe(before + 1);
		expect(hitsOn(A.port).at(-1)!.headers.host).toBe(`files.internal:${A.port}`);
	});

	test("the check and the connection use one answer: a name that turns private after the check is not followed", async () => {
		let n = 0;
		setNetResolver(async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]));
		const dialled: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => (dialled.push(`${input} ${new Headers(init?.headers).get("host")}`), new Response("ok"))) as typeof fetch;
		try {
			expect((await call(net, ctxOf(["*"]), "send", request("https://flip.example/x"))).status).toBe(200);
			expect(dialled).toEqual(["https://93.184.216.34/x flip.example"]);
			expect(n).toBe(1);
		} finally {
			globalThis.fetch = realFetch;
			setNetResolver(async (h) => answers[h] ?? Promise.reject(new Error("ENOTFOUND " + h)));
		}
	});

	test("every hop is resolved again: a public hop that redirects to a name resolving private is refused", async () => {
		answers["hop1.example"] = ["93.184.216.34"];
		answers["hop2.example"] = ["192.168.1.9"];
		const dialled: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => (dialled.push(String(input)), String(input).includes("93.184") ? new Response(null, { status: 302, headers: { Location: "https://hop2.example/in" } }) : new Response("inside"))) as typeof fetch;
		try {
			expect(await failure(call(net, ctxOf(["*"]), "send", request("https://hop1.example/")))).toMatchObject({ tag: "blocked" });
			expect(dialled).toEqual(["https://93.184.216.34/"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("Zinc's core port and 23119/23120 are refused on this machine's own address too, by name or literal", async () => {
		const own = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((i) => i.family === "IPv4")?.address;
		answers["box.internal"] = [own ?? "127.0.0.1"];
		answers.localhost = ["::1", "127.0.0.1"];
		// nothing is contacted: the refusal comes before any connection
		for (const port of [23119, 23120]) {
			for (const host of ["127.0.0.1", "localhost", "box.internal"])
				expect([port, host, await failure(call(net, ctxOf([`http://${host}:${port}`]), "send", request(`http://${host}:${port}/`)))]).toEqual([port, host, expect.objectContaining({ tag: "blocked" })]);
		}
		expect(await failure(call(net, ctxOf([`http://box.internal:${A.port}`], A.url), "send", request(`http://box.internal:${A.port}/`)))).toMatchObject({ tag: "blocked" });
	});
});

// ------------------------------------------------------------------------------------------------- translate.web
describe("translate.web", () => {
	const bodies: any[] = [];
	let core: ReturnType<typeof Bun.serve>;
	beforeAll(() => {
		core = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				bodies.push({ path: new URL(req.url).pathname, ...(await req.json()) });
				return Response.json({ items: [{ key: "ABCD1234" }] });
			},
		});
	});
	afterAll(() => core.stop(true));
	const tctx = (hosts: string[]) => fakeCtx({ url: `http://127.0.0.1:${core.port}` }, manifestOf({ netHosts: hosts, capabilities: ["library.translate", "library.write"] }));
	const web = (url: string) => ({ url, library: undefined, collection: undefined, attachments: true, translator: undefined });

	test("asks core for a public-only job (also for the later select) and never passes a private destination, listed or not", async () => {
		bodies.length = 0;
		expect(await call(translate, tctx(["*"]), "web", web("https://public.example/article"))).toEqual({ tag: "saved", val: ["ABCD1234"] });
		await call(translate, tctx(["*"]), "web-select", "sess", ["1"], undefined);
		expect(bodies.map((b) => [b.path, b.publicOnly])).toEqual([["/api/translate/web", true], ["/api/translate/web/select", true]]);
		bodies.length = 0;
		for (const [hosts, url] of [[["*"], A.url + "/x"], [["*"], "https://[::ffff:7f00:1]/x"], [["*"], "http://public.example/x"], [["*.0.0.1"], "https://127.0.0.1/x"], [[A.url], A.url + "/x"], [["http://localhost:80"], "http://localhost/x"]] as const)
			expect([url, await failure(call(translate, tctx([...hosts]), "web", web(url)))]).toEqual([url, expect.objectContaining({ tag: "permission-denied" })]);
		expect(bodies).toEqual([]);
	});
});
