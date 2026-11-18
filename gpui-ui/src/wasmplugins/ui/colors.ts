// `types.color` -> a CSS colour string for the current mode. Pure (takes the mode), so it is unit-testable.
import type { Mode } from "../../contracts";
import { tokens, withAlpha } from "../../theme";
import type { Color } from "./types";

/** The eight categorical colours (DESIGN.md c-blue ... c-slate), per mode. Dark values are lifted for contrast on #1e1d1b. */
export const PALETTE: Record<Mode, Record<string, string>> = {
	light: {
		"palette-blue": "#2B5FA8",
		"palette-sky": "#2E8AB8",
		"palette-green": "#1F7A62",
		"palette-amber": "#B76A12",
		"palette-rust": "#C0532E",
		"palette-rose": "#B2457A",
		"palette-violet": "#6A4FC8",
		"palette-slate": "#5F6B7A",
	},
	dark: {
		"palette-blue": "#7BA3E6",
		"palette-sky": "#5DB5DD",
		"palette-green": "#4FBF9E",
		"palette-amber": "#E0953A",
		"palette-rust": "#E27D5A",
		"palette-rose": "#DC78A8",
		"palette-violet": "#A38DF0",
		"palette-slate": "#9AA6B6",
	},
};

/** A user override of tokens (`ui.set-theme-override`), per mode. Set by the host module; empty by default. */
export const overrides: Record<Mode, Record<string, string>> = { light: {}, dark: {} };

export function tokenColor(name: string, mode: Mode): string {
	return overrides[mode][name] ?? PALETTE[mode][name] ?? tokens[mode][name] ?? "#888888";
}

/** 0xRRGGBBAA -> "#rrggbb" or "rgba(r, g, b, a)". */
export function rgbaCss(v: number): string {
	const n = v >>> 0;
	const r = (n >>> 24) & 255,
		g = (n >>> 16) & 255,
		b = (n >>> 8) & 255,
		a = n & 255;
	const h = (x: number) => x.toString(16).padStart(2, "0");
	return a === 255 ? `#${h(r)}${h(g)}${h(b)}` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
}

export function resolveColor(c: Color | undefined, mode: Mode): string | undefined {
	if (!c) return undefined;
	switch (c.tag) {
		case "token":
			return tokenColor(c.val, mode);
		case "token-alpha":
			return withAlpha(tokenColor(c.val.token, mode), c.val.alpha / 255);
		case "rgba":
			return rgbaCss(c.val);
		case "themed":
			return rgbaCss(mode === "dark" ? c.val.dark : c.val.light);
	}
}

/** "#rrggbb" for a canvas / svg fill (alpha dropped: svg takes fill-opacity separately). */
export function svgColor(c: Color | undefined, mode: Mode): { color: string; opacity: number } | undefined {
	const css = resolveColor(c, mode);
	if (!css) return undefined;
	const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(css);
	if (m) return { color: `rgb(${m[1]},${m[2]},${m[3]})`, opacity: parseFloat(m[4]!) };
	return { color: css, opacity: 1 };
}
