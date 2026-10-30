// Interface theme (light / dark / system, colour scheme, font, text size) shared by the app shell (ui/) and the
// reader chrome (reader-next/). The Settings page writes `zn.theme`; every document applies it at boot and follows
// the `storage` event (fired in the other same-origin documents) plus the OS colour-scheme media query.
//
// The stored JSON also carries the derived CSS variables (`v`), so the tiny inline script in each index.html can
// paint the right theme before first paint without any of the colour maths below.
//
// This module is dependency-free (no Solid) so it can run from an inline boot path and from both bundles.

export type ThemeMode = "system" | "light" | "dark";
export type FontId = "manrope" | "system" | "inter" | "plex" | "source" | "custom";

export interface ThemePrefs {
	mode: ThemeMode;
	/** Id from SCHEMES, or "custom" (uses `accent`). */
	scheme: string;
	/** #rrggbb, used when scheme === "custom". */
	accent: string;
	font: FontId;
	/** Installed font family typed by the user, used when font === "custom". */
	fontCustom: string;
	/** Base interface text size in px (the app was designed at 13). */
	size: number;
}

export const THEME_KEY = "zn.theme";
export const DEFAULT_THEME: ThemePrefs = { mode: "system", scheme: "paper", accent: "#2f6fdc", font: "inter", fontCustom: "", size: 13 };
export const TEXT_SIZES = [12, 13, 14, 15] as const;
const BASE_SIZE = 13;

export interface SchemeDef {
	id: string;
	label: string;
	/** oklch hue and chroma of the accent */
	h: number;
	c: number;
	/** starting lightness in light / dark mode (nudged until the button text reaches 4.5:1) */
	lLight: number;
	lDark: number;
	/** hue of the neutral greys (tinted very slightly towards the accent) */
	nh: number;
	/** Hand-picked CSS variables for a whole look (surfaces, text, borders, accent), replacing the computed accent and the
	 *  CSS neutrals. Cleared from <html> again when another scheme is chosen. */
	palette?: { light: Record<string, string>; dark: Record<string, string> };
}

/** "Quiet Paper": warm paper canvas with raised white cards (the zotero-next default look). */
const PAPER: NonNullable<SchemeDef["palette"]> = {
	light: {
		"--canvas": "#F7F6F3", "--topbar": "#F1EFEA",
		"--background": "#FFFFFF", "--foreground": "#23221F",
		"--card": "#FBFAF8", "--muted": "#F4F2EE", "--muted-foreground": "#6B675F",
		"--popover": "#FFFFFF", "--popover-foreground": "#23221F",
		"--border": "#E4E1DA", "--border-soft": "#ECE9E3", "--input": "#D2CEC5",
		"--secondary": "#F1EFEA", "--secondary-foreground": "#3B3934",
		"--accent": "#F1EFEA", "--accent-foreground": "#23221F",
		"--primary": "#2B5FA8", "--ring": "#2B5FA8", "--primary-foreground": "#FFFFFF",
		"--primary-soft": "#EEF3FA", "--primary-tint": "#E3ECF9", "--primary-line": "#C9D7EC", "--primary-deep": "#1D467F",
		"--header-tint": "#F6F8FC",
	},
	dark: {
		"--canvas": "#141413", "--topbar": "#1A1917",
		"--background": "#1E1D1B", "--foreground": "#EDEBE6",
		"--card": "#1A1917", "--muted": "#272623", "--muted-foreground": "#A29E94",
		"--popover": "#242320", "--popover-foreground": "#EDEBE6",
		"--border": "#35332F", "--border-soft": "#2C2A27", "--input": "#47443E",
		"--secondary": "#2A2926", "--secondary-foreground": "#E4E1DA",
		"--accent": "#2A2926", "--accent-foreground": "#EDEBE6",
		"--primary": "#7BA3E6", "--ring": "#7BA3E6", "--primary-foreground": "#0E121C",
		"--primary-soft": "#1D2431", "--primary-tint": "#243350", "--primary-line": "#35507E", "--primary-deep": "#A9C4F0",
		"--header-tint": "#1B212D",
	},
};
const PALETTE_KEYS = Object.keys({ ...PAPER.light, ...PAPER.dark });

