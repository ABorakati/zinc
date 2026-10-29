import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullTextSettingsView, FullTextSignInResult, FullTextSignInStatus } from "../../src/api-types";
import { openDb } from "../../src/db";
import { handleFulltextApi } from "../../src/fulltext/api";
import { BodyStore } from "../../src/fulltext/bodies";
import {
	type BridgeCookie,
	type BrowserBridge,
	type BrowserLoadRequest,
	type BrowserLoadResult,
	type LoginRequest,
	type LoginSession,
	type LoginUserAction,
	setBrowserBridge,
} from "../../src/fulltext/browser-bridge";
import { buildEngineConfig } from "../../src/fulltext/config";
import { PersistStore, Runner } from "../../src/fulltext/host";
import { CookieJar, HttpClient, OpError } from "../../src/fulltext/http";
import { normalizeInstitution, parseProxyPrefix, resolveInstitution, searchPresets, warmupTarget } from "../../src/fulltext/institutions";
import { type DecideInput, decide, LoginController } from "../../src/fulltext/login";
import type { Command, CompletionMsg, Effect, LoginOk, LoginReq, LoginState, StepIn, StepOut } from "../../src/fulltext/proto";
import { disposeFulltextService, fulltextService } from "../../src/fulltext/service";
import { WasmHost } from "../../src/fulltext/wasm";

let wasm: WasmHost;
beforeAll(async () => {
	wasm = await WasmHost.load();
});
afterEach(() => setBrowserBridge(null));

// ---------------------------------------------------------------- fakes

