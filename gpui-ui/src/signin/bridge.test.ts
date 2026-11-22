// The sign-in bridge against a fake helper (no WebView2): window life cycle, navigation tracking, cookies, PDF capture, the idle end,
// and the core's real LoginController driving it (patterns of core/test/fulltext/login.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyStore } from "../../../core/src/fulltext/bodies";
import { getBrowserBridge, setBrowserBridge, type LoginRequest } from "../../../core/src/fulltext/browser-bridge";
import { LoginController } from "../../../core/src/fulltext/login";
import { cookieHeader, cookiesForUrl, createSigninBridge, hasPdfMagic, pdfish, safeUrl, windowTitle } from "./bridge";
import type { Driver, HelperEvent, HelperOp, HelperOps, RawCookie } from "./protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => {
	const t0 = Date.now();
	while (!f() && Date.now() - t0 < ms) await sleep(5);
	if (!f()) throw new Error("timed out");
};

class FakeDriver implements Driver {
	alive = true;
	calls: { op: string; args: any }[] = [];
	cookies: RawCookie[] = [];
	htmlByUrl: Record<string, string> = {};
	cur = new Map<string, string>(); // window id -> url
	stopped = false;
	private listeners: ((e: HelperEvent) => void)[] = [];
	/** what a navigation does in the fake browser */
	onNavigate: (id: string, url: string, d: FakeDriver) => void = (id, url, d) => {
		d.cur.set(id, url);
		d.emit({ ev: "nav", id, url, mime: "text/html" });
		d.emit({ ev: "loaded", id });
	};
	onEvent(cb: (e: HelperEvent) => void) {
		this.listeners.push(cb);
	}
	emit(e: HelperEvent) {
		for (const l of this.listeners) l(e);
	}
	async call<K extends HelperOp>(op: K, args: HelperOps[K]["args"]): Promise<HelperOps[K]["result"]> {
		this.calls.push({ op, args });
		const a = args as any;
		if (!this.alive) throw new Error("not running");
		switch (op) {
			case "open":
			case "navigate":
				queueMicrotask(() => this.onNavigate(a.id, a.url, this));
				return null as any;
			case "html":
				return (this.htmlByUrl[this.cur.get(a.id) ?? ""] ?? "") as any;
			case "cookies":
				return this.cookies.map((c) => ({ ...c })) as any;
			case "setCookies":
				this.cookies.push(...a.cookies);
				return a.cookies.length as any;
			default:
				return null as any;
		}
	}
	async stop() {
		this.stopped = true;
		this.alive = false;
	}
	of(op: string) {
		return this.calls.filter((c) => c.op === op);
	}
}

const REQ: LoginRequest = {
	entryUrl: "https://login.example.org/start?token=SECRET1",
	realm: "r1",
	institutionName: "Example University",
	kind: "openathens",
	waiting: 2,
	capturePdf: false,
};
const ck = (o: Partial<RawCookie>): RawCookie => ({
	name: "n",
	value: "v",
	domain: "example.org",
	path: "/",
	secure: false,
	httpOnly: false,
	expires: -1,
	session: true,
	...o,
});

function make(d = new FakeDriver(), extra: Partial<Parameters<typeof createSigninBridge>[0]> = {}) {
	const lines: string[] = [];
	const drivers: FakeDriver[] = [d];
	const bridge = createSigninBridge({
		start: async () => {
			const x = drivers.length > 1 || drivers[0]!.stopped ? new FakeDriver() : drivers[0]!;
			if (x !== drivers[0]) drivers.unshift(x);
			return x;
		},
		profileExists: () => false,
		log: (_l, m) => lines.push(m),
		...extra,
	});
	return { bridge, d, lines, drivers };
}

afterEach(() => setBrowserBridge(null));

