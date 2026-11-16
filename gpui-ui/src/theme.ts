// Theme for the GPUI spike: ui/src/styles.css (+ the default "Quiet Paper" scheme from reader-next/src/viewer/theme.ts)
// resolved to concrete colours, and tw(): the Tailwind classes the web UI uses -> a GPUIX style object.
//
// GPUIX style props used by tw() (all CSS-camelCase, numbers are px):
//   display flexDirection flexWrap flexGrow flexShrink flexBasis alignItems alignSelf alignContent justifyContent gap rowGap
//   columnGap gridTemplateColumns gridTemplateRows width height minWidth minHeight maxWidth maxHeight (number | "N%" | "auto")
//   padding{,Top,Right,Bottom,Left} margin{,Top,Right,Bottom,Left} position top right bottom left aspectRatio
//   backgroundColor color opacity borderWidth border{Top,Right,Bottom,Left}Width borderColor borderStyle
//   borderRadius border{TopLeft,TopRight,BottomLeft,BottomRight}Radius boxShadow (BoxShadow[]) outlineWidth outlineColor
//   outlineOffset fontSize fontFamily fontWeight textAlign lineHeight (px) whiteSpace textOverflow lineClamp textDecoration
//   overflow overflowX overflowY scrollbarColor scrollbarWidth cursor pointerEvents userSelect visibility
//   hover / active / focusVisible (nested style objects)
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Mode, Style } from "./contracts";

// ------------------------------------------------------------------------------------------------ colour maths

interface RGBA {
	r: number;
	g: number;
	b: number;
	a: number;
} // r,g,b 0..255 (float), a 0..1

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type V3 = [number, number, number];

function toOklab({ r, g, b }: RGBA): V3 {
	const R = lin(r / 255),
		G = lin(g / 255),
		B = lin(b / 255);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}
function oklabToLinear(L: number, a: number, b: number): V3 {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}
const fromLinear = (v: V3, a = 1): RGBA => ({ r: gam(clamp01(v[0])) * 255, g: gam(clamp01(v[1])) * 255, b: gam(clamp01(v[2])) * 255, a });

