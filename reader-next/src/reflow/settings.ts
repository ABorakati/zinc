// Reading view settings: typography + theme. Pure helpers (no DOM) except the localStorage wrappers, which
// are try/catch'd because storage can be missing or throw (private windows, blocked site data).

export type FontKind = "serif" | "sans" | "dyslexic" | "custom";
export type ThemeKind = "light" | "sepia" | "dark" | "custom";

export interface ReadingSettings {
	font: FontKind;
	customFont: string; // any installed font, typed by name
	size: number; // px
	lineHeight: number; // unitless
	width: number; // max text column width, px
	theme: ThemeKind;
	customBg: string; // #rrggbb, used when theme === "custom"
	justify: boolean;
}

export const DEFAULT_SETTINGS: ReadingSettings = {
	font: "serif",
	customFont: "",
	size: 19,
	lineHeight: 1.65,
	width: 680,
	theme: "light",
	customBg: "#e6efe3",
	justify: false,
};

export const LIMITS = {
	size: [13, 34],
	lineHeight: [1.2, 2.4],
	width: [420, 1100],
} as const;

export const STORAGE_KEY = "rn.reading.settings";

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Validate untrusted (stored) data into a complete settings object. */
export function sanitize(v: unknown): ReadingSettings {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const d = DEFAULT_SETTINGS;
	return {
		font: o.font === "serif" || o.font === "sans" || o.font === "dyslexic" || o.font === "custom" ? o.font : d.font,
		customFont: typeof o.customFont === "string" ? o.customFont.slice(0, 80) : d.customFont,
		size: clamp(o.size, LIMITS.size, d.size),
		lineHeight: clamp(o.lineHeight, LIMITS.lineHeight, d.lineHeight),
		width: clamp(o.width, LIMITS.width, d.width),
		theme: o.theme === "light" || o.theme === "sepia" || o.theme === "dark" || o.theme === "custom" ? o.theme : d.theme,
		customBg: typeof o.customBg === "string" && parseHex(o.customBg) ? normaliseHex(o.customBg) : d.customBg,
		justify: typeof o.justify === "boolean" ? o.justify : d.justify,
	};
}

export function loadSettings(storage: Pick<Storage, "getItem"> | null = safeStorage()): ReadingSettings {
	try {
		const raw = storage?.getItem(STORAGE_KEY);
		return sanitize(raw ? JSON.parse(raw) : null);
	}
	catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s: ReadingSettings, storage: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
	try { storage?.setItem(STORAGE_KEY, JSON.stringify(s)); return !!storage; }
	catch { return false; }
}

function safeStorage(): Storage | null {
	try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

// ---------------------------------------------------------------- colours

export type RGB = [number, number, number];

export function parseHex(s: string): RGB | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
	if (!m) return null;
	let h = m[1];
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
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK_DARK: RGB = [28, 27, 25];
const INK_LIGHT: RGB = [236, 233, 226];

/** Text colour with the best contrast on bg (a soft near-black or near-white). Accepts "#rgb"/"#rrggbb". */
export function contrastColor(bg: string): string {
	const c = parseHex(bg);
	if (!c) return toHex(INK_DARK);
	return toHex(contrastRatio(c, INK_DARK) >= contrastRatio(c, INK_LIGHT) ? INK_DARK : INK_LIGHT);
}

export interface Palette { dark: boolean; bg: string; fg: string; muted: string; rule: string; cite: string; citeBg: string }

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function palette(s: ReadingSettings): Palette {
	const bg = s.theme === "light" ? "#fbfaf7" : s.theme === "sepia" ? "#f4ecd8" : s.theme === "dark" ? "#17181b" : s.customBg;
	const fg = s.theme === "dark" ? "#dedcd6" : s.theme === "sepia" ? "#3b2f22" : s.theme === "light" ? "#1f1e1c" : contrastColor(bg);
	const b = parseHex(bg)!;
	const f = parseHex(fg)!;
	const dark = relativeLuminance(b) < 0.3;
	// citation links: a hue that reads on this background, found by picking the better-contrasting of two blues
	const blueDark: RGB = [26, 68, 190];
	const blueLight: RGB = [140, 182, 255];
	const cite = toHex(contrastRatio(b, blueDark) >= contrastRatio(b, blueLight) ? blueDark : blueLight);
	return {
		dark, bg, fg,
		muted: toHex(mix(f, b, 0.38)),
		rule: toHex(mix(f, b, dark ? 0.8 : 0.82)),
		cite,
		citeBg: dark ? "rgba(140,182,255,.20)" : "rgba(26,68,190,.12)",
	};
}

export function fontStack(s: ReadingSettings): string {
	switch (s.font) {
		case "sans": return `"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
		case "dyslexic": return `"Atkinson Hyperlegible", "OpenDyslexic", "Lexend", "Verdana", "Segoe UI", sans-serif`;
		case "custom": {
			const name = s.customFont.replace(/["\\;{}<>]/g, "").trim();
			return name ? `"${name}", Georgia, serif` : fontStack({ ...s, font: "serif" });
		}
		default: return `"Charter", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif`;
	}
}

/** Best-effort check whether a font family is installed (canvas width comparison). */
export function isFontInstalled(name: string, doc: Document = document): boolean {
	try {
		const ctx = doc.createElement("canvas").getContext("2d");
		if (!ctx) return false;
		const text = "mmmmmmmmmmlliWWW1234 gqy";
		const w = (family: string) => { ctx.font = `72px ${family}`; return ctx.measureText(text).width; };
		return w(`"${name}", monospace`) !== w("monospace") || w(`"${name}", serif`) !== w("serif");
	}
	catch { return false; }
}
