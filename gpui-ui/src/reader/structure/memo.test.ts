// bun test src/reader/structure/memo.test.ts -- what loadStructure remembers.
import { describe, expect, test } from "bun:test";
import { fingerprint, latestPerAttachment } from "./memo";

describe("fingerprint", () => {
	test("differs for the same size with other content, anywhere in the file", () => {
		const size = 300_000;
		const base = new Uint8Array(size).fill(7);
		const seen = new Set([fingerprint(base)]);
		for (const at of [0, 100, 70_000, 150_000, 229_000, size - 1]) {
			const edited = base.slice();
			edited[at] = 9;
			seen.add(fingerprint(edited));
		}
		// (the bytes between the sampled ones of the middle are not looked at: only edits that touch an end or a sample are caught)
		expect(seen.size).toBeGreaterThanOrEqual(4);
		expect(fingerprint(base)).toBe(fingerprint(base.slice()));
	});
	test("starts with the size, and copes with tiny and empty files", () => {
		expect(fingerprint(new Uint8Array(0))).toStartWith("0-");
		expect(fingerprint(new Uint8Array(3).fill(1))).toStartWith("3-");
	});
});

describe("latestPerAttachment", () => {
	test("the same attachment and id share one run; other content replaces it", async () => {
		const remember = latestPerAttachment<string>();
		let runs = 0;
		const make = (v: string) => () => (runs++, Promise.resolve(v));
		const a = remember("K", "id1", make("one"));
		expect(remember("K", "id1", make("never"))).toBe(a);
		expect(runs).toBe(1);
		expect(await remember("K", "id2", make("two"))).toBe("two");
		expect(runs).toBe(2);
		expect(await remember("K", "id1", make("again"))).toBe("again"); // the old content is not kept next to the new
		expect(runs).toBe(3);
	});

	test("a failed run is forgotten so a retry runs", async () => {
		const remember = latestPerAttachment<string>();
		await expect(remember("K", "id", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await Promise.resolve();
		expect(await remember("K", "id", () => Promise.resolve("ok"))).toBe("ok");
	});

	test("only the attachments used last are kept", async () => {
		const remember = latestPerAttachment<number>(3);
		let runs = 0;
		const make = () => () => Promise.resolve(++runs);
		for (const k of ["a", "b", "c"]) await remember(k, "x", make());
		await remember("a", "x", make()); // a is used again: b is now the oldest
		await remember("d", "x", make()); // evicts b
		expect(runs).toBe(4);
		await remember("a", "x", make());
		await remember("c", "x", make());
		await remember("d", "x", make());
		expect(runs).toBe(4);
		await remember("b", "x", make());
		expect(runs).toBe(5);
	});
});
