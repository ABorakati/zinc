// bun test src/reader/core/cacheRelease.test.ts -- the page caches give their memory back (closed document, inactive tab) and a late render cannot refill them.
import { describe, expect, test } from "bun:test";
import type { PdfDoc, RenderTask } from "../pdf";
import { BitmapCache } from "./Page";
import { Previews } from "./preview";

type Bitmap = Parameters<BitmapCache["put"]>[2];
/** A whole-page bitmap of `bytes` bytes whose release() is counted. */
function bitmap(bytes: number): { r: Bitmap; released: () => number } {
	let n = 0;
	const r = { width: 1, height: bytes / 4, pixels: Buffer.alloc(bytes), renderMs: 0, slice: () => Buffer.alloc(0), release: () => void n++ };
	return { r: r as unknown as Bitmap, released: () => n };
}

describe("BitmapCache.close", () => {
	test("a render that finishes after the cache was closed is released, not kept", () => {
		const c = new BitmapCache(1 << 20);
		const kept = bitmap(1000);
		c.unuse(c.put("a", 0, kept.r));
		c.close();
		expect(kept.released()).toBe(1);
		const late = bitmap(1000);
		const e = c.put("b", 1, late.r); // the page was still rendering when the document closed
		expect(c.size).toBe(0);
		expect(c.acquire("b")).toBeUndefined();
		expect(late.released()).toBe(0); // the caller still uses it to upload its tiles...
		c.unuse(e);
		expect(late.released()).toBe(1); // ...and that is the last use
	});

	test("clear() frees what is held but the cache keeps working (an inactive tab, shown again later)", () => {
		const c = new BitmapCache(1 << 20);
		const a = bitmap(1000);
		c.unuse(c.put("a", 0, a.r));
		c.clear();
		expect(a.released()).toBe(1);
		const b = bitmap(1000);
		c.unuse(c.put("b", 1, b.r));
		expect(c.size).toBe(1);
		const hit = c.acquire("b");
		expect(hit).toBeDefined();
		expect(b.released()).toBe(0);
		c.unuse(hit!);
	});

	test("an entry being cut when the cache is closed is freed after it", () => {
		const c = new BitmapCache(1 << 20);
		const a = bitmap(1000);
		c.unuse(c.put("a", 0, a.r));
		const cutting = c.acquire("a")!;
		c.close();
		expect(a.released()).toBe(0);
		c.unuse(cutting);
		expect(a.released()).toBe(1);
	});
});

describe("Previews.release", () => {
	const settle = () => new Promise<void>((r) => setTimeout(r, 10));
	function fakeDoc() {
		let started = 0,
			cancelled = 0;
		const doc = {
			sizes: [[612, 792]] as [number, number][],
			render3: (): RenderTask => {
				started++;
				return {
					promise: Promise.resolve({ width: 4, height: 4, pixels: Buffer.alloc(64), renderMs: 0, slice: () => Buffer.alloc(0), release() {} }),
					cancel: () => void cancelled++,
					setPrio() {},
				} as unknown as RenderTask;
			},
		};
		return { doc: doc as unknown as PdfDoc, started: () => started, cancelled: () => cancelled };
	}

	test("previews are dropped and made again on the next want()", async () => {
		const f = fakeDoc();
		const pv = new Previews(f.doc, () => 1, () => ({ mode: 0 }));
		pv.want([{ page: 0, rot: 0, prio: 0 }]);
		await settle();
		expect(pv.get(0, 0)).toBeDefined();
		pv.release();
		expect(pv.get(0, 0)).toBeUndefined();
		pv.want([{ page: 0, rot: 0, prio: 0 }]);
		await settle();
		expect(pv.get(0, 0)).toBeDefined(); // rebuilt: the tab was shown again
		expect(f.started()).toBe(2);
		pv.close();
		pv.want([{ page: 0, rot: 0, prio: 0 }]);
		expect(f.started()).toBe(2); // closed for good
	});
});
