// `ui.measure-text`: GPUIX has no text-measurement call, so sizes are estimated from per-character advances of Inter (and Cascadia
// Mono), close enough for label layout in a canvas. Wrapping is greedy on spaces.
import { FONT_SIZE } from "./styleMap";

// advance widths in em for Inter regular (rounded); anything else uses the average
const NARROW = new Set("iIjl.,:;'|!");
const WIDE = new Set("mwMW@%");
const advance = (ch: string, family: string): number => {
	if (family === "mono") return 0.6;
	if (ch === " ") return 0.28;
	if (NARROW.has(ch)) return 0.28;
	if (WIDE.has(ch)) return 0.86;
	if (ch >= "A" && ch <= "Z") return 0.66;
	if (ch >= "0" && ch <= "9") return 0.6;
	if (ch.charCodeAt(0) > 0x2e80) return 1; // CJK
	return 0.54;
};

export function measureText(r: { text: string; size: string; weight: string; family: string; maxWidth?: number }): { width: number; height: number; lines: number } {
	const size = FONT_SIZE[r.size] ?? 13;
	const bold = r.weight === "bold" ? 1.06 : r.weight === "semibold" ? 1.04 : r.weight === "medium" ? 1.02 : 1;
	const w = (s: string) => [...s].reduce((n, ch) => n + advance(ch, r.family), 0) * size * bold;
	const lineH = +(size * 1.4).toFixed(2);
	const out: string[] = [];
	for (const para of r.text.split("\n")) {
		if (r.maxWidth === undefined) {
			out.push(para);
			continue;
		}
		let cur = "";
		for (const word of para.split(/(?<= )/)) {
			if (cur && w(cur + word) > r.maxWidth) {
				out.push(cur);
				cur = word;
			} else cur += word;
		}
		out.push(cur);
	}
	const width = Math.max(0, ...out.map((l) => w(l.replace(/ +$/, ""))));
	const lines = Math.max(1, out.length);
	return { width: +Math.min(width, r.maxWidth ?? width).toFixed(2), height: +(lines * lineH).toFixed(2), lines };
}
