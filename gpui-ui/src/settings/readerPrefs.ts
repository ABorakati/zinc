// Defaults of the native PDF reader chosen in Settings > Reader, persisted in ui-state.json ("shell.reader.*"). The reader reads
// these signals when it opens a document for the first time:  import { readerPrefs } from "../settings/readerPrefs".
import { persisted } from "../shell/prefs";
import { reflowSettings, resetReflowSettings, setReflowSettings } from "../reader/reflow/state";

/** Zoom for a document opened for the first time: fit width, fit page, or a fixed scale (1 = 100%). */
export type DefaultZoom = "width" | "page" | number;
export type SidebarStart = "remember" | "open" | "closed";
/** How PDF pages are tinted: follow the app theme, or force one. */
export type PageAppearance = "app" | "normal" | "dark" | "sepia";

const ZOOMS = ["width", "page", "0.5", "0.75", "1", "1.25", "1.5", "2", "3"] as const;
export const ZOOM_CHOICES = ZOOMS;
export const zoomLabel = (v: string): string => (v === "width" ? "Fit width" : v === "page" ? "Fit page" : `${Math.round(+v * 100)}%`);

const okZoom = (v: unknown): string | undefined => (typeof v === "string" && (ZOOMS as readonly string[]).includes(v) ? v : undefined);
const okSide = (v: unknown): SidebarStart | undefined => (v === "remember" || v === "open" || v === "closed" ? v : undefined);
const okPage = (v: unknown): PageAppearance | undefined => (v === "app" || v === "normal" || v === "dark" || v === "sepia" ? v : undefined);

const [zoomKey, setZoomKey] = persisted<string>("shell.reader.zoom", "width", okZoom);
const [sidebar, setSidebar] = persisted<SidebarStart>("shell.reader.sidebar", "remember", okSide);
const [pages, setPages] = persisted<PageAppearance>("shell.reader.pages", "app", okPage);

export const readerPrefs = {
	/** "width" | "page" | a scale as a number (1 = 100%) */
	zoom: (): DefaultZoom => { const z = zoomKey(); return z === "width" || z === "page" ? z : Number(z); },
	zoomKey,
	setZoomKey,
	sidebar, setSidebar,
	pageAppearance: pages, setPageAppearance: setPages,
	reset(): void { setZoomKey("width"); setSidebar("remember"); setPages("app"); },
};

// ---- the reflowed reading view (reader/reflow): typography, theme and "open PDFs in the reading view by default". They live in
// reading-settings.json next to ui-state.json (reader/reflow/settings.ts); the signals are in a module without UI imports.
export { FONTS as READING_FONTS, LIMITS as READING_LIMITS } from "../reader/reflow/settings";
export type { ReadingSettings, ThemeKind as ReadingTheme } from "../reader/reflow/settings";
export const readingView = {
	settings: reflowSettings,
	set: setReflowSettings,
	reset: resetReflowSettings,
};
