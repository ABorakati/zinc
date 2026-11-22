// bun test src/features/fulltext/jobs.test.ts -- the Find Full Text job list against a fake core (api.setDirect): no window, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off"; // jobs.ts pulls in the store: never touch the user's saved list preferences

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const polls = new Map<string, number>(); // job id -> GET /jobs/:id requests the fake core got
let next = 0;
let M: typeof import("./jobs");

beforeAll(async () => {
	const api = await import("../../api");
	api.setDirect(async (req) => {
		const u = new URL(req.url);
		if (u.pathname === "/api/fulltext/find") return json({ jobId: `J${next++}` });
		const m = /^\/api\/fulltext\/jobs\/(J\d+)$/.exec(u.pathname);
		if (m) {
			polls.set(m[1]!, (polls.get(m[1]!) ?? 0) + 1);
			return json({ id: m[1], done: false, items: [] }); // never finishes
		}
		if (u.pathname === "/api/items") return json({ total: 0, items: [] });
		if (u.pathname === "/api/items/groups") return json({ groups: [] });
		if (u.pathname === "/api/collections") return json([]);
		if (u.pathname === "/api/libraries") return json({ libraries: [] });
		return null;
	});
	M = await import("./jobs");
});
afterAll(() => {
	for (const t of M.jobs()) M.dismissJob(t.job.id); // stops every poll timer
});

describe("following jobs", () => {
	test("a job pushed off the list of ten is no longer polled", async () => {
		const first = await M.startJob(["K1"]);
		expect(first).toBe("J0");
		for (let i = 1; i < 10; i++) await M.startJob(["K1"]);
		expect(M.jobs().length).toBe(10);
		await M.startJob(["K1"]); // the eleventh: J0 leaves the list
		expect(M.jobs().some((t) => t.job.id === "J0")).toBe(false);
		await sleep(900); // one poll round: the dropped job's timer gets its last look
		const seen = polls.get("J0") ?? 0;
		await sleep(1700); // two more rounds
		expect(polls.get("J0") ?? 0).toBe(seen);
		expect(polls.get("J10") ?? 0).toBeGreaterThan(1); // the newest job is still followed
	});
});
