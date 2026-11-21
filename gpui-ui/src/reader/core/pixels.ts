// Shared bits of "put native pixels into a GPUIX <img>" for the page tiles, the page previews and the thumbnails.
//
// GPUIX paints an <img> that has no pixels yet as a dark box with the text "img: no src". An <img> can only receive pixels
// (setImagePixels) once its host node exists natively, which is some time AFTER the component creates it, so every image of the
// reader is created HIDDEN (visibility: hidden: it keeps its box, paints nothing, the page's paper colour shows through) and is
// shown in the same step that hands it its pixels. ZN_LEGACY_IMG=1 restores the old behaviour (benchmarks compare the two).
export const HIDE_UNTIL_PIXELS = process.env.ZN_LEGACY_IMG !== "1";

export type ImgNode = {
	id: number;
	mounted: boolean;
	setImagePixels(w: number, h: number, b: Uint8Array, o?: { format?: "rgba" | "bgra" }): void;
};

/** Style fragment of an image that waits for its first pixels (empty once it has them). */
export const hiddenUntil = (ready: boolean): { visibility?: string } => (HIDE_UNTIL_PIXELS && !ready ? { visibility: "hidden" } : {});

/** True when GPUIX rejected a host call because the element id is not live natively (not flushed yet, or already destroyed). */
export function isUnknownElementError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return /Unknown element id\b/.test(msg);
}

/** Resolves true once the host node of `img()` exists (a few ms after creation), false if `alive()` turned false first or it never did. */
export async function whenMounted(img: () => ImgNode | undefined, alive: () => boolean): Promise<boolean> {
	for (let i = 0; i < 400; i++) {
		if (!alive()) return false;
		const el = img();
		if (el?.mounted) return true;
		await new Promise<void>((r) => setTimeout(r, i < 3 ? 0 : 2));
	}
	return false;
}

export interface UploadPixelsOptions {
	format?: "rgba" | "bgra";
	/** retries when `setImagePixels` throws `Unknown element id` while the node is still mounted (e.g. `createElement` batch not yet flushed) */
	maxRetries?: number;
	onMountWait?: (ms: number) => void;
	onUpload?: (ms: number) => void;
}

/**
 * Wait until `img()` is mounted and upload pixels to it. Guards against mount/unmount races:
 * - re-checks `alive()` and `el.mounted` right before `setImagePixels` after every `await`
 * - catches benign `Unknown element id` errors (retrying briefly if still alive & mounted while a `createElement` batch flushes,
 *   otherwise returning `false` cleanly instead of throwing)
 */
export async function uploadImagePixels(
	img: () => ImgNode | undefined,
	alive: () => boolean,
	getPixels: () => { width: number; height: number; pixels: Uint8Array },
	options: UploadPixelsOptions = {},
): Promise<boolean> {
	const format = options.format ?? "bgra";
	const maxRetries = options.maxRetries ?? 8;
	const m0 = performance.now();
	if (!(await whenMounted(img, alive))) return false;
	options.onMountWait?.(performance.now() - m0);

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (!alive()) return false;
		const el = img();
		if (!el?.mounted) return false;
		const { width, height, pixels } = getPixels();
		const u0 = performance.now();
		try {
			el.setImagePixels(width, height, pixels, { format });
			options.onUpload?.(performance.now() - u0);
			return true;
		} catch (e) {
			if (!isUnknownElementError(e)) throw e;
			if (!alive() || !img()?.mounted || attempt === maxRetries) return false;
			await new Promise<void>((r) => setTimeout(r, attempt < 2 ? 0 : 2));
		}
	}
	return false;
}
