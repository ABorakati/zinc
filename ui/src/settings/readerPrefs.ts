// Preferences of the zotero-next PDF reader (reader-next/). The reader runs in same-origin iframes, so its localStorage
// is ours: we write the same keys it reads, and it follows via the `storage` event (see reader-next/src/viewer/appearance.ts,
// reflow/index.ts). We follow its changes the same way (e.g. a font picked inside the reading view).
import { createSignal } from "solid-js";
import { loadSettings, sanitize, saveSettings, STORAGE_KEY, DEFAULT_SETTINGS, type ReadingSettings } from "../../../reader-next/src/reflow/settings";
import { loadViewerPrefs, saveViewerPrefs, VIEWER_PREFS_KEY, DEFAULT_VIEWER_PREFS, type ViewerPrefs } from "../../../reader-next/src/viewer/prefs";

export type { ReadingSettings, ViewerPrefs };

// ---- reading view (rn.reading.settings)
const [reading, setReadingSig] = createSignal<ReadingSettings>(loadSettings());
export { reading };
export function setReading(patch: Partial<ReadingSettings>) {
	const next = sanitize({ ...reading(), ...patch });
	setReadingSig(next);
	saveSettings(next);
}
/** Typography and theme back to defaults; "open in the reading view" is a separate choice and stays. */
export const resetReading = () => setReading({ ...DEFAULT_SETTINGS, openByDefault: reading().openByDefault });

// ---- viewer defaults (rn.viewer.prefs)
const [viewer, setViewerSig] = createSignal<ViewerPrefs>(loadViewerPrefs());
export { viewer };
export function setViewer(patch: Partial<ViewerPrefs>) {
	const next = { ...viewer(), ...patch };
	setViewerSig(next);
	saveViewerPrefs(next);
}
export const resetViewer = () => { setViewerSig({ ...DEFAULT_VIEWER_PREFS }); saveViewerPrefs(DEFAULT_VIEWER_PREFS); };

// ---- page appearance (rn.appearance)
export type AppearanceMode = "normal" | "dark" | "sepia" | "custom" | "reading";
export interface Appearance { mode: AppearanceMode; custom: string }
const APPEARANCE_KEY = "rn.appearance";
const MODES: AppearanceMode[] = ["normal", "dark", "sepia", "custom", "reading"];
function loadAppearance(): Appearance {
	try {
		const v = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null");
		if (v && MODES.includes(v.mode)) return { mode: v.mode, custom: typeof v.custom === "string" && /^#[0-9a-f]{6}$/i.test(v.custom) ? v.custom : "#e8f0e0" };
	} catch { /* ignore */ }
	return { mode: "normal", custom: "#e8f0e0" };
}
const [appearance, setAppearanceSig] = createSignal<Appearance>(loadAppearance());
export { appearance };
export function setAppearance(patch: Partial<Appearance>) {
	const next = { ...appearance(), ...patch };
	setAppearanceSig(next);
	try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

// changes made inside a reader tab
if (typeof window !== "undefined") {
	window.addEventListener("storage", (e) => {
		if (e.key === null || e.key === STORAGE_KEY) setReadingSig(loadSettings());
		if (e.key === null || e.key === VIEWER_PREFS_KEY) setViewerSig(loadViewerPrefs());
		if (e.key === null || e.key === APPEARANCE_KEY) setAppearanceSig(loadAppearance());
	});
}
