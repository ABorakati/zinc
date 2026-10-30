// Page appearance: how the white PDF page is tinted. The canvas is composited over a coloured backing
// element so that white -> chosen colour and black stays black:
//   normal   no change
//   dark     invert + hue-rotate (images keep their hues)
//   sepia    multiply onto #f4ecd8
//   custom   light colour: multiply; dark colour: invert, then screen onto the colour
//   reading  duotone SVG filter mapping black -> --rn-reading-fg and white -> --rn-reading-bg
//            (the variables are published on documentElement by the reflow view)
import { createSignal } from "solid-js";

export type AppearanceMode = "normal" | "dark" | "sepia" | "custom" | "reading";
export interface Appearance {
	mode: AppearanceMode;
	custom: string; // #rrggbb
}

const KEY = "rn.appearance";
const SEPIA = "#f4ecd8";

function load(): Appearance {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
		if (v && typeof v.mode === "string") return { mode: v.mode, custom: typeof v.custom === "string" ? v.custom : "#e8f0e0" };
	} catch { /* ignore */ }
	return { mode: "normal", custom: "#e8f0e0" };
}

const [appearance, setAppearanceSig] = createSignal<Appearance>(load());
export { appearance };
export function setAppearance(a: Appearance) {
	setAppearanceSig(a);
	try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* ignore */ }
}

export type RGB = [number, number, number];

let probe: CanvasRenderingContext2D | null = null;
/** Normalise any CSS colour string to rgb 0-255 (null if unparseable). */
export function parseColor(s: string): RGB | null {
	s = s.trim();
	if (!s) return null;
	probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!probe) return null;
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = "#010203";
	probe.fillStyle = s;
	probe.fillRect(0, 0, 1, 1);
	const d = probe.getImageData(0, 0, 1, 1).data;
	return [d[0], d[1], d[2]];
}
export const luminance = ([r, g, b]: RGB) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

// The reflow view's colours; re-read when documentElement's style/class changes.
const [readingVars, setReadingVars] = createSignal<{ bg: RGB; fg: RGB } | null>(null);
function readReading() {
	const cs = getComputedStyle(document.documentElement);
	const bg = parseColor(cs.getPropertyValue("--rn-reading-bg"));
	const fg = parseColor(cs.getPropertyValue("--rn-reading-fg"));
	const prev = readingVars();
	if (bg && fg) {
		if (!prev || prev.bg.join() !== bg.join() || prev.fg.join() !== fg.join()) setReadingVars({ bg, fg });
	} else if (prev) setReadingVars(null);
}
export function watchReadingVars() {
	readReading();
	new MutationObserver(readReading).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
	window.addEventListener("focus", readReading);
}
export const hasReadingColours = () => readingVars() !== null;

export interface PageLook {
	/** style for the element behind the canvas (the "paper") */
	paper: Record<string, string>;
	/** style for the canvas */
	canvas: Record<string, string>;
	/** approximate paper colour (for chrome around pages) */
	paperColor: string;
	/** SVG duotone filter definition, if needed */
	duotone?: { id: string; fg: RGB; bg: RGB };
	dark: boolean;
}

export function pageLook(a: Appearance): PageLook {
	const white = { paper: { "background-color": "#fff" }, canvas: {} as Record<string, string>, paperColor: "#fff", dark: false };
	switch (a.mode) {
		case "dark":
			return { paper: { "background-color": "#111" }, canvas: { filter: "invert(0.92) hue-rotate(180deg)" }, paperColor: "#111", dark: true };
		case "sepia":
			return { paper: { "background-color": SEPIA }, canvas: { "mix-blend-mode": "multiply" }, paperColor: SEPIA, dark: false };
		case "custom": {
			const c = parseColor(a.custom) ?? ([255, 255, 255] as RGB);
			if (luminance(c) > 0.5) return { paper: { "background-color": hex(c) }, canvas: { "mix-blend-mode": "multiply" }, paperColor: hex(c), dark: false };
			return { paper: { "background-color": hex(c) }, canvas: { filter: "invert(1) hue-rotate(180deg)", "mix-blend-mode": "screen" }, paperColor: hex(c), dark: true };
		}
		case "reading": {
			const r = readingVars();
			if (!r) return { ...white };
			return {
				paper: { "background-color": hex(r.bg) },
				canvas: { filter: "url(#rn-duotone)" },
				paperColor: hex(r.bg),
				duotone: { id: "rn-duotone", fg: r.fg, bg: r.bg },
				dark: luminance(r.bg) < 0.5,
			};
		}
		default:
			return { ...white };
	}
}
