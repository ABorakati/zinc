// Pure parts of the web-view sandbox (webSandbox.ts). The real WebView2 proof (navigation, redirects, storage, bindings) needs a hidden WebView2 and was run
// as a separate probe; these tests pin down what the builders emit.
import { describe, expect, test } from "bun:test";
import { acceptPageMessage, allowedOrigins, allowedUrl, buildWrapper, deliverScript, escapeAttr, normaliseHost, sandboxInit, wrapperCsp, wrapperUrl, type WrapperOpts } from "./webSandbox";

describe("normaliseHost", () => {
	test("accepts plain public https hosts, with optional scheme, port and subdomain wildcard", () => {
		expect(normaliseHost("api.example.com")).toBe("https://api.example.com");
		expect(normaliseHost("https://API.Example.com")).toBe("https://api.example.com");
		expect(normaliseHost("*.example.com")).toBe("https://*.example.com");
		expect(normaliseHost("example.com:443")).toBe("https://example.com");
		expect(normaliseHost("example.com:8443")).toBe("https://example.com:8443");
		expect(normaliseHost("*.cdn.example.co.uk:8443")).toBe("https://*.cdn.example.co.uk:8443");
	});

	test("drops wildcards, other schemes, loopback, private, link-local and internal names and every IP spelling", () => {
		const bad = [
			"*", "*.com", "http://example.com", "ftp://example.com", "//example.com", "example.com/", "example.com/path", "example.com?x", "user@example.com",
			"localhost", "foo.localhost", "*.localhost", "printer.local", "db.internal", "*.internal", "router.lan", "x.home.arpa", "1.0.0.127.in-addr.arpa",
			"127.0.0.1", "127.0.0.1:23119", "*.0.0.1", "*.127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "127.1", "2130706433", "0x7f000001", "0x7f.0.0.1",
			"[::1]", "::1", "[fe80::1]", "example.com.", "localhost.", "127.0.0.1.", "foo..example.com", "-a.example.com", "a-.example.com", "exa mple.com",
			"example.com:0", "example.com:65536", "example.com:", "example.com:80:80", "*.*.example.com", "ex*ample.com", "127.0.0.1.nip.io", "*.nip.io", "*.sslip.io", "app.localtest.me",
			"évil.com", "a".repeat(64) + ".example.com", "", " ", "\n", 'a.com"', "a.com;", "a.com 'unsafe-inline'", "a.com\nscript-src *", "a.com,b.com", "https://", "https:///a.com",
		];
		for (const b of bad) expect(normaliseHost(b)).toBeNull();
		for (const nonString of [undefined, null, 5, {}, [], true]) expect(normaliseHost(nonString)).toBeNull();
	});

	test("never produces text that could end a CSP source or an attribute", () => {
		for (const ok of ["a.example.com", "*.example.com:8443", "xn--80ak6aa92e.com"]) {
			const n = normaliseHost(ok)!;
			expect(n).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/);
		}
	});
});

describe("allowedOrigins", () => {
	test("is the normalised intersection of what the plugin asks for and what its manifest grants", () => {
		expect(allowedOrigins(["a.example.com", "b.example.com", "*.example.com"], ["https://A.example.com", "*.example.com"])).toEqual(["https://a.example.com", "https://*.example.com"]);
		expect(allowedOrigins(["a.example.com"], [])).toEqual([]);
		expect(allowedOrigins([], ["a.example.com"])).toEqual([]);
		expect(allowedOrigins(undefined, undefined)).toEqual([]);
		expect(allowedOrigins("a.example.com", "a.example.com")).toEqual([]);
	});

	test("dangerous entries cannot be granted by naming them in both lists", () => {
		const evil = ["*", "http://a.example.com", "127.0.0.1", "*.0.0.1", "localhost", "a.example.com; script-src *", "a.example.com.", "x.localhost", "[::1]"];
		expect(allowedOrigins(evil, evil)).toEqual([]);
		expect(allowedOrigins([...evil, "ok.example.com"], [...evil, "ok.example.com"])).toEqual(["https://ok.example.com"]);
	});

	test("de-duplicates equal spellings", () => {
		expect(allowedOrigins(["a.example.com", "https://a.example.com:443", "A.EXAMPLE.COM"], ["a.example.com"])).toEqual(["https://a.example.com"]);
	});
});

