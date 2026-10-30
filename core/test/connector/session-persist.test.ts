// Save sessions as plain data: the native-messaging host persists them so a restarted host still knows a session.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SaveSession, SessionManager } from "../../src/connector/session";

beforeEach(() => SessionManager.clear());
afterEach(() => SessionManager.clear());

describe("session export / import", () => {
	test("round-trips items, target, tags and note", () => {
		const s = SessionManager.create("S1", "saveItems");
		s.items.set("item1", "ABCD1234");
		s.targetId = "CXYZ";
		s.tags = ["a", "b"];
		s.note = "hello";
		const data = JSON.parse(JSON.stringify(SessionManager.exportAll()));
		SessionManager.clear();
		expect(SessionManager.get("S1")).toBeUndefined();
		SessionManager.importAll(data);
		const r = SessionManager.get("S1")!;
		expect(r).toBeInstanceOf(SaveSession);
		expect(r.action).toBe("saveItems");
		expect(r.getItem("item1")).toBe("ABCD1234");
		expect(r.targetId).toBe("CXYZ");
		expect(r.tags).toEqual(["a", "b"]);
		expect(r.note).toBe("hello");
		expect(r.created).toBe(s.created);
	});

	test("a session already in memory wins over an imported copy", () => {
		const s = SessionManager.create("S2", "saveItems");
		s.items.set("x", "LIVE");
		SessionManager.importAll([{ ...s.toJSON(), items: [["x", "STALE"]] }]);
		expect(SessionManager.get("S2")!.getItem("x")).toBe("LIVE");
	});

	test("expired sessions are not imported back to life", () => {
		const old = { ...new SaveSession("S3", "import").toJSON(), created: Date.now() - 31 * 60_000 };
		SessionManager.importAll([old]);
		expect(SessionManager.get("S3")).toBeUndefined();
	});
});