export const SCHEMES: SchemeDef[] = [
	{ id: "paper", label: "Quiet Paper", h: 258, c: 0.13, lLight: 0.5, lDark: 0.72, nh: 85, palette: PAPER },
	{ id: "blue", label: "Blue", h: 255, c: 0.16, lLight: 0.55, lDark: 0.7, nh: 260 },
	{ id: "teal", label: "Teal", h: 190, c: 0.11, lLight: 0.55, lDark: 0.74, nh: 205 },
	{ id: "violet", label: "Violet", h: 295, c: 0.17, lLight: 0.52, lDark: 0.72, nh: 295 },
	{ id: "rose", label: "Rose", h: 5, c: 0.18, lLight: 0.55, lDark: 0.72, nh: 10 },
	{ id: "amber", label: "Amber", h: 70, c: 0.14, lLight: 0.55, lDark: 0.78, nh: 80 },
	{ id: "graphite", label: "Graphite", h: 260, c: 0.012, lLight: 0.36, lDark: 0.86, nh: 260 },
];

export interface FontDef { id: FontId; label: string; stack: string }
const FALLBACK = `"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`;
export const FONTS: FontDef[] = [
	{ id: "manrope", label: "Manrope", stack: `"ZN Manrope", ${FALLBACK}` },
	{ id: "system", label: "System font", stack: FALLBACK },
	{ id: "inter", label: "Inter", stack: `"ZN Inter", ${FALLBACK}` },
	{ id: "plex", label: "IBM Plex Sans", stack: `"ZN Plex Sans", ${FALLBACK}` },
	{ id: "source", label: "Source Sans 3", stack: `"ZN Source Sans", ${FALLBACK}` },
];
/** Common installed fonts offered as suggestions for "Other…". */
export const FONT_SUGGESTIONS = ["Segoe UI", "Aptos", "Calibri", "Arial", "Verdana", "Tahoma", "Trebuchet MS", "Georgia", "Cambria", "Consolas"];

// ---------------------------------------------------------------- colour maths (OKLCH <-> sRGB, WCAG contrast)