describe("pure helpers", () => {
	test("safeUrl drops query, fragment and userinfo", () => {
		expect(safeUrl("https://u:p@a.example.org/x/y?token=SECRET#frag")).toBe("https://a.example.org/x/y");
		expect(safeUrl("about:blank")).toBe("");
	});
	test("windowTitle shows the browser's address and flags plain http", () => {
		expect(windowTitle("KCL", "")).toBe("Sign in to KCL");
		expect(windowTitle("KCL", "https://idp.kcl.ac.uk/a?b=1")).toBe("Sign in to KCL - https://idp.kcl.ac.uk");
		expect(windowTitle("KCL", "http://x.test:8080/")).toBe("Sign in to KCL - http://x.test:8080 (not secure)");
	});
	test("pdfish / hasPdfMagic", () => {
		expect(pdfish("https://a.org/x.pdf")).toBe(true);
		expect(pdfish("https://a.org/article")).toBe(false);
		expect(hasPdfMagic(new TextEncoder().encode("\n %PDF-1.4"))).toBe(true);
		expect(hasPdfMagic(new TextEncoder().encode("<html>"))).toBe(false);
	});
	test("cookiesForUrl: domain, host-only, path, secure, expiry", () => {
		const all: RawCookie[] = [
			ck({ name: "dom", domain: ".example.org" }),
			ck({ name: "host", domain: "www.example.org" }),
			ck({ name: "other", domain: "other.org" }),
			ck({ name: "sec", domain: ".example.org", secure: true }),
			ck({ name: "deep", domain: ".example.org", path: "/a/b" }),
			ck({ name: "old", domain: ".example.org", session: false, expires: 100 }),
			ck({ name: "future", domain: ".example.org", session: false, expires: 4102444800, httpOnly: true }),
			ck({ name: "suffix", domain: "ample.org" }),
		];
		const names = (u: string) =>
			cookiesForUrl(all, u, 1000)
				.map((c) => c.name)
				.sort();
		expect(names("https://www.example.org/")).toEqual(["dom", "future", "host", "sec"]);
		expect(names("http://www.example.org/")).toEqual(["dom", "future", "host"]);
		expect(names("https://example.org/a/b/c")).toEqual(["deep", "dom", "future", "sec"]);
		expect(names("https://example.org/a/bc")).toEqual(["dom", "future", "sec"]);
		expect(names("ftp://example.org/")).toEqual([]);
		const f = cookiesForUrl(all, "https://example.org/", 1000).find((c) => c.name === "future")!;
		expect(f.httpOnly).toBe(true);
		expect(f.expires).toBe(4102444800);
		expect(cookiesForUrl(all, "https://example.org/", 1000).find((c) => c.name === "dom")!.expires).toBeUndefined();
		expect(cookieHeader(cookiesForUrl(all, "https://example.org/", 1000))).toContain("dom=v");
	});
});

