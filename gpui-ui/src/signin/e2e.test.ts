// End to end against a mock "institution" on localhost, with the real helper and WebView2 (no window is ever shown: the helper runs
// the sign-in in its hidden window, ZN_SIGNIN_HEADLESS=1). Opt-in, it starts WebView2 processes:
//   ZN_WEBVIEW_TESTS=1 bun test src/signin/e2e.test.ts
// The helper runs under another exe name (zn-signin-test.exe), so its profile is %APPDATA%\zn-signin-test.exe, never the user's; both it
// and the link are removed afterwards. The mock sets a session cookie at /login and serves the PDF only with that cookie.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyStore } from "../../../core/src/fulltext/bodies";
import { LoginController } from "../../../core/src/fulltext/login";
import { HttpClient } from "../../../core/src/fulltext/http";
import { setBrowserBridge } from "../../../core/src/fulltext/browser-bridge";
import { createSigninBridge, hasPdfMagic } from "./bridge";
import { HelperLink } from "./launch";
import { helperExePath, signinProfileDir } from "./paths";

const wanted = process.platform === "win32" && process.env.ZN_WEBVIEW_TESTS === "1";
const EXE = "zn-signin-test.exe";
const HELPER = join(import.meta.dir, "helper.ts");
const PDF = new TextEncoder().encode(`%PDF-1.4\n${"% filler\n".repeat(200)}%%EOF\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!wanted)("sign-in browser against a mock institution", () => {
	let srv: ReturnType<typeof Bun.serve>;
	let base = "";
	const hits: string[] = [];
	const token = `T${crypto.randomUUID()}`;
	const bridges: ReturnType<typeof createSigninBridge>[] = [];

	const newBridge = (o: { idleMs?: number } = {}) => {
		const b = createSigninBridge({
			start: () => HelperLink.start([HELPER], { exeName: EXE, env: { ZN_SIGNIN_HEADLESS: "1" } }),
			downloads: mkdtempSync(join(tmpdir(), "zn-dl-")),
			log: () => {},
			...o,
		});
		bridges.push(b);
		return b;
	};
	const controller = (bridge: ReturnType<typeof createSigninBridge>) => {
		setBrowserBridge(bridge);
		return new LoginController({
			bridge: () => bridge,
			wasm: { loginState: ({ url }: { url: string }) => (new URL(url).pathname === "/landed" ? { state: "landed" } : { state: "pending" }), inspect: () => ({ expect: "none" }) } as any,
			bodies: new BodyStore(join(mkdtempSync(join(tmpdir(), "zn-e2e-")), "storage", ".tmp")),
			pollMs: 100,
			lingerMs: 50,
			standbyMs: 100,
			institutionName: () => "Mock University",
		});
	};

	beforeAll(() => {
		process.env.ZN_SIGNIN_EXE_NAME = EXE;
		srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const u = new URL(req.url);
				hits.push(u.pathname);
				const has = (req.headers.get("cookie") ?? "").includes(`sess=${token}`);
				switch (u.pathname) {
					case "/login": {
						const h = new Headers({ location: "/landed" });
						h.append("set-cookie", `sess=${token}; Path=/; HttpOnly`);
						h.append("set-cookie", "keep=1; Path=/; Max-Age=3600");
						return new Response(null, { status: 302, headers: h });
					}
					case "/landed":
						return new Response("<html><body>Welcome to the mock institution</body></html>", { headers: { "content-type": "text/html" } });
					case "/whoami":
						return new Response(`<html><body><p id=c>cookie:${req.headers.get("cookie") ?? ""}</p></body></html>`, { headers: { "content-type": "text/html" } });
					case "/paper.pdf":
						return has ? new Response(PDF, { headers: { "content-type": "application/pdf" } }) : new Response("login required", { status: 401 });
					case "/download.pdf":
						return has
							? new Response(PDF, { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="dl.pdf"' } })
							: new Response("login required", { status: 401 });
					default:
						return new Response("not found", { status: 404 });
				}
			},
		});
		base = `http://127.0.0.1:${srv.port}`;
	});

	afterAll(async () => {
		setBrowserBridge(null);
		for (const b of bridges) await b.dispose().catch(() => {});
		srv?.stop(true);
		await sleep(1500);
		rmSync(join(signinProfileDir(), ".."), { recursive: true, force: true });
		rmSync(helperExePath(undefined, EXE), { force: true });
	});

	test("sign in through the window, then the core downloads the PDF with the session cookie", async () => {
		const bridge = newBridge();
		const c = controller(bridge);
		const ok = await c.open(1, { entry_url: `${base}/login`, realm: "mock", kind: "openathens", waiting: 1, timeout_ms: 30_000, capture_pdf: false } as any, new AbortController().signal);
		expect(ok.result).toBe("landed");
		expect(ok.final_url).toBe(`${base}/landed`);
		expect(hits.slice(0, 2)).toEqual(["/login", "/landed"]);
		// the cookie handoff: HttpOnly, so a page script could never have given it
		const cs = await bridge.cookiesFor(`${base}/paper.pdf`);
		expect(cs.find((x) => x.name === "sess")?.httpOnly).toBe(true);
		expect(cs.map((x) => x.name).sort()).toEqual(["keep", "sess"]);
		// the core's HTTP client, as the Find Full Text host drives it
		const http = new HttpClient();
		const req = { url: `${base}/paper.pdf`, method: "GET", timeout_ms: 10_000 } as any;
		const signedOut = await http.request(req, { signal: new AbortController().signal, sink: "memory" });
		expect(signedOut.status).toBe(401);
		const signedIn = await new HttpClient().request(req, { signal: new AbortController().signal, sink: "memory", cookieSource: (u) => bridge.cookiesFor(u) });
		expect(signedIn.status).toBe(200);
		expect(hasPdfMagic(signedIn.body!)).toBe(true);
		expect(signedIn.body!.length).toBe(PDF.length);
		await bridge.dispose();
	}, 60_000);

	test("hidden page loads share the session: the browser sends the cookie, PDF viewer and attachment are captured", async () => {
		const bridge = newBridge();
		const c = controller(bridge);
		await c.open(2, { entry_url: `${base}/login`, realm: "mock", kind: "openathens", waiting: 0, timeout_ms: 30_000, capture_pdf: false } as any, new AbortController().signal);
		const page = await bridge.load({ url: `${base}/whoami`, timeoutMs: 10_000, capturePdf: false }, new AbortController().signal);
		expect(page.pageHtml).toContain(`sess=${token}`);
		const viewer = await bridge.load({ url: `${base}/paper.pdf`, timeoutMs: 15_000, capturePdf: true }, new AbortController().signal);
		expect(viewer.pdf).toBeTruthy();
		expect(hasPdfMagic(viewer.pdf!.bytes)).toBe(true);
		const attach = await bridge.load({ url: `${base}/download.pdf`, timeoutMs: 15_000, capturePdf: true }, new AbortController().signal);
		expect(attach.pdf).toBeTruthy();
		expect(hasPdfMagic(attach.pdf!.bytes)).toBe(true);
		await bridge.dispose();
	}, 90_000);

	test("the sign-in survives the browser ending and the app restarting", async () => {
		// one app run: the browser ends when idle; the session cookie (which the browser forgets) is put back from memory
		const bridge = newBridge({ idleMs: 400 });
		await controller(bridge).open(3, { entry_url: `${base}/login`, realm: "mock", kind: "openathens", waiting: 0, timeout_ms: 30_000, capture_pdf: false } as any, new AbortController().signal);
		bridge.closeAll();
		for (let i = 0; i < 100 && bridge.helperRunning; i++) await sleep(100);
		expect(bridge.helperRunning).toBe(false);
		const page = await bridge.load({ url: `${base}/whoami`, timeoutMs: 10_000, capturePdf: false }, new AbortController().signal);
		expect(page.pageHtml).toContain(`sess=${token}`);
		expect(page.pageHtml).toContain("keep=1");
		await bridge.dispose();
		// a new app run: only the cookies the browser wrote to its profile remain
		await sleep(1000);
		expect(existsSync(signinProfileDir())).toBe(true);
		const next = newBridge();
		const cs = await next.cookiesFor(`${base}/paper.pdf`);
		expect(cs.map((x) => x.name)).toEqual(["keep"]);
	}, 90_000);
});