/** oklch() -> sRGB; chroma is lowered (not channels clipped) until the colour is inside the gamut, like CSS gamut mapping. */
function oklch(L: number, C: number, h: number, a = 1): RGBA {
	let c = C;
	for (let i = 0; i < 40; i++) {
		const [x, y] = [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
		const rgb = oklabToLinear(L, x, y);
		if (c <= 0 || rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return fromLinear(rgb, a);
		c *= 0.95;
	}
	return fromLinear(oklabToLinear(L, 0, 0), a);
}

const NAMED: Record<string, RGBA> = {
	transparent: { r: 0, g: 0, b: 0, a: 0 },
	black: { r: 0, g: 0, b: 0, a: 1 },
	white: { r: 255, g: 255, b: 255, a: 1 },
};

function parseColor(s: string): RGBA {
	s = s.trim().toLowerCase();
	if (NAMED[s]) return NAMED[s];
	let m = /^#([0-9a-f]{3,8})$/.exec(s);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
		const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
		return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
	}
	m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
	if (m) {
		const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		return { r: +m[1], g: +m[2], b: +m[3], a };
	}
	m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
	if (m) {
		const l = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
		const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
		return oklch(l, +m[2], +m[3], a);
	}
	throw new Error(`theme: cannot parse colour "${s}"`);
}

/** CSS color-mix(in <space>, a pa%, b): premultiplied interpolation, so mixing with `transparent` only lowers alpha. */
function mix(space: "oklab" | "srgb", a: RGBA, pa: number, b: RGBA): RGBA {
	const wa = pa / 100,
		wb = 1 - wa;
	const al = a.a * wa + b.a * wb;
	if (al <= 0) return { r: 0, g: 0, b: 0, a: 0 };
	const coords = (c: RGBA): V3 => (space === "oklab" ? toOklab(c) : [c.r / 255, c.g / 255, c.b / 255]);
	const ca = coords(a),
		cb = coords(b);
	const out = ca.map((v, i) => (v * a.a * wa + cb[i] * b.a * wb) / al) as V3;
	if (space === "srgb") return { r: out[0] * 255, g: out[1] * 255, b: out[2] * 255, a: al };
	return fromLinear(oklabToLinear(out[0], out[1], out[2]), al);
}

const hex2 = (v: number) =>
	Math.round(Math.min(255, Math.max(0, v)))
		.toString(16)
		.padStart(2, "0");
/** #rrggbb when opaque, otherwise rgba(r, g, b, a). */
function css({ r, g, b, a }: RGBA): string {
	if (a >= 0.9995) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
	return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;
}
/** Multiply a colour's alpha: withAlpha("#2b5fa8", 0.1) -> rgba(43, 95, 168, 0.1). */
export function withAlpha(color: string, alpha: number): string {
	const c = parseColor(color);
	return css({ ...c, a: c.a * clamp01(alpha) });
}

// ------------------------------------------------------------------------------------------------ box shadows

export interface BoxShadow {
	offsetX: number;
	offsetY: number;
	blurRadius: number;
	spreadRadius: number;
	color: string;
	inset?: boolean;
}

function splitTop(s: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0,
		cur = "";
	for (const ch of s) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		if (ch === sep && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out;
}

/** "0 1px 2px rgba(0,0,0,.1), inset 0 0 0 1px #fff" -> BoxShadow[]. */
export function parseShadow(str: string): BoxShadow[] {
	if (!str || str === "none") return [];
	return splitTop(str, ",").map((part) => {
		let inset = false;
		const nums: number[] = [];
		let color = "#000000";
		for (const tok of splitTop(part.trim(), " ")) {
			const t = tok.trim();
			if (!t) continue;
			if (t === "inset") inset = true;
			else if (/^-?[\d.]+(px)?$/.test(t)) nums.push(parseFloat(t));
			else color = css(parseColor(t));
		}
		const [offsetX = 0, offsetY = 0, blurRadius = 0, spreadRadius = 0] = nums;
		const sh: BoxShadow = { offsetX, offsetY, blurRadius, spreadRadius, color };
		if (inset) sh.inset = true;
		return sh;
	});
}

// ------------------------------------------------------------------------------------------------ tokens (styles.css)

/** Hue of the neutral greys and the "Quiet Paper" palette (the default scheme in reader-next/src/viewer/theme.ts). */
const PAPER: Record<Mode, Record<string, string>> = {
	light: {
		canvas: "#F7F6F3",
		topbar: "#F1EFEA",
		background: "#FFFFFF",
		foreground: "#23221F",
		card: "#FBFAF8",
		muted: "#F4F2EE",
		"muted-foreground": "#6B675F",
		popover: "#FFFFFF",
		"popover-foreground": "#23221F",
		border: "#E4E1DA",
		"border-soft": "#ECE9E3",
		input: "#D2CEC5",
		secondary: "#F1EFEA",
		"secondary-foreground": "#3B3934",
		accent: "#F1EFEA",
		"accent-foreground": "#23221F",
		primary: "#2B5FA8",
		ring: "#2B5FA8",
		"primary-foreground": "#FFFFFF",
		"primary-soft": "#EEF3FA",
		"primary-tint": "#E3ECF9",
		"primary-line": "#C9D7EC",
		"primary-deep": "#1D467F",
		"header-tint": "#F6F8FC",
	},
	dark: {
		canvas: "#141413",
		topbar: "#1A1917",
		background: "#1E1D1B",
		foreground: "#EDEBE6",
		card: "#1A1917",
		muted: "#272623",
		"muted-foreground": "#A29E94",
		popover: "#242320",
		"popover-foreground": "#EDEBE6",
		border: "#35332F",
		"border-soft": "#2C2A27",
		input: "#47443E",
		secondary: "#2A2926",
		"secondary-foreground": "#E4E1DA",
		accent: "#2A2926",
		"accent-foreground": "#EDEBE6",
		primary: "#7BA3E6",
		ring: "#7BA3E6",
		"primary-foreground": "#0E121C",
		"primary-soft": "#1D2431",
		"primary-tint": "#243350",
		"primary-line": "#35507E",
		"primary-deep": "#A9C4F0",
		"header-tint": "#1B212D",
	},
};

export const FONT_STACK_SANS = `"ZN Inter", "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`;
export const FONT_STACK_TITLE = `"ZN Source Serif", "Source Serif 4", Georgia, "Times New Roman", serif`;

/**
 * Every custom property of styles.css for one mode, resolved to concrete values. `palette` overrides keys (no leading `--`);
 * the default is Quiet Paper (nh 85), the zotero-next default look. Pass `{}` and nh 260 for the plain "Blue" CSS defaults.
 */
export function buildTokens(mode: Mode, palette: Record<string, string> = PAPER[mode], nh = 85): Record<string, string> {
	const d = mode === "dark";
	const o = (l: number, c: number, h = nh) => css(oklch(l, c, h));
	const t: Record<string, string> = d
		? {
				background: o(0.2, 0.006),
				foreground: o(0.92, 0.005),
				card: o(0.175, 0.006),
				muted: o(0.24, 0.006),
				"muted-foreground": o(0.7, 0.012),
				popover: o(0.235, 0.006),
				"popover-foreground": o(0.92, 0.005),
				border: o(0.31, 0.008),
				input: o(0.36, 0.01),
				ring: "#7aa2f0",
				primary: "#7aa2f0",
				"primary-foreground": "#0e121c",
				secondary: o(0.27, 0.008),
				"secondary-foreground": o(0.9, 0.005),
				accent: o(0.29, 0.012),
				"accent-foreground": o(0.94, 0.005),
				destructive: o(0.68, 0.17, 25),
				"destructive-foreground": o(0.15, 0.02, 25),
				success: o(0.3, 0.06, 150),
				"success-foreground": o(0.82, 0.12, 150),
				warning: o(0.32, 0.06, 90),
				"warning-foreground": o(0.85, 0.12, 90),
				error: o(0.3, 0.07, 25),
				"error-foreground": o(0.82, 0.12, 25),
				journal: "#55c2a0",
				"raised-shadow": "0 0 0 1px rgba(255, 255, 255, 0.05), 0 2px 4px rgba(0, 0, 0, 0.25), 0 12px 32px rgba(0, 0, 0, 0.35)",
				"pill-shadow": "0 0 0 1px rgba(255, 255, 255, 0.07), 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.3)",
			}
		: {
				background: o(0.995, 0),
				foreground: o(0.24, 0.012),
				card: o(0.972, 0.003),
				muted: o(0.955, 0.004),
				"muted-foreground": o(0.47, 0.014),
				popover: o(1, 0),
				"popover-foreground": o(0.24, 0.012),
				border: o(0.88, 0.006),
				input: o(0.8, 0.008),
				ring: "#2a63c4",
				primary: "#2a63c4",
				"primary-foreground": "#ffffff",
				secondary: o(0.95, 0.006),
				"secondary-foreground": o(0.3, 0.012),
				accent: o(0.935, 0.01),
				"accent-foreground": o(0.24, 0.012),
				destructive: o(0.53, 0.2, 27),
				"destructive-foreground": o(0.99, 0),
				success: o(0.95, 0.05, 150),
				"success-foreground": o(0.4, 0.12, 150),
				warning: o(0.96, 0.06, 90),
				"warning-foreground": o(0.44, 0.11, 80),
				error: o(0.95, 0.04, 25),
				"error-foreground": o(0.47, 0.18, 27),
				journal: "#1f7a62",
				"raised-shadow": "0 0 0 1px rgba(35, 34, 31, 0.05), 0 2px 4px rgba(35, 34, 31, 0.04), 0 12px 32px rgba(35, 34, 31, 0.08)",
				"pill-shadow": "0 0 0 1px rgba(35, 34, 31, 0.06), 0 1px 2px rgba(35, 34, 31, 0.06), 0 4px 12px rgba(35, 34, 31, 0.08)",
			};
	Object.assign(t, palette);
	// derived (var()/color-mix chains) unless the palette set them
	const P = parseColor(t["primary"]),
		BG = parseColor(t["background"]);
	t["canvas"] ??= t["card"];
	t["topbar"] ??= t["card"];
	t["border-soft"] ??= t["border"];
	t["header-tint"] ??= css(mix("oklab", P, 4, BG));
	t["primary-soft"] ??= css(mix("oklab", P, 8, BG));
	t["primary-tint"] ??= css(mix("oklab", P, 15, BG));
	t["primary-line"] ??= css(mix("oklab", P, 30, BG));
	t["primary-deep"] ??= css(mix("oklab", P, d ? 70 : 80, d ? NAMED.white : NAMED.black));
	const tr = NAMED.transparent;
	t["primary-shadow"] = `0 1px 2px ${css(mix("srgb", P, 35, tr))}, 0 6px 14px ${css(mix("srgb", P, 25, tr))}`;
	// non-colour custom properties
	t["nh"] = String(nh);
	t["zn-scale"] = "1";
	t["zn-font"] = FONT_STACK_SANS;
	t["zn-title-font"] = FONT_STACK_TITLE;
	t["ip-label"] = "clamp(64px, 28cqw, 112px)";
	return t;
}

/** styles.css custom properties (no leading `--`) resolved per mode, default scheme Quiet Paper. */
export const tokens: Record<Mode, Record<string, string>> = { light: buildTokens("light"), dark: buildTokens("dark") };

/** Parsed box-shadow tokens, ready for style.boxShadow. */
export const shadows: Record<Mode, { raised: BoxShadow[]; pill: BoxShadow[]; primary: BoxShadow[] }> = {
	light: shadowsOf("light"),
	dark: shadowsOf("dark"),
};
function shadowsOf(m: Mode) {
	const t = tokens[m];
	return { raised: parseShadow(t["raised-shadow"]), pill: parseShadow(t["pill-shadow"]), primary: parseShadow(t["primary-shadow"]) };
}

const NON_COLOUR = new Set(["nh", "zn-scale", "zn-font", "zn-title-font", "ip-label", "raised-shadow", "pill-shadow", "primary-shadow"]);

// Sizes. html font-size is 16px * --zn-scale; the app is designed at 13px base text.
export const baseFontSize = 13;
/** Corner radii of Tailwind v4's default scale (the web UI defines no --radius), px. */
export const radius = { none: 0, xs: 2, sm: 4, DEFAULT: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, full: 9999 } as const;
export const fontSizes = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36 } as const;

let scale = 1; // --zn-scale
/** Change the interface text size (13px = scale 1). Rem-based lengths (spacing, text-xs ...) follow, like the web UI. */
export function setUiScale(s: number) {
	if (s === scale) return;
	scale = s;
	cache.clear();
	textCache.clear();
}
let viewportWidth = 1440;
/** Width used to decide whether sm:/md:/lg:/xl: variants apply (default: a wide desktop window). */
export function setViewportWidth(w: number) {
	viewportWidth = w;
	cache.clear();
	textCache.clear();
}

// ------------------------------------------------------------------------------------------------ tailwind -> style

const unknown = new Set<string>();
/** Classes (and variant-prefixed classes) tw() could not map so far, sorted. */
export const twUnknown = (): string[] => [...unknown].sort();
export const twResetUnknown = () => unknown.clear();

/** Tailwind v4 palette entries the UI uses (oklch). Other shades are collected as unknown. */
const PALETTE: Record<string, string> = {
	"red-500": "oklch(0.637 0.237 25.331)",
	"orange-500": "oklch(0.705 0.213 47.604)",
	"amber-500": "oklch(0.769 0.188 70.08)",
	"yellow-500": "oklch(0.795 0.184 86.047)",
	"yellow-300": "oklch(0.905 0.182 98.111)",
	"green-500": "oklch(0.723 0.219 149.579)",
	"emerald-500": "oklch(0.696 0.17 162.48)",
	"teal-500": "oklch(0.704 0.14 182.503)",
	"blue-500": "oklch(0.623 0.214 259.815)",
	"indigo-500": "oklch(0.585 0.233 277.117)",
	"violet-500": "oklch(0.606 0.25 292.717)",
	"purple-500": "oklch(0.627 0.265 303.9)",
	"pink-500": "oklch(0.656 0.241 354.308)",
	"gray-500": "oklch(0.551 0.027 264.364)",
	"slate-500": "oklch(0.554 0.046 257.417)",
	"zinc-500": "oklch(0.552 0.016 285.938)",
	"neutral-500": "oklch(0.556 0 0)",
};

function colourByName(name: string, mode: Mode): string | undefined {
	const tk = tokens[mode];
	if (name === "current" || name === "inherit") return tk["foreground"];
	if (NAMED[name]) return name === "transparent" ? "transparent" : css(NAMED[name]);
	if (!NON_COLOUR.has(name) && tk[name] !== undefined) return tk[name];
	if (PALETTE[name]) return css(parseColor(PALETTE[name]));
	return undefined;
}
/** "primary", "primary/10", "foreground/[0.07]", "[#abc]", "[var(--card)]" -> css colour. */
function colour(v: string, mode: Mode): string | undefined {
	let alpha: number | undefined;
	const slash = v.lastIndexOf("/");
	if (slash > 0 && !v.startsWith("[")) {
		const a = v.slice(slash + 1);
		const n = a.startsWith("[") ? parseFloat(a.slice(1, -1)) : parseFloat(a) / 100;
		if (Number.isNaN(n)) return undefined;
		alpha = n;
		v = v.slice(0, slash);
	}
	let base: string | undefined;
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).replace(/^color:/, "");
		const mv = /^var\(--([\w-]+)\)$/.exec(inner);
		if (mv) base = colourByName(mv[1], mode);
		else {
			try {
				base = css(parseColor(inner.replace(/_/g, " ")));
			} catch {
				base = undefined;
			}
		}
	} else base = colourByName(v, mode);
	if (base === undefined) return undefined;
	return alpha === undefined ? base : withAlpha(base === "transparent" ? "#00000000" : base, alpha);
}