describe("sign-in window", () => {
	test("opens a visible window, tracks the browser's address, titles it, reports user actions and closing", async () => {
		const { bridge, d } = make();
		const s = await bridge.openLogin(REQ, new AbortController().signal);
		const open = d.of("open")[0]!.args;
		expect(open.visible).toBe(true);
		expect(open.url).toBe(REQ.entryUrl);
		expect(open.title).toBe("Sign in to Example University");
		await until(() => s.url() === REQ.entryUrl);
		await until(() => d.of("title").length > 0);
		expect(d.of("title").at(-1)!.args.text).toBe("Sign in to Example University - https://login.example.org");
		// the banner carries the count and the name
		await until(() => d.of("banner").length > 0);
		expect(d.of("banner")[0]!.args.state).toMatchObject({ institution: "Example University", waiting: 2, standby: false });
		s.setBanner({ waiting: 5, offerKeepWaiting: true, status: "busy" });
		await until(() => d.of("banner").length > 1);
		expect(d.of("banner").at(-1)!.args.state).toMatchObject({ waiting: 5, offerKeepWaiting: true, status: "busy" });
		// a page's own HTML comes through the browser
		d.htmlByUrl[REQ.entryUrl] = "<html>x</html>";
		expect(await s.html(1000)).toBe("<html>x</html>");
		// actions
		d.emit({ ev: "action", id: open.id, a: "keep_waiting" });
		d.emit({ ev: "action", id: open.id, a: "skip" });
		expect(s.takeActions()).toEqual(["keep_waiting", "skip"]);
		expect(s.takeActions()).toEqual([]);
		// the user closes the window
		let woke = false;
		const w = s.waitForChange(5000).then(() => (woke = true));
		d.emit({ ev: "closed", id: open.id });
		await w;
		expect(woke).toBe(true);
		expect(s.closed()).toBe(true);
	});

	test("only http(s) addresses count; about:blank and chrome-error pages are ignored", async () => {
		const { bridge, d } = make();
		d.onNavigate = () => {};
		const s = await bridge.openLogin(REQ, new AbortController().signal);
		const id = d.of("open")[0]!.args.id;
		d.emit({ ev: "nav", id, url: "about:blank" });
		d.emit({ ev: "nav", id, url: "chrome-error://chromewebdata/" });
		expect(s.url()).toBe("");
		d.emit({ ev: "nav", id, url: "https://a.example.org/x" });
		expect(s.url()).toBe("https://a.example.org/x");
	});

	test("a second window is refused while one is open; a finished one is parked and reused", async () => {
		const { bridge, d } = make();
		const s1 = await bridge.openLogin(REQ, new AbortController().signal);
		await expect(bridge.openLogin({ ...REQ, realm: "r2" }, new AbortController().signal)).rejects.toThrow(/already open/);
		s1.finish("standby", 60_000);
		await until(() => d.of("banner").some((c) => c.args.state?.standby === true));
		const s2 = await bridge.openLogin(
			{ ...REQ, entryUrl: "https://publisher.example.com/a", realm: "r2", waiting: 1 },
			new AbortController().signal,
		);
		expect(d.of("open").length).toBe(1); // the parked window was reused
		expect(d.of("navigate")[0]!.args.url).toBe("https://publisher.example.com/a");
		await until(() => s2.url() === "https://publisher.example.com/a");
		s2.finish("close");
		await until(() => d.of("release").length === 1);
		expect(s2.closed()).toBe(true);
	});

	test("an abort closes the window", async () => {
		const { bridge, d } = make();
		const ac = new AbortController();
		const s = await bridge.openLogin(REQ, ac.signal);
		ac.abort();
		await until(() => d.of("release").length === 1);
		expect(s.closed()).toBe(true);
	});

	test("the helper ending closes the window", async () => {
		const { bridge, d } = make();
		const s = await bridge.openLogin(REQ, new AbortController().signal);
		d.emit({ ev: "exit" });
		expect(s.closed()).toBe(true);
		expect(bridge.helperRunning).toBe(false); // the next request starts a new one
	});

	test("opening fails cleanly when the helper cannot open the window", async () => {
		const d = new FakeDriver();
		d.call = (async () => {
			throw new Error("no window");
		}) as any;
		const { bridge } = make(d);
		await expect(bridge.openLogin(REQ, new AbortController().signal)).rejects.toThrow("no window");
		// a later request is not blocked by the failed one
		d.call = FakeDriver.prototype.call.bind(d) as any;
		await bridge.openLogin(REQ, new AbortController().signal);
	});

	test("a PDF the window shows is fetched with the session cookies; a download is taken from disk", async () => {
		const d = new FakeDriver();
		d.cookies = [ck({ name: "sess", value: "S3", domain: "pub.example.org", httpOnly: true })];
		const seen: { url: string; cookie: string | null }[] = [];
		const pdf = new TextEncoder().encode("%PDF-1.4 body");
		const { bridge } = make(d, {
			fetchFn: (async (url: any, init: any) => {
				seen.push({ url: String(url), cookie: init?.headers?.Cookie ?? null });
				return new Response(pdf, { headers: { "content-type": "application/pdf" } });
			}) as any,
		});
		d.onNavigate = (id, url) => d.emit({ ev: "nav", id, url, mime: url.endsWith(".pdf") ? "application/pdf" : "text/html" });
		const s = await bridge.openLogin({ ...REQ, capturePdf: true }, new AbortController().signal);
		const id = d.of("open")[0]!.args.id;
		expect(d.of("downloads")[0]!.args.dir).not.toBeNull();
		d.emit({ ev: "nav", id, url: "https://pub.example.org/paper.pdf?sig=SECRET2", mime: "application/pdf" });
		await until(() => s.capturedPdf() !== null);
		expect(seen[0]!.cookie).toBe("sess=S3"); // HttpOnly cookie reaches the download
		expect(s.capturedPdf()!.filename).toBe("paper.pdf");
		expect(hasPdfMagic(s.capturedPdf()!.bytes)).toBe(true);
	});
});