describe("allowedUrl", () => {
	const origins = ["https://a.example.com", "https://*.cdn.example.org", "https://p.example.net:8443"];
	test("passes https URLs on an allowed origin, normalised", () => {
		expect(allowedUrl("https://a.example.com/x?y=1#z", origins)).toBe("https://a.example.com/x?y=1#z");
		expect(allowedUrl("https://A.EXAMPLE.COM:443/", origins)).toBe("https://a.example.com/");
		expect(allowedUrl("https://x.cdn.example.org/", origins)).toBe("https://x.cdn.example.org/");
		expect(allowedUrl("https://x.y.cdn.example.org/", origins)).toBe("https://x.y.cdn.example.org/");
		expect(allowedUrl("https://p.example.net:8443/", origins)).toBe("https://p.example.net:8443/");
	});
	test("rejects everything else", () => {
		for (const u of [
			"http://a.example.com/", "https://cdn.example.org/", "https://evilcdn.example.org/", "https://b.example.com/", "https://a.example.com:8443/", "https://p.example.net/",
			"https://user:pw@a.example.com/", "https://a.example.com./", "https://127.0.0.1/", "https://[::1]/", "javascript:alert(1)", "data:text/html,x", "file:///c:/x", "about:blank", "not a url", "",
			"https://a.example.com@127.0.0.1/", "https://127.0.0.1#@a.example.com/",
		])
			expect(allowedUrl(u, origins)).toBeNull();
		expect(allowedUrl("https://a.example.com/", [])).toBeNull();
		// a backslash ends the host in the URL parser, so this is a path on a.example.com and not a request to 127.0.0.1
		expect(allowedUrl("https://a.example.com\\@127.0.0.1/", origins)).toBe("https://a.example.com/@127.0.0.1/");
		expect(allowedUrl(undefined, origins)).toBeNull();
	});
});

