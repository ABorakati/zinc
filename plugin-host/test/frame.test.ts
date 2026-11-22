import { describe, expect, test } from "bun:test";
import { createLineSplitter, maxFrameBytes } from "../src/transport-wasmtime";

describe("line splitting for the zhw pipe", () => {
	function collect(max: number, chunks: string[]) {
		const lines: string[] = [];
		let tooLong = 0;
		const s = createLineSplitter(max, (l) => lines.push(l), () => tooLong++);
		for (const c of chunks) s.push(c);
		return { lines, tooLong, rest: s.end() };
	}

	test("lines are rebuilt across chunk boundaries", () => {
		const r = collect(100, ["a\nb", "c\n\nd", "e", "\nf"]);
		expect(r.lines).toEqual(["a", "bc", "", "de"]);
		expect(r.rest).toBe("f");
		expect(r.tooLong).toBe(0);
	});

	test("a line over the limit is reported once, in one chunk or across many", () => {
		expect(collect(10, ["x".repeat(11) + "\nok\n"])).toMatchObject({ lines: [], tooLong: 1 });
		const r = collect(10, Array.from({ length: 50 }, () => "xx"));
		expect(r.tooLong).toBe(1);
		expect(r.rest).toBe("");
		expect(collect(10, ["abc\n" + "y".repeat(11)])).toMatchObject({ lines: ["abc"], tooLong: 1 });
	});

	test("a line of exactly the limit is kept", () => {
		expect(collect(10, ["x".repeat(10) + "\n"])).toMatchObject({ lines: ["x".repeat(10)], tooLong: 0 });
		expect(collect(10, ["x".repeat(5), "x".repeat(5) + "\n"])).toMatchObject({ lines: ["x".repeat(10)], tooLong: 0 });
	});

	test("many lines in one chunk are all delivered", () => {
		const chunk = "0123456789\n".repeat(400_000);
		const r = collect(1000, [chunk]);
		expect(r.lines.length).toBe(400_000);
	});

	test("the limit is above the largest legitimate frame", () => {
		// a full 256 MiB plugin memory as base64, and a plugin's prefs at their own limits (1000 values of 64 KiB)
		expect(maxFrameBytes()).toBeGreaterThan(Math.ceil((256 * 1048576 * 4) / 3) + 1000 * 65536);
		expect(maxFrameBytes(512)).toBeGreaterThan(maxFrameBytes(256));
	});
});
