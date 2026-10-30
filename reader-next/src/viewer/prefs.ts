// Viewer defaults set from the app's Settings page (the app and its reader iframes share localStorage).
// Pure helpers except the storage wrappers, which are try/catch'd (storage can be missing or throw).

/** Zoom for a document opened for the first time: fit width, fit page, or a fixed scale (1 = 100%). */
export type DefaultZoom = "width" | "page" | number;
/** Side panel on open: as last left, or always open / closed. */
export type SidebarStart = "remember" | "open" | "closed";

export interface ViewerPrefs {
	zoom: DefaultZoom;
	sidebar: SidebarStart;
}

export const DEFAULT_VIEWER_PREFS: ViewerPrefs = { zoom: "width", sidebar: "remember" };
export const VIEWER_PREFS_KEY = "rn.viewer.prefs";
export const ZOOM_LIMITS = [0.25, 6] as const;

/** Validate untrusted (stored) data into a complete prefs object. */
export function sanitizePrefs(v: unknown): ViewerPrefs {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const d = DEFAULT_VIEWER_PREFS;
	const zoom = o.zoom === "width" || o.zoom === "page" ? o.zoom
		: typeof o.zoom === "number" && Number.isFinite(o.zoom) ? Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], o.zoom)) : d.zoom;
	return { zoom, sidebar: o.sidebar === "open" || o.sidebar === "closed" || o.sidebar === "remember" ? o.sidebar : d.sidebar };
}

export function loadViewerPrefs(): ViewerPrefs {
	try { return sanitizePrefs(JSON.parse(localStorage.getItem(VIEWER_PREFS_KEY) ?? "null")); }
	catch { return { ...DEFAULT_VIEWER_PREFS }; }
}

export function saveViewerPrefs(p: ViewerPrefs): boolean {
	try { localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify(p)); return true; }
	catch { return false; }
}