const ARTICLE_URL = "https://www.nature.com/articles/s41586-020-2649-2";
const ARTICLE_HTML = "<html><head><meta name='citation_pdf_url' content='https://www.nature.com/a.pdf'><title>x</title></head><body>article</body></html>";
const CA_URL = "https://login.microsoftonline.com/x/login?secret=1";
const CA_HTML = "<html><body>AADSTS53000: Device is not in required device state: compliant.</body></html>";
const IDP_URL = "https://login.openathens.net/auth/x";
const PDF = new TextEncoder().encode(`%PDF-1.4\n${"% filler line of ordinary pdf comment text................\n".repeat(900)}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);

type Script = (n: number, s: FakeSession) => void;

class FakeSession implements LoginSession {
	polls = 0;
	cur = "";
	htmlOf: Record<string, string> = {};
	actionQ: LoginUserAction[] = [];
	isClosed = false;
	pdf: { bytes: Uint8Array; url: string } | null = null;
	banners: Record<string, unknown>[] = [];
	finished: { mode: string; ms?: number }[] = [];
	script: Script = () => {};
	constructor(
		private clock: { t: number },
		public req: LoginRequest,
	) {}
	url() {
		return this.cur;
	}
	async html() {
		return this.htmlOf[this.cur] ?? "";
	}
	takeActions() {
		const a = this.actionQ;
		this.actionQ = [];
		return a;
	}
	closed() {
		return this.isClosed;
	}
	capturedPdf() {
		return this.pdf;
	}
	setBanner(b: Record<string, unknown>) {
		this.banners.push(b);
	}
	async waitForChange(ms: number) {
		this.polls++;
		this.clock.t += ms;
		this.script(this.polls, this);
	}
	finish(mode: "close" | "standby", ms?: number) {
		this.finished.push({ mode, ms });
	}
}

class FakeBridge implements BrowserBridge {
	clock = { t: 0 };
	scripts: Script[] = [];
	opened: FakeSession[] = [];
	opens: LoginRequest[] = [];
	parked: FakeSession | null = null;
	waitingUpdates: [string, number][] = [];
	loadReqs: BrowserLoadRequest[] = [];
	loadResult: BrowserLoadResult = { finalUrl: "https://x.test/", status: 200, urlTrail: [], ms: 5 };
	cookies: BridgeCookie[] = [];
	cookieCalls: string[] = [];
	async openLogin(req: LoginRequest, signal: AbortSignal): Promise<LoginSession> {
		if (signal.aborted) throw new Error("aborted");
		this.opens.push(req);
		const script = this.scripts.shift() ?? (() => {});
		let s = this.parked;
		this.parked = null;
		if (s) {
			s.finished = [];
			s.req = req; // the parked window is reused: new session, old page still showing
		} else {
			const created = new FakeSession(this.clock, req);
			const orig = created.finish.bind(created);
			created.finish = (mode, ms) => {
				orig(mode, ms);
				if (mode === "standby") this.parked = created;
			};
			s = created;
			this.opened.push(s);
		}
		s.script = script;
		return s;
	}
	updateWaiting(realm: string, waiting: number) {
		this.waitingUpdates.push([realm, waiting]);
	}
	async load(req: BrowserLoadRequest): Promise<BrowserLoadResult> {
		this.loadReqs.push(req);
		return this.loadResult;
	}
	async cookiesFor(url: string) {
		this.cookieCalls.push(url);
		return this.cookies;
	}
	closeAll() {}
}

function tmpBodies() {
	const dir = mkdtempSync(join(tmpdir(), "zn-login-"));
	return { dir, bodies: new BodyStore(join(dir, "storage", ".tmp")) };
}

function controller(bridge: BrowserBridge | null, extra: Partial<ConstructorParameters<typeof LoginController>[0]> = {}) {
	const { bodies } = tmpBodies();
	const clock = bridge instanceof FakeBridge ? bridge.clock : { t: 0 };
	const c = new LoginController({
		bridge: () => bridge,
		wasm,
		bodies,
		now: () => clock.t,
		pollMs: 500,
		lingerMs: 0,
		...extra,
	});
	return { c, bodies };
}

const req = (o: Partial<LoginReq> = {}): LoginReq => ({
	kind: "login",
	realm: "openathens",
	entry_url: "https://go.openathens.net/redirector/ucl.ac.uk?url=x",
	item_title: "A paper",
	waiting: 2,
	timeout_ms: 60000,
	capture_pdf: false,
	...o,
});

/** pending on the IdP for `n` polls, then `then` */
const landAfter = (n: number): Script => (i, s) => {
	if (i < n) s.cur = IDP_URL;
	else {
		s.cur = ARTICLE_URL;
		s.htmlOf[ARTICLE_URL] = ARTICLE_HTML;
	}
};

const signal = () => new AbortController().signal;

// ---------------------------------------------------------------- decide (pure table)

describe("decide", () => {
	const base: DecideInput = { state: { state: "pending" }, elapsedMs: 0, timeoutMs: 60000, extended: false, windowClosed: false, userAction: null, pdfCaptured: false };
	const d = (o: Partial<DecideInput>) => decide({ ...base, ...o });
	test("priority: pdf > closed/skip > handoff > refused > landed > timeout", () => {
		const all: Partial<DecideInput> = { pdfCaptured: true, windowClosed: true, userAction: "handoff", state: { state: "landed" }, elapsedMs: 99999 };
		expect(d(all).done).toBe("pdf");
		expect(d({ ...all, pdfCaptured: false }).done).toBe("closed_by_user");
		expect(d({ ...all, pdfCaptured: false, windowClosed: false }).done).toBe("handoff");
		expect(d({ userAction: "skip", state: { state: "landed" } }).done).toBe("closed_by_user");
		expect(d({ state: { state: "refused", code: "AADSTS53000" }, elapsedMs: 99999 })).toEqual({ done: "ca_blocked", caError: "AADSTS53000" });
		expect(d({ state: { state: "refused" } })).toEqual({ done: "ca_blocked", caError: null });
		expect(d({ state: { state: "landed" }, elapsedMs: 99999 }).done).toBe("landed");
		expect(d({ elapsedMs: 60000 }).done).toBe("timeout");
	});
	test("keep-waiting offered at 75 % and extends once", () => {
		expect(d({ elapsedMs: 44999 }).offerKeepWaiting).toBeUndefined();
		expect(d({ elapsedMs: 45000 })).toEqual({ done: null, offerKeepWaiting: true });
		expect(d({ elapsedMs: 60000, userAction: "keep_waiting" })).toEqual({ done: null, extend: true });
		expect(d({ elapsedMs: 120000, userAction: "keep_waiting", extended: true }).done).toBe("timeout");
		expect(d({ elapsedMs: 100000, extended: true }).offerKeepWaiting).toBeUndefined();
	});
	test("challenge hint", () => {
		expect(d({ state: { state: "challenge_shown" } })).toEqual({ done: null, showChallengeHint: true });
	});
});

// ---------------------------------------------------------------- controller

describe("LoginController", () => {
	test("landed after N polls: page staged, inspected, window parked", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push(landAfter(4));
		const { c, bodies } = controller(bridge);
		const ok = await c.open(7, req(), signal());
		expect(ok.result).toBe("landed");
		expect(ok.final_url).toBe(ARTICLE_URL);
		expect(ok.page?.len).toBe(new TextEncoder().encode(ARTICLE_HTML).length);
		expect(new TextDecoder().decode(bodies.get(ok.page!.handle)!.mem!)).toBe(ARTICLE_HTML);
		expect(typeof ok.inspect.expect).toBe("string");
		expect(ok.inspect.expect).not.toBe("none");
		const s = bridge.opened[0];
		expect(s.polls).toBe(4);
		expect(s.finished).toEqual([{ mode: "standby", ms: 120000 }]);
		expect(bridge.opens[0]).toMatchObject({ entryUrl: req().entry_url, realm: "openathens", kind: "login", waiting: 2, capturePdf: false });
		expect(s.banners[0]).toMatchObject({ waiting: 2, challengeHint: false });
		expect(c.signedInAt).toBeGreaterThan(0);
	});

	test("closed by the user", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 3) s.isClosed = true;
		});
		const { c } = controller(bridge);
		const ok = await c.open(1, req(), signal());
		expect(ok.result).toBe("closed_by_user");
		expect(ok.page).toBeUndefined();
		expect(bridge.opened[0].finished).toEqual([{ mode: "close", ms: undefined }]);
		expect(c.signedInAt).toBe(0);
	});

	test("Skip button", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 2) s.actionQ.push("skip");
		});
		const ok = await controller(bridge).c.open(1, req(), signal());
		expect(ok.result).toBe("closed_by_user");
	});

	test("hand-off opens the entry URL in the user's browser and closes the window", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 2) s.actionQ.push("handoff");
		});
		const opened: string[] = [];
		const { c } = controller(bridge, { openExternal: (u) => opened.push(u) });
		const ok = await c.open(1, req(), signal());
		expect(ok.result).toBe("handoff");
		expect(ok.final_url).toBe(IDP_URL); // the page the window was on, query stripped
		expect(opened).toEqual([req().entry_url]);
		expect(bridge.opened[0].finished[0].mode).toBe("close");
	});

	test("timeout, with the keep-waiting offer at 75 % and one extension", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((_n, s) => (s.cur = IDP_URL));
		const r1 = await controller(bridge).c.open(1, req({ timeout_ms: 5000 }), signal());
		expect(r1.result).toBe("timeout");
		const s1 = bridge.opened[0];
		expect(s1.polls).toBe(10); // 5000 ms / 500 ms
		const offer = s1.banners.findIndex((b) => b.offerKeepWaiting === true);
		expect(offer).toBeGreaterThan(0);
		expect(s1.banners.length).toBeGreaterThan(offer); // offered once, before the timeout

		// the user clicks Keep waiting when offered: the timeout doubles, then ends
		const b2 = new FakeBridge();
		b2.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 8) s.actionQ.push("keep_waiting");
		});
		const r2 = await controller(b2).c.open(1, req({ timeout_ms: 5000 }), signal());
		expect(r2.result).toBe("timeout");
		expect(b2.opened[0].polls).toBe(20);
		expect(b2.opened[0].banners.some((b) => b.offerKeepWaiting === false)).toBe(true);
	});

	test("ca_blocked from a real fx_login_state on an Entra page", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((_n, s) => {
			s.cur = CA_URL;
			s.htmlOf[CA_URL] = CA_HTML;
		});
		const ok = await controller(bridge).c.open(1, req(), signal());
		expect(ok.result).toBe("ca_blocked");
		expect(ok.ca_error).toBe("AADSTS53000");
		expect(ok.final_url).toBe("https://login.microsoftonline.com/x/login"); // no query
		expect(bridge.opened[0].finished[0].mode).toBe("close");
		expect(bridge.opened[0].banners.some((b) => typeof b.status === "string")).toBe(true);
	});

	test("challenge page keeps the window open and shows the hint (loginState stub)", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			s.htmlOf[IDP_URL] = "x";
			if (n === 6) s.isClosed = true;
		});
		let calls = 0;
		const stub = {
			inspect: wasm.inspect.bind(wasm),
			loginState: (): LoginState => ({ state: ++calls < 3 ? "challenge_shown" : "pending" }),
		};
		const { c } = controller(bridge, { wasm: stub });
		const ok = await c.open(1, req(), signal());
		expect(ok.result).toBe("closed_by_user");
		const hints = bridge.opened[0].banners.filter((b) => "challengeHint" in b).map((b) => b.challengeHint);
		expect(hints).toContain(true);
		expect(hints.at(-1)).toBe(false);
	});

	test("a PDF captured after sign-in is staged as a PDF body with a Pdf inspect", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 3) s.pdf = { bytes: PDF, url: "https://pub.example.org/paper.pdf" };
		});
		const { c, bodies } = controller(bridge);
		const ok = await c.open(5, req({ capture_pdf: true }), signal());
		expect(ok.result).toBe("pdf");
		expect(ok.final_url).toBe("https://pub.example.org/paper.pdf");
		expect(ok.pdf?.len).toBe(PDF.length);
		const info = bodies.get(ok.pdf!.handle)!;
		expect(existsSync(info.path!)).toBe(true);
		expect(readFileSync(info.path!).length).toBe(PDF.length);
		expect(ok.inspect.expect).toBe("pdf");
		expect(bridge.opened[0].finished[0].mode).toBe("standby");
		expect(bridge.opens[0].capturePdf).toBe(true);
	});

	test("standby reuse: the second LoginWindow takes the parked window and ignores its stale page", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push(landAfter(2));
		bridge.scripts.push((n, s) => {
			// the old publisher page is still showing for 3 polls, then the new route's IdP, then it lands
			if (n >= 6) {
				s.cur = "https://www.sciencedirect.com/science/article/pii/S0";
				s.htmlOf[s.cur] = ARTICLE_HTML;
			} else if (n >= 4) s.cur = IDP_URL;
		});
		const { c } = controller(bridge);
		const first = await c.open(1, req(), signal());
		expect(first.result).toBe("landed");
		expect(bridge.parked).toBe(bridge.opened[0]);
		const second = await c.open(1, req({ realm: "saml", entry_url: "https://sp.nature.com/saml/login?idp=x" }), signal());
		expect(second.result).toBe("landed");
		expect(bridge.opened).toHaveLength(1); // same window
		expect(bridge.opens).toHaveLength(2);
		expect(bridge.opened[0].polls).toBe(6); // cumulative: 2 for the first route, then 3 polls on the stale page / IdP, landing at the 6th
	});

	test("single flight: a concurrent login waits for the open window; a warm-up joins it", async () => {
		const bridge = new FakeBridge();
		let releaseFirst!: () => void;
		const gate = new Promise<void>((r) => (releaseFirst = r));
		bridge.scripts.push(landAfter(2), landAfter(2));
		const orig = bridge.openLogin.bind(bridge);
		let opens = 0;
		bridge.openLogin = async (r, sig) => {
			opens++;
			if (opens === 1) await gate;
			return orig(r, sig);
		};
		const { c } = controller(bridge);
		const p1 = c.open(1, req({ realm: "openathens" }), signal());
		const p2 = c.open(1, req({ realm: "openathens" }), signal());
		const warm = c.warmUp("https://go.openathens.net/redirector/x?url=y", "openathens", 60000, signal());
		await new Promise((r) => setTimeout(r, 20));
		expect(opens).toBe(1); // p2 and the warm-up did not open a second window
		releaseFirst();
		const [a, b, w] = await Promise.all([p1, p2, warm]);
		expect(a.result).toBe("landed");
		expect(b.result).toBe("landed");
		expect(w.result).toBe("landed"); // joined p1's result
		expect(opens).toBe(2); // p2 ran after p1 (on the parked window)
		expect(bridge.opened).toHaveLength(1);
	});

	test("login_update forwards the waiting count to the window", async () => {
		const bridge = new FakeBridge();
		const { c } = controller(bridge);
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 2) c.update(5);
			if (n === 3) s.isClosed = true;
		});
		await c.open(1, req(), signal());
		expect(bridge.waitingUpdates).toEqual([["openathens", 5]]);
		expect(bridge.opened[0].banners.some((b) => b.waiting === 5)).toBe(true);
		c.update(9); // no window: harmless
		expect(bridge.waitingUpdates).toHaveLength(1);
	});

	test("the op's AbortSignal closes the window and rejects with cancelled", async () => {
		const bridge = new FakeBridge();
		const ac = new AbortController();
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 3) ac.abort("run cancelled");
		});
		const { c } = controller(bridge);
		const err = await c.open(1, req(), ac.signal).catch((e) => e);
		expect(err).toBeInstanceOf(OpError);
		expect(err.kind).toBe("cancelled");
		expect(bridge.opened[0].finished.at(-1)?.mode).toBe("close");
		expect(c.active).toBe(false);
	});

	test("an entry URL that is not http(s) never reaches the browser", async () => {
		const bridge = new FakeBridge();
		const ok = await controller(bridge).c.open(1, req({ entry_url: "file:///etc/passwd" }), signal());
		expect(ok.result).toBe("closed_by_user");
		expect(bridge.opens).toHaveLength(0);
	});

	test("no bridge: handoff and unavailable, as before", async () => {
		const { c } = controller(null);
		const ok = await c.open(1, req(), signal());
		expect(ok).toEqual({ result: "handoff", final_url: req().entry_url, inspect: { expect: "none" } });
		expect((await c.warmUp("https://x.test/", "x", 1000, signal())).result).toBe("unavailable");
	});
});

// ---------------------------------------------------------------- Runner (effects)

type StepFn = (n: number, input: StepIn) => Effect[];

function fakeEngine(effects: StepFn) {
	const completions: CompletionMsg[] = [];
	let n = 0;
	const eng = {
		step(input: StepIn): StepOut {
			n++;
			completions.push(...input.completions);
			return { effects: effects(n, input), next_timer: null, more: false, ignored: [], stats: {} };
		},
		inspect: wasm.inspect.bind(wasm),
		loginState: wasm.loginState.bind(wasm),
		resetEngine() {},
	};
	return { eng: eng as unknown as WasmHost, completions };
}

async function until(f: () => boolean, ms = 3000) {
	const t0 = Date.now();
	while (!f()) {
		if (Date.now() - t0 > ms) throw new Error("timeout waiting");
		await new Promise((r) => setTimeout(r, 5));
	}
}

function runner(eng: WasmHost, bridge: BrowserBridge | null, http = new HttpClient({ fetch: async () => new Response("no", { status: 404 }) })) {
	const { dir, bodies } = tmpBodies();
	const r = new Runner(
		{
			wasm: eng,
			http,
			bodies,
			state: new PersistStore(null),
			save: () => ({ attachment_key: "K", filename: "f.pdf" }),
			onProgress: () => {},
			onRunFinished: () => {},
			bridge: () => bridge,
			onLog: () => {},
		},
		{},
	);
	return { r, bodies, dir, http };
}

const kick: Command[] = [{ type: "dump_state" }];

describe("Runner: login_window / browser_load / cookies", () => {
	test("login_window with a bridge drives the window and answers LoginOk", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push(landAfter(2));
		const { eng, completions } = fakeEngine((n) => (n === 1 ? [{ type: "login_window", op: 11, run: 1, req: req() }] : []));
		const { r } = runner(eng, bridge);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 11));
		const ok = completions.find((c) => c.op === 11)!.ok as LoginOk;
		expect(ok.result).toBe("landed");
		expect(ok.page?.handle).toBeGreaterThan(0);
		await r.dispose();
	});

	test("login_window without a bridge answers handoff", async () => {
		const { eng, completions } = fakeEngine((n) => (n === 1 ? [{ type: "login_window", op: 12, run: 1, req: req() }] : []));
		const { r } = runner(eng, null);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 12));
		expect(completions[0].ok).toEqual({ result: "handoff", final_url: req().entry_url, inspect: { expect: "none" } });
		await r.dispose();
	});

	test("login_update tells the open window and completes its own op", async () => {
		const bridge = new FakeBridge();
		let ctlRef: LoginController | null = null;
		bridge.scripts.push((n, s) => {
			s.cur = IDP_URL;
			if (n === 5) s.isClosed = true;
		});
		const { eng, completions } = fakeEngine((n) => {
			if (n === 1) return [{ type: "login_window", op: 21, run: 1, req: req() }];
			if (n === 2) return [{ type: "login_update", op: 22, waiting: 4 }];
			return [];
		});
		const { r } = runner(eng, bridge);
		ctlRef = r.login;
		expect(ctlRef.active).toBe(false);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 22));
		await until(() => completions.some((c) => c.op === 21));
		expect(completions.find((c) => c.op === 22)!.ok).toEqual({});
		await r.dispose();
	});

	test("browser_load without a bridge is unsupported", async () => {
		const { eng, completions } = fakeEngine((n) =>
			n === 1 ? [{ type: "browser_load", op: 31, run: 1, item: 1, route: "inst", req: { url: "https://x.test/", timeout_ms: 1000 }, inspect: { expect: "page", requested: {}, route: "inst" } }] : [],
		);
		const { r } = runner(eng, null);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 31));
		expect(completions[0].err?.kind).toBe("unsupported");
		await r.dispose();
	});

	test("browser_load PDF becomes a PDF body with an {expect: 'pdf'} inspect", async () => {
		const bridge = new FakeBridge();
		bridge.loadResult = { finalUrl: "https://pub.example.org/p.pdf", status: 200, urlTrail: ["https://a.test/x", "https://pub.example.org/p.pdf"], pdf: { bytes: PDF, url: "https://pub.example.org/p.pdf" }, ms: 40 };
		const { eng, completions } = fakeEngine((n) =>
			n === 1
				? [{ type: "browser_load", op: 32, run: 1, item: 1, route: "inst", req: { url: "https://x.test/a", timeout_ms: 9000, capture_pdf: true, ua: "plain" }, inspect: { expect: "page", requested: {}, route: "inst" } }]
				: [],
		);
		const { r, bodies } = runner(eng, bridge);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 32));
		const ok = completions[0].ok as any;
		expect(bridge.loadReqs[0]).toEqual({ url: "https://x.test/a", timeoutMs: 9000, capturePdf: true, userAgent: "plain" });
		expect(ok.final_url).toBe("https://pub.example.org/p.pdf");
		expect(ok.status).toBe(200);
		expect(ok.url_trail).toHaveLength(2);
		expect(ok.pdf.len).toBe(PDF.length);
		expect(ok.page).toBeNull();
		expect(ok.inspect.expect).toBe("pdf");
		expect(readFileSync(bodies.get(ok.pdf.handle)!.path!).length).toBe(PDF.length);
		await r.dispose();
	});

	test("browser_load page becomes a memory body inspected with the effect's spec", async () => {
		const bridge = new FakeBridge();
		bridge.loadResult = { finalUrl: ARTICLE_URL, status: 0, urlTrail: [ARTICLE_URL], pageHtml: ARTICLE_HTML, ms: 12 };
		const { eng, completions } = fakeEngine((n) =>
			n === 1 ? [{ type: "browser_load", op: 33, run: 1, item: 1, route: "inst", req: { url: ARTICLE_URL, timeout_ms: 9000 }, inspect: { expect: "page", requested: {}, route: "inst" } }] : [],
		);
		const { r, bodies } = runner(eng, bridge);
		r.send(kick);
		await until(() => completions.some((c) => c.op === 33));
		const ok = completions[0].ok as any;
		expect(ok.pdf).toBeNull();
		expect(ok.status).toBeNull(); // unknown status
		expect(new TextDecoder().decode(bodies.get(ok.page.handle)!.mem!)).toBe(ARTICLE_HTML);
		expect(ok.inspect.expect).not.toBe("none");
		expect(typeof ok.inspect.expect).toBe("string");
		await r.dispose();
	});

	test("institutional http requests get the browser's cookies, open access ones do not", async () => {
		const bridge = new FakeBridge();
		bridge.cookies = [{ name: "sid", value: "SECRET", domain: ".example.org", path: "/", secure: true, httpOnly: true }];
		const seen: Record<string, string | null> = {};
		const http = new HttpClient({
			fetch: async (url, init) => {
				seen[url] = new Headers(init?.headers as any).get("cookie");
				return new Response("ok", { headers: { "content-type": "text/html" } });
			},
		});
		const mk = (op: number, route: "oa" | "inst", url: string): Effect => ({
			type: "http",
			op,
			run: 1,
			item: 1,
			route,
			req: { method: "get", url, headers: {}, ua: "plain", timeout_ms: 5000, follow_redirects: true, max_bytes: 100000 },
			retain: "none",
			inspect: { expect: "page", requested: {}, route },
		});
		const { eng, completions } = fakeEngine((n) =>
			n === 1 ? [mk(41, "inst", "https://pub.example.org/a"), mk(42, "oa", "https://pub.example.org/b")] : [],
		);
		const { r } = runner(eng, bridge, http);
		r.send(kick);
		await until(() => completions.filter((c) => c.op === 41 || c.op === 42).length === 2);
		expect(seen["https://pub.example.org/a"]).toBe("sid=SECRET");
		// route oa: the bridge is not asked (but a cookie merged by the inst request may already sit in the shared jar)
		expect(bridge.cookieCalls).toEqual(["https://pub.example.org/a"]);
		await r.dispose();
	});
});

describe("Runner: institutional fetches after a sign-in go through the browser", () => {
	const httpEff = (op: number, route: "oa" | "inst", url: string, expect: string, retain: "none" | "page" | "pdf", method: "get" | "post" = "get"): Effect => ({
		type: "http",
		op,
		run: 1,
		item: 1,
		route,
		req: { method, url, headers: {}, ua: "plain", timeout_ms: 7000, follow_redirects: true, max_bytes: 10_000_000 },
		retain,
		inspect: { expect, requested: {}, route },
	});
	let fetched: string[] = [];
	const http = () =>
		new HttpClient({
			fetch: async (url) => {
				fetched.push(url);
				return new Response("<html>plain</html>", { headers: { "content-type": "text/html" } });
			},
		});

	test("signed in: an inst page GET is loaded by the browser and answered as HttpOk", async () => {
		fetched = [];
		const bridge = new FakeBridge();
		bridge.loadResult = { finalUrl: ARTICLE_URL, status: 200, urlTrail: [], pageHtml: ARTICLE_HTML, ms: 9 };
		const { eng, completions } = fakeEngine((n) => (n === 1 ? [httpEff(51, "inst", ARTICLE_URL, "page", "page")] : []));
		const { r, bodies } = runner(eng, bridge, http());
		r.login.markSignedIn();
		r.send(kick);
		await until(() => completions.some((c) => c.op === 51));
		const ok = completions[0].ok as any;
		expect(fetched).toEqual([]);
		expect(bridge.loadReqs[0]).toEqual({ url: ARTICLE_URL, timeoutMs: 7000, capturePdf: true, userAgent: "plain" });
		expect(ok).toMatchObject({ status: 200, final_url: ARTICLE_URL });
		expect(new TextDecoder().decode(bodies.get(ok.body.handle)!.mem!)).toBe(ARTICLE_HTML);
		expect(ok.inspect.expect).toBe("page");
		await r.dispose();
	});

	test("signed in: a PDF the browser gets is returned as a retained PDF body with a Pdf inspect", async () => {
		const bridge = new FakeBridge();
		bridge.loadResult = { finalUrl: "https://pub.example.org/p.pdf", status: 200, urlTrail: [], pdf: { bytes: PDF, url: "https://pub.example.org/p.pdf" }, ms: 9 };
		const { eng, completions } = fakeEngine((n) => (n === 1 ? [httpEff(52, "inst", "https://pub.example.org/p.pdf", "pdf", "pdf")] : []));
		const { r, bodies } = runner(eng, bridge, http());
		r.login.markSignedIn();
		r.send(kick);
		await until(() => completions.some((c) => c.op === 52));
		const ok = completions[0].ok as any;
		expect(ok.inspect.expect).toBe("pdf");
		expect(ok.bytes).toBe(PDF.length);
		expect(readFileSync(bodies.get(ok.body.handle)!.path!).length).toBe(PDF.length);
		await r.dispose();
	});

	test("not signed in, other routes, API specs and POSTs keep using HTTP; a failing browser falls back to HTTP", async () => {
		fetched = [];
		const bridge = new FakeBridge();
		const { eng, completions } = fakeEngine((n) =>
			n === 1
				? [
						httpEff(61, "inst", "https://a.test/page", "page", "none"), // not signed in
						httpEff(62, "oa", "https://b.test/page", "page", "none"),
					]
				: n === 2
					? [httpEff(63, "inst", "https://c.test/post", "page", "none", "post"), httpEff(64, "inst", "https://d.test/api", "api", "none")]
					: [],
		);
		const { r } = runner(eng, bridge, http());
		r.send(kick);
		await until(() => completions.filter((c) => c.op === 61 || c.op === 62).length === 2);
		r.login.markSignedIn();
		r.send(kick);
		await until(() => completions.filter((c) => c.op === 63 || c.op === 64).length === 2);
		expect(bridge.loadReqs).toEqual([]);
		expect(fetched.sort()).toEqual(["https://a.test/page", "https://b.test/page", "https://c.test/post", "https://d.test/api"]);
		await r.dispose();

		fetched = [];
		const failing = new FakeBridge();
		failing.load = async () => {
			throw new Error("window crashed");
		};
		const e2 = fakeEngine((n) => (n === 1 ? [httpEff(71, "inst", "https://e.test/page", "page", "none")] : []));
		const r2 = runner(e2.eng, failing, http());
		r2.r.login.markSignedIn();
		r2.r.send(kick);
		await until(() => e2.completions.some((c) => c.op === 71));
		expect(fetched).toEqual(["https://e.test/page"]);
		expect((e2.completions[0].ok as any).status).toBe(200);
		await r2.r.dispose();
	});

	test("institutionName reaches the bridge on LoginRequest", async () => {
		const bridge = new FakeBridge();
		bridge.scripts.push(landAfter(1));
		const { c } = controller(bridge, { institutionName: () => "University College London" });
		await c.open(1, req(), signal());
		expect((bridge.opens[0] as any).institutionName).toBe("University College London");
	});
});

describe("CookieJar.merge", () => {
	const c = (o: Partial<BridgeCookie>): BridgeCookie => ({ name: "n", value: "v", domain: ".example.org", path: "/", secure: false, httpOnly: false, ...o });
	test("domain, host-only, path, secure and expiry are respected", () => {
		const jar = new CookieJar();
		const future = Math.floor(Date.now() / 1000) + 3600;
		const n = jar.merge([
			c({ name: "dom", domain: ".example.org" }),
			c({ name: "host", domain: "www.example.org" }),
			c({ name: "path", path: "/private" }),
			c({ name: "sec", secure: true }),
			c({ name: "old", expires: Math.floor(Date.now() / 1000) - 5 }),
			c({ name: "fut", expires: future }),
			c({ name: "other", domain: ".other.org" }),
		]);
		expect(n).toBe(6); // the expired one is dropped
		const names = (url: string) =>
			jar
				.header(url)
				.split("; ")
				.filter(Boolean)
				.map((x) => x.split("=")[0])
				.sort();
		expect(names("https://www.example.org/")).toEqual(["dom", "fut", "host", "sec"]);
		expect(names("https://api.example.org/")).toEqual(["dom", "fut", "sec"]); // host-only cookie stays on www
		expect(names("http://www.example.org/")).toEqual(["dom", "fut", "host"]); // secure only over https
		expect(names("https://www.example.org/private/x")).toEqual(["dom", "fut", "host", "path", "sec"]);
		expect(names("https://www.other.org/")).toEqual(["other"]);
	});
	test("a cookie the engine got later wins over the browser's copy, unless forced", () => {
		const jar = new CookieJar();
		jar.merge([c({ value: "browser1" })]);
		jar.merge([c({ value: "browser2" })]); // browser cookies update each other
		expect(jar.header("https://example.org/")).toBe("n=browser2");
		jar.store("https://example.org/", ["n=engine; Domain=example.org; Path=/"]);
		jar.merge([c({ value: "browser3" })]);
		expect(jar.header("https://example.org/")).toBe("n=engine");
		jar.merge([c({ value: "browser3" })], true);
		expect(jar.header("https://example.org/")).toBe("n=browser3");
	});
});

// ---------------------------------------------------------------- institutions, settings, API

describe("institutions and settings", () => {
	test("no institution configured = the engine default, unchanged", () => {
		const cfg = buildEngineConfig({});
		expect(cfg.institution).toMatchObject({ name: "King's College London", openathens_domain: "kcl.ac.uk", ezproxy: { login_host: "login.kcl.idm.oclc.org", suffix: "kcl.idm.oclc.org" }, libkey_library_id: 286 });
		expect(cfg.inst).toMatchObject({ enabled: true, use_openathens: true, use_saml: true, use_ezproxy: true, check_alma: true, login_mode: "handoff" });
	});

	test("login_mode becomes window with an embedded browser unless the settings force a hand-off", () => {
		expect(buildEngineConfig({}, { embeddedBrowser: true }).inst).toMatchObject({ login_mode: "window" });
		expect(buildEngineConfig({ institution: { name: "X", loginMode: "handoff" } }, { embeddedBrowser: true }).inst).toMatchObject({ login_mode: "handoff" });
		expect(buildEngineConfig({ engine: { inst: { login_mode: "handoff" } } }, { embeddedBrowser: true }).inst).toMatchObject({ login_mode: "handoff" });
	});

	test("a chosen institution drives the engine config; nothing of KCL leaks in", () => {
		const cfg = buildEngineConfig({ institution: normalizeInstitution({ id: "ucl", name: "University College London", openathensDomain: "ucl.ac.uk", shibbolethEntityId: "https://shib-idp.ucl.ac.uk/shibboleth", proxyPrefix: "" }) });
		const i = cfg.institution as any;
		expect(i.name).toBe("University College London");
		expect(i.openathens_domain).toBe("ucl.ac.uk");
		expect(i.saml_entity_id).toBe("https://shib-idp.ucl.ac.uk/shibboleth");
		expect(i.ezproxy).toBeNull();
		expect(i.alma).toBeNull();
		expect(i.entra_tenant).toBeNull();
		expect(i.libkey_library_id).toBeNull();
		expect(JSON.stringify(cfg)).not.toMatch(/kcl/i);
		expect(cfg.inst).toMatchObject({ use_openathens: true, use_saml: true, use_ezproxy: false, check_alma: false });
	});

	test("none = open access only; custom proxy needs a valid address", () => {
		expect(buildEngineConfig({ institution: normalizeInstitution({ id: "none", name: "" }) }).inst).toMatchObject({ enabled: false });
		const r = resolveInstitution(normalizeInstitution({ id: "other", name: "Uni of Nowhere", proxyPrefix: "https://login.nowhere.idm.oclc.org/login?url=" }));
		expect(r.engine.ezproxy).toEqual({ login_host: "login.nowhere.idm.oclc.org", suffix: "nowhere.idm.oclc.org" });
		expect(r.engine.ezproxy_all_hosts).toBe(true);
		expect(() => normalizeInstitution({ id: "other", name: "X", proxyPrefix: "https://a.b.org/some/path" })).toThrow();
		expect(() => normalizeInstitution({ id: "other", name: "X", openathensDomain: "not a domain" })).toThrow();
		expect(() => normalizeInstitution({ id: "other", name: "X", shibbolethEntityId: "idp.x.org" })).toThrow();
		expect(() => normalizeInstitution({ id: "other", name: "" })).toThrow();
		expect(parseProxyPrefix("login.x.idm.oclc.org").ok).toBe(true);
	});

	test("warm-up target: OpenAthens redirector, else proxy, else Shibboleth", () => {
		const t = (o: object) => warmupTarget(resolveInstitution(normalizeInstitution({ id: "other", name: "X", ...o })).engine);
		expect(t({ openathensDomain: "ucl.ac.uk" })).toEqual({
			url: "https://go.openathens.net/redirector/ucl.ac.uk?url=https%3A%2F%2Fwww.nature.com%2F",
			realm: "openathens",
		});
		expect(t({ proxyPrefix: "login.x.idm.oclc.org", shibbolethEntityId: "https://idp.x.org/shib" })?.realm).toBe("ezproxy");
		expect(t({ shibbolethEntityId: "https://idp.x.org/shib" })?.url).toContain("sp.nature.com/saml/login?idp=https%3A%2F%2Fidp.x.org%2Fshib");
		expect(t({})).toBeNull();
	});

	test("preset search", () => {
		expect(searchPresets("king").map((p) => p.id)).toEqual(["kcl"]);
		expect(searchPresets("univ college").map((p) => p.id)).toEqual(["ucl"]);
		expect(searchPresets("").length).toBeGreaterThan(20);
	});
});

describe("Find Full Text API: settings, institutions, sign-in", () => {
	const dbs: ReturnType<typeof openDb>[] = [];
	afterAll(async () => {
		for (const db of dbs) {
			await disposeFulltextService(db);
			db.close(true);
		}
	});

	function setup(fetchMock: (url: string) => Response = () => new Response("{}", { status: 404 })) {
		const dir = mkdtempSync(join(tmpdir(), "zn-ftapi-"));
		const db = openDb(join(dir, "library.sqlite"));
		dbs.push(db);
		const svc = fulltextService(db, { wasm, fetch: async (url) => fetchMock(url) });
		const call = async (method: string, path: string, body?: unknown) =>
			handleFulltextApi(new Request(`http://localhost/api/fulltext${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), db);
		return { dir, svc, call };
	}

	test("settings GET/PUT round-trip, persisted to fulltext-settings.json, bad input rejected", async () => {
		const { dir, call } = setup();
		const v0 = (await (await call("GET", "/settings"))!.json()) as FullTextSettingsView;
		expect(v0.isDefaultInstitution).toBe(true);
		expect(v0.institution.name).toBe("King's College London");
		expect(v0.embeddedBrowser).toBe(false);

		const put = await call("PUT", "/settings", {
			institution: { id: "ucl", name: "University College London", openathensDomain: "ucl.ac.uk", shibbolethEntityId: "https://shib-idp.ucl.ac.uk/shibboleth", proxyPrefix: "", loginMode: "window" },
			unpaywallEmail: "me@ucl.ac.uk",
		});
		expect(put!.status).toBe(200);
		const v1 = (await put!.json()) as FullTextSettingsView;
		expect(v1.institution).toMatchObject({ id: "ucl", name: "University College London", openathensDomain: "ucl.ac.uk", proxyPrefix: "", realm: "ucl", loginMode: "window" });
		expect(v1.methods).toEqual(["openathens", "saml"]);
		expect(v1.unpaywallEmail).toBe("me@ucl.ac.uk");
		expect(v1.isDefaultInstitution).toBe(false);
		const file = JSON.parse(readFileSync(join(dir, "fulltext-settings.json"), "utf8"));
		expect(file.institution.openathensDomain).toBe("ucl.ac.uk");
		expect(file.unpaywallEmail).toBe("me@ucl.ac.uk");

		expect((await call("PUT", "/settings", { unpaywallEmail: "nope" }))!.status).toBe(400);
		expect((await call("PUT", "/settings", { institution: { id: "other", name: "X", openathensDomain: "bad domain" } }))!.status).toBe(400);
		expect((await call("PUT", "/settings", { concurrency: 99 }))!.status).toBe(400);

		const back = (await (await call("PUT", "/settings", { institution: null }))!.json()) as FullTextSettingsView;
		expect(back.isDefaultInstitution).toBe(true);
		expect(back.institution.name).toBe("King's College London");
	});

	test("institutions search: presets, then federation hits for 3+ characters; offline is fine", async () => {
		const urls: string[] = [];
		const { call } = setup((url) => {
			urls.push(url);
			return Response.json([
				{ type: "idp", entityID: "https://idp.nowhere.ac.uk/shibboleth", title: "University of Nowhere", domain: "nowhere.ac.uk", registrationAuthority: ["http://ukfederation.org.uk"] },
				{ type: "idp", entityID: "https://kclidp.kcl.ac.uk/idp/shibboleth", title: "King's College London" },
				{ type: "idp", entityID: "https://hidden.example/idp", title: "Hidden", hidden: true },
			]);
		});
		const short = (await (await call("GET", "/institutions?q=ki"))!.json()) as any[];
		expect(short.map((h) => h.id)).toEqual(["kcl"]);
		expect(urls).toEqual([]); // 2 characters: nothing is sent
		const hits = (await (await call("GET", "/institutions?q=king"))!.json()) as any[];
		expect(urls[0]).toBe("https://md.seamlessaccess.org/entities/?q=king");
		expect(hits[0]).toMatchObject({ id: "kcl", source: "preset", methods: ["openathens", "saml", "ezproxy"] });
		expect(hits.find((h) => h.name === "University of Nowhere")).toMatchObject({ source: "federation", shibbolethEntityId: "https://idp.nowhere.ac.uk/shibboleth", methods: ["saml"] });
		expect(hits.filter((h) => h.shibbolethEntityId === "https://kclidp.kcl.ac.uk/idp/shibboleth")).toHaveLength(1); // deduplicated against the preset
		expect(hits.some((h) => h.name === "Hidden")).toBe(false);

		const offline = setup(() => {
			throw new Error("offline");
		});
		expect(((await (await offline.call("GET", "/institutions?q=king"))!.json()) as any[]).map((h) => h.id)).toEqual(["kcl"]);
	});

	test("sign-in without a bridge: unavailable; status not available", async () => {
		const { call } = setup();
		const r = (await (await call("POST", "/sign-in"))!.json()) as FullTextSignInResult;
		expect(r).toEqual({ result: "unavailable", institution: "King's College London" });
		const st = (await (await call("GET", "/sign-in/status"))!.json()) as FullTextSignInStatus;
		expect(st).toMatchObject({ available: false, signedIn: false, institution: "King's College London" });
	});

	test("sign-in with a bridge uses the configured institution; status follows", async () => {
		const bridge = new FakeBridge();
		setBrowserBridge(bridge);
		bridge.scripts.push(landAfter(2));
		const { call } = setup();
		await call("PUT", "/settings", { institution: { id: "ucl", name: "University College London", openathensDomain: "ucl.ac.uk", shibbolethEntityId: "", proxyPrefix: "" } });
		const st0 = (await (await call("GET", "/sign-in/status"))!.json()) as FullTextSignInStatus;
		expect(st0).toMatchObject({ available: true, signedIn: false, realm: "ucl", institution: "University College London" });
		const r = (await (await call("POST", "/sign-in"))!.json()) as FullTextSignInResult;
		expect(r).toEqual({ result: "landed", institution: "University College London" });
		expect(bridge.opens[0]).toMatchObject({
			entryUrl: "https://go.openathens.net/redirector/ucl.ac.uk?url=https%3A%2F%2Fwww.nature.com%2F",
			realm: "openathens",
			kind: "warmup",
			capturePdf: false,
		});
		expect(bridge.opened[0].finished[0].mode).toBe("close"); // the warm-up window is not parked
		const st1 = (await (await call("GET", "/sign-in/status"))!.json()) as FullTextSignInStatus;
		expect(st1.signedIn).toBe(true);
		expect(JSON.stringify(bridge.opens)).not.toMatch(/kcl/i);
	});

	test("status is signed in when the session holds cookies for the OpenAthens host", async () => {
		const bridge = new FakeBridge();
		bridge.cookies = [{ name: "oa", value: "x", domain: ".openathens.net", path: "/", secure: true, httpOnly: true }];
		setBrowserBridge(bridge);
		const { call } = setup();
		const st = (await (await call("GET", "/sign-in/status"))!.json()) as FullTextSignInStatus;
		expect(st.signedIn).toBe(true);
		expect(bridge.cookieCalls[0]).toBe("https://login.openathens.net/");
	});

	test("an institution without a sign-in method gets no_method", async () => {
		const bridge = new FakeBridge();
		setBrowserBridge(bridge);
		const { call } = setup();
		await call("PUT", "/settings", { institution: { id: "other", name: "Uni of Nowhere" } });
		const r = (await (await call("POST", "/sign-in"))!.json()) as FullTextSignInResult;
		expect(r).toEqual({ result: "no_method", institution: "Uni of Nowhere" });
		expect(bridge.opens).toHaveLength(0);
	});
});