type V3 = [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const byte = (c: number) => Math.round(Math.min(1, Math.max(0, gam(Math.min(1, Math.max(0, c))))) * 255);
const toHex = (b: V3) => "#" + b.map((v) => v.toString(16).padStart(2, "0")).join("");

function oklchToLinear(L: number, C: number, h: number): V3 {
	const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** OKLCH -> #rrggbb, lowering chroma (not clipping channels) until the colour is inside sRGB. */
function oklchToBytes(L: number, C: number, h: number): V3 {
	let c = C;
	for (let i = 0; i < 40; i++) {
		const rgb = oklchToLinear(L, c, h);
		if (rgb.every((v) => v >= -0.0005 && v <= 1.0005) || c <= 0) return rgb.map(byte) as V3;
		c *= 0.93;
	}
	return oklchToLinear(L, 0, h).map(byte) as V3;
}
function hexToOklch(hex: string): { L: number; C: number; h: number } {
	const n = parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255));
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
const luminance = ([r, g, b]: V3) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
export function contrast(a: V3, b: V3) {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const WHITE: V3 = [255, 255, 255];
const INK: V3 = [14, 18, 28];
const MIN_CONTRAST = 4.6; // a little over 4.5 so rounding never lands under it

/** The accent for one mode: nudges lightness until white (light) / dark ink (dark) text on it reaches >= 4.5:1. */
export function accentFor(h: number, c: number, l0: number, dark: boolean): { primary: string; foreground: string; ratio: number } {
	let L = l0;
	let rgb = oklchToBytes(L, c, h);
	for (let i = 0; i < 70; i++) {
		rgb = oklchToBytes(L, c, h);
		if (Math.max(contrast(rgb, WHITE), contrast(rgb, INK)) >= MIN_CONTRAST) break;
		L += dark ? 0.01 : -0.01;
	}
	const cw = contrast(rgb, WHITE), ci = contrast(rgb, INK);
	// prefer the mode's natural text colour when it passes, else whichever reads better
	const useWhite = dark ? cw > ci && ci < MIN_CONTRAST : cw >= MIN_CONTRAST || cw >= ci;
	return { primary: toHex(rgb), foreground: toHex(useWhite ? WHITE : INK), ratio: Math.max(useWhite ? cw : ci, 0) };
}

// ---------------------------------------------------------------- prefs

const HEX = /^#[0-9a-f]{6}$/i;
export function sanitizeTheme(v: unknown): ThemePrefs {
	const o = (v && typeof v === "object" ? v : {}) as Partial<ThemePrefs>;
	const d = DEFAULT_THEME;
	const scheme = typeof o.scheme === "string" && (o.scheme === "custom" || SCHEMES.some((s) => s.id === o.scheme)) ? o.scheme : d.scheme;
	return {
		mode: o.mode === "light" || o.mode === "dark" || o.mode === "system" ? o.mode : d.mode,
		scheme,
		accent: typeof o.accent === "string" && HEX.test(o.accent) ? o.accent.toLowerCase() : d.accent,
		font: (["manrope", "system", "inter", "plex", "source", "custom"] as const).includes(o.font as FontId) ? (o.font as FontId) : d.font,
		fontCustom: typeof o.fontCustom === "string" ? cleanFamily(o.fontCustom) : "",
		size: typeof o.size === "number" && o.size >= 11 && o.size <= 18 ? Math.round(o.size) : d.size,
	};
}
/** A single family name; quotes, separators and braces are dropped so it cannot break out of the CSS declaration. */
export function cleanFamily(s: string) { return s.replace(/["'`;{}<>\\\n\r:]/g, "").replace(/\s+/g, " ").trim().slice(0, 64); }

export function loadTheme(): ThemePrefs {
	try { return sanitizeTheme(JSON.parse(localStorage.getItem(THEME_KEY) ?? "null")); } catch { return { ...DEFAULT_THEME }; }
}

export interface ThemeVars { g: Record<string, string>; light: Record<string, string>; dark: Record<string, string> }

export function fontStack(p: ThemePrefs): string {
	if (p.font === "custom" && p.fontCustom) return `"${p.fontCustom}", ${FALLBACK}`;
	return (FONTS.find((f) => f.id === p.font) ?? FONTS[0]).stack;
}

/** Everything the CSS needs from the prefs, split into mode-independent and per-mode variables. */
export function computeVars(p: ThemePrefs): ThemeVars {
	const def = SCHEMES.find((s) => s.id === p.scheme);
	const modeVars = (dark: boolean) => {
		let h: number, c: number, l: number, nh: number;
		if (def) { h = def.h; c = def.c; l = dark ? def.lDark : def.lLight; nh = def.nh; }
		else {
			const k = hexToOklch(p.accent);
			h = k.h; c = Math.min(k.C, 0.2);
			l = dark ? Math.min(0.82, Math.max(0.66, k.L)) : Math.min(0.56, Math.max(0.42, k.L));
			nh = k.C > 0.03 ? k.h : 260;
		}
		const a = accentFor(h, c, l, dark);
		const base = { "--primary": a.primary, "--ring": a.primary, "--primary-foreground": a.foreground, "--nh": String(Math.round(nh)) };
		return def?.palette ? { ...base, ...def.palette[dark ? "dark" : "light"] } : base;
	};
	return {
		g: { "--zn-font": fontStack(p), "--zn-scale": String(+(p.size / BASE_SIZE).toFixed(4)) },
		light: modeVars(false),
		dark: modeVars(true),
	};
}

export function saveTheme(p: ThemePrefs) {
	try { localStorage.setItem(THEME_KEY, JSON.stringify({ ...p, v: computeVars(p) })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- applying

const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
export const resolveDark = (m: ThemeMode) => (m === "system" ? !!media()?.matches : m === "dark");

export function applyTheme(p: ThemePrefs, root: HTMLElement = document.documentElement) {
	const dark = resolveDark(p.mode);
	root.classList.toggle("dark", dark);
	root.dataset.theme = dark ? "dark" : "light";
	root.dataset.scheme = p.scheme;
	root.style.colorScheme = dark ? "dark" : "light";
	const v = computeVars(p);
	// a previous scheme's hand-picked palette must not linger once another scheme is chosen
	for (const k of PALETTE_KEYS) root.style.removeProperty(k);
	for (const [k, val] of Object.entries({ ...v.g, ...(dark ? v.dark : v.light) })) root.style.setProperty(k, val);
}

/** Apply now and keep applying: other documents changing `zn.theme`, and the OS scheme while mode is "system". */
export function watchTheme(onChange?: (p: ThemePrefs) => void) {
	let cur = loadTheme();
	const run = () => { applyTheme(cur); onChange?.(cur); };
	run();
	window.addEventListener("storage", (e) => { if (e.key === THEME_KEY || e.key === null) { cur = loadTheme(); run(); } });
	media()?.addEventListener("change", () => { if (cur.mode === "system") run(); });
	return {
		set(next: ThemePrefs) { cur = sanitizeTheme(next); saveTheme(cur); run(); },
		get: () => cur,
	};
}
