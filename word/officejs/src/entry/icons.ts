// Pure TypeScript RGBA PNG encoder for the add-in's manifest icons (16, 32, 64, 80 px).
// Draws Zinc's crimson rounded-tile mark with a bold white "Z" (matching website/public/icon.svg) using node:zlib.
import { deflateSync } from "node:zlib";

export const ICON_SIZES = [16, 32, 64, 80] as const;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length, false);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
	return out;
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Signed distance to a rounded box centred at (0.5, 0.5) in normalised [0, 1] coordinates. */
function roundedBoxSdf(nx: number, ny: number, half: number, radius: number): number {
	const qx = Math.abs(nx - 0.5) - (half - radius);
	const qy = Math.abs(ny - 0.5) - (half - radius);
	const ox = Math.max(qx, 0);
	const oy = Math.max(qy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** True when normalised point (nx, ny) lies inside a crisp geometric "Z" glyph. */
function inZGlyph(nx: number, ny: number): boolean {
	const left = 0.24;
	const right = 0.76;
	const top = 0.25;
	const bottom = 0.75;
	const bar = 0.115;
	if (nx < left || nx > right || ny < top || ny > bottom) return false;
	if (ny <= top + bar || ny >= bottom - bar) return true;
	// Diagonal from (right - bar*0.6, top + bar) down-left to (left + bar*0.6, bottom - bar)
	const t = (ny - (top + bar * 0.5)) / (bottom - top - bar);
	const cx = right - bar * 0.55 - t * (right - left - bar * 1.1);
	return Math.abs(nx - cx) <= bar * 0.62;
}

/** Encode a `size` x `size` RGBA PNG for the Zinc add-in icon. */
export function renderZincIconPng(size: number): Uint8Array {
	const stride = 1 + size * 4;
	const raw = new Uint8Array(stride * size);
	const aa = 1 / size;

	for (let y = 0; y < size; y++) {
		const row = y * stride;
		raw[row] = 0; // PNG filter type 0 (None)
		for (let x = 0; x < size; x++) {
			const nx = (x + 0.5) / size;
			const ny = (y + 0.5) / size;
			const d = roundedBoxSdf(nx, ny, 0.468, 0.21);
			const bgAlpha = clamp01(0.5 - d / aa);

			const grad = clamp01((nx + ny) * 0.5);
			let r = 0xe5 + (0xb4 - 0xe5) * grad;
			let g = 0x48 + (0x23 - 0x48) * grad;
			let b = 0x4d + (0x2c - 0x4d) * grad;
			if (ny < 0.5) {
				const shine = (1 - ny * 2) * 0.16;
				r = r + (255 - r) * shine;
				g = g + (255 - g) * shine;
				b = b + (255 - b) * shine;
			}

			// 2x2 supersampling on the foreground "Z" so 16x16 and 32x32 stay sharp
			let fg = 0;
			for (const oy of [-0.25, 0.25]) {
				for (const ox of [-0.25, 0.25]) {
					if (inZGlyph((x + 0.5 + ox) / size, (y + 0.5 + oy) / size)) fg += 0.25;
				}
			}
			r = r + (255 - r) * fg;
			g = g + (255 - g) * fg;
			b = b + (255 - b) * fg;

			const px = row + 1 + x * 4;
			raw[px] = Math.round(r);
			raw[px + 1] = Math.round(g);
			raw[px + 2] = Math.round(b);
			raw[px + 3] = Math.round(bgAlpha * 255);
		}
	}

	const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, size, false);
	iv.setUint32(4, size, false);
	ihdr[8] = 8; // 8 bits per channel
	ihdr[9] = 6; // RGBA

	const cIhdr = pngChunk("IHDR", ihdr);
	const cIdat = pngChunk("IDAT", new Uint8Array(deflateSync(raw)));
	const cIend = pngChunk("IEND", new Uint8Array(0));

	const out = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
	let offset = 0;
	for (const part of [sig, cIhdr, cIdat, cIend]) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
