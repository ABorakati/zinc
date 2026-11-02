// What the reader remembers between runs: per document the page, zoom and rotation; the page appearance; the sidebar.
// One JSON file, %APPDATA%\zotero-next-gpui\reader-state.json (the web reader keeps the same view state in the core, under
// /api/attachments/:key/view-state; the GPUI spike keeps it beside the app instead so it never touches the library).
// Writes are debounced and atomic (temp file + rename); a corrupt or missing file is just an empty state.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ZoomMode = "width" | "page" | "custom";

export interface DocViewState {
	/** page at the top of the viewport (0-based) and how far into its row, 0..1 */
	page: number;
	frac: number;
	zoomMode: ZoomMode;
	zoom: number;
	/** per-page rotation in degrees (only non-zero pages are stored) and the whole-document rotation */
	rot: number;
	rots?: Record<string, number>;
	/** ms since epoch, to drop the oldest entries */
	t: number;
}

export type AppearanceMode = "normal" | "dark" | "sepia" | "custom" | "reading";
export interface Appearance { mode: AppearanceMode; custom: string; /** reading mode: text and paper colours */ fg?: string; bg?: string }

export interface SidebarState { open: boolean; tab: string; width: number }

interface Persisted { v: 1; docs: Record<string, DocViewState>; appearance: Appearance; sidebar: SidebarState }

const MAX_DOCS = 300;
const defaults = (): Persisted => ({ v: 1, docs: {}, appearance: { mode: "normal", custom: "#e8f0e0" }, sidebar: { open: true, tab: "thumbs", width: 232 } });

export function stateFile(): string {
	return process.env.ZN_READER_STATE ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "zotero-next-gpui", "reader-state.json");
}

let data: Persisted | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/** scripts set this to keep a run from touching the real file */
let disabled = false;
const off = () => disabled || process.env.ZN_READER_STATE === "off";
export function disableReaderState(): void { disabled = true; }

function load(): Persisted {
	if (data) return data;
	const d = defaults();
	if (!off()) {
		try {
			const f = stateFile();
			if (existsSync(f)) {
				const j = JSON.parse(readFileSync(f, "utf8")) as Partial<Persisted>;
				if (j && typeof j === "object") {
					if (j.docs && typeof j.docs === "object") d.docs = j.docs;
					if (j.appearance && typeof j.appearance.mode === "string") d.appearance = { ...d.appearance, ...j.appearance };
					if (j.sidebar && typeof j.sidebar === "object") d.sidebar = { ...d.sidebar, ...j.sidebar };
				}
			}
		} catch { /* corrupt file: start empty */ }
	}
	return (data = d);
}

export function flushReaderState(): void {
	clearTimeout(timer);
	timer = undefined;
	if (!data || off()) return;
	try {
		const keys = Object.keys(data.docs);
		if (keys.length > MAX_DOCS) {
			keys.sort((a, b) => data!.docs[a]!.t - data!.docs[b]!.t);
			for (const k of keys.slice(0, keys.length - MAX_DOCS)) delete data.docs[k];
		}
		const f = stateFile();
		mkdirSync(dirname(f), { recursive: true });
		const tmp = `${f}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data));
		renameSync(tmp, f);
	} catch (e) {
		console.error("[reader] cannot save the view state:", e instanceof Error ? e.message : e);
	}
}
// the debounced write may still be pending when the process exits
process.on("exit", () => { if (timer) flushReaderState(); });
function schedule() {
	if (timer || off()) return;
	timer = setTimeout(flushReaderState, 900);
}

export const getDocState = (key: string): DocViewState | undefined => load().docs[key];
export function setDocState(key: string, s: Omit<DocViewState, "t">): void {
	load().docs[key] = { ...s, t: Date.now() };
	schedule();
}

export const getAppearance = (): Appearance => load().appearance;
export function saveAppearance(a: Appearance): void { load().appearance = a; schedule(); }
export const getSidebar = (): SidebarState => load().sidebar;
export function saveSidebar(s: SidebarState): void { load().sidebar = s; schedule(); }
