import { describe, expect, test } from "bun:test";
import { answerStorage, apiBaseFrom, DEFAULT_API_BASE, storageClient } from "./sync-storage";

describe("test-only API base", () => {
	test("only http://127.0.0.1:<port> is honoured", () => {
		expect(apiBaseFrom("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
		for (const v of [
			undefined,
			null,
			5,
			"",
			"https://127.0.0.1:5000",
			"http://127.0.0.1",
			"http://127.0.0.1:5000/",
			"http://127.0.0.1:5000/x",
			"http://localhost:5000",
			"http://127.0.0.1:5000@evil.test",
			"http://evil.test:5000",
			"http://127.0.0.1.evil.test:5000",
		]) {
			expect(apiBaseFrom(v)).toBe(DEFAULT_API_BASE);
		}
	});
});

describe("storage proxy", () => {
	const mem = new Map<string, unknown>();
	const area = {
		get: async (k: string) => ({ [k]: mem.get(k) }),
		set: async (o: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(o)) mem.set(k, v);
		},
		remove: async (k: string) => {
			mem.delete(k);
		},
	};
	const chrome = { storage: { local: area }, runtime: { sendMessage: async () => undefined } };

	test("worker -> answer -> worker round trip, key only", async () => {
		const c = storageClient((m) => void answerStorage(chrome, m).then((r) => c.onReply(r)));
		await c.area.set({ zincZoteroApiKey: "k1" });
		expect((await c.area.get("zincZoteroApiKey")).zincZoteroApiKey).toBe("k1");
		await c.area.remove("zincZoteroApiKey");
		expect(mem.has("zincZoteroApiKey")).toBe(false);
	});
	test("other names are refused; the override is read-only", async () => {
		const c = storageClient((m) => void answerStorage(chrome, m).then((r) => c.onReply(r)));
		await expect(c.area.get("zincBrowserLibrary")).rejects.toThrow("not allowed");
		await expect(c.area.set({ zincTestZoteroApiBase: "http://127.0.0.1:1" })).rejects.toThrow("read-only");
		mem.set("zincTestZoteroApiBase", "http://127.0.0.1:1");
		expect((await c.area.get("zincTestZoteroApiBase")).zincTestZoteroApiBase).toBe("http://127.0.0.1:1");
	});
	test("without chrome.storage the service worker is asked", async () => {
		const sent: unknown[] = [];
		const r = await answerStorage(
			{
				runtime: {
					sendMessage: async (m) => {
						sent.push(m);
						return { ok: true, value: "v" };
					},
				},
			},
			{ rid: 1, op: "get", name: "zincZoteroApiKey" },
		);
		expect(r).toEqual({ t: "storage-res", rid: 1, value: "v" });
		expect(sent).toEqual([{ zincStorage: { op: "get", name: "zincZoteroApiKey", value: undefined } }]);
	});
});
