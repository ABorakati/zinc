import { describe, expect, test } from "bun:test";
import { proxyFrom, toProper } from "../../src/connector/proxy";

// Proxy JSON as the extension sends it (Zotero.Proxy.toJSON()).
const ezHost = proxyFrom({ scheme: "%h.ezproxy.kcl.ac.uk/%p", toProperScheme: "%h.ezproxy.kcl.ac.uk/%p", hosts: ["www.nature.com"] });
const ezPrefix = proxyFrom({ scheme: "ezproxy.example.edu/login?url=%u", hosts: [] });
const pathOnly = proxyFrom({ toProperScheme: "proxy.example.org/www.jstor.org/%p", hosts: ["www.jstor.org"] });

describe("proxied URL -> publisher URL (port of Zotero.Proxy.toProper)", () => {
	test("EZproxy host-name style, https with dashes for dots (HttpsHyphens)", () => {
		expect(toProper(ezHost, "https://www-nature-com.ezproxy.kcl.ac.uk/articles/s41586-020-2012-7")).toBe(
			"https://www.nature.com/articles/s41586-020-2012-7",
		);
	});
	test("EZproxy host-name style over http keeps dots", () => {
		expect(toProper(ezHost, "http://www.nature.com.ezproxy.kcl.ac.uk/articles/x?y=1")).toBe("http://www.nature.com/articles/x?y=1");
	});
	test("a scheme without %h uses the proxy's known host", () => {
		expect(toProper(pathOnly, "https://proxy.example.org/www.jstor.org/stable/123")).toBe("https://www.jstor.org/stable/123");
	});
	test("URLs that aren't this proxy's, missing proxies and bad input are left alone", () => {
		expect(toProper(ezHost, "https://www.nature.com/articles/x")).toBe("https://www.nature.com/articles/x");
		expect(toProper(null, "https://www-nature-com.ezproxy.kcl.ac.uk/a")).toBe("https://www-nature-com.ezproxy.kcl.ac.uk/a");
		expect(toProper(ezHost, "not a url")).toBe("not a url");
		expect(toProper(ezHost, "")).toBe("");
	});
	test("proxyFrom accepts toProperScheme or scheme, rejects junk", () => {
		expect(ezPrefix?.scheme).toBe("ezproxy.example.edu/login?url=%u");
		expect(proxyFrom(null)).toBeNull();
		expect(proxyFrom({ scheme: "no params here" })).toBeNull();
		expect(proxyFrom("x")).toBeNull();
	});
});
