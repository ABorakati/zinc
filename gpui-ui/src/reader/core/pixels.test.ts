// bun test src/reader/core/pixels.test.ts -- safe image pixel uploads across mount/unmount races.
import { describe, expect, test } from "bun:test";
import { type ImgNode, isUnknownElementError, uploadImagePixels, whenMounted } from "./pixels";

const px = () => ({ width: 4, height: 4, pixels: new Uint8Array(64) });

function fakeImg(id: number, onSet?: (id: number) => void): ImgNode {
	return {
		id,
		mounted: false,
		setImagePixels() {
			onSet?.(id);
		},
	};
}

describe("isUnknownElementError", () => {
	test("recognises GPUIX unknown element errors and ignores unrelated ones", () => {
		expect(isUnknownElementError(new Error("Unknown element id 16682"))).toBe(true);
		expect(isUnknownElementError("Unknown element id 42")).toBe(true);
		expect(isUnknownElementError(new Error("Invalid pixel buffer length"))).toBe(false);
		expect(isUnknownElementError(null)).toBe(false);
	});
});

describe("whenMounted", () => {
	test("returns false immediately once alive turns false even if mounted was set", async () => {
		const el = fakeImg(1);
		el.mounted = true;
		expect(
			await whenMounted(
				() => el,
				() => false,
			),
		).toBe(false);
	});
});

describe("uploadImagePixels", () => {
	test("waits until mounted, uploads pixels, and reports mount/upload timings", async () => {
		let calls = 0;
		let mountWait = -1;
		let uploadMs = -1;
		const el = fakeImg(10, () => {
			calls++;
		});
		setTimeout(() => {
			el.mounted = true;
		}, 1);

		const ok = await uploadImagePixels(
			() => el,
			() => true,
			px,
			{
				onMountWait: (ms) => {
					mountWait = ms;
				},
				onUpload: (ms) => {
					uploadMs = ms;
				},
			},
		);
		expect(ok).toBe(true);
		expect(calls).toBe(1);
		expect(mountWait).toBeGreaterThanOrEqual(0);
		expect(uploadMs).toBeGreaterThanOrEqual(0);
	});

	test("skips setImagePixels if the element unmounts before or right after whenMounted resolves", async () => {
		let calls = 0;
		let alive = true;
		const el = fakeImg(11, () => {
			calls++;
		});
		el.mounted = true;

		// start upload; immediately unmount in the same tick before the microtask after `await whenMounted` runs
		const pending = uploadImagePixels(
			() => el,
			() => alive,
			px,
		);
		alive = false;
		el.mounted = false;

		expect(await pending).toBe(false);
		expect(calls).toBe(0);
	});

	test("retries transient Unknown element id while mounted and succeeds once flushed", async () => {
		let attempts = 0;
		const el = fakeImg(12, (id) => {
			attempts++;
			if (attempts < 3) throw new Error(`Unknown element id ${id}`);
		});
		el.mounted = true;

		const ok = await uploadImagePixels(
			() => el,
			() => true,
			px,
		);
		expect(ok).toBe(true);
		expect(attempts).toBe(3);
	});

	test("returns false cleanly when Unknown element id happens on a concurrently destroyed element", async () => {
		let attempts = 0;
		let alive = true;
		const el = fakeImg(16682, (id) => {
			attempts++;
			// native host destroyed the element while JS was in flight
			el.mounted = false;
			alive = false;
			throw new Error(`Unknown element id ${id}`);
		});
		el.mounted = true;

		const ok = await uploadImagePixels(
			() => el,
			() => alive,
			px,
		);
		expect(ok).toBe(false);
		expect(attempts).toBe(1);
	});

	test("returns false cleanly when Unknown element id persists past maxRetries", async () => {
		let attempts = 0;
		const el = fakeImg(16682, (id) => {
			attempts++;
			throw new Error(`Unknown element id ${id}`);
		});
		el.mounted = true;

		const ok = await uploadImagePixels(
			() => el,
			() => true,
			px,
			{ maxRetries: 2 },
		);
		expect(ok).toBe(false);
		expect(attempts).toBe(3);
	});

	test("rethrows unexpected non-element errors", async () => {
		const el = fakeImg(14, () => {
			throw new Error("pixel buffer size mismatch");
		});
		el.mounted = true;

		await expect(
			uploadImagePixels(
				() => el,
				() => true,
				px,
			),
		).rejects.toThrow("pixel buffer size mismatch");
	});
});
