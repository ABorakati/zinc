// Export and clipboard utilities for image (rectangle) annotations.
// Uses the app's native PDF rendering path (renderRegion in structure/regions) at 3x scale (~216 DPI)
// and encodes to PNG (via pngjs) and CF_DIB (for native Windows applications).
import { join } from "node:path";
import { PNG } from "pngjs";
import { pickPaths } from "../../features/platform";
import { writeClipboardImage } from "../../shell/clipboard-win";
import type { ReaderContext } from "../plugins";
import { renderRegion, type Crop } from "../structure/regions";
import { boundingRect, type Annotation } from "./model";

/** Convert raw BGRA8 pixels into a PNG Buffer via pngjs. */
export function bgraToPng(bgra: Uint8Array, width: number, height: number): Buffer {
	const png = new PNG({ width, height });
	for (let i = 0; i < width * height; i++) {
		const b = bgra[i * 4]!;
		const g = bgra[i * 4 + 1]!;
		const r = bgra[i * 4 + 2]!;
		const a = bgra[i * 4 + 3]!;
		png.data[i * 4] = r;
		png.data[i * 4 + 1] = g;
		png.data[i * 4 + 2] = b;
		png.data[i * 4 + 3] = a;
	}
	return PNG.sync.write(png);
}

/** Convert raw BGRA8 pixels into a Win32 CF_DIB buffer (40-byte BITMAPINFOHEADER + bottom-up BGRA rows). */
export function bgraToDib(bgra: Uint8Array, width: number, height: number): Buffer {
	const dib = Buffer.alloc(40 + width * height * 4);
	// BITMAPINFOHEADER
	dib.writeUInt32LE(40, 0); // biSize
	dib.writeInt32LE(width, 4); // biWidth
	dib.writeInt32LE(height, 8); // biHeight (positive = bottom-up)
	dib.writeUInt16LE(1, 12); // biPlanes
	dib.writeUInt16LE(32, 14); // biBitCount
	dib.writeUInt32LE(0, 16); // biCompression = BI_RGB
	dib.writeUInt32LE(width * height * 4, 20); // biSizeImage
	dib.writeInt32LE(0, 24); // biXPelsPerMeter
	dib.writeInt32LE(0, 28); // biYPelsPerMeter
	dib.writeUInt32LE(0, 32); // biClrUsed
	dib.writeUInt32LE(0, 36); // biClrImportant

	const rowBytes = width * 4;
	for (let y = 0; y < height; y++) {
		const srcOffset = (height - 1 - y) * rowBytes;
		const dstOffset = 40 + y * rowBytes;
		Buffer.from(bgra.buffer, bgra.byteOffset + srcOffset, rowBytes).copy(dib, dstOffset);
	}
	return dib;
}

export interface RenderedAnnotationImage {
	png: Buffer;
	dib: Buffer;
	width: number;
	height: number;
	crop: Crop;
}

/**
 * Render the region of an image annotation at high resolution (~216 DPI, 3x) through the PDF rendering path.
 */
export async function renderAnnotationImage(ctx: ReaderContext, a: Annotation, scale = 3): Promise<RenderedAnnotationImage | null> {
	const pos = a.position;
	const page = pos.pageIndex;
	const rect = pos.rects?.[0] ?? boundingRect(pos);
	const rw = Math.max(2, rect[2] - rect[0]);
	const rh = Math.max(2, rect[3] - rect[1]);
	if (rw <= 0 || rh <= 0) return null;

	const targetWidth = Math.max(300, Math.round(rw * scale));
	const crop = await renderRegion(ctx, page, rect, targetWidth);
	if (!crop) return null;

	const png = bgraToPng(crop.pixels, crop.width, crop.height);
	const dib = bgraToDib(crop.pixels, crop.width, crop.height);
	return { png, dib, width: crop.width, height: crop.height, crop };
}

/**
 * Copy an image annotation to the Windows clipboard as both PNG and CF_DIB.
 */
export async function copyAnnotationImage(ctx: ReaderContext, a: Annotation, notify?: (msg: string) => void): Promise<boolean> {
	try {
		const rendered = await renderAnnotationImage(ctx, a, 3);
		if (!rendered) {
			notify?.("Could not render image for copy");
			return false;
		}
		const ok = writeClipboardImage(rendered.png, rendered.dib);
		if (ok) {
			notify?.("Copied image to clipboard");
		} else {
			notify?.("Failed to copy image to clipboard");
		}
		return ok;
	} catch (e) {
		console.warn("[imageExport] copy failed:", (e as Error).message);
		notify?.(`Copy failed: ${(e as Error).message}`);
		return false;
	}
}

/** One piece of a file name: letters, digits, dot, dash, underscore; no separator, no drive colon, no leading dot, at most 60 characters. */
function namePart(s: string): string {
	return s.replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "_").slice(0, 60) || "_";
}

/** The file an exported image annotation is saved as. The id and the page label can come from someone else's library, so they cannot name a place outside the folder. */
export function annotationImageName(a: Annotation): string {
	return `annotation-${namePart(a.id)}-p${namePart(a.pageLabel || String(a.position.pageIndex + 1))}.png`;
}

/**
 * Export an image annotation as a PNG file.
 * If destDir is provided, saves directly into that folder; otherwise prompts for a directory.
 */
export async function exportAnnotationImage(
	ctx: ReaderContext,
	a: Annotation,
	destDir?: string,
	notify?: (msg: string) => void,
): Promise<string | null> {
	try {
		const rendered = await renderAnnotationImage(ctx, a, 3);
		if (!rendered) {
			notify?.("Could not render image for export");
			return null;
		}
		let dir = destDir;
		if (!dir) {
			const picked = await pickPaths({ directories: true, prompt: "Save image to folder" });
			dir = picked?.[0];
		}
		if (!dir) return null;

		const fullPath = join(dir, annotationImageName(a));
		await Bun.write(fullPath, rendered.png);
		notify?.(`Exported image to ${fullPath}`);
		return fullPath;
	} catch (e) {
		console.warn("[imageExport] export failed:", (e as Error).message);
		notify?.(`Export failed: ${(e as Error).message}`);
		return null;
	}
}
