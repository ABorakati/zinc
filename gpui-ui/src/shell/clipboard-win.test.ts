// bun test src/shell/clipboard-win.test.ts -- the copy that readClipboardImage makes before it unlocks the clipboard's memory.
// Never touches the real clipboard: only the pure helper is called.
import { describe, expect, test } from "bun:test";
import { copyOut } from "./clipboard-win";

describe("bytes read from locked clipboard memory", () => {
	test("Buffer.from(arrayBuffer) is a view of the same memory (why a copy is needed)", () => {
		const mem = new Uint8Array([1, 2, 3, 4]);
		const view = Buffer.from(mem.buffer);
		mem[0] = 99;
		expect(view[0]).toBe(99);
	});
	test("copyOut returns bytes that stay as they were when the memory changes or goes away", () => {
		const mem = new Uint8Array([1, 2, 3, 4]);
		const copy = copyOut(mem.buffer);
		mem.fill(0); // the clipboard owner frees / overwrites the block after GlobalUnlock
		expect([...copy]).toEqual([1, 2, 3, 4]);
		expect(copy.buffer).not.toBe(mem.buffer);
	});
	test("copyOut of an empty block is an empty buffer", () => {
		expect(copyOut(new ArrayBuffer(0)).length).toBe(0);
	});
});