/** Length from an arbitrary value body ("13px", "2rem", "0.5em", "1.35"); percentages are handled by the caller. */
function len(v: string): number | undefined {
	const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(v);
	if (!m) return undefined;
	const n = parseFloat(m[1]);
	if (m[2] === "rem" || m[2] === "em") return n * 16 * scale;
	return n;
}
const arb = (v: string): string | undefined => (v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : undefined);

/** Spacing scale value ("4", "2.5", "px", "[13px]") -> px. */
function sp(v: string): number | undefined {
	if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v) * 4 * scale;
	if (v === "px") return 1;
	const a = arb(v);
	if (a !== undefined) return len(a);
	return undefined;
}

/** Width/height style value: scale, fractions, full, auto, [..]. */
function dim(v: string): number | string | undefined {
	if (v === "full" || v === "screen") return "100%";
	if (v === "auto") return "auto";
	const f = /^(\d+)\/(\d+)$/.exec(v);
	if (f) return `${+((parseFloat(f[1]) / parseFloat(f[2])) * 100).toFixed(4)}%`;
	const a = arb(v);
	if (a !== undefined) {
		if (/^[\d.]+%$/.test(a)) return a;
		return len(a);
	}
	return sp(v);
}

const MAX_W: Record<string, number> = {
	"3xs": 256,
	"2xs": 288,
	xs: 320,
	sm: 384,
	md: 448,
	lg: 512,
	xl: 576,
	"2xl": 672,
	"3xl": 768,
	"4xl": 896,
	"5xl": 1024,
	"6xl": 1152,
	"7xl": 1280,
};

