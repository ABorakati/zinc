// Reading view settings: typography + theme (reader-next/src/reflow/settings.ts). Pure helpers plus a small JSON file for
// persistence (the web reader keeps these in localStorage; here they live next to the app's other per-user data).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ThemeKind = "light" | "sepia" | "dark" | "custom";

/**
 * Reading fonts. The text is drawn by GPUIX, which resolves a family by name: the app's own registered fonts ("Source Serif 4",
 * "Inter") and fonts installed on this computer (Georgia, Palatino Linotype, Cambria, Segoe UI, Verdana, ...).
 */
export const FONTS = [
	{ id: "source-serif", label: "Source Serif 4", group: "serif", family: "Source Serif 4" },
	{ id: "georgia", label: "Georgia", group: "serif", family: "Georgia" },
	{ id: "palatino", label: "Palatino Linotype", group: "serif", family: "Palatino Linotype" },
	{ id: "cambria", label: "Cambria", group: "serif", family: "Cambria" },
	{ id: "inter", label: "Inter", group: "sans", family: "Inter" },
	{ id: "segoe", label: "Segoe UI", group: "sans", family: "Segoe UI" },
	{ id: "verdana", label: "Verdana", group: "sans", family: "Verdana" },
] as const satisfies readonly { id: string; label: string; group: "serif" | "sans"; family: string }[];

export type FontKind = (typeof FONTS)[number]["id"];
const FONT_IDS = new Set<string>(FONTS.map((f) => f.id));

export interface ReadingSettings {
	font: FontKind;
	size: number; // px
	lineHeight: number; // unitless
	width: number; // max text column width, px
	theme: ThemeKind;
	customBg: string; // #rrggbb, used when theme === "custom"
	openByDefault: boolean; // open PDFs straight in the reading view
}

export const DEFAULT_SETTINGS: ReadingSettings = {
	font: "source-serif",
	size: 17,
	lineHeight: 1.6,
	width: 680,
	theme: "light",
	customBg: "#e6efe3",
	openByDefault: false,
};

export const LIMITS = {
	size: [12, 30],
	lineHeight: [1.2, 2.2],
	width: [420, 1000],
} as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Validate untrusted (stored) data into a complete settings object. */
export function sanitize(v: unknown): ReadingSettings {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const d = DEFAULT_SETTINGS;
	return {
		font: typeof o.font === "string" && FONT_IDS.has(o.font) ? (o.font as FontKind) : d.font,
		size: clamp(o.size, LIMITS.size, d.size),
		lineHeight: clamp(o.lineHeight, LIMITS.lineHeight, d.lineHeight),
		width: clamp(o.width, LIMITS.width, d.width),
		theme: o.theme === "light" || o.theme === "sepia" || o.theme === "dark" || o.theme === "custom" ? o.theme : d.theme,
		customBg: typeof o.customBg === "string" && parseHex(o.customBg) ? normaliseHex(o.customBg) : d.customBg,
		openByDefault: typeof o.openByDefault === "boolean" ? o.openByDefault : d.openByDefault,
	};
}

export const SETTINGS_FILE = process.env.ZN_READING_SETTINGS ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "zotero-next-gpui", "reading-settings.json");

export function loadSettings(file = SETTINGS_FILE): ReadingSettings {
	try { return sanitize(JSON.parse(readFileSync(file, "utf8"))); } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s: ReadingSettings, file = SETTINGS_FILE): boolean {
	try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(s)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- colours

export type RGB = [number, number, number];

export function parseHex(s: string): RGB | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
	if (!m) return null;
	let h = m[1]!;
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
export const normaliseHex = (s: string) => { const c = parseHex(s); return c ? toHex(c) : s; };

/** WCAG relative luminance, 0..1. */
export function relativeLuminance([r, g, b]: RGB): number {
	const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(a: RGB, b: RGB): number {
	const la = relativeLuminance(a), lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK_DARK: RGB = [28, 27, 25];
const INK_LIGHT: RGB = [236, 233, 226];

/** Text colour with the best contrast on bg (a soft near-black or near-white). */
export function contrastColor(bg: string): string {
	const c = parseHex(bg);
	if (!c) return toHex(INK_DARK);
	return toHex(contrastRatio(c, INK_DARK) >= contrastRatio(c, INK_LIGHT) ? INK_DARK : INK_LIGHT);
}

export interface Palette { dark: boolean; bg: string; fg: string; muted: string; rule: string; cite: string; panel: string }

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function palette(s: ReadingSettings): Palette {
	const bg = s.theme === "light" ? "#fbfaf7" : s.theme === "sepia" ? "#f4ecd8" : s.theme === "dark" ? "#17181b" : s.customBg;
	const fg = s.theme === "dark" ? "#dedcd6" : s.theme === "sepia" ? "#3b2f22" : s.theme === "light" ? "#1f1e1c" : contrastColor(bg);
	const b = parseHex(bg)!, f = parseHex(fg)!;
	const dark = relativeLuminance(b) < 0.3;
	const blueDark: RGB = [26, 68, 190], blueLight: RGB = [140, 182, 255];
	return {
		dark, bg, fg,
		muted: toHex(mix(f, b, 0.38)),
		rule: toHex(mix(f, b, dark ? 0.8 : 0.82)),
		cite: toHex(contrastRatio(b, blueDark) >= contrastRatio(b, blueLight) ? blueDark : blueLight),
		panel: toHex(mix(f, b, dark ? 0.9 : 0.94)),
	};
}

export const fontFamilyOf = (s: ReadingSettings): string => (FONTS.find((f) => f.id === s.font) ?? FONTS[0]).family;