describe("buildWrapper", () => {
	const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
	const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

	test("has exactly one iframe, sandboxed without any dangerous allowance, and nothing else but the policy and a style", () => {
		for (const scripts of [false, true]) {
			const html = buildWrapper({ kind: "srcdoc", value: "<p>x</p>", scripts, origins: ["https://a.example.com"] });
			expect(html.match(/<iframe/g)?.length).toBe(1);
			expect(html.match(/<script/gi)).toBeNull();
			const sb = attr(html, "sandbox");
			expect(sb).toBe(scripts ? "allow-scripts" : "");
			for (const bad of ["same-origin", "top-navigation", "popups", "forms", "modals", "downloads", "pointer-lock", "presentation", "orientation-lock", "storage-access"]) expect(sb).not.toContain(bad);
			expect(html).toContain('referrerpolicy="no-referrer"');
			expect(html).toContain(' allow=""');
		}
	});

	test("html goes in srcdoc and survives a round trip, whatever quotes, tags and entities it holds", () => {
		const nasty = `"><script>top.location='http://127.0.0.1/'</script>&amp; ' \n\t\0 <iframe sandbox="allow-same-origin" srcdoc="x">`;
		const html = buildWrapper({ kind: "srcdoc", value: nasty, scripts: true, origins: [] });
		expect(html.match(/<iframe/g)?.length).toBe(1);
		expect(html.match(/<script/gi)).toBeNull();
		expect(html.match(/ sandbox="/g)?.length).toBe(1); // the hostile one is escaped text inside an attribute
		expect(decode(attr(html, "srcdoc")!)).toBe(nasty);
		expect(attr(html, "src")).toBeUndefined();
	});

	test("a url goes in src, escaped, and cannot change the sandbox or the policy", () => {
		const value = `https://a.example.com/"><iframe sandbox="allow-same-origin" src="http://127.0.0.1/'&x=1`;
		const html = buildWrapper({ kind: "url", value, scripts: false, origins: ["https://a.example.com"] });
		expect(html.match(/<iframe/g)?.length).toBe(1);
		expect(html).not.toContain("srcdoc=");
		expect(html.match(/ sandbox="/g)?.length).toBe(1); // the hostile one is escaped text inside an attribute
		expect(decode(/ src="([^"]*)"/.exec(html)![1]!)).toBe(value);
		expect(html.match(/Content-Security-Policy/g)?.length).toBe(1);
		expect(attr(html, "sandbox")).toBe("");
	});

	test("the policy is first, and a url source gets a narrower one than a srcdoc source", () => {
		const o = ["https://a.example.com", "https://*.b.example.org:8443"];
		const doc = wrapperCsp("srcdoc", true, o);
		expect(doc).toContain("default-src 'none'");
		expect(doc).toContain("frame-src https://a.example.com https://*.b.example.org:8443;");
		expect(doc).toContain("script-src 'unsafe-inline' https://a.example.com https://*.b.example.org:8443");
		expect(doc).toContain("form-action 'none'");
		expect(doc).toContain("base-uri 'none'");
		expect(wrapperCsp("srcdoc", false, o)).not.toContain("script-src");
		const url = wrapperCsp("url", true, o);
		expect(url).not.toContain("script-src");
		expect(url).not.toContain("connect-src");
		expect(url).toContain("frame-src https://a.example.com https://*.b.example.org:8443;");
		expect(buildWrapper({ kind: "url", value: "https://a.example.com/", scripts: true, origins: o }).indexOf("Content-Security-Policy")).toBeLessThan(
			buildWrapper({ kind: "url", value: "https://a.example.com/", scripts: true, origins: o }).indexOf("<iframe"),
		);
	});

	test("with no allowed origin nothing can be framed, fetched or navigated to", () => {
		for (const kind of ["srcdoc", "url"] as const) {
			const c = wrapperCsp(kind, true, []);
			expect(c).toContain("frame-src 'none'");
			expect(c).not.toMatch(/https?:/);
			expect(c).not.toContain("*");
		}
		expect(wrapperCsp("srcdoc", true, [])).toContain("connect-src 'none'");
	});

	test("the data url decodes back to the wrapper", () => {
		const o: WrapperOpts = { kind: "srcdoc", value: "<b>é</b>", scripts: true, origins: [] };
		const u = wrapperUrl(o);
		expect(u.startsWith("data:text/html;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(u.slice(u.indexOf(",") + 1))).toBe(buildWrapper(o));
	});
});

describe("escapeAttr", () => {
	test("leaves nothing that could close or reopen an attribute or a tag", () => {
		const out = escapeAttr(`a"b'c<d>e&f\ng\rh\ti\0`);
		expect(out).not.toMatch(/["'<>\n\r\t\0]/);
		expect(out.replace(/&(amp|quot|lt|gt|#\d+);/g, "")).not.toContain("&");
	});
});

describe("plugin -> page delivery", () => {
	test("invalid JSON and non-strings are dropped, never turned into a script", () => {
		expect(deliverScript(`0);fetch("/api/maintenance/empty-trash");(0`)).toBeNull();
		expect(deliverScript("alert(1)")).toBeNull();
		expect(deliverScript("")).toBeNull();
		expect(deliverScript("{")).toBeNull();
		expect(deliverScript(undefined)).toBeNull();
		expect(deliverScript({ a: 1 })).toBeNull();
	});

	test("valid JSON is re-encoded into a string literal argument of a fixed function", () => {
		const hostile = `"0);fetch('/x');(0 </script> \u2028 \\"`;
		const s = deliverScript(JSON.stringify(hostile))!;
		const fixed = deliverScript("1")!;
		expect(s.slice(0, fixed.indexOf("})(") + 3)).toBe(fixed.slice(0, fixed.indexOf("})(") + 3)); // the function text never varies
		// the argument is one JS string literal that parses back to the JSON text
		const arg = s.slice(s.indexOf("})(") + 3, s.lastIndexOf(");"));
		expect(JSON.parse(JSON.parse(arg))).toBe(hostile);
		// evaluating the whole script in a stub of the page delivers exactly the parsed value
		const got: unknown[] = [];
		const doc = { getElementById: () => ({ tagName: "IFRAME", contentWindow: { postMessage: (m: unknown) => got.push(m) } }) };
		const win: Record<string, unknown> = { document: doc };
		win.top = win;
		new Function("window", "document", s)(win, doc);
		expect(got).toEqual([{ zn: "down", m: hostile }]);
	});

	test("it does nothing when the top document is not the wrapper", () => {
		const s = deliverScript('{"a":1}')!;
		const got: unknown[] = [];
		const frame = { tagName: "IFRAME", contentWindow: { postMessage: (m: unknown) => got.push(m) } };
		const run = (doc: unknown, win: Record<string, unknown>) => new Function("window", "document", s)(win, doc);
		const notTop: Record<string, unknown> = { top: {} };
		run({ getElementById: () => frame }, notTop);
		const noFrame: Record<string, unknown> = {};
		noFrame.top = noFrame;
		run({ getElementById: () => null }, noFrame);
		run({ getElementById: () => ({ tagName: "DIV", contentWindow: frame.contentWindow }) }, noFrame);
		expect(got).toEqual([]);
	});
});

describe("page -> plugin acceptance", () => {
	test("only the wrapper's relay (right nonce) and only while messaging is on", () => {
		expect(acceptPageMessage({ type: "zinc", n: "N", message: { a: 1 } }, "N", true)).toBe('{"a":1}');
		expect(acceptPageMessage({ type: "zinc", n: "N" }, "N", true)).toBe("null");
		expect(acceptPageMessage({ type: "zinc", n: "N", message: 1 }, "N", false)).toBeNull();
		expect(acceptPageMessage({ type: "zinc", message: 1 }, "N", true)).toBeNull();
		expect(acceptPageMessage({ type: "zinc", n: "other", message: 1 }, "N", true)).toBeNull();
		expect(acceptPageMessage({ type: "other", n: "N", message: 1 }, "N", true)).toBeNull();
		expect(acceptPageMessage({ n: "N", message: 1 }, "N", true)).toBeNull();
	});
});

describe("sandboxInit", () => {
	test("is a plain script with the flag and nonce baked in, nothing from the plugin", () => {
		const on = sandboxInit(true, "abc-123");
		const off = sandboxInit(false, "abc-123");
		expect(on).toContain("MSG=true");
		expect(off).toContain("MSG=false");
		expect(on).toContain('"abc-123"');
		expect(() => new Function(on)).not.toThrow();
		expect(() => new Function(off)).not.toThrow();
	});
});
