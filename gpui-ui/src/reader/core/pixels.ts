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

/** Resolves true once the host node of `img()` exists (a few ms after creation), false if `alive()` turned false first or it never did. */
export async function whenMounted(img: () => ImgNode | undefined, alive: () => boolean): Promise<boolean> {
	for (let i = 0; i < 400; i++) {
		const el = img();
		if (el?.mounted) return alive();
		if (!alive()) return false;
		await new Promise<void>((r) => setTimeout(r, i < 3 ? 0 : 2));
	}
	return false;
}