describe("hidden page load", () => {
	test("returns the page HTML once the browser is quiet, with the address trail", async () => {
		const { bridge, d } = make();
		d.htmlByUrl["https://pub.example.org/final"] = "<html>final</html>";
		d.onNavigate = (id, url, dd) => {
			dd.emit({ ev: "nav", id, url });
			dd.cur.set(id, "https://pub.example.org/final");
			dd.emit({ ev: "nav", id, url: "https://pub.example.org/final" });
			dd.emit({ ev: "loaded", id });
		};
		// the quiet period is 1.5 s by design; shorten the wait with a small timeout
		const r = await bridge.load({ url: "https://pub.example.org/a", timeoutMs: 400, capturePdf: false }, new AbortController().signal);
		expect(d.of("open")[0]!.args.visible).toBe(false);
		expect(r.finalUrl).toBe("https://pub.example.org/final");
		expect(r.urlTrail).toEqual(["https://pub.example.org/a", "https://pub.example.org/final"]);
		expect(r.pageHtml).toBe("<html>final</html>");
		expect(r.status).toBe(200);
		expect(d.of("release").length).toBe(1);
	});

	test("rejects non-http addresses and honours the abort", async () => {
		const { bridge, d } = make();
		await expect(
			bridge.load({ url: "file:///c:/x", timeoutMs: 100, capturePdf: false }, new AbortController().signal),
		).rejects.toThrow();
		d.onNavigate = () => {};
		const ac = new AbortController();
		const p = bridge.load({ url: "https://pub.example.org/a", timeoutMs: 5000, capturePdf: false }, ac.signal);
		setTimeout(() => ac.abort(), 50);
		await expect(p).rejects.toThrow("aborted");
		expect(d.of("release").length).toBe(1);
	});
});

describe("cookies", () => {
	test("cookiesFor serves what the browser would send, once per 2 s", async () => {
		const { bridge, d } = make();
		await bridge.openLogin(REQ, new AbortController().signal);
		d.cookies = [ck({ name: "a", domain: ".example.org", httpOnly: true }), ck({ name: "b", domain: "other.org" })];
		const cs = await bridge.cookiesFor("https://www.example.org/x");
		expect(cs.map((c) => c.name)).toEqual(["a"]);
		expect(cs[0]!.httpOnly).toBe(true);
		await bridge.cookiesFor("https://www.example.org/y");
		expect(d.of("cookies").length).toBe(1);
		expect(await bridge.cookiesFor("mailto:a@b.c")).toEqual([]);
	});

	test("with no helper and no profile nothing is started", async () => {
		const { bridge, d } = make();
		expect(await bridge.cookiesFor("https://www.example.org/")).toEqual([]);
		expect(d.calls.length).toBe(0);
		expect(bridge.helperRunning).toBe(false);
	});

	test("with a profile on disk the helper is started once to read its cookies", async () => {
		const d = new FakeDriver();
		d.cookies = [ck({ name: "persisted", domain: ".example.org", session: false, expires: 4102444800 })];
		const { bridge } = make(d, { profileExists: () => true });
		const cs = await bridge.cookiesFor("https://login.example.org/");
		expect(cs.map((c) => c.name)).toEqual(["persisted"]);
		expect(bridge.helperRunning).toBe(true);
	});

	test("the idle end keeps the session cookies in memory and puts them back into the next browser", async () => {
		const { bridge, d, drivers } = make(new FakeDriver(), { idleMs: 30 });
		await bridge.openLogin(REQ, new AbortController().signal);
		d.cookies = [
			ck({ name: "sessionOnly", domain: ".example.org", httpOnly: true }),
			ck({ name: "kept", domain: ".example.org", session: false, expires: 4102444800 }),
		];
		await bridge.cookiesFor("https://example.org/");
		// the window is still open: not idle
		await sleep(80);
		expect(d.stopped).toBe(false);
		bridge.closeAll();
		await until(() => d.stopped, 1500);
		expect(bridge.helperRunning).toBe(false);
		// served from memory while no browser runs
		expect((await bridge.cookiesFor("https://example.org/")).map((c) => c.name).sort()).toEqual(["kept", "sessionOnly"]);
		// the next browser gets the session cookie back
		await bridge.openLogin(REQ, new AbortController().signal);
		const next = drivers[0]!;
		expect(next).not.toBe(d);
		const injected = next.of("setCookies")[0]!.args.cookies as RawCookie[];
		expect(injected.map((c) => c.name)).toEqual(["sessionOnly"]);
		await bridge.dispose();
	});

	test("nothing logged carries a query, a token or a cookie value", async () => {
		const { bridge, d, lines } = make();
		d.cookies = [ck({ name: "sess", value: "COOKIEVALUE", domain: ".login.example.org" })];
		const s = await bridge.openLogin(REQ, new AbortController().signal);
		await bridge.cookiesFor("https://login.example.org/");
		s.finish("close");
		await bridge.dispose();
		const all = lines.join("\n");
		expect(all).toContain("https://login.example.org/start");
		expect(all).not.toContain("SECRET1");
		expect(all).not.toContain("COOKIEVALUE");
	});
});

