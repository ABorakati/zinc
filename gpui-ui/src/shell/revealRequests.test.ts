import { describe, expect, test } from "bun:test";
import { setDirect } from "../api";
import { pendingReveal, startRevealPolling, type RevealRequest } from "./revealRequests";

const req = (seq: number, at = Date.now(), key = "ABCD2345"): RevealRequest => ({ key, title: "t", seq, at });

describe("pendingReveal", () => {
	test("first poll: a fresh request is acted on, an old one is not", () => {
		expect(pendingReveal(null, req(1))?.key).toBe("ABCD2345");
		expect(pendingReveal(null, req(1, Date.now() - 120_000))).toBeNull();
		expect(pendingReveal(null, null)).toBeNull();
	});
	test("later polls: only a new sequence number", () => {
		expect(pendingReveal(3, req(3))).toBeNull();
		expect(pendingReveal(3, req(4))?.seq).toBe(4);
		expect(pendingReveal(3, req(1))?.seq).toBe(1); // the core restarted
	});
});

test("startRevealPolling shows each new request once", async () => {
	let reveal: RevealRequest | null = null;
	setDirect((r) => (new URL(r.url).pathname === "/api/ui/selection" ? Response.json({ selection: { kind: "library" }, rev: 1, reveal }) : null));
	const shown: string[] = [];
	const stop = startRevealPolling((k) => shown.push(k), 20);
	await Bun.sleep(60);
	reveal = req(1, Date.now(), "KEY00001");
	await Bun.sleep(80);
	reveal = req(2, Date.now(), "KEY00002");
	await Bun.sleep(80);
	stop();
	expect(shown).toEqual(["KEY00001", "KEY00002"]);
});

test("startRevealPolling passes the attachment to open", async () => {
	const reveal: RevealRequest = { ...req(7, Date.now(), "PARENT01"), open: { key: "PDFKEY01", title: "Full Text PDF" } };
	setDirect((r) => (new URL(r.url).pathname === "/api/ui/selection" ? Response.json({ selection: { kind: "library" }, rev: 1, reveal }) : null));
	const shown: unknown[] = [];
	const stop = startRevealPolling((k, open) => shown.push([k, open]), 20);
	await Bun.sleep(60);
	stop();
	expect(shown).toEqual([["PARENT01", { key: "PDFKEY01", title: "Full Text PDF" }]]);
});
