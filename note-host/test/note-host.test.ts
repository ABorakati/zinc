// The origin rules and the save queue of the note host page (note-host/src/origins.ts, saver.ts), called as the page calls them.
import { describe, expect, test } from "bun:test";
import { fromOwnOrigin, isLoopbackHttpOrigin, messageOrigin, resolveApiBase } from "../src/origins";
import { KEEPALIVE_MAX_BYTES, createNoteSaver, fitsKeepalive } from "../src/saver";

const APP = "http://127.0.0.1:23120";

describe("?api= is the page's own origin or a loopback http origin", () => {
	test("no api, or the page's own origin, is same-origin", () => {
		expect(resolveApiBase(null, APP)).toBe("");
		expect(resolveApiBase("", APP)).toBe("");
		expect(resolveApiBase(APP, APP)).toBe("");
		expect(resolveApiBase(APP + "/", APP)).toBe("");
		expect(resolveApiBase("https://app.example", "https://app.example")).toBe("");
	});

	test("another loopback http origin is allowed for a page that is itself on loopback", () => {
		expect(resolveApiBase("http://localhost:3000", APP)).toBe("http://localhost:3000");
		expect(resolveApiBase("http://[::1]:23120", "http://localhost:5173")).toBe("http://[::1]:23120");
	});

	test("anything else is refused", () => {
		for (const raw of [
			"https://evil.example",
			"http://evil.example",
			"//evil.example",
			"https://127.0.0.1:23120", // not http
			"http://127.0.0.1.evil.example",
			"http://localhost.evil.example:80",
			"http://user@127.0.0.1:23120", // userinfo
			"http://127.0.0.1:23120/api", // a path is not an origin
			"http://127.1", // normalises to another form: not the exact origin
			"http://0.0.0.0:23120",
			"javascript:alert(1)",
			"not a url",
		])
			expect(resolveApiBase(raw, APP)).toBeNull();
	});

	test("a page that is not on loopback never follows api to another origin, loopback or not", () => {
		expect(resolveApiBase("http://127.0.0.1:23120", "https://app.example")).toBeNull();
		expect(resolveApiBase("http://127.0.0.1:23120", "chrome-extension://abcdef")).toBeNull();
		expect(resolveApiBase("https://evil.example", "https://app.example")).toBeNull();
	});

	test("isLoopbackHttpOrigin", () => {
		expect(isLoopbackHttpOrigin("http://127.0.0.1")).toBe(true);
		expect(isLoopbackHttpOrigin("http://localhost:1")).toBe(true);
		expect(isLoopbackHttpOrigin("http://[::1]:9")).toBe(true);
		expect(isLoopbackHttpOrigin("http://127.0.0.2:9")).toBe(false);
		expect(isLoopbackHttpOrigin("ws://127.0.0.1:9")).toBe(false);
	});
});

describe("messages are addressed to, and accepted from, the page's own origin", () => {
	const parent = {};
	test("target origin", () => {
		expect(messageOrigin(APP)).toBe(APP);
		expect(messageOrigin("null")).toBeNull();
		expect(messageOrigin("")).toBeNull();
	});
	test("incoming: the right window and the right origin", () => {
		expect(fromOwnOrigin({ source: parent, origin: APP }, parent, APP)).toBe(true);
		expect(fromOwnOrigin({ source: parent, origin: "http://127.0.0.1:9" }, parent, APP)).toBe(false);
		expect(fromOwnOrigin({ source: {}, origin: APP }, parent, APP)).toBe(false);
		expect(fromOwnOrigin({ source: parent, origin: "null" }, parent, "null")).toBe(false);
	});
});

interface Call {
	url: string;
	init: RequestInit;
	release: (ok?: boolean) => void;
}

/** A fetch whose answers the test controls: each call waits until it is released. */
function manualFetch() {
	const calls: Call[] = [];
	const fetchFn = (url: string, init: RequestInit) =>
		new Promise<{ ok: boolean; status: number }>((resolve) => {
			calls.push({ url, init, release: (ok = true) => resolve({ ok, status: ok ? 200 : 500 }) });
		});
	return { calls, fetchFn };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("note saving", () => {
	test("the keepalive limit is counted in bytes of the JSON body, not characters of the note", () => {
		const cjk = "字".repeat(25000); // 25 000 characters, 75 000 bytes
		expect(cjk.length).toBeLessThan(KEEPALIVE_MAX_BYTES);
		expect(fitsKeepalive(JSON.stringify({ data: { note: cjk } }))).toBe(false);
		expect(fitsKeepalive(JSON.stringify({ data: { note: "a".repeat(1000) } }))).toBe(true);
		// quotes are escaped in the JSON, so a note of 59 000 quotes is far over the limit
		expect(fitsKeepalive(JSON.stringify({ data: { note: '"'.repeat(59000) } }))).toBe(false);
	});

	test("a large non-ASCII note is not sent with keepalive at unload", async () => {
		const { calls, fetchFn } = manualFetch();
		const s = createNoteSaver({ url: "/api/items/K", fetchFn, onSaved() {}, onError() {} });
		s.setPending("字".repeat(25000));
		const p = s.flush(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.init.keepalive).toBe(false);
		calls[0]!.release();
		await p;
		s.setPending("small");
		const q = s.flush(true);
		expect(calls[1]!.init.keepalive).toBe(true);
		calls[1]!.release();
		await q;
	});

	test("the unload flush is sent at once, not behind a request still in flight", async () => {
		const { calls, fetchFn } = manualFetch();
		const saved: number[] = [];
		const s = createNoteSaver({ url: "/api/items/K", fetchFn, onSaved: () => saved.push(1), onError() {} });
		s.setPending("first");
		s.flush();
		await tick();
		expect(calls).toHaveLength(1); // PATCH "first" is waiting for the server
		s.setPending("second");
		const unload = s.flush(true);
		expect(calls).toHaveLength(2); // sent without waiting
		expect(calls[1]!.init.keepalive).toBe(true);
		expect(JSON.parse(String(calls[1]!.init.body)).data.note).toBe("second");
		calls[1]!.release();
		calls[0]!.release();
		await unload;
		expect(saved.length).toBeGreaterThan(0);
	});

	test("ordinary saves run one at a time, in order", async () => {
		const { calls, fetchFn } = manualFetch();
		const s = createNoteSaver({ url: "/api/items/K", fetchFn, onSaved() {}, onError() {} });
		s.setPending("one");
		const a = s.flush();
		s.setPending("two");
		const b = s.flush();
		await tick();
		expect(calls).toHaveLength(1);
		calls[0]!.release();
		await a;
		await tick();
		expect(calls).toHaveLength(2);
		calls[1]!.release();
		await b;
	});

	test("a failed save is kept for the next one, and an unchanged note is not sent", async () => {
		const { calls, fetchFn } = manualFetch();
		const errors: string[] = [];
		const s = createNoteSaver({ url: "/api/items/K", fetchFn, onSaved() {}, onError: (e) => errors.push(e) });
		s.setBaseline("same");
		s.setPending("same");
		await s.flush();
		expect(calls).toHaveLength(0);
		s.setPending("edited");
		const p = s.flush();
		await tick();
		calls[0]!.release(false);
		await p;
		expect(errors).toHaveLength(1);
		const q = s.flush();
		await tick();
		expect(calls).toHaveLength(2);
		expect(JSON.parse(String(calls[1]!.init.body)).data.note).toBe("edited");
		calls[1]!.release();
		await q;
	});
});