describe("with the core's LoginController", () => {
	const stubWasm = {
		loginState: ({ url }: { url: string }) => (url.includes("/landed") ? { state: "landed" } : { state: "pending" }),
		inspect: () => ({ expect: "none" }),
	} as any;
	const ctl = (bridge: ReturnType<typeof make>["bridge"]) => {
		const dir = mkdtempSync(join(tmpdir(), "zn-signin-"));
		setBrowserBridge(bridge);
		return new LoginController({
			bridge: () => getBrowserBridge(),
			wasm: stubWasm,
			bodies: new BodyStore(join(dir, "storage", ".tmp")),
			pollMs: 10,
			lingerMs: 10,
			standbyMs: 50,
			institutionName: () => "Example University",
		});
	};
	const open = (c: LoginController, signal = new AbortController().signal) =>
		c.open(
			1,
			{
				entry_url: "https://login.example.org/start",
				realm: "r1",
				kind: "openathens",
				waiting: 1,
				timeout_ms: 5000,
				capture_pdf: false,
			} as any,
			signal,
		);

	test("sign-in that reaches a landing page ends 'landed' and parks the window", async () => {
		const { bridge, d } = make();
		d.onNavigate = (id, url, dd) => {
			dd.cur.set(id, url);
			dd.emit({ ev: "nav", id, url });
			setTimeout(() => {
				dd.cur.set(id, "https://publisher.example.com/landed");
				dd.htmlByUrl["https://publisher.example.com/landed"] = "<html>article</html>";
				dd.emit({ ev: "nav", id, url: "https://publisher.example.com/landed" });
			}, 40);
		};
		const c = ctl(bridge);
		const r = await open(c);
		expect(r.result).toBe("landed");
		expect(r.final_url).toBe("https://publisher.example.com/landed");
		expect(c.signedIn()).toBe(true);
		expect(d.of("open")[0]!.args.title).toContain("Example University");
		await until(() => d.of("banner").some((x) => x.args.state?.standby === true));
		await until(() => d.of("release").length === 1, 1500); // standbyMs elapsed
	});

	test("closing the window ends 'closed_by_user'; the Open in browser button ends 'handoff'", async () => {
		const { bridge, d } = make();
		d.onNavigate = (id, url, dd) => dd.emit({ ev: "nav", id, url });
		const c = ctl(bridge);
		const p = open(c);
		await until(() => d.of("open").length === 1);
		d.emit({ ev: "closed", id: d.of("open")[0]!.args.id });
		expect((await p).result).toBe("closed_by_user");

		const opened: string[] = [];
		const c2 = new LoginController({
			bridge: () => bridge,
			wasm: stubWasm,
			bodies: new BodyStore(join(mkdtempSync(join(tmpdir(), "zn-signin-")), "storage", ".tmp")),
			pollMs: 10,
			openExternal: (u) => opened.push(u),
		});
		const p2 = open(c2);
		await until(() => d.of("open").length === 2);
		d.emit({ ev: "action", id: d.of("open")[1]!.args.id, a: "handoff" });
		expect((await p2).result).toBe("handoff");
		expect(opened).toEqual(["https://login.example.org/start"]);
	});

	test("warm-up joins the same window and the signed-in state follows", async () => {
		const { bridge, d } = make();
		d.onNavigate = (id, url, dd) => {
			dd.cur.set(id, "https://idp.example.org/landed");
			dd.emit({ ev: "nav", id, url: "https://idp.example.org/landed" });
		};
		const c = ctl(bridge);
		const r = await c.warmUp("https://login.example.org/start", "r1", 5000, new AbortController().signal);
		expect(r.result).toBe("landed");
		expect(c.signedIn()).toBe(true);
	});
});

