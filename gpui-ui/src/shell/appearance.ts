// Appearance preferences (Settings > Appearance): light / dark / system, colour scheme, interface font and text size.
// The colour maths and the scheme list are the web UI's (reader-next/src/viewer/theme.ts, dependency-free), so the schemes
// match one for one; this module applies the result to the GPUI theme:
//
//   * colours   -> theme.ts `tokens` / `shadows` are rewritten in place (buildTokens with the scheme's palette), then tw()'s
//                  memo is dropped and every component that reads store.mode() is poked to re-run;
//   * text size -> setUiScale(size / 13);   * font -> setSansFont() (registers the font file on demand).
// It is light on purpose (no store import): main.tsx calls applyAppearance() before the first frame and startAppearance(store)
// once the store exists.
import { batch, createEffect, createRoot, createSignal, type Accessor } from "solid-js";
import { dlopen, FFIType } from "bun:ffi";
import {
	accentFor, cleanFamily, computeVars, DEFAULT_THEME, FONT_SUGGESTIONS, FONTS, sanitizeTheme, SCHEMES, TEXT_SIZES,
	type FontId, type ThemeMode, type ThemePrefs,
} from "../../../reader-next/src/viewer/theme";
import type { Mode } from "../contracts";
import { setSansFont } from "../fonts";
import { buildTokens, parseShadow, setUiScale, shadows, tokens } from "../theme";
import { persisted } from "./prefs";

export { accentFor, cleanFamily, DEFAULT_THEME, FONT_SUGGESTIONS, FONTS, SCHEMES, TEXT_SIZES };
export type { FontId, ThemeMode, ThemePrefs };

const BASE_SIZE = 13;

// ------------------------------------------------------------------------------------------------ prefs

const [prefs, setPrefsSig] = persisted<ThemePrefs>("shell.theme", { ...DEFAULT_THEME }, (v) => sanitizeTheme(v));
/** The appearance preferences (reactive). */
export const themePrefs: Accessor<ThemePrefs> = prefs;
export function setThemePrefs(patch: Partial<ThemePrefs>): void {
	setPrefsSig(sanitizeTheme({ ...prefs(), ...patch }));
}
export const resetThemePrefs = (): void => setPrefsSig({ ...DEFAULT_THEME });

// ------------------------------------------------------------------------------------------------ OS light / dark

/** Windows "Choose your default app mode" (HKCU\...\Themes\Personalize\AppsUseLightTheme); undefined when unreadable. */
export function readWindowsAppsUseDark(): boolean | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const adv = dlopen("advapi32.dll", {
			RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		}).symbols;
		const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");
		const sub = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
		const name = wide("AppsUseLightTheme");
		const out = new Uint32Array(1);
		const size = new Uint32Array([4]);
		// HKEY_CURRENT_USER = 0x80000001, RRF_RT_REG_DWORD = 0x10
		const rc = adv.RegGetValueW(0x80000001n as never, sub as never, name as never, 0x10, null as never, out as never, size as never);
		return rc === 0 ? out[0] === 0 : undefined;
	} catch {
		return undefined;
	}
}

const [systemDark, setSystemDark] = createSignal(true);
let watching = false;
/** Follow the OS light/dark setting (polled every few seconds; there is no change event in the GPUIX window). */
export function watchSystemTheme(): void {
	if (watching) return;
	watching = true;
	const poll = () => {
		const d = readWindowsAppsUseDark();
		if (d !== undefined && d !== systemDark()) setSystemDark(d);
	};
	poll();
	const t = setInterval(poll, 4000);
	(t as unknown as { unref?: () => void }).unref?.();
}
/** Is the OS in dark mode (as last read)? */
export const systemIsDark: Accessor<boolean> = systemDark;

export function resolveMode(p: ThemePrefs = prefs()): Mode {
	return p.mode === "system" ? (systemDark() ? "dark" : "light") : p.mode;
}

// ------------------------------------------------------------------------------------------------ applying

const SANS: Record<string, string> = { inter: "inter", manrope: "manrope", plex: "plex", source: "source", system: "Segoe UI Variable Text" };
function sansFor(p: ThemePrefs): string {
	if (p.font === "custom") return p.fontCustom || "Segoe UI Variable Text";
	return SANS[p.font] ?? "inter";
}

let scale = 1;
let appliedKey = "";

/** Rewrite theme.ts's tokens and shadows for a colour scheme. Returns true when something changed. */
function applyColours(p: ThemePrefs): boolean {
	const key = `${p.scheme}|${p.scheme === "custom" ? p.accent : ""}`;
	if (key === appliedKey) return false;
	appliedKey = key;
	const v = computeVars(p);
	for (const m of ["light", "dark"] as const) {
		const vars = v[m];
		const pal: Record<string, string> = {};
		for (const [k, val] of Object.entries(vars)) if (k !== "--nh") pal[k.slice(2)] = val;
		const t = buildTokens(m, pal, Number(vars["--nh"]) || 85);
		const cur = tokens[m];
		for (const k of Object.keys(cur)) delete cur[k];
		Object.assign(cur, t);
		shadows[m] = { raised: parseShadow(t["raised-shadow"]!), pill: parseShadow(t["pill-shadow"]!), primary: parseShadow(t["primary-shadow"]!) };
	}
	return true;
}

let lastSans = "";
function applyTypography(p: ThemePrefs): boolean {
	let changed = false;
	const s = +(p.size / BASE_SIZE).toFixed(4);
	if (s !== scale) { scale = s; setUiScale(s); changed = true; }
	const sans = sansFor(p);
	if (sans !== lastSans) { lastSans = sans; setSansFont(sans); changed = true; }
	return changed;
}

/** Drop tw()'s memo (setUiScale clears it when the value differs). */
function dropStyleCache(): void {
	setUiScale(scale + 1e-4);
	setUiScale(scale);
}

/**
 * Apply colours, text size and font from the stored preferences, synchronously and without the store. Call once before the
 * first frame (main.tsx); returns the resolved mode so the splash and the store can start in it.
 */
export function applyAppearance(): Mode {
	const p = prefs();
	if (p.mode === "system") watchSystemTheme();
	applyColours(p);
	applyTypography(p);
	dropStyleCache();
	return resolveMode(p);
}

/** Minimal slice of the app store this module drives. */
interface ModeStore { mode: Accessor<Mode>; setMode(m: Mode): void }

let started = false;
/**
 * Keep the theme in step with the preferences and the OS: mode goes to store.setMode; a colour / font / size change rewrites the
 * tokens and pokes every subscriber of store.mode() so already-drawn components restyle (one batched re-run, mode unchanged).
 */
export function startAppearance(store: ModeStore): void {
	if (started) return;
	started = true;
	createRoot(() => {
		let first = true;
		createEffect(() => {
			const p = prefs();
			if (p.mode === "system") watchSystemTheme();
			const dark = p.mode === "system" ? systemDark() : p.mode === "dark";
			const mode: Mode = dark ? "dark" : "light";
			const changed = applyColours(p) || applyTypography(p);
			if (changed) dropStyleCache();
			batch(() => {
				const cur = store.mode();
				if (cur !== mode) store.setMode(mode);
				else if (changed && !first) {
					// same mode, new look: write the opposite then the real mode inside one batch so readers re-run once
					store.setMode(mode === "dark" ? "light" : "dark");
					store.setMode(mode);
				}
			});
			first = false;
		});
	});
}
