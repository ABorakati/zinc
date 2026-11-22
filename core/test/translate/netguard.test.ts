// core/src/translate/netguard.ts: the private-address classifier, DNS that is checked and then pinned, and the public-only
// fetch. Local throw-away servers only; DNS and the one outgoing fetch are replaced where a public address is needed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchPinned,
	fetchPublic,
	isLoopbackOrUnspecified,
	isOwnAddress,
	isPrivateAddress,
	isPrivateHost,
	NetBlockedError,
	pinned,
	resolvePublic,
	setNetResolver,
} from "../../src/translate/netguard";

/** A throw-away self-signed certificate for the name good.test, made with the openssl on the PATH; undefined when there is none. */
function makeCert(): { cert: string; key: string } | undefined {
	const dir = mkdtempSync(join(tmpdir(), "zn-netguard-"));
	try {
		const r = Bun.spawnSync(
			["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=good.test", "-addext", "subjectAltName=DNS:good.test"],
			{ env: { ...process.env, OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null", MSYS_NO_PATHCONV: "1" }, stdout: "ignore", stderr: "ignore" },
		);
		if (r.exitCode !== 0) return undefined;
		return { cert: readFileSync(join(dir, "c.pem"), "utf8"), key: readFileSync(join(dir, "k.pem"), "utf8") };
	} catch {
		return undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const realFetch = globalThis.fetch;
afterEach(() => {
	setNetResolver();
	globalThis.fetch = realFetch;
});

describe("classifier", () => {
	test("addresses", () => {
		for (const a of ["127.0.0.1", "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "fe80::1%eth0", "10.0.0.1", "not an address"]) expect([a, isPrivateAddress(a)]).toEqual([a, true]);
		for (const a of ["8.8.8.8", "2606:4700::1111", "::ffff:808:808", "64:ff9b::808:808"]) expect([a, isPrivateAddress(a)]).toEqual([a, false]);
	});

	test("loopback and unspecified in every spelling", () => {
		for (const a of ["127.0.0.1", "127.9.9.9", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:0:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::"]) expect([a, isLoopbackOrUnspecified(a)]).toEqual([a, true]);
		for (const a of ["8.8.8.8", "10.0.0.1", "192.168.1.1", "fe80::1", "::ffff:808:808"]) expect([a, isLoopbackOrUnspecified(a)]).toEqual([a, false]);
	});

	test("this machine's own interface addresses, also written as v4-in-v6", () => {
		const mine = Object.values(networkInterfaces()).flatMap((l) => l ?? []).map((i) => i.address);
		expect(mine.length).toBeGreaterThan(0);
		for (const a of mine) {
			expect([a, isOwnAddress(a)]).toEqual([a, true]);
			if (!a.includes(":")) {
				const [p, q, r, s] = a.split(".").map(Number);
				const hex = (x: number, y: number) => ((x << 8) | y).toString(16);
				expect(isOwnAddress(`::ffff:${a}`)).toBe(true);
				expect(isOwnAddress(`::ffff:${hex(p!, q!)}:${hex(r!, s!)}`)).toBe(true);
			}
		}
		expect(isOwnAddress("8.8.8.8")).toBe(false);
	});
});

describe("resolvePublic", () => {
	test("every address must be public; a public answer followed by a private one is refused", async () => {
		const answers: Record<string, string[]> = {
			"pub.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
			"mixed.test": ["93.184.216.34", "127.0.0.1"],
			"mixed6.test": ["93.184.216.34", "::ffff:7f00:1"],
			"private.test": ["10.1.2.3"],
			"empty.test": [],
		};
		setNetResolver(async (h) => {
			const a = answers[h];
			if (!a) throw new Error("ENOTFOUND " + h);
			return a;
		});
		expect(await resolvePublic("pub.test")).toEqual(answers["pub.test"]!);
		expect(await resolvePublic("PUB.test.")).toEqual(answers["pub.test"]!);
		for (const h of ["mixed.test", "mixed6.test", "private.test", "localhost", "x.localhost", "nas.local", "db.internal", "127.0.0.1", "[::1]", "[::ffff:7f00:1]", "169.254.169.254"])
			await expect(resolvePublic(h)).rejects.toMatchObject({ name: "NetBlockedError", code: "blocked" });
		await expect(resolvePublic("empty.test")).rejects.toMatchObject({ code: "dns" });
		await expect(resolvePublic("nx.test")).rejects.toMatchObject({ code: "dns" });
		expect(await resolvePublic("8.8.8.8")).toEqual(["8.8.8.8"]);
		expect(isPrivateHost("mixed.test")).toBe(false); // names are judged by what they resolve to
	});
});

describe("pinning", () => {
	test("a name becomes the checked address in the URL, the name stays in Host; address literals are untouched", () => {
		const p = pinned(new URL("https://Example.org:8443/a?b=1"), "93.184.216.34");
		expect(p.url.href).toBe("https://93.184.216.34:8443/a?b=1");
		expect(p.host).toBe("example.org:8443");
		expect(p.serverName).toBe("example.org");
		expect(pinned(new URL("http://example.org/"), "2606:4700::1111").url.href).toBe("http://[2606:4700::1111]/");
		expect(pinned(new URL("http://example.org/"), "93.184.216.34").serverName).toBeUndefined();
		expect(pinned(new URL("https://8.8.8.8/"), "8.8.8.8")).toEqual({ url: new URL("https://8.8.8.8/") });
	});

	test("plain http connects to the given address with the original Host header, and moves on when an address refuses", async () => {
		const seen: string[] = [];
		const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.headers.get("host") ?? ""), new Response("ok")) });
		try {
			// "files.example.test" does not resolve anywhere: only the pin can make this connect
			const res = await fetchPinned(new URL(`http://files.example.test:${s.port}/x`), ["127.0.0.1"], {});
			expect(await res.text()).toBe("ok");
			expect(seen).toEqual([`files.example.test:${s.port}`]);
			// ::1 refuses (nothing listens there): the next address is tried
			const res2 = await fetchPinned(new URL(`http://files.example.test:${s.port}/y`), ["::1", "127.0.0.1"], {});
			expect(res2.status).toBe(200);
			expect(seen.length).toBe(2);
		} finally {
			s.stop(true);
		}
	});

	const pem = makeCert();
	test.skipIf(!pem)("https is verified against the original name, not the address (Bun's tls.serverName)", async () => {
		const { cert, key } = pem!;
		const s = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert, key }, fetch: () => new Response("secure") });
		try {
			const ok = await fetchPinned(new URL(`https://good.test:${s.port}/`), ["127.0.0.1"], { tls: { ca: cert } } as RequestInit);
			expect(await ok.text()).toBe("secure");
			// the same server and address, asked for under another name: the certificate does not match it
			await expect(fetchPinned(new URL(`https://bad.test:${s.port}/`), ["127.0.0.1"], { tls: { ca: cert } } as RequestInit)).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
			// and an address literal in the URL is not a name the certificate covers
			await expect(fetchPinned(new URL(`https://127.0.0.1:${s.port}/`), ["127.0.0.1"], { tls: { ca: cert } } as RequestInit)).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
		} finally {
			s.stop(true);
		}
	});
});

describe("fetchPublic", () => {
	test("never reaches a private address: a local server gets zero hits however it is named", async () => {
		let hits = 0;
		const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("secret")) });
		try {
			setNetResolver(async () => ["127.0.0.1"]);
			for (const u of [`http://127.0.0.1:${s.port}/`, `http://localhost:${s.port}/`, `http://rebinding.test:${s.port}/`, `http://[::ffff:127.0.0.1]:${s.port}/`, `http://0x7f.1:${s.port}/`, `http://2130706433:${s.port}/`])
				await expect(fetchPublic(u)).rejects.toBeInstanceOf(NetBlockedError);
			expect(hits).toBe(0);
		} finally {
			s.stop(true);
		}
	});

	test("resolves and checks every hop, connects to the checked address, and drops credentials on a cross-origin redirect", async () => {
		const calls: { url: string; host: string | null; auth: string | null; cookie: string | null }[] = [];
		const lookups: string[] = [];
		setNetResolver(async (h) => {
			lookups.push(h);
			if (h === "start.test") return ["93.184.216.34"];
			if (h === "other.test") return ["198.51.100.7"];
			if (h === "turns-private.test") return ["10.0.0.5"];
			throw new Error("ENOTFOUND " + h);
		});
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const h = new Headers(init?.headers);
			calls.push({ url, host: h.get("host"), auth: h.get("authorization"), cookie: h.get("cookie") });
			if (url.startsWith("http://93.184.216.34/first")) return new Response(null, { status: 302, headers: { Location: "/second" } });
			if (url.startsWith("http://93.184.216.34/second")) return new Response(null, { status: 302, headers: { Location: "http://other.test/third" } });
			if (url.startsWith("http://198.51.100.7/third")) return new Response(null, { status: 302, headers: { Location: "http://turns-private.test/fourth" } });
			return new Response("never reached");
		}) as typeof fetch;
		const headers = { Authorization: "Bearer secret", Cookie: "a=b", "X-Keep": "1" };
		await expect(fetchPublic("http://start.test/first", { headers })).rejects.toMatchObject({ code: "blocked" });
		expect(lookups).toEqual(["start.test", "start.test", "other.test", "turns-private.test"]); // one lookup per hop, none after the private answer
		expect(calls.map((c) => c.url)).toEqual(["http://93.184.216.34/first", "http://93.184.216.34/second", "http://198.51.100.7/third"]);
		expect(calls.map((c) => c.host)).toEqual(["start.test", "start.test", "other.test"]);
		expect(calls[1]!.auth).toBe("Bearer secret"); // same origin: kept
		expect(calls[2]!.auth).toBeNull(); // other origin: gone
		expect(calls[2]!.cookie).toBeNull();
	});

	test("a name that answers public for the check cannot be used to reach another address afterwards", async () => {
		let n = 0;
		setNetResolver(async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"])); // rebinding: the second answer is loopback
		const dialled: string[] = [];
		globalThis.fetch = (async (input: unknown) => (dialled.push(String(input)), new Response("ok"))) as typeof fetch;
		const res = await fetchPublic("http://rebind.test/");
		expect(await res.text()).toBe("ok");
		expect(dialled).toEqual(["http://93.184.216.34/"]);
		expect(n).toBe(1);
	});
});