const TEXT_SIZES: Record<string, [number, number]> = {
	xs: [12, 4 / 3],
	sm: [14, 20 / 14],
	base: [16, 1.5],
	lg: [18, 28 / 18],
	xl: [20, 1.4],
	"2xl": [24, 4 / 3],
	"3xl": [30, 1.2],
	"4xl": [36, 10 / 9],
	"5xl": [48, 1],
	"6xl": [60, 1],
	"7xl": [72, 1],
	"8xl": [96, 1],
	"9xl": [128, 1],
};
const LEADING: Record<string, number> = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };
const WEIGHTS: Record<string, number> = {
	thin: 100,
	extralight: 200,
	light: 300,
	normal: 400,
	medium: 500,
	semibold: 600,
	bold: 700,
	extrabold: 800,
	black: 900,
};
const SHADOWS: Record<string, string> = {
	"2xs": "0 1px rgba(0,0,0,0.05)",
	xs: "0 1px 2px 0 rgba(0,0,0,0.05)",
	sm: "0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)",
	md: "0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)",
	lg: "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
	xl: "0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
	"2xl": "0 25px 50px -12px rgba(0,0,0,0.25)",
	inner: "inset 0 2px 4px 0 rgba(0,0,0,0.05)",
	none: "none",
};

/** Exact-match utilities. */
const STATIC: Record<string, Style> = {
	flex: { display: "flex" },
	"inline-flex": { display: "flex" },
	grid: { display: "grid" },
	"inline-grid": { display: "grid" },
	"flex-row": { flexDirection: "row" },
	"flex-col": { flexDirection: "column" },
	"flex-wrap": { flexWrap: "wrap" },
	"flex-nowrap": { flexWrap: "nowrap" },
	"flex-wrap-reverse": { flexWrap: "wrap-reverse" },
	"flex-1": { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
	"flex-auto": { flexGrow: 1, flexShrink: 1 },
	"flex-initial": { flexGrow: 0, flexShrink: 1 },
	"flex-none": { flexGrow: 0, flexShrink: 0 },
	grow: { flexGrow: 1 },
	"grow-0": { flexGrow: 0 },
	shrink: { flexShrink: 1 },
	"shrink-0": { flexShrink: 0 },
	"items-start": { alignItems: "flex-start" },
	"items-center": { alignItems: "center" },
	"items-end": { alignItems: "flex-end" },
	"items-stretch": { alignItems: "stretch" },
	"items-baseline": { alignItems: "baseline" },
	"justify-start": { justifyContent: "flex-start" },
	"justify-center": { justifyContent: "center" },
	"justify-end": { justifyContent: "flex-end" },
	"justify-between": { justifyContent: "space-between" },
	"justify-around": { justifyContent: "space-around" },
	"justify-evenly": { justifyContent: "space-evenly" },
	"self-start": { alignSelf: "flex-start" },
	"self-center": { alignSelf: "center" },
	"self-end": { alignSelf: "flex-end" },
	"self-stretch": { alignSelf: "stretch" },
	"self-baseline": { alignSelf: "baseline" },
	"content-start": { alignContent: "flex-start" },
	"content-center": { alignContent: "center" },
	"content-end": { alignContent: "flex-end" },
	"content-between": { alignContent: "space-between" },
	"content-around": { alignContent: "space-around" },
	"content-evenly": { alignContent: "space-evenly" },
	relative: { position: "relative" },
	absolute: { position: "absolute" },
	fixed: { position: "fixed" },
	visible: { visibility: "visible" },
	invisible: { visibility: "hidden" },
	"overflow-hidden": { overflow: "hidden" },
	"overflow-visible": { overflow: "visible" },
	"overflow-auto": { overflow: "scroll" },
	"overflow-scroll": { overflow: "scroll" },
	"overflow-x-hidden": { overflowX: "hidden" },
	"overflow-y-hidden": { overflowY: "hidden" },
	"overflow-x-auto": { overflowX: "scroll" },
	"overflow-y-auto": { overflowY: "scroll" },
	"overflow-x-scroll": { overflowX: "scroll" },
	"overflow-y-scroll": { overflowY: "scroll" },
	"overflow-x-visible": { overflowX: "visible" },
	"overflow-y-visible": { overflowY: "visible" },
	truncate: { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
	"text-ellipsis": { textOverflow: "ellipsis" },
	"text-clip": {},
	"whitespace-nowrap": { whiteSpace: "nowrap" },
	"whitespace-normal": { whiteSpace: "normal" },
	"text-nowrap": { whiteSpace: "nowrap" },
	"text-left": { textAlign: "left" },
	"text-center": { textAlign: "center" },
	"text-right": { textAlign: "right" },
	"text-start": { textAlign: "left" },
	"text-end": { textAlign: "right" },
	underline: { textDecoration: "underline" },
	"line-through": { textDecoration: "line-through" },
	"no-underline": { textDecoration: "none" },
	"select-none": { userSelect: "none" },
	"select-text": { userSelect: "text" },
	"select-auto": { userSelect: "auto" },
	"pointer-events-none": { pointerEvents: "none" },
	"pointer-events-auto": { pointerEvents: "auto" },
	"sr-only": { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
	"aspect-square": { aspectRatio: 1 },
	"aspect-video": { aspectRatio: 16 / 9 },
	"size-full": { width: "100%", height: "100%" },
	"size-auto": {},
	"border-solid": { borderStyle: "solid" },
	"border-dashed": { borderStyle: "dashed" },
	"border-dotted": { borderStyle: "dashed" },
	"font-sans": { fontFamily: "@sans" },
	"font-title": { fontFamily: "@title" },
	"font-serif": { fontFamily: "@title" },
	"font-mono": { fontFamily: "Cascadia Mono" },
};

/** Utilities that have no static visual effect on a native element (animation, focus rings, stacking, a11y hints ...). */
const NOOP =
	/^(transition|duration-|ease-|delay-|animate-|fade-|zoom-|slide-|spin|origin-|will-change|antialiased|subpixel-antialiased|tabular-nums|ordinal|slashed-zero|normal-nums|outline-none|outline-hidden|ring-offset|ring-inset|group(\/.+)?$|peer(\/.+)?$|appearance-|touch-|resize|list-|z-|break-|hyphens-|fill-|stroke-|stroke$|fill$|align-|isolate|isolation|backdrop-|brightness-|contrast-|saturate-|grayscale|invert|blur|decoration-|underline-offset-|caret-|accent-|scroll-|snap-|overscroll-|content-none|bg-clip|bg-no-repeat|bg-cover|bg-center|text-balance|text-pretty|text-wrap|truncate-none|zn-|cards-|pointer$|focus-within|forced-)/;

interface Acc {
	s: Style;
	hidden?: boolean;
	lhRatio?: number; // explicit leading
	lhSize?: number; // line-height ratio that came with a text-* size
	lhPx?: number;
	ringW?: number;
	ringC?: string;
	shadow?: BoxShadow[];
	border?: boolean;
	borderColored?: boolean;
}

function sides(acc: Acc, base: string, v: number, which: string) {
	// base: "padding" | "margin"; which: "" | x | y | t | r | b | l
	const C = (k: string) => base + k;
	switch (which) {
		case "":
			acc.s[base] = v;
			break;
		case "x":
			acc.s[C("Left")] = v;
			acc.s[C("Right")] = v;
			break;
		case "y":
			acc.s[C("Top")] = v;
			acc.s[C("Bottom")] = v;
			break;
		case "t":
			acc.s[C("Top")] = v;
			break;
		case "r":
		case "e":
			acc.s[C("Right")] = v;
			break;
		case "b":
			acc.s[C("Bottom")] = v;
			break;
		case "l":
		case "s":
			acc.s[C("Left")] = v;
			break;
	}
}

const CORNERS: Record<string, string[]> = {
	"": ["TopLeft", "TopRight", "BottomLeft", "BottomRight"],
	t: ["TopLeft", "TopRight"],
	r: ["TopRight", "BottomRight"],
	b: ["BottomLeft", "BottomRight"],
	l: ["TopLeft", "BottomLeft"],
	tl: ["TopLeft"],
	tr: ["TopRight"],
	bl: ["BottomLeft"],
	br: ["BottomRight"],
	s: ["TopLeft", "BottomLeft"],
	e: ["TopRight", "BottomRight"],
	ss: ["TopLeft"],
	se: ["TopRight"],
	ee: ["BottomRight"],
	es: ["BottomLeft"],
};

/** Apply one utility (no variants) to acc. Returns false when the class is not understood. */
function util(acc: Acc, raw: string, mode: Mode): boolean {
	let neg = false;
	let u = raw;
	if (u.startsWith("-")) {
		neg = true;
		u = u.slice(1);
	}
	const sgn = (n: number) => (neg ? -n : n);
	if (u === "hidden") {
		acc.hidden = true;
		return true;
	}
	if (u === "block" || u === "inline" || u === "inline-block" || u === "contents") {
		acc.hidden = false;
		return true;
	}
	const st = STATIC[u];
	if (st && !neg) {
		if (st.display === "flex" || st.display === "grid") acc.hidden = false;
		Object.assign(acc.s, st);
		return true;
	}
	if (NOOP.test(u)) return true;
	let m: RegExpExecArray | null;

	// spacing
	if ((m = /^(p|px|py|pt|pr|pb|pl|ps|pe)-(.+)$/.exec(u))) {
		const v = sp(m[2]);
		if (v === undefined) return false;
		sides(acc, "padding", v, m[1].slice(1));
		return true;
	}
	if ((m = /^(m|mx|my|mt|mr|mb|ml|ms|me)-(.+)$/.exec(u))) {
		const v = sp(m[2]);
		if (v === undefined) return false; // m*-auto: margin auto is not supported by GPUIX
		sides(acc, "margin", sgn(v), m[1].slice(1));
		return true;
	}
	if ((m = /^gap(?:-(x|y))?-(.+)$/.exec(u))) {
		const v = sp(m[2]);
		if (v === undefined) return false;
		acc.s[m[1] === "x" ? "columnGap" : m[1] === "y" ? "rowGap" : "gap"] = v;
		return true;
	}
	if ((m = /^space-(x|y)-(.+)$/.exec(u))) {
		// children-based in CSS; approximated as a flex container gap
		const v = sp(m[2]);
		if (v === undefined) return false;
		acc.s.gap = v;
		acc.s.display ??= "flex";
		acc.s.flexDirection ??= m[1] === "x" ? "row" : "column";
		return true;
	}

	// position
	if ((m = /^(top|right|bottom|left|inset-x|inset-y|inset)-(.+)$/.exec(u))) {
		const v = sp(m[2]);
		if (v === undefined) return false; // fractions / auto are not supported for offsets
		const val = sgn(v);
		const k = m[1];
		if (k === "inset") Object.assign(acc.s, { top: val, right: val, bottom: val, left: val });
		else if (k === "inset-x") Object.assign(acc.s, { left: val, right: val });
		else if (k === "inset-y") Object.assign(acc.s, { top: val, bottom: val });
		else acc.s[k] = val;
		return true;
	}

	// sizing
	if ((m = /^(w|h|size|min-w|min-h|max-w|max-h)-(.+)$/.exec(u))) {
		const [, k, v] = m;
		if (k.startsWith("max-") && v === "none") return true;
		let val: number | string | undefined;
		if (k === "max-w" && MAX_W[v] !== undefined) val = MAX_W[v] * scale;
		else if (k === "max-w" && v === "prose") val = 65 * 16 * scale * 0.5;
		else val = dim(v);
		if (val === undefined) return false;
		if (val === "auto" && k.startsWith("m")) return true;
		const key: Record<string, string> = {
			w: "width",
			h: "height",
			"min-w": "minWidth",
			"min-h": "minHeight",
			"max-w": "maxWidth",
			"max-h": "maxHeight",
		};
		if (k === "size") {
			acc.s.width = val;
			acc.s.height = val;
		} else acc.s[key[k]] = val;
		return true;
	}
	if ((m = /^basis-(.+)$/.exec(u))) {
		const v = sp(m[1]);
		if (v === undefined) return false;
		acc.s.flexBasis = v;
		return true;
	}
	if ((m = /^grid-(cols|rows)-(\d+)$/.exec(u))) {
		acc.s.display ??= "grid";
		acc.s[m[1] === "cols" ? "gridTemplateColumns" : "gridTemplateRows"] = parseInt(m[2], 10);
		return true;
	}
	if ((m = /^aspect-\[(\d+)\/(\d+)\]$/.exec(u))) {
		acc.s.aspectRatio = parseFloat(m[1]) / parseFloat(m[2]);
		return true;
	}

	// typography
	if ((m = /^text-(.+)$/.exec(u))) {
		const v = m[1];
		if (TEXT_SIZES[v]) {
			acc.s.fontSize = TEXT_SIZES[v][0] * scale;
			acc.lhSize = TEXT_SIZES[v][1];
			return true;
		}
		const a = arb(v);
		if (a !== undefined && /^[\d.]+(px|rem|em)$/.test(a)) {
			const n = len(a)!;
			acc.s.fontSize = a.endsWith("px") ? n * scale : n; // .text-[Npx] follows --zn-scale
			return true;
		}
		const c = colour(v, mode);
		if (c === undefined) return false;
		acc.s.color = c;
		return true;
	}
	if ((m = /^font-(.+)$/.exec(u))) {
		if (WEIGHTS[m[1]] !== undefined) {
			acc.s.fontWeight = WEIGHTS[m[1]];
			return true;
		}
		const a = arb(m[1]);
		if (a !== undefined && /^\d+$/.test(a)) {
			acc.s.fontWeight = parseInt(a, 10);
			return true;
		}
		return false;
	}
	if ((m = /^leading-(.+)$/.exec(u))) {
		const v = m[1];
		if (LEADING[v] !== undefined) {
			acc.lhRatio = LEADING[v];
			return true;
		}
		const a = arb(v);
		if (a !== undefined) {
			if (/^[\d.]+$/.test(a)) {
				acc.lhRatio = parseFloat(a);
				return true;
			}
			const n = len(a);
			if (n !== undefined) {
				acc.lhPx = n;
				return true;
			}
			return false;
		}
		if (/^\d+(\.\d+)?$/.test(v)) {
			acc.lhPx = parseFloat(v) * 4 * scale;
			return true;
		}
		return false;
	}
	if ((m = /^line-clamp-(\d+)$/.exec(u))) {
		acc.s.lineClamp = parseInt(m[1], 10);
		return true;
	}

	// colours
	if ((m = /^bg-(.+)$/.exec(u))) {
		const c = colour(m[1], mode);
		if (c === undefined) return false;
		acc.s.backgroundColor = c;
		return true;
	}

	// borders
	if (u === "border") {
		acc.s.borderWidth = 1;
		acc.border = true;
		return true;
	}
	if ((m = /^border-(x|y|t|r|b|l|s|e)(?:-(\d+))?$/.exec(u))) {
		const w = m[2] === undefined ? 1 : parseInt(m[2], 10);
		const k = m[1];
		const set = (side: string) => (acc.s[`border${side}Width`] = w);
		if (k === "x") {
			set("Left");
			set("Right");
		} else if (k === "y") {
			set("Top");
			set("Bottom");
		} else set(({ t: "Top", r: "Right", b: "Bottom", l: "Left", s: "Left", e: "Right" } as Record<string, string>)[k]);
		acc.border = true;
		return true;
	}
	if ((m = /^border-(\d+)$/.exec(u))) {
		acc.s.borderWidth = parseInt(m[1], 10);
		acc.border = true;
		return true;
	}
	if ((m = /^border-(.+)$/.exec(u))) {
		const a = arb(m[1]);
		if (a !== undefined && /^[\d.]+px$/.test(a)) {
			acc.s.borderWidth = parseFloat(a);
			acc.border = true;
			return true;
		}
		const c = colour(m[1], mode);
		if (c === undefined) return false;
		acc.s.borderColor = c;
		acc.borderColored = true;
		return true;
	}
	if (u === "outline") {
		acc.s.outlineWidth = 1;
		return true;
	}
	if ((m = /^outline-(\d+)$/.exec(u))) {
		acc.s.outlineWidth = parseInt(m[1], 10);
		return true;
	}
	if ((m = /^outline-offset-(\d+)$/.exec(u))) {
		acc.s.outlineOffset = sgn(parseInt(m[1], 10));
		return true;
	}
	if ((m = /^outline-(.+)$/.exec(u))) {
		const c = colour(m[1], mode);
		if (c === undefined) return false;
		acc.s.outlineColor = c;
		return true;
	}
	if (u === "ring") {
		acc.ringW = 1;
		return true;
	} // Tailwind v4: bare ring is 1px
	if ((m = /^ring-(\d+)$/.exec(u))) {
		acc.ringW = parseInt(m[1], 10);
		return true;
	}
	if ((m = /^ring-(.+)$/.exec(u))) {
		const c = colour(m[1], mode);
		if (c === undefined) return false;
		acc.ringC = c;
		return true;
	}

	// radius
	if ((m = /^rounded(?:-(t|r|b|l|tl|tr|bl|br|s|e|ss|se|ee|es))?(?:-(.+))?$/.exec(u))) {
		const side = m[1] ?? "";
		let v: number | undefined;
		if (m[2] === undefined) v = radius.DEFAULT;
		else if (m[2] in radius) v = radius[m[2] as keyof typeof radius];
		else {
			const a = arb(m[2]);
			if (a !== undefined) v = len(a);
		}
		if (v === undefined) return false;
		if (side === "") acc.s.borderRadius = v;
		else for (const c of CORNERS[side]) acc.s[`border${c}Radius`] = v;
		return true;
	}

	// effects
	if ((m = /^opacity-(\d+)$/.exec(u))) {
		acc.s.opacity = parseInt(m[1], 10) / 100;
		return true;
	}
	if ((m = /^opacity-\[([\d.]+)\]$/.exec(u))) {
		acc.s.opacity = parseFloat(m[1]);
		return true;
	}
	if ((m = /^shadow(?:-(.+))?$/.exec(u))) {
		const k = m[1] ?? "sm"; // Tailwind v4: bare `shadow` is the old `shadow-sm` look
		if (SHADOWS[k] !== undefined) {
			acc.shadow = parseShadow(SHADOWS[k]);
			return true;
		}
		if (k === "raised" || k === "pill" || k === "primary") {
			acc.shadow = shadows[mode][k];
			return true;
		}
		return false;
	}
	if ((m = /^cursor-(.+)$/.exec(u))) {
		acc.s.cursor = m[1];
		return true;
	}
	if ((m = /^scrollbar-/.exec(u))) return true;
	return false;
}

function finish(acc: Acc, mode: Mode, withDefaults: boolean): Style {
	const s = acc.s;
	// display:none has no GPUIX equivalent: collapse the box and hide it (prefer <Show> where it matters)
	if (acc.hidden) Object.assign(s, { display: "none", visibility: "hidden", width: 0, height: 0, overflow: "hidden" });
	if (s.display === "flex" || s.display === "grid") s.flexDirection ??= s.display === "flex" ? "row" : undefined;
	if (s.flexDirection === undefined) delete s.flexDirection;
	// overflow:scroll turns the native scrollbar on only when scrollbarColor is set
	if (s.overflow === "scroll" || s.overflowX === "scroll" || s.overflowY === "scroll") {
		s.scrollbarColor = tokens[mode]["input"];
		s.scrollbarWidth = 6;
	}
	if (acc.border && !acc.borderColored && s.borderColor === undefined) s.borderColor = tokens[mode]["border"];
	if (acc.shadow || acc.ringW !== undefined) {
		const list: BoxShadow[] = [];
		if (acc.ringW !== undefined)
			list.push({ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: acc.ringW, color: acc.ringC ?? tokens[mode]["foreground"] });
		if (acc.shadow) list.push(...acc.shadow);
		if (list.length) s.boxShadow = list;
	}
	// line height: explicit leading > ratio that came with text-* > body leading-snug (1.375)
	const fs = s.fontSize as number | undefined;
	if (acc.lhPx !== undefined) s.lineHeight = acc.lhPx;
	else if (fs !== undefined || acc.lhRatio !== undefined || withDefaults) {
		const size = fs ?? baseFontSize * scale;
		s.lineHeight = +(size * (acc.lhRatio ?? acc.lhSize ?? 1.375)).toFixed(2);
	}
	return s;
}

const RESPONSIVE: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

/** Split "dark:hover:bg-x" at top-level colons (colons inside [..] / (..) are kept). */
function splitVariants(c: string): string[] {
	const parts: string[] = [];
	let depth = 0,
		cur = "";
	for (const ch of c) {
		if (ch === "[" || ch === "(") depth++;
		else if (ch === "]" || ch === ")") depth--;
		if (ch === ":" && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	parts.push(cur);
	return parts;
}

const cache = new Map<string, Style>();
const textCache = new Map<string, Style>();

function compute(classes: string, mode: Mode, withDefaults: boolean): Style {
	const base: Acc = { s: {} };
	const hover: Acc = { s: {} },
		active: Acc = { s: {} },
		focusVisible: Acc = { s: {} };
	for (const token of classes.split(/\s+/)) {
		if (!token) continue;
		const parts = splitVariants(token);
		let u = parts.pop()!;
		if (u.startsWith("!")) u = u.slice(1);
		if (u.endsWith("!")) u = u.slice(0, -1);
		let target = base;
		let skip = false,
			bad = false,
			focusOnly = false;
		for (const v of parts) {
			if (v === "hover") target = hover;
			else if (v === "active") target = active;
			else if (v === "focus-visible") target = focusVisible;
			else if (v === "focus") {
				target = hover;
				focusOnly = true;
			} // menu items: focus follows the pointer; only colours carry over
			else if (v === "dark") {
				if (mode !== "dark") skip = true;
			} else if (v === "light") {
				if (mode !== "light") skip = true;
			} else if (RESPONSIVE[v] !== undefined) {
				if (viewportWidth < RESPONSIVE[v]) skip = true;
			} else if (v === "motion-safe" || v === "print") {
				/* ignore */
			} else bad = true; // group-*, peer-*, data-*, aria-*, disabled:, first:, after:, [&...]:, placeholder: ...
		}
		if (skip) continue;
		if (bad) {
			unknown.add(token);
			continue;
		}
		if (focusOnly) {
			const tmp: Acc = { s: {} };
			if (!util(tmp, u, mode)) {
				unknown.add(token);
				continue;
			}
			for (const k of ["backgroundColor", "color", "opacity"]) if (tmp.s[k] !== undefined) hover.s[k] = tmp.s[k];
			continue;
		}
		if (!util(target, u, mode)) unknown.add(token);
	}
	const s = finish(base, mode, withDefaults);
	for (const [k, acc] of [
		["hover", hover],
		["active", active],
		["focusVisible", focusVisible],
	] as const) {
		const st = finish(acc, mode, false);
		if (Object.keys(st).length) s[k] = st;
	}
	return s;
}

function resolveFamily(s: Style) {
	const f = s.fontFamily;
	if (f === "@sans") s.fontFamily = fontFamilyNames.sans;
	else if (f === "@title") s.fontFamily = fontFamilyNames.title;
	for (const k of ["hover", "active", "focusVisible"]) {
		const sub = s[k] as Style | undefined;
		if (sub?.fontFamily === "@sans") sub.fontFamily = fontFamilyNames.sans;
		else if (sub?.fontFamily === "@title") sub.fontFamily = fontFamilyNames.title;
	}
	return s;
}

/** Registered font family names (fonts.ts mirrors this; kept here so theme.ts has no GPUIX dependency). */
export const fontFamilyNames = { sans: "Inter", title: "Source Serif 4" };

/**
 * Tailwind classes -> GPUIX style. Memoised per (classes, mode); treat the result as read-only.
 * Utilities with no native equivalent are skipped and recorded (see twUnknown()).
 */
export function tw(classes: string | undefined | false | null, mode: Mode): Style {
	if (!classes) return EMPTY;
	const key = `${mode}|${classes}`;
	let s = cache.get(key);
	if (!s) {
		s = resolveFamily(compute(classes, mode, false));
		cache.set(key, s);
	}
	return s;
}
const EMPTY: Style = Object.freeze({}) as Style;

/** tw() for a <text> element: always has color (default foreground), fontSize (13), lineHeight and fontFamily (UI sans). */
export function textStyle(classes: string | undefined | false | null, mode: Mode): Style {
	const key = `${mode}|${classes || ""}`;
	let s = textCache.get(key);
	if (!s) {
		const base = classes ? compute(classes, mode, true) : compute("", mode, true);
		s = { ...base };
		s.color ??= tokens[mode]["foreground"];
		s.fontSize ??= baseFontSize * scale;
		s.fontFamily ??= "@sans";
		s.lineHeight ??= +((s.fontSize as number) * 1.375).toFixed(2);
		resolveFamily(s);
		textCache.set(key, s);
	}
	return s;
}

/** clsx + tailwind-merge, the same helper the web UI's lib/utils.ts exports. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