describe("helper life cycle", () => {
	/** the browser's cookie read waits until released: the idle end is then parked on its await */
	function holdCookies(d: FakeDriver) {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held = true;
		let reached = false;
		const orig = d.call.bind(d);
		d.call = (async (op: HelperOp, args: unknown) => {
			if (op === "cookies" && held) {
				reached = true;
				await gate;
			}
			return orig(op, args as never);
		}) as typeof d.call;
		return {
			reached: () => reached,
			release: () => {
				held = false;
				release();
			},
		};
	}

	test("a sign-in window opened while the idle end reads the cookies keeps the browser", async () => {
		const { bridge, d } = make(new FakeDriver(), { idleMs: 20 });
		await bridge.openLogin(REQ, new AbortController().signal);
		const hold = holdCookies(d);
		bridge.closeAll(); // the next idle check goes ahead and parks on the cookie read
		await until(hold.reached);
		await bridge.openLogin({ ...REQ, realm: "r2" }, new AbortController().signal);
		hold.release();
		await sleep(100);
		expect(d.stopped).toBe(false);
		expect(bridge.helperRunning).toBe(true);
		await bridge.dispose();
	});

	test("a page load started while the idle end reads the cookies keeps the browser", async () => {
		const { bridge, d } = make(new FakeDriver(), { idleMs: 20 });
		await bridge.openLogin(REQ, new AbortController().signal);
		const hold = holdCookies(d);
		bridge.closeAll();
		await until(hold.reached);
		const load = bridge.load({ url: "https://pub.example.org/a", timeoutMs: 300, capturePdf: false }, new AbortController().signal);
		await sleep(10);
		hold.release();
		await load;
		expect(d.of("open").length).toBe(2);
		expect(d.stopped).toBe(false);
		await bridge.dispose();
	});

	test("two sign-in windows requested at once open one", async () => {
		const { bridge, d } = make();
		const ac = new AbortController();
		const r = await Promise.allSettled([bridge.openLogin(REQ, ac.signal), bridge.openLogin({ ...REQ, realm: "r2" }, ac.signal)]);
		expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(d.of("open").length).toBe(1);
		await bridge.dispose();
	});

	test("a finished PDF load leaves downloads on while a sign-in window is capturing PDFs", async () => {
		const { bridge, d } = make();
		await bridge.openLogin({ ...REQ, capturePdf: true }, new AbortController().signal);
		await bridge.load({ url: "https://pub.example.org/a", timeoutMs: 100, capturePdf: true }, new AbortController().signal);
		const dirs = d.of("downloads").map((c) => c.args.dir);
		expect(dirs.length).toBeGreaterThan(0);
		expect(dirs.every((x) => x !== null)).toBe(true);
		await bridge.dispose();
	});
});
