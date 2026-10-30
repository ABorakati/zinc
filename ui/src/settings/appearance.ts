// Appearance preferences (light/dark/system, colour scheme, interface font and size). Stored as `zn.theme`; the logic
// (colour maths, applying to <html>, following the OS and other documents) lives in reader-next/src/viewer/theme.ts so the
// reader iframes run exactly the same code. This file just exposes it as Solid signals for the Settings page.
import { createSignal } from "solid-js";
import { loadTheme, sanitizeTheme, watchTheme, type ThemePrefs } from "../../../reader-next/src/viewer/theme";

export type { ThemePrefs };
export {
	accentFor, cleanFamily, computeVars, contrast, FONT_SUGGESTIONS, FONTS, SCHEMES, TEXT_SIZES, DEFAULT_THEME, resolveDark,
	type FontId, type ThemeMode,
} from "../../../reader-next/src/viewer/theme";

const [theme, setThemeSig] = createSignal<ThemePrefs>(loadTheme());
export { theme };

let handle: ReturnType<typeof watchTheme> | undefined;

/** Apply the saved theme and keep following it (call once at startup). */
export function startTheme() {
	handle ??= watchTheme((p) => setThemeSig(p));
}

export function setTheme(patch: Partial<ThemePrefs>) {
	startTheme();
	handle!.set(sanitizeTheme({ ...theme(), ...patch }));
}
