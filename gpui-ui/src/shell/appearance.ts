// Appearance preferences (Settings > Appearance): light / dark / system, colour scheme, interface font and text size.
// The colour maths and the scheme list are the web UI's (./schemes.ts, dependency-free, kept from the old web UI so the schemes
// match one for one); this module applies the result to the GPUI theme:
//
//   * colours   -> theme.ts `tokens` / `shadows` are rewritten in place (buildTokens with the scheme's palette), then tw()'s
//                  memo is dropped and every component that reads store.mode() is poked to re-run;
//   * text size -> setUiScale(size / 13);   * font -> setSansFont() (registers the font file on demand).
// It is light on purpose (no store import): main.tsx calls applyAppearance() before the first frame and startAppearance(store)
// once the store exists.
import { batch, createEffect, createRoot, createSignal, type Accessor } from "solid-js";
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import {
	accentFor,
	cleanFamily,
	computeVars,
	DEFAULT_THEME,
	FONT_SUGGESTIONS,
	FONTS,
	sanitizeTheme,
	SCHEMES,
	TEXT_SIZES,
	type FontId,
	type ThemeMode,
	type ThemePrefs,
} from "./schemes";
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
			RegGetValueW: {
				args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
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

// CF object references travel as u64 (BigInt): short CFStrings such as "Dark" are tagged pointers with the top bit set, which
// FFIType.ptr (a JS number) cannot hold, and passing one back crashes the process.
type CFRef = bigint;
type MacCF = {
	CFStringCreateWithCString(alloc: null, s: Buffer, enc: number): CFRef;
	CFPreferencesAppSynchronize(app: CFRef): boolean;
	CFPreferencesCopyAppValue(key: CFRef, app: CFRef): CFRef;
	CFStringGetCString(s: CFRef, buf: Buffer, len: number, enc: number): boolean;
	CFGetTypeID(cf: CFRef): bigint;
	CFStringGetTypeID(): bigint;
	CFRelease(cf: CFRef): void;
	CFNotificationCenterGetDistributedCenter(): CFRef;
	CFNotificationCenterAddObserver(center: CFRef, observer: CFRef, cb: unknown, name: CFRef, object: CFRef, behavior: number): void;
};
const UTF8 = 0x08000100; // kCFStringEncodingUTF8
let macCF: { cf: MacCF; str(s: string): CFRef; key: CFRef; app: CFRef } | null | undefined;

/** CoreFoundation and the two CFStrings the reader needs, opened once; null when not on macOS or when it fails to load. */
function loadMacCF() {
	if (macCF !== undefined) return macCF;
	macCF = null;
	if (process.platform !== "darwin") return null;
	const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
		CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
		CFPreferencesAppSynchronize: { args: [FFIType.u64], returns: FFIType.bool },
		CFPreferencesCopyAppValue: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
		CFStringGetCString: { args: [FFIType.u64, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
		CFGetTypeID: { args: [FFIType.u64], returns: FFIType.u64 },
		CFStringGetTypeID: { args: [], returns: FFIType.u64 },
		CFRelease: { args: [FFIType.u64], returns: FFIType.void },
		CFNotificationCenterGetDistributedCenter: { args: [], returns: FFIType.u64 },
		CFNotificationCenterAddObserver: {
			args: [FFIType.u64, FFIType.u64, FFIType.function, FFIType.u64, FFIType.u64, FFIType.i64],
			returns: FFIType.void,
		},
	}).symbols as unknown as MacCF;
	const str = (s: string) => cf.CFStringCreateWithCString(null, Buffer.from(`${s}\0`, "utf8"), UTF8);
	// kCFPreferencesAnyApplication is a CFString with this content; CFPreferences compares domains by value
	const key = str("AppleInterfaceStyle");
	const app = str("kCFPreferencesAnyApplication");
	if (!key || !app) return null;
	macCF = { cf, str, key, app };
	return macCF;
}

/**
 * macOS "Appearance" (the global AppleInterfaceStyle preference: "Dark" in dark mode, absent in light mode); undefined when
 * unreadable. The preferences are synchronized before each read, so a long-running process sees the user's changes.
 */
export function readMacDark(): boolean | undefined {
	try {
		const m = loadMacCF();
		if (!m) return undefined;
		const { cf, key, app } = m;
		cf.CFPreferencesAppSynchronize(app);
		const v = cf.CFPreferencesCopyAppValue(key, app);
		if (!v) return false;
		try {
			if (cf.CFGetTypeID(v) !== cf.CFStringGetTypeID()) return false;
			const buf = Buffer.alloc(16);
			if (!cf.CFStringGetCString(v, buf, buf.length, UTF8)) return false;
			return buf.toString("utf8", 0, buf.indexOf(0)) === "Dark";
		} finally {
			cf.CFRelease(v);
		}
	} catch {
		return undefined;
	}
}

// Kept for the life of the process: CoreFoundation holds the function pointer and has no use for removing the observer here.
let macThemeCallback: JSCallback | undefined;
/**
 * Call `onChange` when the user switches macOS between light and dark (the distributed notification
 * AppleInterfaceThemeChangedNotification). CoreFoundation delivers it on the main run loop, which GPUIX's tick() pumps on the
 * JavaScript thread, so `onChange` runs there. Returns false when not on macOS or when the observer cannot be registered.
 */
export function onMacThemeChange(onChange: () => void): boolean {
	try {
		const m = loadMacCF();
		if (!m || macThemeCallback) return false;
		// void (*)(CFNotificationCenterRef, void *observer, CFNotificationName, const void *object, CFDictionaryRef userInfo)
		macThemeCallback = new JSCallback(() => onChange(), {
			args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
			returns: FFIType.void,
		});
		const center = m.cf.CFNotificationCenterGetDistributedCenter();
		// observer: any non-null token; CFNotificationSuspensionBehaviorDeliverImmediately = 4
		m.cf.CFNotificationCenterAddObserver(center, 1n, macThemeCallback.ptr, m.str("AppleInterfaceThemeChangedNotification"), 0n, 4);
		return true;
	} catch {
		return false;
	}
}

const [systemDark, setSystemDark] = createSignal(true);
let watching = false;
/**
 * Follow the OS light/dark setting. macOS: read it now and again on each change notification. Windows: polled every few seconds,
 * as there is no change event in the GPUIX window.
 */
export function watchSystemTheme(): void {
	if (watching) return;
	watching = true;
	const read = (d: boolean | undefined) => {
		if (d !== undefined && d !== systemDark()) setSystemDark(d);
	};
	if (process.platform === "darwin") {
		read(readMacDark());
		onMacThemeChange(() => read(readMacDark()));
		return;
	}
	const poll = () => read(readWindowsAppsUseDark());
	poll();
	if (process.platform !== "win32") return;
	const t = setInterval(poll, 4000);
	(t as unknown as { unref?: () => void }).unref?.();
}
/** Is the OS in dark mode (as last read)? */
export const systemIsDark: Accessor<boolean> = systemDark;

export function resolveMode(p: ThemePrefs = prefs()): Mode {
	return p.mode === "system" ? (systemDark() ? "dark" : "light") : p.mode;
}

// ------------------------------------------------------------------------------------------------ applying

const SANS: Record<string, string> = {
	inter: "inter",
	manrope: "manrope",
	plex: "plex",
	source: "source",
	system: "Segoe UI Variable Text",
};
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
		shadows[m] = {
			raised: parseShadow(t["raised-shadow"]!),
			pill: parseShadow(t["pill-shadow"]!),
			primary: parseShadow(t["primary-shadow"]!),
		};
	}
	return true;
}

let lastSans = "";
function applyTypography(p: ThemePrefs): boolean {
	let changed = false;
	const s = +(p.size / BASE_SIZE).toFixed(4);
	if (s !== scale) {
		scale = s;
		setUiScale(s);
		changed = true;
	}
	const sans = sansFor(p);
	if (sans !== lastSans) {
		lastSans = sans;
		setSansFont(sans);
		changed = true;
	}
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
interface ModeStore {
	mode: Accessor<Mode>;
	setMode(m: Mode): void;
}

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
