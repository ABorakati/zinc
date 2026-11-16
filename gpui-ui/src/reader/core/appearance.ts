// Page appearance (reader-next/src/viewer/appearance.ts): how the white PDF page is tinted. The web viewer does it with CSS
// filters on the canvas; GPUIX has none, so the recolouring happens in the rasterizer (native/pdf `look`) while the bitmap is
// converted to BGRA. Changing the appearance re-renders the visible tiles; it costs nothing otherwise.
//
//   normal   no change
//   dark     invert + hue-rotate (images keep their hues)                -> look 1
//   sepia    multiply onto #f4ecd8                                       -> look 2
//   custom   light colour: multiply; dark colour: dark + screen onto it  -> look 2 / 3
//   reading  duotone black -> text colour, white -> paper colour         -> look 4 (colours set with setAppearance({mode:"reading", fg, bg}),
//            e.g. by the reflow plugin so the page view matches the reading view)
import { createSignal } from "solid-js";
import type { Look } from "../pdf";
import { getAppearance, saveAppearance, type Appearance, type AppearanceMode } from "./state";

export type { Appearance, AppearanceMode };

const [appearance, setAppearanceSig] = createSignal<Appearance>({ mode: "normal", custom: "#e8f0e0" });
export { appearance as readerAppearance };

let loaded = false;
/** Read the remembered appearance (once; the file is not touched at import time so scripts can point it elsewhere first). */
export function initReaderAppearance(): void {
	if (loaded) return;
	loaded = true;
	setAppearanceSig(getAppearance());
}

export function setReaderAppearance(a: Appearance): void {
	loaded = true;
	setAppearanceSig(a);
	saveAppearance(a);
}

export const SEPIA = "#f4ecd8";

export function hexToRgb(h: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
	if (!m) return null;
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const num = (h: string, d = 0xffffff): number => {
	const c = hexToRgb(h);
	return c ? (c[0] << 16) | (c[1] << 8) | c[2] : d;
};
const luminance = (c: [number, number, number]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** The rasterizer look for an appearance. */
export function lookOf(a: Appearance): Look {
	switch (a.mode) {
		case "dark":
			return { mode: 1 };
		case "sepia":
			return { mode: 2, c0: num(SEPIA) };
		case "custom": {
			const c = hexToRgb(a.custom) ?? [255, 255, 255];
			return luminance(c) > 0.5 ? { mode: 2, c0: num(a.custom) } : { mode: 3, c0: num(a.custom) };
		}
		case "reading":
			return a.fg && a.bg ? { mode: 4, c0: num(a.fg, 0), c1: num(a.bg) } : { mode: 0 };
		default:
			return { mode: 0 };
	}
}
export const lookKey = (l: Look): string => `${l.mode}.${l.c0 ?? 0}.${l.c1 ?? 0}`;

/** Approximate paper colour (shown where a tile has not been drawn yet, and around the pages). */
export function paperColor(a: Appearance): string {
	switch (a.mode) {
		case "dark":
			return "#111111";
		case "sepia":
			return SEPIA;
		case "custom":
			return hexToRgb(a.custom) ? a.custom : "#ffffff";
		case "reading":
			return a.bg && a.fg ? a.bg : "#ffffff";
		default:
			return "#ffffff";
	}
}
/** Whether the paper is dark, so overlays (selection, search) pick a visible colour. */
export function paperIsDark(a: Appearance): boolean {
	const c = hexToRgb(paperColor(a));
	return c ? luminance(c) < 0.5 : false;
}
