// bun test src/reader/annotations/store.test.ts -- saving annotations: read-only libraries, no retry of a refusal, capped backoff.
import { beforeAll, describe, expect, test } from "bun:test";
import { isPermanentFailure, MAX_RETRIES, retryDelay } from "./store";

let puts = 0;
let answer: () => Response = () => new Response("{}", { status: 200 });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ann = (id: string) =>
	({
		id,
		type: "highlight",
		color: "#ffd400",
		comment: "",
		text: "t",
		sortIndex: "00000|000000|00000",
		pageLabel: "1",
		position: { pageIndex: 0, rects: [[0, 0, 1, 1]] },
		dateCreated: "",
		dateModified: "",
		tags: [],
	}) as never;

beforeAll(async () => {
	const api = await import("../../api");
	api.setDirect(async (req) => {
		const u = new URL(req.url);
		if (u.pathname.endsWith("/annotations")) {
			if (req.method === "PUT") {
				puts++;
				return answer();
			}
			return new Response("[]", { status: 200 });
		}
		return null;
	});
});

describe("retry policy", () => {
	test("backoff doubles from 4 s and is capped", () => {
		expect([1, 2, 3, 4].map(retryDelay)).toEqual([4000, 8000, 16000, 32000]);
		expect(retryDelay(10)).toBe(60_000);
		expect(MAX_RETRIES).toBeGreaterThan(0);
	});
	test("a 4xx answer is permanent (except timeouts and rate limits); a network error or 5xx is not", () => {
		const e = (status: number) => Object.assign(new Error("x"), { status });
		expect(isPermanentFailure(e(403))).toBe(true);
		expect(isPermanentFailure(e(404))).toBe(true);
		expect(isPermanentFailure(e(408))).toBe(false);
		expect(isPermanentFailure(e(429))).toBe(false);
		expect(isPermanentFailure(e(500))).toBe(false);
		expect(isPermanentFailure(new Error("fetch failed"))).toBe(false);
	});
});

describe("annotation store", () => {
	test("a read-only store keeps nothing and sends nothing", async () => {
		const { createStore } = await import("./store");
		puts = 0;
		const s = createStore("RO000001", { readOnly: () => true });
		s.add(ann("a"));
		s.update("a", { comment: "c" });
		s.remove(["a"]);
		await s.flush();
		await tick();
		expect(s.list()).toEqual([]);
		expect(puts).toBe(0);
		s.dispose();
	});

	test("a 403 is reported once, not retried, and Retry sends it again", async () => {
		const { createStore } = await import("./store");
		puts = 0;
		answer = () => new Response(JSON.stringify({ error: "read-only library" }), { status: 403 });
		const s = createStore("RW000001");
		s.add(ann("a"));
		await s.flush();
		await tick(60);
		expect(puts).toBe(1);
		expect(s.status()).toBe("error");
		expect(s.retrying()).toBe(false);
		expect(s.lastError()).toBe("read-only library");

		answer = () => new Response("{}", { status: 200 });
		await s.retry();
		expect(puts).toBe(2);
		expect(s.status()).toBe("saved");
		expect(s.lastError()).toBeNull();
		s.dispose();
	});

	test("a transient failure is scheduled again, and closing the store stops the retries", async () => {
		const { createStore } = await import("./store");
		puts = 0;
		answer = () => new Response("{}", { status: 503 });
		const s = createStore("RW000002");
		s.add(ann("b"));
		await s.flush();
		expect(s.retrying()).toBe(true); // waiting 4 s for the next try
		s.dispose(); // the document closed: one last save, no timer left
		await tick(60);
		expect(puts).toBe(2); // the first try and the last one on close
		expect(s.retrying()).toBe(false);
	});
});
